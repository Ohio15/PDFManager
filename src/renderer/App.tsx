import React, { useState, useCallback, useEffect } from 'react';
import Toolbar from './components/Toolbar';
import Sidebar from './components/Sidebar';
import PDFViewer from './components/PDFViewer';
import WelcomeScreen from './components/WelcomeScreen';
import StatusBar from './components/StatusBar';
import UpdateNotification from './components/UpdateNotification';
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
    };
  }
}

export type Tool = 'select' | 'text' | 'highlight' | 'image' | 'erase';

const App: React.FC = () => {
  const [sidebarVisible, setSidebarVisible] = useState(true);
  const [currentTool, setCurrentTool] = useState<Tool>('select');
  const [zoom, setZoom] = useState(100);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedAnnotationId, setSelectedAnnotationId] = useState<string | null>(null);
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

  const handleOpenFile = useCallback(async () => {
    const result = await window.electronAPI.openFileDialog();
    if (result) {
      await openFile(result.path, result.data);
    }
  }, [openFile]);

  const handleFileDrop = useCallback(async (filePath: string) => {
    const result = await window.electronAPI.readFileByPath(filePath);
    if (result) {
      await openFile(result.path, result.data);
    }
  }, [openFile]);

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

  const handleDeleteSelected = useCallback(() => {
    if (document && selectedAnnotationId) {
      // Find which page has this annotation
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

  // Handle tool activation on existing selection
  // When eraser is selected with something already selected, delete it
  // When highlighter is selected with something already selected, it stays selected (ready for highlight interaction)
  const handleToolChange = useCallback((newTool: Tool) => {
    if (newTool === 'erase' && selectedAnnotationId && document) {
      // Find which page has this annotation and delete it
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

  // Menu event handlers
  useEffect(() => {
    const menuActions: Record<string, () => void> = {
      save: handleSave,
      'save-as': saveFileAs,
      undo: undo,
      redo: redo,
      'add-text': handleAddText,
      'add-image': handleAddImage,
      'zoom-in': handleZoomIn,
      'zoom-out': handleZoomOut,
      'fit-width': handleFitWidth,
      'toggle-sidebar': () => setSidebarVisible((prev) => !prev),
      'rotate-cw': () => handleRotatePage(true),
      'rotate-ccw': () => handleRotatePage(false),
      'delete-selected': handleDeleteSelected,
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
    saveFileAs,
    undo,
    redo,
    handleAddText,
    handleAddImage,
    handleZoomIn,
    handleZoomOut,
    handleFitWidth,
    handleRotatePage,
    handleDeleteSelected,
    openFile,
  ]);


  // Keyboard shortcuts for tools
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Ignore shortcuts when typing in input fields
      const target = e.target as HTMLElement;
      if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable) {
        return;
      }

      // Don't handle if modifier keys are pressed (except for Ctrl combos)
      if (e.altKey || e.metaKey) return;

      // Tool shortcuts (no modifiers)
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

      // Ctrl shortcuts
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
        }
      }

      // Ctrl+Shift shortcuts
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
    canUndo,
    canRedo,
    undo,
    redo,
    handleZoomIn,
    handleZoomOut,
    saveFileAs,
  ]);

  // Prevent default drag behavior that opens files in Explorer
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
        ) : (
          <WelcomeScreen onOpenFile={handleOpenFile} onFileDropped={handleFileDrop} />
        )}
      </div>

      <StatusBar
        document={document}
        currentPage={currentPage}
        zoom={zoom}
        modified={modified}
      />

      <ToastContainer toasts={toast.toasts} onDismiss={toast.dismissToast} />
    </div>
  );
};

export default App;
