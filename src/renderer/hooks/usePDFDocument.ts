import { useState, useCallback, useRef, useEffect } from 'react';
import { PDFDocument as PDFLib, rgb, StandardFonts, PDFFont } from 'pdf-lib';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, Annotation, Position, Size, TextAnnotation, ImageAnnotation, HighlightAnnotation, DrawingAnnotation, ShapeAnnotation, StickyNoteAnnotation, StampAnnotation, PDFTextItem, TabInfo } from '../types';

import { replaceTextInPage } from '../utils/pdfTextReplacer';
import { blankTextInContentStream } from '../utils/blankText';
import { saveFormFieldValues, buildFormFieldMapping, FormFieldMapping } from '../utils/formFieldSaver';
import { buildTextColorMap, matchTextColor } from '../utils/textColorExtractor';
import { extractSourceAnnotations } from '../utils/annotationExtractor';

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


// Map common PDF font names to pdf-lib StandardFonts
function mapToStandardFont(fontName: string): typeof StandardFonts[keyof typeof StandardFonts] {
  const name = fontName.toLowerCase();

  // Helvetica variants
  if (name.includes('helvetica') || name.includes('arial') || name.includes('sans')) {
    if (name.includes('bold') && name.includes('oblique')) return StandardFonts.HelveticaBoldOblique;
    if (name.includes('bold')) return StandardFonts.HelveticaBold;
    if (name.includes('oblique') || name.includes('italic')) return StandardFonts.HelveticaOblique;
    return StandardFonts.Helvetica;
  }

  // Times variants
  if (name.includes('times') || name.includes('serif')) {
    if (name.includes('bold') && name.includes('italic')) return StandardFonts.TimesRomanBoldItalic;
    if (name.includes('bold')) return StandardFonts.TimesRomanBold;
    if (name.includes('italic')) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }

  // Courier variants
  if (name.includes('courier') || name.includes('mono')) {
    if (name.includes('bold') && name.includes('oblique')) return StandardFonts.CourierBoldOblique;
    if (name.includes('bold')) return StandardFonts.CourierBold;
    if (name.includes('oblique') || name.includes('italic')) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }

  // Default to Helvetica
  return StandardFonts.Helvetica;
}



// Sample background color from rendered canvas at a specific position
async function sampleBackgroundColor(
  pdfDoc: pdfjsLib.PDFDocumentProxy,
  pageNum: number,
  x: number,
  y: number,
  width: number,
  height: number,
  pageHeight: number
): Promise<{ r: number; g: number; b: number }> {
  try {
    const page = await pdfDoc.getPage(pageNum);
    const scale = 1;
    const viewport = page.getViewport({ scale });

    // Create an offscreen canvas
    const canvas = new OffscreenCanvas(viewport.width, viewport.height);
    const context = canvas.getContext('2d');
    if (!context) return { r: 1, g: 1, b: 1 }; // Default white

    // Render the page
    await page.render({
      canvasContext: context as any,
      viewport,
    }).promise;

    // Sample from the center of where the text will be
    // Convert PDF coordinates to canvas coordinates
    const sampleX = Math.floor(x + width / 2);
    const sampleY = Math.floor(y + height / 2);

    // Get pixel data at the sample point
    const imageData = context.getImageData(sampleX, sampleY, 1, 1);
    const [r, g, b] = imageData.data;

    return { r: r / 255, g: g / 255, b: b / 255 };
  } catch (error) {
    console.error('Failed to sample background color:', error);
    return { r: 1, g: 1, b: 1 }; // Default white on error
  }
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

    // Remove from cache
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
      const binaryData = Uint8Array.from(atob(base64Data), (c) => c.charCodeAt(0));
      const dataCopyForPdfJs = new Uint8Array(binaryData);
      const loadingTask = pdfjsLib.getDocument({
        data: dataCopyForPdfJs,
        password: password || undefined,
      });

      let pdfDoc: pdfjsLib.PDFDocumentProxy;
      try {
        pdfDoc = await loadingTask.promise;
      } catch (error: any) {
        if (error?.name === 'PasswordException') {
          // Re-throw with a special marker so the caller can show a password dialog
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

          // Build text color map from operator list
          const textColorMap = buildTextColorMap(operatorList, viewport.height);

          // First pass: collect basic text item data
          // Split text items into individual words for finer-grained erasing
          let itemCounter = 0;
          const basicTextItems: any[] = [];

          textContent.items
            .filter((item: any) => item.str && item.str.trim())
            .forEach((item: any) => {
              const transform = item.transform;
              const baseX = transform[4];
              const fontSize = Math.sqrt(transform[0] * transform[0] + transform[1] * transform[1]);
              const height = item.height || fontSize * 1.2;
              const y = viewport.height - transform[5] - height;
              const avgCharWidth = (item.width || (item.str.length * fontSize * 0.5)) / item.str.length;
              const rawFontName = item.fontName || 'default';

              // Split into words, preserving spaces
              const words = item.str.split(/( +)/);
              let currentX = baseX;

              words.forEach((word: string) => {
                if (!word) return;

                const wordWidth = word.length * avgCharWidth;

                // Only create items for non-empty words (skip pure whitespace)
                if (word.trim()) {
                  basicTextItems.push({
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
                  });
                }

                currentX += wordWidth;
              });
            });

          // Second pass: sample background colors and match text colors
          // Render page once for background sampling
          const canvas = new OffscreenCanvas(viewport.width, viewport.height);
          const context = canvas.getContext('2d');
          if (context) {
            await page.render({
              canvasContext: context as any,
              viewport,
            }).promise;
          }

          const textItems: PDFTextItem[] = basicTextItems.map((item) => {
            let backgroundColor = { r: 1, g: 1, b: 1 }; // Default white

            if (context) {
              const sampleX = Math.max(0, Math.floor(item.x - 2));
              const sampleY = Math.max(0, Math.floor(item.y + item.height / 2));

              try {
                const imageData = context.getImageData(sampleX, sampleY, 1, 1);
                const [r, g, b] = imageData.data;
                backgroundColor = { r: r / 255, g: g / 255, b: b / 255 };
              } catch (e) {
                // Keep default white
              }
            }

            // Match text color from operator list color map
            const textColor = matchTextColor(item.x, item.y, item.fontSize, textColorMap);

            // Detect bold/italic from font name
            const bold = isBoldFontName(item.fontName);
            const italic = isItalicFontName(item.fontName);

            return {
              ...item,
              backgroundColor,
              textColor,
              bold,
              italic,
            };
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
        pdfData: binaryData,
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

  const saveFile = useCallback(async () => {
    if (!document) return;

    setLoading(true);
    try {
      const pdfDoc = await PDFLib.load(document.pdfData);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

      for (const page of document.pages) {
        const pdfPage = pdfDoc.getPage(page.index);
        const { height } = pdfPage.getSize();

        // Handle text edits - try content stream modification first, then overlay fallback
        console.log('Processing page', page.index, 'textEdits:', page.textEdits?.length || 0);
        // Handle deleted text items - blank them in the content stream, with overlay fallback
        const deletedItems = page.textItems?.filter(t => t.isDeleted) || [];
        for (const deletedItem of deletedItems) {
          console.log('[SAVE] Blanking deleted text item:', deletedItem.originalStr);
          const blanked = await blankTextInContentStream(pdfDoc, page.index, deletedItem.originalStr);

          // Always draw a background-colored rectangle to cover the text as fallback
          // This ensures deletion works even if content stream modification fails
          const textHeight = deletedItem.fontSize;
          const baselineY = deletedItem.transform ? deletedItem.transform[5] : (height - deletedItem.y - textHeight);
          const bgColor = deletedItem.backgroundColor || { r: 1, g: 1, b: 1 };

          console.log('[SAVE] Drawing cover rectangle for deleted text:', deletedItem.originalStr, 'blanked:', blanked);
          pdfPage.drawRectangle({
            x: deletedItem.x - 1,
            y: baselineY - (textHeight * 0.25),
            width: deletedItem.width + 2,
            height: textHeight * 1.3,
            color: rgb(bgColor.r, bgColor.g, bgColor.b),
          });
        }

        if (page.textEdits && page.textEdits.length > 0) {
          const fontCache = new Map<string, PDFFont>();

          for (const edit of page.textEdits) {
            const textItem = page.textItems?.find(t => t.id === edit.itemId);
            if (textItem) {
              // First, try to modify the content stream directly
              console.log('[SAVE] Attempting content stream modification for:', edit.originalText, '->', edit.newText, 'pageIndex:', page.index);
              const contentStreamModified = await replaceTextInPage(
                pdfDoc,
                page.index,
                edit.originalText,
                edit.newText
              );

              if (contentStreamModified) {
                console.log('Content stream modification successful for:', edit.newText);
              } else {
                // Fall back to overlay approach if content stream modification fails
                console.log('Content stream modification failed, using overlay for:', edit.newText);
                // Try to blank the original text in content stream so PDF.js doesn't re-extract it
                await blankTextInContentStream(pdfDoc, page.index, edit.originalText);
                const standardFontName = mapToStandardFont(textItem.fontName);
                let itemFont = fontCache.get(standardFontName);
                if (!itemFont) {
                  itemFont = await pdfDoc.embedFont(standardFontName);
                  fontCache.set(standardFontName, itemFont);
                }

                const textHeight = textItem.fontSize;
                const baselineY = textItem.transform ? textItem.transform[5] : (height - textItem.y - textHeight);

                // Use detected background color or default to white
                const bgColor = textItem.backgroundColor || { r: 1, g: 1, b: 1 };
                pdfPage.drawRectangle({
                  x: textItem.x - 1,
                  y: baselineY - (textHeight * 0.25),
                  width: textItem.width + 2,
                  height: textHeight * 1.3,
                  color: rgb(bgColor.r, bgColor.g, bgColor.b),
                });

                // Use detected text color or default to black
                const txtColor = textItem.textColor || { r: 0, g: 0, b: 0 };
                console.log('Drawing edited text (overlay):', edit.newText, 'at', textItem.x, baselineY);
                pdfPage.drawText(edit.newText, {
                  x: textItem.x,
                  y: baselineY,
                  size: textItem.fontSize,
                  font: itemFont,
                  color: rgb(txtColor.r, txtColor.g, txtColor.b),
                });
              }
            }
          }
        }

        for (const annotation of page.annotations) {
          if (annotation.type === 'text') {
            const textAnnotation = annotation as TextAnnotation;
            pdfPage.drawText(textAnnotation.content, {
              x: textAnnotation.position.x,
              y: height - textAnnotation.position.y - textAnnotation.fontSize,
              size: textAnnotation.fontSize,
              font,
              color: hexToRgb(textAnnotation.color),
            });
          } else if (annotation.type === 'image') {
            const imgAnnotation = annotation as ImageAnnotation;
            let image;
            if (imgAnnotation.imageType === 'png') {
              image = await pdfDoc.embedPng(
                Uint8Array.from(atob(imgAnnotation.data), (c) => c.charCodeAt(0))
              );
            } else {
              image = await pdfDoc.embedJpg(
                Uint8Array.from(atob(imgAnnotation.data), (c) => c.charCodeAt(0))
              );
            }
            pdfPage.drawImage(image, {
              x: imgAnnotation.position.x,
              y: height - imgAnnotation.position.y - imgAnnotation.size.height,
              width: imgAnnotation.size.width,
              height: imgAnnotation.size.height,
            });
          }
        }
      }

      // Save form field values from AnnotationStorage into pdf-lib form fields
      if (annotationStorageRef.current && formFieldMappings.length > 0) {
        try {
          await saveFormFieldValues(pdfDoc, annotationStorageRef.current, formFieldMappings);
        } catch (e) {
          console.warn('Failed to save form field values:', e);
        }
      }

      const modifiedPdfBytes = await pdfDoc.save();
      const base64 = uint8ArrayToBase64(modifiedPdfBytes);

      // Save directly to the existing file path
      const result = await window.electronAPI.saveFile(base64, document.filePath);
      if (result.success) {
        // After successful save, re-extract text from the modified PDF to get accurate text items
        try {
          const dataCopyForPdfJs = new Uint8Array(modifiedPdfBytes);
          const pdfDocReload = await pdfjsLib.getDocument({ data: dataCopyForPdfJs }).promise;
          
          const updatedPages = await Promise.all(
            document.pages.map(async (page, i) => {
              const pdfPage = await pdfDocReload.getPage(i + 1);
              const viewport = pdfPage.getViewport({ scale: 1 });
              const textContent = await pdfPage.getTextContent();
              
                            // Re-extract text items from the saved PDF, split into words
              let itemCounter = 0;
              const newTextItems: any[] = [];

              textContent.items
                .filter((item: any) => item.str && item.str.trim())
                .forEach((item: any) => {
                  const transform = item.transform;
                  const baseX = transform[4];
                  const fontSize = Math.sqrt(transform[0] * transform[0] + transform[1] * transform[1]);
                  const height = item.height || fontSize * 1.2;
                  const y = viewport.height - transform[5] - height;
                  const avgCharWidth = (item.width || (item.str.length * fontSize * 0.5)) / item.str.length;

                  const words = item.str.split(/( +)/);
                  let currentX = baseX;

                  words.forEach((word: string) => {
                    if (!word) return;
                    const wordWidth = word.length * avgCharWidth;

                    if (word.trim()) {
                      newTextItems.push({
                        id: `text-item-${i}-${itemCounter++}`,
                        str: word,
                        originalStr: word,
                        x: currentX,
                        y,
                        width: wordWidth,
                        height,
                        fontName: item.fontName || 'default',
                        fontSize,
                        transform: [...transform.slice(0, 4), currentX, transform[5]],
                        isEdited: false,
                        backgroundColor: { r: 1, g: 1, b: 1 },
                        textColor: { r: 0, g: 0, b: 0 },
                      });
                    }

                    currentX += wordWidth;
                  });
                });
              
              return {
                ...page,
                textEdits: [],
                textItems: newTextItems,
              };
            })
          );
          
          setDocument((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              pdfData: modifiedPdfBytes,
              pages: updatedPages,
            };
          });
        } catch (reloadError) {
          console.error('Error re-extracting text after save:', reloadError);
          // Fallback: just update pdfData and clear edits
          setDocument((prev) => {
            if (!prev) return null;
            const updatedPages = prev.pages.map(page => ({
              ...page,
              textEdits: [],
              textItems: page.textItems?.map(item => ({
                ...item,
                originalStr: item.str,
                isEdited: false,
              })),
            }));
            return {
              ...prev,
              pdfData: modifiedPdfBytes,
              pages: updatedPages,
            };
          });
        }
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
  }, [document, formFieldMappings]);

  const saveFileAs = useCallback(async () => {
    if (!document) return;

    setLoading(true);
    try {
      const pdfDoc = await PDFLib.load(document.pdfData);
      const font = await pdfDoc.embedFont(StandardFonts.Helvetica);

      for (const page of document.pages) {
        const pdfPage = pdfDoc.getPage(page.index);
        const { height } = pdfPage.getSize();

        // Handle text edits - try content stream modification first, then overlay fallback
        // Handle deleted text items - blank them in the content stream, with overlay fallback
        const deletedItems = page.textItems?.filter(t => t.isDeleted) || [];
        for (const deletedItem of deletedItems) {
          console.log('[SAVE] Blanking deleted text item:', deletedItem.originalStr);
          const blanked = await blankTextInContentStream(pdfDoc, page.index, deletedItem.originalStr);

          // Always draw a background-colored rectangle to cover the text as fallback
          // This ensures deletion works even if content stream modification fails
          const textHeight = deletedItem.fontSize;
          const baselineY = deletedItem.transform ? deletedItem.transform[5] : (height - deletedItem.y - textHeight);
          const bgColor = deletedItem.backgroundColor || { r: 1, g: 1, b: 1 };

          console.log('[SAVE] Drawing cover rectangle for deleted text:', deletedItem.originalStr, 'blanked:', blanked);
          pdfPage.drawRectangle({
            x: deletedItem.x - 1,
            y: baselineY - (textHeight * 0.25),
            width: deletedItem.width + 2,
            height: textHeight * 1.3,
            color: rgb(bgColor.r, bgColor.g, bgColor.b),
          });
        }

        if (page.textEdits && page.textEdits.length > 0) {
          const fontCache = new Map<string, PDFFont>();

          for (const edit of page.textEdits) {
            const textItem = page.textItems?.find(t => t.id === edit.itemId);
            if (textItem) {
              // First, try to modify the content stream directly
              console.log('[SAVE] Attempting content stream modification for:', edit.originalText, '->', edit.newText, 'pageIndex:', page.index);
              const contentStreamModified = await replaceTextInPage(
                pdfDoc,
                page.index,
                edit.originalText,
                edit.newText
              );

              if (contentStreamModified) {
                console.log('Content stream modification successful for:', edit.newText);
              } else {
                // Fall back to overlay approach if content stream modification fails
                console.log('Content stream modification failed, using overlay for:', edit.newText);
                // Try to blank the original text in content stream so PDF.js doesn't re-extract it
                await blankTextInContentStream(pdfDoc, page.index, edit.originalText);
                const standardFontName = mapToStandardFont(textItem.fontName);
                let itemFont = fontCache.get(standardFontName);
                if (!itemFont) {
                  itemFont = await pdfDoc.embedFont(standardFontName);
                  fontCache.set(standardFontName, itemFont);
                }

                const textHeight = textItem.fontSize;
                const baselineY = textItem.transform ? textItem.transform[5] : (height - textItem.y - textHeight);

                // Use detected background color or default to white
                const bgColor = textItem.backgroundColor || { r: 1, g: 1, b: 1 };
                pdfPage.drawRectangle({
                  x: textItem.x - 1,
                  y: baselineY - (textHeight * 0.25),
                  width: textItem.width + 2,
                  height: textHeight * 1.3,
                  color: rgb(bgColor.r, bgColor.g, bgColor.b),
                });

                // Use detected text color or default to black
                const txtColor = textItem.textColor || { r: 0, g: 0, b: 0 };
                console.log('Drawing edited text (overlay):', edit.newText, 'at', textItem.x, baselineY);
                pdfPage.drawText(edit.newText, {
                  x: textItem.x,
                  y: baselineY,
                  size: textItem.fontSize,
                  font: itemFont,
                  color: rgb(txtColor.r, txtColor.g, txtColor.b),
                });
              }
            }
          }
        }

        for (const annotation of page.annotations) {
          if (annotation.type === 'text') {
            const textAnnotation = annotation as TextAnnotation;
            pdfPage.drawText(textAnnotation.content, {
              x: textAnnotation.position.x,
              y: height - textAnnotation.position.y - textAnnotation.fontSize,
              size: textAnnotation.fontSize,
              font,
              color: hexToRgb(textAnnotation.color),
            });
          } else if (annotation.type === 'image') {
            const imgAnnotation = annotation as ImageAnnotation;
            let image;
            if (imgAnnotation.imageType === 'png') {
              image = await pdfDoc.embedPng(
                Uint8Array.from(atob(imgAnnotation.data), (c) => c.charCodeAt(0))
              );
            } else {
              image = await pdfDoc.embedJpg(
                Uint8Array.from(atob(imgAnnotation.data), (c) => c.charCodeAt(0))
              );
            }
            pdfPage.drawImage(image, {
              x: imgAnnotation.position.x,
              y: height - imgAnnotation.position.y - imgAnnotation.size.height,
              width: imgAnnotation.size.width,
              height: imgAnnotation.size.height,
            });
          }
        }
      }

      // Save form field values from AnnotationStorage into pdf-lib form fields
      if (annotationStorageRef.current && formFieldMappings.length > 0) {
        try {
          await saveFormFieldValues(pdfDoc, annotationStorageRef.current, formFieldMappings);
        } catch (e) {
          console.warn('Failed to save form field values:', e);
        }
      }

      const modifiedPdfBytes = await pdfDoc.save();
      const base64 = uint8ArrayToBase64(modifiedPdfBytes);

      // Show Save As dialog
      const result = await window.electronAPI.saveFileDialog(base64, document.fileName);
      if (result.success && result.path) {
        const fileName = result.path.split(/[\\/]/).pop() || 'Untitled';
        // After successful save, re-extract text from the modified PDF to get accurate text items
        try {
          const dataCopyForPdfJs = new Uint8Array(modifiedPdfBytes);
          const pdfDocReload = await pdfjsLib.getDocument({ data: dataCopyForPdfJs }).promise;

          const updatedPages = await Promise.all(
            document.pages.map(async (page, i) => {
              const pdfPage = await pdfDocReload.getPage(i + 1);
              const viewport = pdfPage.getViewport({ scale: 1 });
              const textContent = await pdfPage.getTextContent();

              // Re-extract text items from the saved PDF
              // Split into words for finer-grained control
              let itemCounter = 0;
              const newTextItems: any[] = [];

              textContent.items
                .filter((item: any) => item.str && item.str.trim())
                .forEach((item: any) => {
                  const transform = item.transform;
                  const baseX = transform[4];
                  const fontSize = Math.sqrt(transform[0] * transform[0] + transform[1] * transform[1]);
                  const height = item.height || fontSize * 1.2;
                  const y = viewport.height - transform[5] - height;
                  const avgCharWidth = (item.width || (item.str.length * fontSize * 0.5)) / item.str.length;

                  const words = item.str.split(/( +)/);
                  let currentX = baseX;

                  words.forEach((word: string) => {
                    if (!word) return;
                    const wordWidth = word.length * avgCharWidth;

                    if (word.trim()) {
                      newTextItems.push({
                        id: `text-item-${i}-${itemCounter++}`,
                        str: word,
                        originalStr: word,
                        x: currentX,
                        y,
                        width: wordWidth,
                        height,
                        fontName: item.fontName || 'default',
                        fontSize,
                        transform: [...transform.slice(0, 4), currentX, transform[5]],
                        isEdited: false,
                        backgroundColor: { r: 1, g: 1, b: 1 },
                        textColor: { r: 0, g: 0, b: 0 },
                      });
                    }

                    currentX += wordWidth;
                  });
                });

              return {
                ...page,
                textEdits: [],
                textItems: newTextItems,
              };
            })
          );

          setDocument((prev) => {
            if (!prev) return null;
            return {
              ...prev,
              filePath: result.path,
              fileName,
              pdfData: modifiedPdfBytes,
              pages: updatedPages,
            };
          });
        } catch (reloadError) {
          console.error('Error re-extracting text after save:', reloadError);
          // Fallback: just update pdfData and clear edits
          setDocument((prev) => {
            if (!prev) return null;
            const updatedPages = prev.pages.map(page => ({
              ...page,
              textEdits: [],
              textItems: page.textItems?.map(item => ({
                ...item,
                originalStr: item.str,
                isEdited: false,
              })),
            }));
            return {
              ...prev,
              filePath: result.path,
              fileName,
              pdfData: modifiedPdfBytes,
              pages: updatedPages,
            };
          });
        }
        setModified(false);
      }
    } catch (error) {
      console.error('Failed to save PDF:', error);
      throw error;
    } finally {
      setLoading(false);
    }
  }, [document, formFieldMappings]);

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
    (pageIndex: number, position: Position, data: string, imageType: string) => {
      if (!document) return;

      const annotation: ImageAnnotation = {
        id: `image-${Date.now()}`,
        type: 'image',
        pageIndex,
        position,
        size: { width: 200, height: 200 },
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
  };
}

function hexToRgb(hex: string) {
  const result = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (result) {
    return rgb(
      parseInt(result[1], 16) / 255,
      parseInt(result[2], 16) / 255,
      parseInt(result[3], 16) / 255
    );
  }
  return rgb(0, 0, 0);
}
