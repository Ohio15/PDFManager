import React, { useState, useCallback, useEffect } from 'react';
import { PDFDocument as PDFLib } from 'pdf-lib';
import Toolbar from './components/Toolbar';
import Sidebar from './components/Sidebar';
import PDFViewer from './components/PDFViewer';
import WelcomeScreen from './components/WelcomeScreen';
import StatusBar from './components/StatusBar';
import UpdateNotification from './components/UpdateNotification';
import ToolsPanel from './components/ToolsPanel';
import MergePdfsDialog from './components/MergePdfsDialog';
import SplitPdfDialog from './components/SplitPdfDialog';
import ExtractPagesDialog from './components/ExtractPagesDialog';
import ExtractImagesDialog from './components/ExtractImagesDialog';
import ConvertToPdfDialog from './components/ConvertToPdfDialog';
import ConvertFromPdfDialog from './components/ConvertFromPdfDialog';
import PrintDialog from './components/PrintDialog';
import DroppedFileDialog from './components/DroppedFileDialog';
import ConversionActionBar from './components/ConversionActionBar';
import SettingsDialog from './components/SettingsDialog';
import { ToastContainer, useToast } from './components/Toast';
import { PDFDocument } from './types';
import { usePDFDocument } from './hooks/usePDFDocument';

declare global {
  interface Window {
    electronAPI: {
      openFileDialog: () => Promise<{ path: string; data: string } | null>;
      readFileByPath: (filePath: string) => Promise<{ path: string; data: string } | null>;
      saveFile: (data: string, filePath: string) => Promise<{ success: boolean; error?: string }>;
      saveFileDialog: (data: string, defaultPath?: string) => Promise<{ success: boolean; path?: string; canceled?: boolean }>;
      openImageDialog: () => Promise<{ path: string; data: string; type: string } | null>;
      getStore: (key: string) => Promise<unknown>;
      setStore: (key: string, value: unknown) => Promise<void>;
      onFileOpened: (callback: (data: { path: string; data: string }) => void) => void;
      onMenuAction: (action: string, callback: () => void) => void;
      removeMenuListener: (action: string) => void;
      // Auto-update methods
      checkForUpdates: () => Promise<{ success: boolean; updateInfo?: unknown; error?: string }>;
      downloadUpdate: () => Promise<{ success: boolean; error?: string }>;
      installUpdate: () => void;
      getAppVersion: () => Promise<string>;
      onUpdateAvailable: (callback: (info: { version: string; releaseNotes?: string }) => void) => void;
      onUpdateNotAvailable: (callback: (info: { version: string }) => void) => void;
      onUpdateDownloadProgress: (callback: (progress: { percent: number; bytesPerSecond: number; transferred: number; total: number }) => void) => void;
      onUpdateDownloaded: (callback: (info: { version: string; releaseNotes?: string }) => void) => void;
      onUpdateError: (callback: (error: { message: string }) => void) => void;
      removeUpdateListeners: () => void;
      // Multi-file operations
      openMultipleFilesDialog: () => Promise<Array<{ path: string; data: string }> | null>;
      selectOutputDirectory: () => Promise<string | null>;
      saveFileToPath: (data: string, filePath: string) => Promise<{ success: boolean; path?: string; error?: string }>;
      saveImageToPath: (data: string, filePath: string) => Promise<{ success: boolean; path?: string; error?: string }>;
      openFolder: (folderPath: string) => Promise<{ success: boolean; error?: string }>;
      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
      // Recent files
      getRecentFiles: () => Promise<string[]>;
      addRecentFile: (filePath: string) => Promise<string[]>;
      clearRecentFiles: () => Promise<string[]>;
      // Document conversion
      detectLibreOffice: () => Promise<string | null>;
      onLibreOfficeStatus: (callback: (path: string | null) => void) => void;
      openDocumentsDialog: () => Promise<string[] | null>;
      convertToPdf: (inputPath: string, outputDir: string) => Promise<{ success: boolean; path?: string; data?: string; error?: string }>;
      getPrinters: () => Promise<Array<{ name: string; displayName: string; description: string; isDefault: boolean; status: number }>>;
      printPdf: (options: { html: string; printerName: string; copies: number; landscape: boolean; color: boolean; scaleFactor: number }) => Promise<{ success: boolean; error?: string }>;
      getLaunchFile: () => Promise<{ path: string; data: string } | null>;
    };
  }
}

export type Tool = 'select' | 'text' | 'highlight' | 'image' | 'erase';

// Helper to convert Uint8Array to base64
function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = '';
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    const chunk = bytes.subarray(i, Math.min(i + chunkSize, bytes.length));
    binary += String.fromCharCode.apply(null, chunk as unknown as number[]);
  }
  return btoa(binary);
}

const App: React.FC = () => {
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [toolsPanelVisible, setToolsPanelVisible] = useState(true);
  const [currentTool, setCurrentTool] = useState<Tool>('select');
  const [zoom, setZoom] = useState(100);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
  const [libreOfficeAvailable, setLibreOfficeAvailable] = useState(false);

  // Dialog states
  const [mergeDialogOpen, setMergeDialogOpen] = useState(false);
  const [splitDialogOpen, setSplitDialogOpen] = useState(false);
  const [extractPagesDialogOpen, setExtractPagesDialogOpen] = useState(false);
  const [extractImagesDialogOpen, setExtractImagesDialogOpen] = useState(false);
  const [convertDialogOpen, setConvertDialogOpen] = useState(false);
  const [convertFromDialogOpen, setConvertFromDialogOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);
  const [printDialogOpen, setPrintDialogOpen] = useState(false);

  // Dropped file conversion state
  const [droppedFilePath, setDroppedFilePath] = useState<string>('');
  const [droppedFileDialogOpen, setDroppedFileDialogOpen] = useState(false);
  const [showConversionBar, setShowConversionBar] = useState(false);

  const toast = useToast();

  const {
    document,
    loading,
    modified,
    openFile,
    saveFile,
    saveFileAs,
    addText,
    addImage,
    addHighlight,
    deletePage,
    rotatePage,
    undo,
    redo,
    canUndo,
    canRedo,
    updateAnnotation,
    deleteAnnotation,
    updateTextItem,
    markTextDeleted,
  } = usePDFDocument();

  // Load persisted settings and check LibreOffice on mount
  useEffect(() => {
    const loadSettings = async () => {
      try {
        const savedSidebar = await window.electronAPI.getStore('sidebarVisible');
        if (typeof savedSidebar === 'boolean') setSidebarVisible(savedSidebar);

        const savedToolsPanel = await window.electronAPI.getStore('toolsPanelVisible');
        if (typeof savedToolsPanel === 'boolean') setToolsPanelVisible(savedToolsPanel);

        const savedZoom = await window.electronAPI.getStore('defaultZoom');
        if (typeof savedZoom === 'number') setZoom(savedZoom);

        // Check LibreOffice availability via IPC
        const loPath = await window.electronAPI.detectLibreOffice();
        setLibreOfficeAvailable(!!loPath);

        // Load and apply theme
        const savedTheme = await window.electronAPI.getStore('theme') as 'light' | 'dark' | 'system' | null;
        const theme = savedTheme || 'system';
        const root = window.document.documentElement; // Use window.document to avoid shadowing
        if (theme === 'system') {
          const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
          root.classList.toggle('dark', prefersDark);
        } else {
          root.classList.toggle('dark', theme === 'dark');
        }
      } catch (e) {
        console.error('Failed to load settings:', e);
      }

      // Check if app was launched with a file (double-click / file association)
      try {
        const launchFile = await window.electronAPI.getLaunchFile();
        if (launchFile) {
          await openFile(launchFile.path, launchFile.data);
          await window.electronAPI.addRecentFile(launchFile.path);
        }
      } catch (e) {
        console.error('Failed to open launch file:', e);
      }
    };
    loadSettings();
  }, []);

  // Save settings when they change
  useEffect(() => {
    window.electronAPI.setStore('sidebarVisible', sidebarVisible);
  }, [sidebarVisible]);

  useEffect(() => {
    window.electronAPI.setStore('toolsPanelVisible', toolsPanelVisible);
  }, [toolsPanelVisible]);

  const handleOpenFile = useCallback(async () => {
    const result = await window.electronAPI.openFileDialog();
    if (result) {
      await openFile(result.path, result.data);
      await window.electronAPI.addRecentFile(result.path);
    }
  }, [openFile]);

  // Also listen for LibreOffice status from main process
  useEffect(() => {
    window.electronAPI.onLibreOfficeStatus((path) => {
      setLibreOfficeAvailable(!!path);
    });
  }, []);

  const handleFileDrop = useCallback(async (filePath: string) => {
    const result = await window.electronAPI.readFileByPath(filePath);
    if (result) {
      await openFile(result.path, result.data);
      await window.electronAPI.addRecentFile(result.path);
      // Show conversion action bar when PDF is loaded
      setShowConversionBar(true);
    }
  }, [openFile]);

  // Handle non-PDF file drop - open conversion dialog
  const handleNonPdfDrop = useCallback((filePath: string) => {
    setDroppedFilePath(filePath);
    setDroppedFileDialogOpen(true);
  }, []);

  // Handle converted file - open the resulting PDF
  const handleConvertedFileOpen = useCallback(async (pdfPath: string, pdfData: string) => {
    setDroppedFileDialogOpen(false);
    setDroppedFilePath('');
    await openFile(pdfPath, pdfData);
    await window.electronAPI.addRecentFile(pdfPath);
    setShowConversionBar(true);
    toast.success('Document converted and opened');
  }, [openFile, toast]);

  const handleSave = useCallback(async () => {
    try {
      if (document?.filePath) {
        await saveFile();
        toast.success('Document saved successfully');
      } else {
        const result = await saveFileAs();
        if (result) {
          toast.success('Document saved successfully');
        }
      }
    } catch (error) {
      toast.error('Failed to save document');
      console.error('Save error:', error);
    }
  }, [document, saveFile, saveFileAs, toast]);

  const handlePrint = useCallback(() => {
    if (document) {
      setPrintDialogOpen(true);
    }
  }, [document]);

  const handleZoomIn = useCallback(() => {
    setZoom((prev) => Math.min(prev + 25, 400));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom((prev) => Math.max(prev - 25, 25));
  }, []);

  const handleFitWidth = useCallback(() => {
    setZoom(100);
  }, []);

  const handleAddText = useCallback(() => {
    if (document) {
      addText(currentPage, { x: 100, y: 100 }, 'New Text');
    }
  }, [document, currentPage, addText]);

  const handleAddImage = useCallback(async () => {
    const result = await window.electronAPI.openImageDialog();
    if (result && document) {
      addImage(currentPage, { x: 100, y: 100 }, result.data, result.type);
    }
  }, [document, currentPage, addImage]);

  const handleRotatePage = useCallback(
    (clockwise: boolean) => {
      if (document) {
        rotatePage(currentPage, clockwise ? 90 : -90);
      }
    },
    [document, currentPage, rotatePage]
  );

  const handleRotateAllPages = useCallback(() => {
    if (!document) return;
    for (let i = 1; i <= document.pageCount; i++) {
      rotatePage(i, 90);
    }
    toast.success('All pages rotated');
  }, [document, rotatePage, toast]);

  const handleDeleteSelected = useCallback(() => {
    if (document && selectedAnnotationId) {
      const pageIndex = document.pages.findIndex((p) =>
        p.annotations.some((a) => a.id === selectedAnnotationId)
      );
      if (pageIndex !== -1) {
        deleteAnnotation(pageIndex + 1, selectedAnnotationId);
        setSelectedAnnotationId(null);
      }
    }
  }, [document, selectedAnnotationId, deleteAnnotation]);

  const handleSelectionChange = useCallback((annotationId: string | null) => {
    setSelectedAnnotationId(annotationId);
  }, []);

  const handleToolChange = useCallback((newTool: Tool) => {
    if (newTool === 'erase' && selectedAnnotationId && document) {
      const pageIndex = document.pages.findIndex((p) =>
        p.annotations.some((a) => a.id === selectedAnnotationId)
      );
      if (pageIndex !== -1) {
        deleteAnnotation(pageIndex + 1, selectedAnnotationId);
        setSelectedAnnotationId(null);
      }
    }
    setCurrentTool(newTool);
  }, [selectedAnnotationId, document, deleteAnnotation]);

  // Merge PDFs handler
  const handleMergePdfs = useCallback(async (files: Array<{ path: string; data: string }>) => {
    try {
      const mergedPdf = await PDFLib.create();

      for (const file of files) {
        const pdfBytes = Uint8Array.from(atob(file.data), c => c.charCodeAt(0));
        const pdf = await PDFLib.load(pdfBytes);
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        pages.forEach(page => mergedPdf.addPage(page));
      }

      const mergedBytes = await mergedPdf.save();
      const base64 = uint8ArrayToBase64(mergedBytes);

      const result = await window.electronAPI.saveFileDialog(base64, 'merged.pdf');
      if (result.success && result.path) {
        toast.success(`Merged ${files.length} PDFs successfully`);
        // Optionally open the merged file
        const fileData = await window.electronAPI.readFileByPath(result.path);
        if (fileData) {
          await openFile(fileData.path, fileData.data);
        }
      }
    } catch (error) {
      throw new Error(`Failed to merge PDFs: ${(error as Error).message}`);
    }
  }, [toast, openFile]);

  // Split PDF handler
  const handleSplitPdf = useCallback(async (outputDir: string) => {
    if (!document) return;

    try {
      const sourcePdf = await PDFLib.load(document.pdfData);
      const baseName = document.fileName.replace('.pdf', '');

      for (let i = 0; i < sourcePdf.getPageCount(); i++) {
        const newPdf = await PDFLib.create();
        const [page] = await newPdf.copyPages(sourcePdf, [i]);
        newPdf.addPage(page);

        const pdfBytes = await newPdf.save();
        const base64 = uint8ArrayToBase64(pdfBytes);
        const filePath = `${outputDir}/${baseName}_page_${i + 1}.pdf`;

        await window.electronAPI.saveFileToPath(base64, filePath);
      }

      toast.success(`Split into ${sourcePdf.getPageCount()} files`);
      await window.electronAPI.openFolder(outputDir);
    } catch (error) {
      throw new Error(`Failed to split PDF: ${(error as Error).message}`);
    }
  }, [document, toast]);

  // Extract pages handler
  const handleExtractPages = useCallback(async (pageRange: string) => {
    if (!document) return;

    try {
      // Parse page range
      const pages: number[] = [];
      const parts = pageRange.split(',');
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.includes('-')) {
          const [start, end] = trimmed.split('-').map(s => parseInt(s.trim()) - 1);
          for (let i = start; i <= end; i++) {
            pages.push(i);
          }
        } else {
          pages.push(parseInt(trimmed) - 1);
        }
      }

      const uniquePages = [...new Set(pages)].sort((a, b) => a - b);

      const sourcePdf = await PDFLib.load(document.pdfData);
      const newPdf = await PDFLib.create();
      const copiedPages = await newPdf.copyPages(sourcePdf, uniquePages);
      copiedPages.forEach(page => newPdf.addPage(page));

      const pdfBytes = await newPdf.save();
      const base64 = uint8ArrayToBase64(pdfBytes);

      const result = await window.electronAPI.saveFileDialog(base64, `${document.fileName.replace('.pdf', '')}_extracted.pdf`);
      if (result.success) {
        toast.success(`Extracted ${uniquePages.length} pages`);
      }
    } catch (error) {
      throw new Error(`Failed to extract pages: ${(error as Error).message}`);
    }
  }, [document, toast]);

  // Extract images handler
  const handleExtractImages = useCallback(async (outputDir: string): Promise<{ count: number; folder: string }> => {
    if (!document) return { count: 0, folder: outputDir };

    // Note: pdf-lib doesn't support image extraction directly
    // We'll use a workaround by parsing the PDF structure
    // For now, show a message that this feature requires PyMuPDF backend
    toast.warning('Image extraction requires additional backend support. Coming soon!');
    return { count: 0, folder: outputDir };
  }, [document, toast]);

  // Convert PDF to images handler
  const handleConvertFromPdf = useCallback(async (
    outputDir: string,
    format: 'png' | 'jpeg',
    quality: number
  ): Promise<{ count: number; folder: string }> => {
    if (!document) return { count: 0, folder: outputDir };

    const baseName = document.fileName.replace('.pdf', '');
    let convertedCount = 0;

    // Use canvas rendering approach for each page
    const pdfData = document.pdfData;
    const pdfjsLib = await import('pdfjs-dist');

    // Configure worker
    pdfjsLib.GlobalWorkerOptions.workerSrc = new URL(
      'pdfjs-dist/build/pdf.worker.min.mjs',
      import.meta.url
    ).toString();

    const pdfDoc = await pdfjsLib.getDocument({ data: pdfData }).promise;

    for (let pageNum = 1; pageNum <= pdfDoc.numPages; pageNum++) {
      const page = await pdfDoc.getPage(pageNum);
      const viewport = page.getViewport({ scale: 2.0 }); // Higher scale for better quality

      const canvas = window.document.createElement('canvas');
      const context = canvas.getContext('2d');
      canvas.width = viewport.width;
      canvas.height = viewport.height;

      await page.render({
        canvasContext: context!,
        viewport: viewport,
      }).promise;

      // Convert canvas to image data
      const mimeType = format === 'png' ? 'image/png' : 'image/jpeg';
      const qualityValue = format === 'jpeg' ? quality / 100 : undefined;
      const dataUrl = canvas.toDataURL(mimeType, qualityValue);
      const base64Data = dataUrl.split(',')[1];

      const filePath = `${outputDir}/${baseName}_page_${pageNum}.${format}`;
      await window.electronAPI.saveImageToPath(base64Data, filePath);
      convertedCount++;
    }

    toast.success(`Converted ${convertedCount} pages to ${format.toUpperCase()}`);
    await window.electronAPI.openFolder(outputDir);
    return { count: convertedCount, folder: outputDir };
  }, [document, toast]);

  // Menu event handlers
  useEffect(() => {
    const menuActions: Record<string, () => void> = {
      save: handleSave,
      'save-as': saveFileAs,
      print: handlePrint,
      undo: undo,
      redo: redo,
      'add-text': handleAddText,
      'add-image': handleAddImage,
      'zoom-in': handleZoomIn,
      'zoom-out': handleZoomOut,
      'fit-width': handleFitWidth,
      'toggle-sidebar': () => setSidebarVisible((prev) => !prev),
      'toggle-tools-panel': () => setToolsPanelVisible((prev) => !prev),
      'rotate-cw': () => handleRotatePage(true),
      'rotate-ccw': () => handleRotatePage(false),
      'rotate-all': handleRotateAllPages,
      'delete-selected': handleDeleteSelected,
      'delete-page': () => document && deletePage(currentPage),
      'merge-pdfs': () => setMergeDialogOpen(true),
      'split-pdf': () => document && setSplitDialogOpen(true),
      'extract-pages': () => document && setExtractPagesDialogOpen(true),
      'extract-images': () => document && setExtractImagesDialogOpen(true),
      'convert-to-pdf': () => setConvertDialogOpen(true),
      'settings': () => setSettingsDialogOpen(true),
    };

    Object.entries(menuActions).forEach(([action, handler]) => {
      window.electronAPI.onMenuAction(action, handler);
    });

    window.electronAPI.onFileOpened(async (data) => {
      await openFile(data.path, data.data);
    });

    return () => {
      Object.keys(menuActions).forEach((action) => {
        window.electronAPI.removeMenuListener(action);
      });
    };
  }, [
    handleSave,
    handlePrint,
    saveFileAs,
    undo,
    redo,
    handleAddText,
    handleAddImage,
    handleZoomIn,
    handleZoomOut,
    handleFitWidth,
    handleRotatePage,
    handleRotateAllPages,
    handleDeleteSelected,
    openFile,
    document,
    deletePage,
    currentPage,
  ]);


  // Keyboard shortcuts for tools
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      if (e.altKey || e.metaKey) return;

      if (!e.ctrlKey && !e.shiftKey) {
        switch (e.key.toLowerCase()) {
          case 'v':
            handleToolChange('select');
            break;
          case 't':
            handleToolChange('text');
            break;
          case 'h':
            handleToolChange('highlight');
            break;
          case 'i':
            if (document) handleAddImage();
            break;
          case 'e':
            handleToolChange('erase');
            break;
          case 'delete':
          case 'backspace':
            if (selectedAnnotationId) {
              handleDeleteSelected();
            }
            break;
          case 'escape':
            setSelectedAnnotationId(null);
            handleToolChange('select');
            break;
        }
      }

      if (e.ctrlKey && !e.shiftKey) {
        switch (e.key.toLowerCase()) {
          case 'o':
            e.preventDefault();
            handleOpenFile();
            break;
          case 's':
            e.preventDefault();
            handleSave();
            break;
          case 'p':
            e.preventDefault();
            handlePrint();
            break;
          case 'z':
            e.preventDefault();
            if (canUndo) undo();
            break;
          case 'y':
            e.preventDefault();
            if (canRedo) redo();
            break;
          case '=':
          case '+':
            e.preventDefault();
            handleZoomIn();
            break;
          case '-':
            e.preventDefault();
            handleZoomOut();
            break;
          case '0':
            e.preventDefault();
            setZoom(100);
            break;
          case 'b':
            e.preventDefault();
            setSidebarVisible(prev => !prev);
            break;
          case 't':
            e.preventDefault();
            setToolsPanelVisible(prev => !prev);
            break;
          case 'm':
            e.preventDefault();
            setMergeDialogOpen(true);
            break;
        }
      }

      if (e.ctrlKey && e.shiftKey) {
        switch (e.key.toLowerCase()) {
          case 's':
            e.preventDefault();
            saveFileAs();
            break;
          case 'z':
            e.preventDefault();
            if (canRedo) redo();
            break;
        }
      }
    };

    window.document.addEventListener('keydown', handleKeyDown);
    return () => window.document.removeEventListener('keydown', handleKeyDown);
  }, [
    document,
    handleToolChange,
    handleAddImage,
    handleDeleteSelected,
    selectedAnnotationId,
    handleOpenFile,
    handleSave,
    handlePrint,
    canUndo,
    canRedo,
    undo,
    redo,
    handleZoomIn,
    handleZoomOut,
    saveFileAs,
  ]);

  // Prevent default drag behavior
  useEffect(() => {
    const preventDefaultDrag = (e: DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
    };

    window.document.addEventListener('dragover', preventDefaultDrag);
    window.document.addEventListener('drop', preventDefaultDrag);

    return () => {
      window.document.removeEventListener('dragover', preventDefaultDrag);
      window.document.removeEventListener('drop', preventDefaultDrag);
    };
  }, []);

  return (
    <div className="app-container">
      <UpdateNotification />
      <Toolbar
        currentTool={currentTool}
        onToolChange={handleToolChange}
        zoom={zoom}
        onZoomIn={handleZoomIn}
        onZoomOut={handleZoomOut}
        onZoomChange={setZoom}
        onOpenFile={handleOpenFile}
        onSave={handleSave}
        onPrint={handlePrint}
        onUndo={undo}
        onRedo={redo}
        canUndo={canUndo}
        canRedo={canRedo}
        onAddText={handleAddText}
        onAddImage={handleAddImage}
        onRotateCW={() => handleRotatePage(true)}
        onRotateCCW={() => handleRotatePage(false)}
        onDeleteSelected={handleDeleteSelected}
        onDeletePage={() => document && deletePage(currentPage)}
        onToggleSidebar={() => setSidebarVisible(prev => !prev)}
        sidebarVisible={sidebarVisible}
        pageCount={document?.pageCount}
        disabled={!document}
      />

      <div className="main-content">
        <Sidebar
          visible={sidebarVisible}
          document={document}
          currentPage={currentPage}
          onPageSelect={setCurrentPage}
        />

        {document ? (
          <>
            <PDFViewer
              document={document}
              zoom={zoom}
              currentPage={currentPage}
              onPageChange={setCurrentPage}
              currentTool={currentTool}
              onToolChange={setCurrentTool}
              onUpdateAnnotation={updateAnnotation}
              onDeleteAnnotation={deleteAnnotation}
              onUpdateTextItem={updateTextItem}
              onMarkTextDeleted={markTextDeleted}
              onSelectionChange={handleSelectionChange}
              onAddHighlight={addHighlight}
              onAddText={(pageIndex, position) => addText(pageIndex, position, 'New Text')}
              loading={loading}
            />
            <ConversionActionBar
              visible={showConversionBar}
              onClose={() => setShowConversionBar(false)}
              onConvertToImages={() => setConvertFromDialogOpen(true)}
              libreOfficeAvailable={libreOfficeAvailable}
            />
          </>
        ) : (
          <WelcomeScreen
            onOpenFile={handleOpenFile}
            onFileDropped={handleFileDrop}
            onNonPdfDropped={handleNonPdfDrop}
            onConvertToPdf={() => setConvertDialogOpen(true)}
            libreOfficeAvailable={libreOfficeAvailable}
          />
        )}

        <ToolsPanel
          visible={toolsPanelVisible}
          onToggle={() => setToolsPanelVisible(prev => !prev)}
          disabled={!document}
          onMergePdfs={() => setMergeDialogOpen(true)}
          onSplitPdf={() => setSplitDialogOpen(true)}
          onExtractPages={() => setExtractPagesDialogOpen(true)}
          onExtractImages={() => setExtractImagesDialogOpen(true)}
          onRotateAll={handleRotateAllPages}
          onConvertToPdf={() => setConvertDialogOpen(true)}
          onConvertFromPdf={() => setConvertFromDialogOpen(true)}
          libreOfficeAvailable={libreOfficeAvailable}
        />
      </div>

      <StatusBar
        document={document}
        currentPage={currentPage}
        zoom={zoom}
        modified={modified}
      />

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismissToast} />

      {/* Dialogs */}
      <MergePdfsDialog
        isOpen={mergeDialogOpen}
        onClose={() => setMergeDialogOpen(false)}
        onMerge={handleMergePdfs}
      />

      {document && (
        <>
          <SplitPdfDialog
            isOpen={splitDialogOpen}
            onClose={() => setSplitDialogOpen(false)}
            onSplit={handleSplitPdf}
            pageCount={document.pageCount}
            fileName={document.fileName}
            filePath={document.filePath || ''}
          />

          <ExtractPagesDialog
            isOpen={extractPagesDialogOpen}
            onClose={() => setExtractPagesDialogOpen(false)}
            onExtract={handleExtractPages}
            pageCount={document.pageCount}
          />

          <ExtractImagesDialog
            isOpen={extractImagesDialogOpen}
            onClose={() => setExtractImagesDialogOpen(false)}
            onExtract={handleExtractImages}
            fileName={document.fileName}
            filePath={document.filePath || ''}
          />
        </>
      )}

      <ConvertToPdfDialog
        isOpen={convertDialogOpen}
        onClose={() => setConvertDialogOpen(false)}
        libreOfficeAvailable={libreOfficeAvailable}
      />

      {document && (
        <ConvertFromPdfDialog
          isOpen={convertFromDialogOpen}
          onClose={() => setConvertFromDialogOpen(false)}
          onConvert={handleConvertFromPdf}
          fileName={document.fileName}
          pageCount={document.pageCount}
          filePath={document.filePath || ''}
        />
      )}

      {document && (
        <PrintDialog
          isOpen={printDialogOpen}
          onClose={() => setPrintDialogOpen(false)}
          pdfData={document.pdfData}
          pageCount={document.pageCount}
          currentPage={currentPage}
          fileName={document.fileName}
        />
      )}

      <SettingsDialog
        isOpen={settingsDialogOpen}
        onClose={() => setSettingsDialogOpen(false)}
      />

      <DroppedFileDialog
        isOpen={droppedFileDialogOpen}
        onClose={() => {
          setDroppedFileDialogOpen(false);
          setDroppedFilePath('');
        }}
        filePath={droppedFilePath}
        libreOfficeAvailable={libreOfficeAvailable}
        onConvertAndOpen={handleConvertedFileOpen}
      />
    </div>
  );
};

export default App;
