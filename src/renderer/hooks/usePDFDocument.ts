import { useState, useCallback, useRef, useEffect } from 'react';

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, Annotation, Position, Size, TextAnnotation, ImageAnnotation, HighlightAnnotation, DrawingAnnotation, ShapeAnnotation, StickyNoteAnnotation, StampAnnotation, PDFTextItem, TabInfo } from '../types';

import { buildFormFieldMapping, FormFieldMapping } from '../utils/formFieldSaver';
import { buildTextColorMap, matchTextColor, buildFilledRectMap, matchBackgroundColor } from '../utils/textColorExtractor';
import { extractSourceAnnotations } from '../utils/annotationExtractor';
import { applyEditsAndAnnotations } from '../utils/pdfSavePipeline';
import { mapToStandardFontName, measureTextWidth, getTextHeight } from '../utils/standardFontMetrics';
import { PDFJS_DOCUMENT_OPTIONS } from '../utils/pdfjsConfig';
import { decryptPdf, encryptPdf, hasEncryptDict as hasEncryptDictPrefix } from '../utils/pdfEncryption';

// Configure PDF.js worker - imported with ?url suffix for proper bundling
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Helper function to convert Uint8Array to base64 without stack overflow
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000; // Process in 32KB chunks to avoid stack overflow
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}



/** Detect bold from PDF font name patterns */
function isBoldFontName(fontName: string): boolean {
  const lower = fontName.toLowerCase();
  return lower.includes('bold') || lower.includes('-bd') || lower.endsWith('bd');
}

/** Detect italic from PDF font name patterns */
function isItalicFontName(fontName: string): boolean {
  const lower = fontName.toLowerCase();
  return lower.includes('italic') || lower.includes('oblique') || lower.includes('-it');
}
interface HistoryEntry {
  type: string;
  undo: () => void;
  redo: () => void;
}

interface TabState {
  document: PDFDocument | null;
  modified: boolean;
  history: HistoryEntry[];
  historyIndex: number;
}

let tabCounter = 0;
function generateTabId(): string {
  return `tab-${Date.now()}-${tabCounter++}`;
}

export function usePDFDocument() {
  const [document, setDocument] = useState<PDFDocument | null>(null);
  const [loading, setLoading] = useState(false);
  const [modified, setModified] = useState(false);
  const [history, setHistory] = useState<HistoryEntry[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);

  // Tab management
  const [tabs, setTabs] = useState<TabInfo[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const tabStatesRef = useRef<Map<string, TabState>>(new Map());

  // Form field state
  const [formFieldMappings, setFormFieldMappings] = useState<FormFieldMapping[]>([]);
  const annotationStorageRef = useRef<any>(null);

  // Ref that always holds the latest state values (updated synchronously each render)
  const stateRef = useRef<{
    document: PDFDocument | null;
    modified: boolean;
    history: HistoryEntry[];
    historyIndex: number;
    activeTabId: string | null;
    tabs: TabInfo[];
  }>({ document: null, modified: false, history: [], historyIndex: -1, activeTabId: null, tabs: [] });
  stateRef.current = { document, modified, history, historyIndex, activeTabId, tabs };

  // Lock set to prevent race conditions when opening the same file concurrently
  const openingFilesRef = useRef<Set<string>>(new Set());

  const canUndo = historyIndex >= 0;
  const canRedo = historyIndex < history.length - 1;

  const setAnnotationStorage = useCallback((storage: any) => {
    annotationStorageRef.current = storage;
  }, []);

  const addToHistory = useCallback((entry: HistoryEntry) => {
    setHistory((prev) => [...prev.slice(0, historyIndex + 1), entry]);
    setHistoryIndex((prev) => prev + 1);
    setModified(true);
  }, [historyIndex]);

  // Save current active tab state to the cache
  const saveCurrentTabState = useCallback(() => {
    const { activeTabId: currentId, document: doc, modified: mod, history: hist, historyIndex: hIdx } = stateRef.current;
    if (currentId) {
      tabStatesRef.current.set(currentId, {
        document: doc,
        modified: mod,
        history: hist,
        historyIndex: hIdx,
      });
    }
  }, []);

  // Switch to a different tab
  const switchTab = useCallback((tabId: string) => {
    const { activeTabId: currentId } = stateRef.current;
    if (tabId === currentId) return;

    // Save departing tab's state
    saveCurrentTabState();

    // Load target tab state
    const tabState = tabStatesRef.current.get(tabId);
    if (tabState) {
      setDocument(tabState.document);
      setModified(tabState.modified);
      setHistory(tabState.history);
      setHistoryIndex(tabState.historyIndex);
      setActiveTabId(tabId);
    }
  }, [saveCurrentTabState]);

  // Close a tab
  const closeTab = useCallback((tabId: string) => {
    const { activeTabId: currentId, tabs: currentTabs } = stateRef.current;

    // Zero plaintext-after-decrypt material on the cached document before
    // dropping the cache. Passwords always; pdfData only for documents
    // opened from an encrypted source (where pdfData is decrypted plaintext
    // that should not survive the doc lifetime).
    const cached = tabStatesRef.current.get(tabId);
    if (cached?.document) {
      const wasProtected = !!cached.document.password;
      cached.document.password = undefined;
      cached.document.pendingEncryption = undefined;
      if (wasProtected) {
        cached.document.pdfData = new Uint8Array(0);
        cached.document.encryptionMeta = undefined;
      }
    }
    tabStatesRef.current.delete(tabId);

    const newTabs = currentTabs.filter(t => t.id !== tabId);

    if (tabId === currentId) {
      // Closing the active tab - switch to an adjacent one
      const closedIndex = currentTabs.findIndex(t => t.id === tabId);
      const nextTab = newTabs[closedIndex] || newTabs[closedIndex - 1];

      if (nextTab) {
        const nextState = tabStatesRef.current.get(nextTab.id);
        if (nextState) {
          setDocument(nextState.document);
          setModified(nextState.modified);
          setHistory(nextState.history);
          setHistoryIndex(nextState.historyIndex);
          setActiveTabId(nextTab.id);
        }
      } else {
        // No more tabs - back to welcome screen
        setDocument(null);
        setModified(false);
        setHistory([]);
        setHistoryIndex(-1);
        setActiveTabId(null);
      }
    }

    setTabs(newTabs);
  }, []);

  // Clear in-memory plaintext material on app/window unload — passwords
  // always; pdfData only for protected docs (decrypted plaintext).
  useEffect(() => {
    const handler = () => {
      tabStatesRef.current.forEach((s) => {
        if (s.document) {
          const wasProtected = !!s.document.password;
          s.document.password = undefined;
          s.document.pendingEncryption = undefined;
          if (wasProtected) {
            s.document.pdfData = new Uint8Array(0);
            s.document.encryptionMeta = undefined;
          }
        }
      });
    };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, []);

  // Keep active tab metadata in sync
  useEffect(() => {
    if (activeTabId && document) {
      setTabs(prev => {
        const idx = prev.findIndex(t => t.id === activeTabId);
        if (idx === -1) return prev;
        const current = prev[idx];
        if (current.fileName === document.fileName && current.filePath === document.filePath && current.modified === modified) {
          return prev;
        }
        const updated = [...prev];
        updated[idx] = { ...current, fileName: document.fileName, filePath: document.filePath, modified };
        return updated;
      });
    }
  }, [activeTabId, document?.fileName, document?.filePath, modified]);

  const openFile = useCallback(async (filePath: string, base64Data: string, password?: string) => {
    // Check if file is already open in a tab
    if (filePath) {
      const existingTab = stateRef.current.tabs.find(t => t.filePath === filePath);
      if (existingTab) {
        switchTab(existingTab.id);
        return;
      }
      // Prevent concurrent opens of the same file (race condition guard)
      if (openingFilesRef.current.has(filePath)) {
        return;
      }
      openingFilesRef.current.add(filePath);
    }
    setLoading(true);
    try {
      const rawBytes = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));

      // Detect encryption and, if so, decrypt to plaintext bytes via qpdf-wasm.
      // Working with plaintext downstream means the pdf-lib save pipeline can
      // edit content streams; we re-encrypt with the captured meta on save.
      const isEncrypted = hasEncryptDictPrefix(rawBytes);
      let workingBytes = rawBytes;
      let capturedMeta: PDFDocument['encryptionMeta'] | undefined;

      if (isEncrypted) {
        if (!password) {
          const passwordError = new Error('PASSWORD_REQUIRED');
          (passwordError as any).reason = 'NEED_PASSWORD';
          (passwordError as any).filePath = filePath;
          (passwordError as any).base64Data = base64Data;
          throw passwordError;
        }
        try {
          const decrypted = await decryptPdf(rawBytes, password);
          workingBytes = new Uint8Array(decrypted.plaintextBytes);
          capturedMeta = decrypted.meta;
        } catch (e: any) {
          if (e?.code === 'DECRYPT_FAILED') {
            const passwordError = new Error('PASSWORD_REQUIRED');
            (passwordError as any).reason = 'INCORRECT_PASSWORD';
            (passwordError as any).filePath = filePath;
            (passwordError as any).base64Data = base64Data;
            throw passwordError;
          }
          throw e;
        }
      }

      const dataCopyForPdfJs = new Uint8Array(workingBytes);
      const loadingTask = pdfjsLib.getDocument({
        ...PDFJS_DOCUMENT_OPTIONS,
        data: dataCopyForPdfJs,
      });

      let pdfDoc: pdfjsLib.PDFDocumentProxy;
      try {
        pdfDoc = await loadingTask.promise;
      } catch (error: any) {
        if (error?.name === 'PasswordException') {
          // Defense-in-depth: should not reach here since we already decrypted,
          // but if pdf.js reports encryption, route through the password dialog.
          const passwordError = new Error('PASSWORD_REQUIRED');
          (passwordError as any).reason = error.code === 1 ? 'NEED_PASSWORD' : 'INCORRECT_PASSWORD';
          (passwordError as any).filePath = filePath;
          (passwordError as any).base64Data = base64Data;
          throw passwordError;
        }
        throw error;
      }

      const pages = await Promise.all(
        Array.from({ length: pdfDoc.numPages }, async (_, i) => {
          const page = await pdfDoc.getPage(i + 1);
          const viewport = page.getViewport({ scale: 1 });

          // Get text content and operator list in parallel
          const [textContent, operatorList] = await Promise.all([
            page.getTextContent(),
            page.getOperatorList().catch(() => ({ fnArray: [], argsArray: [] })),
          ]);

          // Build color maps from operator list (source of truth — no canvas rendering)
          const textColorMap = buildTextColorMap(operatorList, viewport.height);
          const filledRectMap = buildFilledRectMap(operatorList, viewport.height);

          // Collect text items — split into individual words for fine-grained editing
          let itemCounter = 0;
          const textItems: PDFTextItem[] = [];

          textContent.items
            .filter((item: any) => item.str && item.str.trim())
            .forEach((item: any) => {
              const transform = item.transform;
              const baseX = transform[4];
              const fontSize = Math.sqrt(transform[0] * transform[0] + transform[1] * transform[1]);
              const rawFontName = item.fontName || 'default';
              const stdFont = mapToStandardFontName(rawFontName);
              const height = item.height || getTextHeight(stdFont, fontSize);
              const y = viewport.height - transform[5] - height;

              // Use real font metrics for width scaling
              const metricsFullWidth = measureTextWidth(item.str, stdFont, fontSize, false);
              const pdfJsWidth = item.width || metricsFullWidth;
              const scaleFactor = metricsFullWidth > 0 ? pdfJsWidth / metricsFullWidth : 1;

              // Split into words, preserving spaces
              const words = item.str.split(/( +)/);
              let currentX = baseX;

              words.forEach((word: string) => {
                if (!word) return;

                const wordMetricsWidth = measureTextWidth(word, stdFont, fontSize, false);
                const wordWidth = wordMetricsWidth * scaleFactor;

                // Only create items for non-empty words (skip pure whitespace)
                if (word.trim()) {
                  // Match colors from operator list data (not canvas rendering)
                  const matchedColor = matchTextColor(currentX, y, fontSize, textColorMap);
                  const backgroundColor = matchBackgroundColor(currentX, y, wordWidth, height, filledRectMap);
                  const bold = isBoldFontName(rawFontName);
                  const italic = isItalicFontName(rawFontName);

                  textItems.push({
                    id: `text-item-${i}-${itemCounter++}`,
                    str: word,
                    originalStr: word,
                    x: currentX,
                    y,
                    width: wordWidth,
                    height,
                    fontName: rawFontName,
                    fontSize,
                    transform: [...transform.slice(0, 4), currentX, transform[5]],
                    isEdited: false,
                    parentTransform: transform,
                    backgroundColor,
                    textColor: { r: matchedColor.r, g: matchedColor.g, b: matchedColor.b },
                    bold,
                    italic,
                    colorSpace: matchedColor.originalSpace as any,
                    originalColorValues: matchedColor.originalValues,
                  });
                }

                currentX += wordWidth;
              });
            });

          // Extract source PDF annotations (non-widget)
          const sourceAnnotations = await extractSourceAnnotations(page, i, viewport.height);

          return {
            index: i,
            width: viewport.width,
            height: viewport.height,
            rotation: page.rotate,
            annotations: [],
            textItems,
            textEdits: [],
            sourceAnnotations,
          };
        })
      );

      const fileName = filePath.split(/[\\/]/).pop() || 'Untitled';

      // Save current tab state before switching
      saveCurrentTabState();

      const newDoc: PDFDocument = {
        filePath,
        fileName,
        pageCount: pdfDoc.numPages,
        pages,
        pdfData: workingBytes,
        password: isEncrypted ? password : undefined,
        encryptionMeta: capturedMeta,
      };

      // Create new tab
      const tabId = generateTabId();
      const newTab: TabInfo = { id: tabId, fileName, filePath, modified: false };

      setDocument(newDoc);
      setModified(false);
      setHistory([]);
      setHistoryIndex(-1);
      setTabs(prev => [...prev, newTab]);
      setActiveTabId(tabId);

      // Cache the new tab state
      tabStatesRef.current.set(tabId, {
        document: newDoc,
        modified: false,
        history: [],
        historyIndex: -1,
      });

      // Build form field mappings for the new document
      try {
        const mappings = await buildFormFieldMapping(pdfDoc);
        setFormFieldMappings(mappings);
      } catch (e) {
        console.warn('Failed to build form field mappings:', e);
        setFormFieldMappings([]);
      }
    } catch (error) {
      console.error('Failed to open PDF:', error);
      throw error;
    } finally {
      setLoading(false);
      if (filePath) {
        openingFilesRef.current.delete(filePath);
      }
    }
  }, [saveCurrentTabState, switchTab]);

  // Shared post-save logic: re-extract text items from the modified PDF
  const reExtractTextAfterSave = useCallback(async (
    modifiedPdfBytes: Uint8Array,
    newFilePath?: string | null,
    newFileName?: string
  ) => {
    try {
      const dataCopyForPdfJs = new Uint8Array(modifiedPdfBytes);
      const pdfDocReload = await pdfjsLib.getDocument({ ...PDFJS_DOCUMENT_OPTIONS, data: dataCopyForPdfJs }).promise;

      const updatedPages = await Promise.all(
        (document?.pages || []).map(async (page, i) => {
          const pdfPage = await pdfDocReload.getPage(i + 1);
          const viewport = pdfPage.getViewport({ scale: 1 });

          const [textContent, operatorList] = await Promise.all([
            pdfPage.getTextContent(),
            pdfPage.getOperatorList().catch(() => ({ fnArray: [], argsArray: [] })),
          ]);

          const textColorMap = buildTextColorMap(operatorList, viewport.height);
          const filledRectMap = buildFilledRectMap(operatorList, viewport.height);

          let itemCounter = 0;
          const newTextItems: any[] = [];

          textContent.items
            .filter((item: any) => item.str && item.str.trim())
            .forEach((item: any) => {
              const transform = item.transform;
              const baseX = transform[4];
              const fontSize = Math.sqrt(transform[0] * transform[0] + transform[1] * transform[1]);
              const rawFontName = item.fontName || 'default';
              const stdFont = mapToStandardFontName(rawFontName);
              const height = item.height || getTextHeight(stdFont, fontSize);
              const y = viewport.height - transform[5] - height;

              const metricsFullWidth = measureTextWidth(item.str, stdFont, fontSize, false);
              const pdfJsWidth = item.width || metricsFullWidth;
              const scaleFactor = metricsFullWidth > 0 ? pdfJsWidth / metricsFullWidth : 1;

              const words = item.str.split(/( +)/);
              let currentX = baseX;

              words.forEach((word: string) => {
                if (!word) return;
                const wordMetricsWidth = measureTextWidth(word, stdFont, fontSize, false);
                const wordWidth = wordMetricsWidth * scaleFactor;

                if (word.trim()) {
                  const matchedColor = matchTextColor(currentX, y, fontSize, textColorMap);
                  const backgroundColor = matchBackgroundColor(currentX, y, wordWidth, height, filledRectMap);
                  const bold = isBoldFontName(rawFontName);
                  const italic = isItalicFontName(rawFontName);

                  newTextItems.push({
                    id: `text-item-${i}-${itemCounter++}`,
                    str: word,
                    originalStr: word,
                    x: currentX,
                    y,
                    width: wordWidth,
                    height,
                    fontName: rawFontName,
                    fontSize,
                    transform: [...transform.slice(0, 4), currentX, transform[5]],
                    isEdited: false,
                    backgroundColor,
                    textColor: { r: matchedColor.r, g: matchedColor.g, b: matchedColor.b },
                    bold,
                    italic,
                    colorSpace: matchedColor.originalSpace as any,
                    originalColorValues: matchedColor.originalValues,
                  });
                }

                currentX += wordWidth;
              });
            });

          return {
            ...page,
            textEdits: [],
            textItems: newTextItems,
            annotations: [], // Clear annotations written to content stream to prevent double-rendering
          };
        })
      );

      setDocument((prev) => {
        if (!prev) return null;
        return {
          ...prev,
          ...(newFilePath !== undefined ? { filePath: newFilePath } : {}),
          ...(newFileName ? { fileName: newFileName } : {}),
          pdfData: modifiedPdfBytes,
          pages: updatedPages,
        };
      });
    } catch (reloadError) {
      console.error('Error re-extracting text after save:', reloadError);
      setDocument((prev) => {
        if (!prev) return null;
        const updatedPages = prev.pages.map(page => ({
          ...page,
          textEdits: [],
          annotations: [], // Clear annotations written to content stream to prevent double-rendering
          textItems: page.textItems?.map(item => ({
            ...item,
            originalStr: item.str,
            isEdited: false,
          })),
        }));
        return {
          ...prev,
          ...(newFilePath !== undefined ? { filePath: newFilePath } : {}),
          ...(newFileName ? { fileName: newFileName } : {}),
          pdfData: modifiedPdfBytes,
          pages: updatedPages,
        };
      });
    }
  }, [document]);

  /** Apply pending encryption changes (or retain current encryption) to plaintext output bytes. */
  const applyOutputEncryption = useCallback(async (
    plaintextBytes: Uint8Array,
    doc: PDFDocument
  ): Promise<{ outputBytes: Uint8Array; newPassword?: string; newMeta?: PDFDocument['encryptionMeta'] }> => {
    const pending = doc.pendingEncryption;

    // Pending: REMOVE encryption
    if (pending && 'remove' in pending && pending.remove) {
      return { outputBytes: plaintextBytes, newPassword: undefined, newMeta: undefined };
    }

    // Pending: SET / CHANGE encryption
    if (pending && 'password' in pending) {
      const cipher = await encryptPdf(plaintextBytes, pending.password, {
        ownerPassword: pending.ownerPassword,
        permissions: pending.permissions,
      });
      const newMeta: PDFDocument['encryptionMeta'] = {
        R: 6,
        keyLength: 256,
        permissions: pending.permissions,
        hasOwnerPassword: !!pending.ownerPassword && pending.ownerPassword !== pending.password,
      };
      return { outputBytes: cipher, newPassword: pending.password, newMeta };
    }

    // No pending change — retain current encryption if doc was encrypted at open
    if (doc.password && doc.encryptionMeta) {
      const cipher = await encryptPdf(plaintextBytes, doc.password, {
        permissions: doc.encryptionMeta.permissions,
      });
      return { outputBytes: cipher, newPassword: doc.password, newMeta: doc.encryptionMeta };
    }

    return { outputBytes: plaintextBytes };
  }, []);

  const saveFile = useCallback(async () => {
    if (!document) return;

    setLoading(true);
    try {
      const editedPlaintext = await applyEditsAndAnnotations({
        pdfData: document.pdfData,
        pages: document.pages,
        annotationStorage: annotationStorageRef.current,
        formFieldMappings,
      });

      const { outputBytes, newPassword, newMeta } = await applyOutputEncryption(editedPlaintext, document);
      const base64 = uint8ArrayToBase64(outputBytes);

      const result = await window.electronAPI.saveFile(base64, document.filePath);
      if (result.success) {
        // Re-extract from the plaintext (not the encrypted output) so downstream
        // tools continue to operate on plaintext bytes in memory.
        await reExtractTextAfterSave(editedPlaintext);
        setDocument((prev) => prev ? {
          ...prev,
          password: newPassword,
          encryptionMeta: newMeta,
          pendingEncryption: undefined,
        } : null);
        setModified(false);
      } else {
        throw new Error(result.error || 'Failed to save file');
      }
    } catch (error) {
      console.error('Failed to save PDF:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [document, formFieldMappings, applyOutputEncryption]);

  const saveFileAs = useCallback(async () => {
    if (!document) return;

    setLoading(true);
    try {
      const editedPlaintext = await applyEditsAndAnnotations({
        pdfData: document.pdfData,
        pages: document.pages,
        annotationStorage: annotationStorageRef.current,
        formFieldMappings,
      });

      const { outputBytes, newPassword, newMeta } = await applyOutputEncryption(editedPlaintext, document);
      const base64 = uint8ArrayToBase64(outputBytes);

      const result = await window.electronAPI.saveFileDialog(base64, document.fileName);
      if (result.success && result.path) {
        const fileName = result.path.split(/[\\/]/).pop() || 'Untitled';
        await reExtractTextAfterSave(editedPlaintext, result.path, fileName);
        setDocument((prev) => prev ? {
          ...prev,
          password: newPassword,
          encryptionMeta: newMeta,
          pendingEncryption: undefined,
        } : null);
        setModified(false);
      }
    } catch (error) {
      console.error('Failed to save PDF:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [document, formFieldMappings, applyOutputEncryption]);

  /** Set, change, or remove the document password. Applied on next save. */
  const setPendingEncryption = useCallback((pending: PDFDocument['pendingEncryption']) => {
    setDocument((prev) => prev ? { ...prev, pendingEncryption: pending } : null);
    setModified(true);
  }, []);

  const addText = useCallback(
    (pageIndex: number, position: Position, content: string, color: string = '#000000', fontSize: number = 16): string | undefined => {
      if (!document) return undefined;

      const annotation: TextAnnotation = {
        id: `text-${Date.now()}`,
        type: 'text',
        pageIndex,
        position,
        content,
        fontSize,
        fontFamily: 'Helvetica',
        color,
      };

      const previousAnnotations = [...document.pages[pageIndex - 1].annotations];

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[pageIndex - 1] = {
          ...newPages[pageIndex - 1],
          annotations: [...newPages[pageIndex - 1].annotations, annotation],
        };
        return { ...prev, pages: newPages };
      });

      addToHistory({
        type: 'addText',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: previousAnnotations,
            };
            return { ...prev, pages: newPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: [...newPages[pageIndex - 1].annotations, annotation],
            };
            return { ...prev, pages: newPages };
          });
        },
      });

      return annotation.id;
    },
    [document, addToHistory]
  );

  const addImage = useCallback(
    (pageIndex: number, position: Position, data: string, imageType: string, size?: { width: number; height: number }) => {
      if (!document) return;

      const annotation: ImageAnnotation = {
        id: `image-${Date.now()}`,
        type: 'image',
        pageIndex,
        position,
        size: size ?? { width: 200, height: 200 },
        data,
        imageType,
      };

      const previousAnnotations = [...document.pages[pageIndex - 1].annotations];

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[pageIndex - 1] = {
          ...newPages[pageIndex - 1],
          annotations: [...newPages[pageIndex - 1].annotations, annotation],
        };
        return { ...prev, pages: newPages };
      });

      addToHistory({
        type: 'addImage',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: previousAnnotations,
            };
            return { ...prev, pages: newPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: [...newPages[pageIndex - 1].annotations, annotation],
            };
            return { ...prev, pages: newPages };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const addHighlight = useCallback(
    (pageIndex: number, rects: Array<{ x: number; y: number; width: number; height: number }>, color: string = 'rgba(255, 255, 0, 0.3)') => {
      if (!document || rects.length === 0) return;

      const annotation: HighlightAnnotation = {
        id: `highlight-${Date.now()}`,
        type: 'highlight',
        pageIndex,
        rects,
        color,
      };

      const previousAnnotations = [...document.pages[pageIndex - 1].annotations];

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[pageIndex - 1] = {
          ...newPages[pageIndex - 1],
          annotations: [...newPages[pageIndex - 1].annotations, annotation],
        };
        return { ...prev, pages: newPages };
      });

      addToHistory({
        type: 'addHighlight',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: previousAnnotations,
            };
            return { ...prev, pages: newPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: [...newPages[pageIndex - 1].annotations, annotation],
            };
            return { ...prev, pages: newPages };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const addDrawing = useCallback(
    (pageIndex: number, paths: DrawingAnnotation['paths']) => {
      if (!document || paths.length === 0) return;

      const annotation: DrawingAnnotation = {
        id: `drawing-${Date.now()}`,
        type: 'drawing',
        pageIndex,
        paths,
      };

      const previousAnnotations = [...document.pages[pageIndex - 1].annotations];

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[pageIndex - 1] = {
          ...newPages[pageIndex - 1],
          annotations: [...newPages[pageIndex - 1].annotations, annotation],
        };
        return { ...prev, pages: newPages };
      });

      addToHistory({
        type: 'addDrawing',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = { ...newPages[pageIndex - 1], annotations: previousAnnotations };
            return { ...prev, pages: newPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: [...newPages[pageIndex - 1].annotations, annotation],
            };
            return { ...prev, pages: newPages };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const addShape = useCallback(
    (pageIndex: number, shapeType: ShapeAnnotation['shapeType'], position: Position, size: Size, strokeColor: string, fillColor: string, strokeWidth: number) => {
      if (!document) return;

      const annotation: ShapeAnnotation = {
        id: `shape-${Date.now()}`,
        type: 'shape',
        pageIndex,
        shapeType,
        position,
        size,
        strokeColor,
        fillColor,
        strokeWidth,
        opacity: 1,
      };

      const previousAnnotations = [...document.pages[pageIndex - 1].annotations];

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[pageIndex - 1] = {
          ...newPages[pageIndex - 1],
          annotations: [...newPages[pageIndex - 1].annotations, annotation],
        };
        return { ...prev, pages: newPages };
      });

      addToHistory({
        type: 'addShape',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = { ...newPages[pageIndex - 1], annotations: previousAnnotations };
            return { ...prev, pages: newPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: [...newPages[pageIndex - 1].annotations, annotation],
            };
            return { ...prev, pages: newPages };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const addStickyNote = useCallback(
    (pageIndex: number, position: Position, color: string = '#FFF9C4') => {
      if (!document) return;

      const annotation: StickyNoteAnnotation = {
        id: `note-${Date.now()}`,
        type: 'note',
        pageIndex,
        position,
        content: '',
        color,
      };

      const previousAnnotations = [...document.pages[pageIndex - 1].annotations];

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[pageIndex - 1] = {
          ...newPages[pageIndex - 1],
          annotations: [...newPages[pageIndex - 1].annotations, annotation],
        };
        return { ...prev, pages: newPages };
      });

      addToHistory({
        type: 'addStickyNote',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = { ...newPages[pageIndex - 1], annotations: previousAnnotations };
            return { ...prev, pages: newPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: [...newPages[pageIndex - 1].annotations, annotation],
            };
            return { ...prev, pages: newPages };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const addStamp = useCallback(
    (pageIndex: number, position: Position, stampType: StampAnnotation['stampType'], text: string, color: string) => {
      if (!document) return;

      // Calculate stamp size based on text length
      const width = Math.max(120, text.length * 14 + 40);
      const height = 40;

      const annotation: StampAnnotation = {
        id: `stamp-${Date.now()}`,
        type: 'stamp',
        pageIndex,
        position,
        stampType,
        text,
        color,
        size: { width, height },
      };

      const previousAnnotations = [...document.pages[pageIndex - 1].annotations];

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[pageIndex - 1] = {
          ...newPages[pageIndex - 1],
          annotations: [...newPages[pageIndex - 1].annotations, annotation],
        };
        return { ...prev, pages: newPages };
      });

      addToHistory({
        type: 'addStamp',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = { ...newPages[pageIndex - 1], annotations: previousAnnotations };
            return { ...prev, pages: newPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: [...newPages[pageIndex - 1].annotations, annotation],
            };
            return { ...prev, pages: newPages };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const updateAnnotation = useCallback(
    (pageIndex: number, annotationId: string, updates: Partial<Annotation>) => {
      if (!document) return;

      const page = document.pages[pageIndex - 1];
      const annotationIndex = page.annotations.findIndex((a) => a.id === annotationId);
      if (annotationIndex === -1) return;

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        const newAnnotations = [...newPages[pageIndex - 1].annotations];
        newAnnotations[annotationIndex] = {
          ...newAnnotations[annotationIndex],
          ...updates,
        } as Annotation;
        newPages[pageIndex - 1] = {
          ...newPages[pageIndex - 1],
          annotations: newAnnotations,
        };
        return { ...prev, pages: newPages };
      });

      setModified(true);
    },
    [document]
  );

  const updateTextItem = useCallback(
    (pageIndex: number, textItemId: string, newText: string) => {
      if (!document) return;

      const page = document.pages[pageIndex - 1];
      const textItem = page.textItems?.find((t) => t.id === textItemId);
      if (!textItem) return;

      const previousEdits = page.textEdits ? [...page.textEdits] : [];
      const existingEditIndex = previousEdits.findIndex((e) => e.itemId === textItemId);

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        const newTextItems = newPages[pageIndex - 1].textItems?.map((t) =>
          t.id === textItemId ? { ...t, str: newText, isEdited: true } : t
        );

        let newTextEdits = [...(newPages[pageIndex - 1].textEdits || [])];
        if (existingEditIndex >= 0) {
          newTextEdits[existingEditIndex] = {
            ...newTextEdits[existingEditIndex],
            newText,
          };
        } else {
          newTextEdits.push({
            itemId: textItemId,
            pageIndex: pageIndex - 1,
            originalText: textItem.originalStr,
            newText,
          });
        }

        newPages[pageIndex - 1] = {
          ...newPages[pageIndex - 1],
          textItems: newTextItems,
          textEdits: newTextEdits,
        };
        return { ...prev, pages: newPages };
      });

      addToHistory({
        type: 'editText',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            const newTextItems = newPages[pageIndex - 1].textItems?.map((t) =>
              t.id === textItemId ? { ...t, str: textItem.str, isEdited: textItem.isEdited } : t
            );
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              textItems: newTextItems,
              textEdits: previousEdits,
            };
            return { ...prev, pages: newPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            const newTextItems = newPages[pageIndex - 1].textItems?.map((t) =>
              t.id === textItemId ? { ...t, str: newText, isEdited: true } : t
            );

            let newTextEdits = [...(newPages[pageIndex - 1].textEdits || [])];
            const editIdx = newTextEdits.findIndex((e) => e.itemId === textItemId);
            if (editIdx >= 0) {
              newTextEdits[editIdx] = { ...newTextEdits[editIdx], newText };
            } else {
              newTextEdits.push({
                itemId: textItemId,
                pageIndex: pageIndex - 1,
                originalText: textItem.originalStr,
                newText,
              });
            }

            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              textItems: newTextItems,
              textEdits: newTextEdits,
            };
            return { ...prev, pages: newPages };
          });
        },
      });
    },
    [document, addToHistory]
  );

const markTextDeleted = useCallback(    (pageIndex: number, textItemId: string, isDeleted: boolean) => {      if (!document) return;      const page = document.pages[pageIndex - 1];      const textItem = page.textItems?.find((t) => t.id === textItemId);      if (!textItem) return;      const wasDeleted = textItem.isDeleted || false;      setDocument((prev) => {        if (!prev) return null;        const newPages = [...prev.pages];        const newTextItems = newPages[pageIndex - 1].textItems?.map((t) =>          t.id === textItemId ? { ...t, isDeleted, isEdited: true } : t        );        newPages[pageIndex - 1] = {          ...newPages[pageIndex - 1],          textItems: newTextItems,        };        return { ...prev, pages: newPages };      });      addToHistory({        type: 'markTextDeleted',        undo: () => {          setDocument((prev) => {            if (!prev) return null;            const newPages = [...prev.pages];            const newTextItems = newPages[pageIndex - 1].textItems?.map((t) =>              t.id === textItemId ? { ...t, isDeleted: wasDeleted, isEdited: textItem.isEdited } : t            );            newPages[pageIndex - 1] = {              ...newPages[pageIndex - 1],              textItems: newTextItems,            };            return { ...prev, pages: newPages };          });        },        redo: () => {          setDocument((prev) => {            if (!prev) return null;            const newPages = [...prev.pages];            const newTextItems = newPages[pageIndex - 1].textItems?.map((t) =>              t.id === textItemId ? { ...t, isDeleted, isEdited: true } : t            );            newPages[pageIndex - 1] = {              ...newPages[pageIndex - 1],              textItems: newTextItems,            };            return { ...prev, pages: newPages };          });        },      });    },    [document, addToHistory]  );
  const deleteAnnotation = useCallback(
    (pageIndex: number, annotationId: string) => {
      if (!document) return;

      const page = document.pages[pageIndex - 1];
      const annotation = page.annotations.find((a) => a.id === annotationId);
      if (!annotation) return;

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[pageIndex - 1] = {
          ...newPages[pageIndex - 1],
          annotations: newPages[pageIndex - 1].annotations.filter(
            (a) => a.id !== annotationId
          ),
        };
        return { ...prev, pages: newPages };
      });

      addToHistory({
        type: 'deleteAnnotation',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: [...newPages[pageIndex - 1].annotations, annotation],
            };
            return { ...prev, pages: newPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              annotations: newPages[pageIndex - 1].annotations.filter(
                (a) => a.id !== annotationId
              ),
            };
            return { ...prev, pages: newPages };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const deletePage = useCallback(
    (pageIndex: number) => {
      if (!document || document.pageCount <= 1) return;

      const deletedPage = document.pages[pageIndex - 1];

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = prev.pages
          .filter((_, i) => i !== pageIndex - 1)
          .map((p, i) => ({ ...p, index: i }));
        return {
          ...prev,
          pageCount: prev.pageCount - 1,
          pages: newPages,
        };
      });

      addToHistory({
        type: 'deletePage',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages.splice(pageIndex - 1, 0, deletedPage);
            return {
              ...prev,
              pageCount: prev.pageCount + 1,
              pages: newPages.map((p, i) => ({ ...p, index: i })),
            };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = prev.pages
              .filter((_, i) => i !== pageIndex - 1)
              .map((p, i) => ({ ...p, index: i }));
            return {
              ...prev,
              pageCount: prev.pageCount - 1,
              pages: newPages,
            };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const rotatePage = useCallback(
    (pageIndex: number, angle: number) => {
      if (!document) return;

      const previousRotation = document.pages[pageIndex - 1].rotation;

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[pageIndex - 1] = {
          ...newPages[pageIndex - 1],
          rotation: (newPages[pageIndex - 1].rotation + angle) % 360,
        };
        return { ...prev, pages: newPages };
      });

      addToHistory({
        type: 'rotatePage',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              rotation: previousRotation,
            };
            return { ...prev, pages: newPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...prev.pages];
            newPages[pageIndex - 1] = {
              ...newPages[pageIndex - 1],
              rotation: (previousRotation + angle) % 360,
            };
            return { ...prev, pages: newPages };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const insertBlankPage = useCallback(
    (afterPageIndex: number) => {
      if (!document) return;

      // Use first page dimensions as template, or default A4
      const templatePage = document.pages[afterPageIndex - 1] || document.pages[0];
      const width = templatePage?.width || 595;
      const height = templatePage?.height || 842;

      const newPage = {
        index: afterPageIndex,
        width,
        height,
        rotation: 0,
        annotations: [],
        textItems: [],
        textEdits: [],
      };

      const previousPages = [...document.pages];

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages.splice(afterPageIndex, 0, newPage);
        const reindexed = newPages.map((p, i) => ({ ...p, index: i }));
        return { ...prev, pageCount: prev.pageCount + 1, pages: reindexed };
      });

      addToHistory({
        type: 'insertBlankPage',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            return { ...prev, pageCount: prev.pageCount - 1, pages: previousPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...previousPages];
            newPages.splice(afterPageIndex, 0, newPage);
            const reindexed = newPages.map((p, i) => ({ ...p, index: i }));
            return { ...prev, pageCount: prev.pageCount + 1, pages: reindexed };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const replacePage = useCallback(
    async (pageIndex: number, newPdfData: Uint8Array) => {
      if (!document) return;

      const { PDFDocument: PDFLib } = await import('pdf-lib');

      // Load both the current document and the replacement
      const currentDoc = await PDFLib.load(document.pdfData, { ignoreEncryption: true });
      const replacementDoc = await PDFLib.load(newPdfData, { ignoreEncryption: true });

      if (replacementDoc.getPageCount() === 0) return;

      // Get original page dimensions before removing it
      const zeroIndex = pageIndex - 1; // pageIndex is 1-based
      const originalPage = currentDoc.getPage(zeroIndex);
      const originalSize = originalPage.getSize();

      // Copy the first page from the replacement into the current document
      const [copiedPage] = await currentDoc.copyPages(replacementDoc, [0]);

      // Scale the replacement page to match the original page dimensions.
      // Scanners often produce pages at different DPI/size than the original.
      const replacementSize = copiedPage.getSize();
      const scaleX = originalSize.width / replacementSize.width;
      const scaleY = originalSize.height / replacementSize.height;

      if (Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) {
        // Resize the page mediabox to match the original
        copiedPage.setSize(originalSize.width, originalSize.height);

        // Scale the page content to fit the new dimensions.
        // Prepend a scale transform to the page's content stream.
        copiedPage.scaleContent(scaleX, scaleY);
      }

      // Remove the old page and insert the scaled replacement
      currentDoc.removePage(zeroIndex);
      currentDoc.insertPage(zeroIndex, copiedPage);

      // Save the modified PDF
      const updatedPdfBytes = await currentDoc.save();
      const updatedPdfData = new Uint8Array(updatedPdfBytes);

      // Use original dimensions for the app's page model
      const width = originalSize.width;
      const height = originalSize.height;

      const previousPages = [...document.pages];
      const previousPdfData = document.pdfData;

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        newPages[zeroIndex] = {
          ...newPages[zeroIndex],
          width,
          height,
          rotation: 0,
          annotations: [],
          textItems: [],
          textEdits: [],
          sourceAnnotations: [],
        };
        const reindexed = newPages.map((p, i) => ({ ...p, index: i }));
        return { ...prev, pages: reindexed, pdfData: updatedPdfData };
      });

      setModified(true);

      addToHistory({
        type: 'replacePage',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            return { ...prev, pages: previousPages, pdfData: previousPdfData };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...previousPages];
            newPages[zeroIndex] = {
              ...newPages[zeroIndex],
              width,
              height,
              rotation: 0,
              annotations: [],
              textItems: [],
              textEdits: [],
              sourceAnnotations: [],
            };
            const reindexed = newPages.map((p, i) => ({ ...p, index: i }));
            return { ...prev, pages: reindexed, pdfData: updatedPdfData };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const reorderPages = useCallback(
    (fromIndex: number, toIndex: number) => {
      if (!document) return;
      if (fromIndex === toIndex) return;

      const previousPages = [...document.pages];

      setDocument((prev) => {
        if (!prev) return null;
        const newPages = [...prev.pages];
        const [movedPage] = newPages.splice(fromIndex, 1);
        newPages.splice(toIndex, 0, movedPage);
        // Re-index pages
        const reindexed = newPages.map((p, i) => ({ ...p, index: i }));
        return { ...prev, pages: reindexed };
      });

      addToHistory({
        type: 'reorderPages',
        undo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            return { ...prev, pages: previousPages };
          });
        },
        redo: () => {
          setDocument((prev) => {
            if (!prev) return null;
            const newPages = [...previousPages];
            const [movedPage] = newPages.splice(fromIndex, 1);
            newPages.splice(toIndex, 0, movedPage);
            const reindexed = newPages.map((p, i) => ({ ...p, index: i }));
            return { ...prev, pages: reindexed };
          });
        },
      });
    },
    [document, addToHistory]
  );

  const undo = useCallback(() => {
    if (!canUndo) return;
    history[historyIndex].undo();
    setHistoryIndex((prev) => prev - 1);
  }, [canUndo, history, historyIndex]);

  const redo = useCallback(() => {
    if (!canRedo) return;
    history[historyIndex + 1].redo();
    setHistoryIndex((prev) => prev + 1);
  }, [canRedo, history, historyIndex]);

  return {
    document,
    loading,
    modified,
    openFile,
    saveFile,
    saveFileAs,
    addText,
    addImage,
    addHighlight,
    addDrawing,
    addShape,
    addStickyNote,
    addStamp,
    insertBlankPage,
    replacePage,
    deletePage,
    reorderPages,
    rotatePage,
    undo,
    redo,
    canUndo,
    canRedo,
    updateAnnotation,
    deleteAnnotation,
    updateTextItem,
    markTextDeleted,
    // Tab management
    tabs,
    activeTabId,
    switchTab,
    closeTab,
    // Form field support
    formFieldMappings,
    setAnnotationStorage,
    // Encryption
    setPendingEncryption,
  };
}

