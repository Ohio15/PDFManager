const fs = require('fs');

// Fix Toolbar.tsx - Add proper onDeleteSelected callback for trash
const toolbarPath = 'D:/Projects/PDFEditor/src/renderer/components/Toolbar.tsx';
let toolbarContent = fs.readFileSync(toolbarPath, 'utf8');

// New Toolbar.tsx content with proper trash functionality
const newToolbarContent = `import React from 'react';
import { Tool } from '../App';
import {
  FolderOpen,
  Save,
  Undo,
  Redo,
  ZoomIn,
  ZoomOut,
  MousePointer,
  Type,
  Highlighter,
  Image,
  Eraser,
  RotateCw,
  RotateCcw,
  Trash2,
} from 'lucide-react';

interface ToolbarProps {
  currentTool: Tool;
  onToolChange: (tool: Tool) => void;
  zoom: number;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomChange: (zoom: number) => void;
  onOpenFile: () => void;
  onSave: () => void;
  onUndo: () => void;
  onRedo: () => void;
  canUndo: boolean;
  canRedo: boolean;
  onAddText: () => void;
  onAddImage: () => void;
  onRotateCW: () => void;
  onRotateCCW: () => void;
  onDeleteSelected: () => void;
  disabled: boolean;
}

const Toolbar: React.FC<ToolbarProps> = ({
  currentTool,
  onToolChange,
  zoom,
  onZoomIn,
  onZoomOut,
  onZoomChange,
  onOpenFile,
  onSave,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  onAddText,
  onAddImage,
  onRotateCW,
  onRotateCCW,
  onDeleteSelected,
  disabled,
}) => {
  const tools: Array<{ id: Tool; icon: React.ReactNode; title: string }> = [
    { id: 'select', icon: <MousePointer />, title: 'Select (V)' },
    { id: 'text', icon: <Type />, title: 'Add Text (T)' },
    { id: 'highlight', icon: <Highlighter />, title: 'Highlight (H)' },
    { id: 'image', icon: <Image />, title: 'Add Image (I)' },
    { id: 'erase', icon: <Eraser />, title: 'Eraser - Click to delete annotations (E)' },
  ];

  const zoomOptions = [25, 50, 75, 100, 125, 150, 200, 300, 400];

  return (
    <div className="toolbar">
      {/* File Operations */}
      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          onClick={onOpenFile}
          title="Open File (Ctrl+O)"
        >
          <FolderOpen />
        </button>
        <button
          className="toolbar-btn"
          onClick={onSave}
          disabled={disabled}
          title="Save (Ctrl+S)"
        >
          <Save />
        </button>
      </div>

      {/* Undo/Redo */}
      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          onClick={onUndo}
          disabled={!canUndo}
          title="Undo (Ctrl+Z)"
        >
          <Undo />
        </button>
        <button
          className="toolbar-btn"
          onClick={onRedo}
          disabled={!canRedo}
          title="Redo (Ctrl+Y)"
        >
          <Redo />
        </button>
      </div>

      {/* Tools */}
      <div className="toolbar-group">
        {tools.map((tool) => (
          <button
            key={tool.id}
            className={\`toolbar-btn \${currentTool === tool.id ? 'active' : ''}\`}
            onClick={() => {
              if (tool.id === 'text') {
                onAddText();
                onToolChange('select');
              } else if (tool.id === 'image') {
                onAddImage();
                onToolChange('select');
              } else {
                onToolChange(tool.id);
              }
            }}
            disabled={disabled}
            title={tool.title}
          >
            {tool.icon}
          </button>
        ))}
      </div>

      {/* Annotation Operations */}
      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          onClick={onDeleteSelected}
          disabled={disabled}
          title="Delete Selected Annotation (Delete)"
        >
          <Trash2 />
        </button>
      </div>

      {/* Page Operations */}
      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          onClick={onRotateCCW}
          disabled={disabled}
          title="Rotate Counter-Clockwise"
        >
          <RotateCcw />
        </button>
        <button
          className="toolbar-btn"
          onClick={onRotateCW}
          disabled={disabled}
          title="Rotate Clockwise"
        >
          <RotateCw />
        </button>
      </div>

      {/* Zoom */}
      <div className="toolbar-group">
        <button
          className="toolbar-btn"
          onClick={onZoomOut}
          disabled={disabled || zoom <= 25}
          title="Zoom Out"
        >
          <ZoomOut />
        </button>
        <select
          className="toolbar-select"
          value={zoom}
          onChange={(e) => onZoomChange(parseInt(e.target.value))}
          disabled={disabled}
        >
          {zoomOptions.map((z) => (
            <option key={z} value={z}>
              {z}%
            </option>
          ))}
        </select>
        <button
          className="toolbar-btn"
          onClick={onZoomIn}
          disabled={disabled || zoom >= 400}
          title="Zoom In"
        >
          <ZoomIn />
        </button>
      </div>
    </div>
  );
};

export default Toolbar;
`;

fs.writeFileSync(toolbarPath, newToolbarContent);
console.log('Updated Toolbar.tsx');

// Fix App.tsx - Update to handle selectedAnnotation and deleteSelected
const appPath = 'D:/Projects/PDFEditor/src/renderer/App.tsx';
let appContent = fs.readFileSync(appPath, 'utf8');

const newAppContent = `import React, { useState, useCallback, useEffect } from 'react';
import Toolbar from './components/Toolbar';
import Sidebar from './components/Sidebar';
import PDFViewer from './components/PDFViewer';
import WelcomeScreen from './components/WelcomeScreen';
import StatusBar from './components/StatusBar';
import UpdateNotification from './components/UpdateNotification';
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

  const {
    document,
    loading,
    modified,
    openFile,
    saveFile,
    saveFileAs,
    addText,
    addImage,
    deletePage,
    rotatePage,
    undo,
    redo,
    canUndo,
    canRedo,
    updateAnnotation,
    deleteAnnotation,
    updateTextItem,
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
    if (document?.filePath) {
      await saveFile();
    } else {
      await saveFileAs();
    }
  }, [document, saveFile, saveFileAs]);

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
        onToolChange={setCurrentTool}
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
            onUpdateAnnotation={updateAnnotation}
            onDeleteAnnotation={deleteAnnotation}
            onUpdateTextItem={updateTextItem}
            onSelectionChange={handleSelectionChange}
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
    </div>
  );
};

export default App;
`;

fs.writeFileSync(appPath, newAppContent);
console.log('Updated App.tsx');

console.log('All files updated successfully!');
