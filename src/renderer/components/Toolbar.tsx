import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Tool } from '../App';
import {
  FolderOpen,
  Save,
  Printer,
  Undo,
  Redo,
  ZoomIn,
  ZoomOut,
  MousePointer,
  Type,
  Highlighter,
  Image,
  Eraser,
  Pencil,
  Shapes,
  StickyNote,
  Stamp,
  RotateCw,
  RotateCcw,
  Trash2,
  PanelLeftClose,
  PanelLeft,
  FileX,
  MoreHorizontal,
} from 'lucide-react';

export type ZoomMode = 'custom' | 'fit-width' | 'fit-page';

interface ToolbarProps {
  currentTool: Tool;
  onToolChange: (tool: Tool) => void;
  zoom: number;
  zoomMode?: ZoomMode;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onZoomChange: (zoom: number) => void;
  onFitWidth?: () => void;
  onFitPage?: () => void;
  onOpenFile: () => void;
  onSave: () => void;
  onPrint: () => void;
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

// Tooltip wrapper component
const TBtn: React.FC<{
  tooltip: string;
  shortcut?: string;
  className?: string;
  onClick?: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}> = ({ tooltip, shortcut, className = '', onClick, disabled, children }) => (
  <button
    className={`toolbar-btn ${className}`}
    onClick={onClick}
    disabled={disabled}
    aria-label={tooltip}
  >
    {children}
    <span className="toolbar-tooltip">
      {tooltip}
      {shortcut && <kbd className="tooltip-shortcut">{shortcut}</kbd>}
    </span>
  </button>
);

const Toolbar: React.FC<ToolbarProps> = ({
  currentTool,
  onToolChange,
  zoom,
  zoomMode = 'custom',
  onZoomIn,
  onZoomOut,
  onZoomChange,
  onFitWidth,
  onFitPage,
  onOpenFile,
  onSave,
  onPrint,
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
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [overflowNeeded, setOverflowNeeded] = useState(false);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);

  // Detect toolbar overflow
  useEffect(() => {
    if (!toolbarRef.current) return;
    const observer = new ResizeObserver(() => {
      if (toolbarRef.current) {
        setOverflowNeeded(toolbarRef.current.scrollWidth > toolbarRef.current.clientWidth + 10);
      }
    });
    observer.observe(toolbarRef.current);
    return () => observer.disconnect();
  }, []);

  // Close overflow menu on outside click
  useEffect(() => {
    if (!overflowOpen) return;
    const close = (e: MouseEvent) => {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) {
        setOverflowOpen(false);
      }
    };
    window.addEventListener('mousedown', close);
    return () => window.removeEventListener('mousedown', close);
  }, [overflowOpen]);

  const tools: Array<{ id: Tool; icon: React.ReactNode; label: string; shortcut?: string }> = [
    { id: 'select', icon: <MousePointer />, label: 'Select', shortcut: 'V' },
    { id: 'text', icon: <Type />, label: 'Text', shortcut: 'T' },
    { id: 'highlight', icon: <Highlighter />, label: 'Highlight', shortcut: 'H' },
    { id: 'draw', icon: <Pencil />, label: 'Draw', shortcut: 'D' },
    { id: 'shape', icon: <Shapes />, label: 'Shape', shortcut: 'S' },
    { id: 'note', icon: <StickyNote />, label: 'Sticky Note', shortcut: 'N' },
    { id: 'stamp', icon: <Stamp />, label: 'Stamp' },
    { id: 'image', icon: <Image />, label: 'Add Image', shortcut: 'I' },
    { id: 'erase', icon: <Eraser />, label: 'Eraser', shortcut: 'E' },
  ];

  const zoomOptions = [25, 50, 75, 100, 125, 150, 200, 300, 400];

  return (
    <div className="toolbar" ref={toolbarRef}>
      {/* Sidebar Toggle */}
      {onToggleSidebar && (
        <div className="toolbar-group">
          <TBtn
            tooltip={sidebarVisible ? "Hide Sidebar" : "Show Sidebar"}
            shortcut="Ctrl+B"
            onClick={onToggleSidebar}
          >
            {sidebarVisible ? <PanelLeftClose /> : <PanelLeft />}
          </TBtn>
        </div>
      )}

      {/* File Operations */}
      <div className="toolbar-group">
        <TBtn tooltip="Open File" shortcut="Ctrl+O" onClick={onOpenFile}>
          <FolderOpen />
        </TBtn>
        <TBtn tooltip="Save" shortcut="Ctrl+S" onClick={onSave} disabled={disabled}>
          <Save />
        </TBtn>
        <TBtn tooltip="Print" shortcut="Ctrl+P" onClick={onPrint} disabled={disabled}>
          <Printer />
        </TBtn>
      </div>

      {/* Undo/Redo */}
      <div className="toolbar-group">
        <TBtn tooltip="Undo" shortcut="Ctrl+Z" onClick={onUndo} disabled={!canUndo}>
          <Undo />
        </TBtn>
        <TBtn tooltip="Redo" shortcut="Ctrl+Y" onClick={onRedo} disabled={!canRedo}>
          <Redo />
        </TBtn>
      </div>

      {/* Tools */}
      <div className="toolbar-group">
        {tools.map((tool) => (
          <TBtn
            key={tool.id}
            tooltip={tool.label}
            shortcut={tool.shortcut}
            className={currentTool === tool.id ? 'active' : ''}
            onClick={() => {
              if (tool.id === 'image') {
                onAddImage();
                onToolChange('select');
              } else {
                onToolChange(tool.id);
              }
            }}
            disabled={disabled}
          >
            {tool.icon}
          </TBtn>
        ))}
      </div>

      {/* Annotation Operations */}
      <div className="toolbar-group toolbar-overflow-hide">
        <TBtn tooltip="Delete Selected" shortcut="Del" onClick={onDeleteSelected} disabled={disabled}>
          <Trash2 />
        </TBtn>
      </div>

      {/* Page Operations */}
      <div className="toolbar-group toolbar-overflow-hide">
        <TBtn tooltip="Rotate Left" onClick={onRotateCCW} disabled={disabled}>
          <RotateCcw />
        </TBtn>
        <TBtn tooltip="Rotate Right" onClick={onRotateCW} disabled={disabled}>
          <RotateCw />
        </TBtn>
        {onDeletePage && (
          <TBtn tooltip="Delete Page" onClick={onDeletePage} disabled={disabled || pageCount <= 1}>
            <FileX />
          </TBtn>
        )}
      </div>

      {/* Zoom */}
      <div className="toolbar-group">
        <TBtn tooltip="Zoom Out" shortcut="Ctrl+-" onClick={onZoomOut} disabled={disabled || zoom <= 25}>
          <ZoomOut />
        </TBtn>
        <select
          className="toolbar-select"
          value={zoomMode !== 'custom' ? zoomMode : zoom}
          onChange={(e) => {
            const val = e.target.value;
            if (val === 'fit-width' && onFitWidth) {
              onFitWidth();
            } else if (val === 'fit-page' && onFitPage) {
              onFitPage();
            } else {
              onZoomChange(parseInt(val));
            }
          }}
          disabled={disabled}
        >
          <option value="fit-width">Fit Width</option>
          <option value="fit-page">Fit Page</option>
          <optgroup label="Zoom">
            {zoomOptions.map((z) => (
              <option key={z} value={z}>
                {z}%
              </option>
            ))}
          </optgroup>
        </select>
        <TBtn tooltip="Zoom In" shortcut="Ctrl+=" onClick={onZoomIn} disabled={disabled || zoom >= 400}>
          <ZoomIn />
        </TBtn>
      </div>

      {/* Overflow menu */}
      {overflowNeeded && (
        <div className="toolbar-overflow-container" ref={overflowRef}>
          <button
            className={`toolbar-btn toolbar-overflow-btn ${overflowOpen ? 'active' : ''}`}
            onClick={() => setOverflowOpen(!overflowOpen)}
            aria-label="More tools"
          >
            <MoreHorizontal />
          </button>
          {overflowOpen && (
            <div className="toolbar-overflow-menu">
              <button className="overflow-menu-item" onClick={onDeleteSelected} disabled={disabled}>
                <Trash2 size={14} /> Delete Selected
              </button>
              <button className="overflow-menu-item" onClick={onRotateCCW} disabled={disabled}>
                <RotateCcw size={14} /> Rotate Left
              </button>
              <button className="overflow-menu-item" onClick={onRotateCW} disabled={disabled}>
                <RotateCw size={14} /> Rotate Right
              </button>
              {onDeletePage && (
                <button className="overflow-menu-item" onClick={onDeletePage} disabled={disabled || pageCount <= 1}>
                  <FileX size={14} /> Delete Page
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default Toolbar;
