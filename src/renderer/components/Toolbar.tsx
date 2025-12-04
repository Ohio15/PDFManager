import React from 'react';
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
  PanelLeftClose,
  PanelLeft,
  FileX,
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
  onDeletePage?: () => void;
  onToggleSidebar?: () => void;
  sidebarVisible?: boolean;
  disabled: boolean;
  pageCount?: number;
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
  onDeletePage,
  onToggleSidebar,
  sidebarVisible = true,
  disabled,
  pageCount = 0,
}) => {
  const tools: Array<{ id: Tool; icon: React.ReactNode; title: string }> = [
    { id: 'select', icon: <MousePointer />, title: 'Select (V)' },
    { id: 'text', icon: <Type />, title: 'Text - Click to place (T)' },
    { id: 'highlight', icon: <Highlighter />, title: 'Highlight - Drag to select (H)' },
    { id: 'image', icon: <Image />, title: 'Add Image (I)' },
    { id: 'erase', icon: <Eraser />, title: 'Eraser - Click to delete (E)' },
  ];

  const zoomOptions = [25, 50, 75, 100, 125, 150, 200, 300, 400];

  return (
    <div className="toolbar">
      {/* Sidebar Toggle */}
      {onToggleSidebar && (
        <div className="toolbar-group">
          <button
            className="toolbar-btn"
            onClick={onToggleSidebar}
            title={sidebarVisible ? "Hide Sidebar (Ctrl+B)" : "Show Sidebar (Ctrl+B)"}
          >
            {sidebarVisible ? <PanelLeftClose /> : <PanelLeft />}
          </button>
        </div>
      )}

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
            className={`toolbar-btn ${currentTool === tool.id ? 'active' : ''}`}
            onClick={() => {
              if (tool.id === 'image') {
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
        {onDeletePage && (
          <button
            className="toolbar-btn"
            onClick={onDeletePage}
            disabled={disabled || pageCount <= 1}
            title="Delete Current Page"
          >
            <FileX />
          </button>
        )}
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
