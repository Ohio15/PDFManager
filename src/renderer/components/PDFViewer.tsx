import React, { useEffect, useRef, useCallback, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, Annotation, TextAnnotation, ImageAnnotation, HighlightAnnotation, PDFTextItem, Size } from '../types';
import { Tool } from '../App';

interface TextEditDialogState {
  isOpen: boolean;
  pageNum: number;
  textItemId: string;
  originalText: string;
  editedText: string;
}

// Resize handle types for 8-point resize
type ResizeHandle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';

interface ResizeState {
  id: string;
  handle: ResizeHandle;
  startX: number;
  startY: number;
  origX: number;
  origY: number;
  origWidth: number;
  origHeight: number;
}

interface ContextMenuState {
  isOpen: boolean;
  x: number;
  y: number;
  annotationId: string;
  pageIndex: number;
}

// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

// Minimum size for annotations
const MIN_SIZE = 20;

interface PDFViewerProps {
  document: PDFDocument;
  zoom: number;
  currentPage: number;
  onPageChange: (page: number) => void;
  currentTool: Tool;
  onUpdateAnnotation: (pageIndex: number, annotationId: string, updates: Partial<Annotation>) => void;
  onDeleteAnnotation: (pageIndex: number, annotationId: string) => void;
  onUpdateTextItem: (pageIndex: number, textItemId: string, newText: string) => void;
  onDuplicateAnnotation?: (pageIndex: number, annotationId: string) => void;
  onBringToFront?: (pageIndex: number, annotationId: string) => void;
  onSelectionChange?: (annotationId: string | null) => void;
  onAddHighlight?: (pageIndex: number, rects: Array<{ x: number; y: number; width: number; height: number }>) => void;
  loading: boolean;
}

const PDFViewer: React.FC<PDFViewerProps> = ({
  document,
  zoom,
  currentPage,
  onPageChange,
  currentTool,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onUpdateTextItem,
  onDuplicateAnnotation,
  onBringToFront,
  onSelectionChange,
  onAddHighlight,
  loading,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const editableTextRef = useRef<HTMLDivElement>(null);
  const [renderedPages, setRenderedPages] = useState<Map<number, HTMLCanvasElement>>(new Map());
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null);
  const [editingAnnotation, setEditingAnnotation] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [resizing, setResizing] = useState<ResizeState | null>(null);
  const [contextMenu, setContextMenu] = useState<ContextMenuState>({
    isOpen: false,
    x: 0,
    y: 0,
    annotationId: '',
    pageIndex: 0,
  });
  const [editingTextItem, setEditingTextItem] = useState<string | null>(null);
  const [textEditDialog, setTextEditDialog] = useState<TextEditDialogState>({
    isOpen: false,
    pageNum: 0,
    textItemId: '',
    originalText: '',
    editedText: '',
  });
  const [highlightStart, setHighlightStart] = useState<{ pageNum: number; x: number; y: number } | null>(null);
  const [highlightPreview, setHighlightPreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);

  const scale = zoom / 100;

  // Notify parent when selection changes
  useEffect(() => {
    onSelectionChange?.(selectedAnnotation);
  }, [selectedAnnotation, onSelectionChange]);

  // Focus editable text when entering edit mode
  useEffect(() => {
    if (editingAnnotation && editableTextRef.current) {
      editableTextRef.current.focus();
      // Select all text for easy editing
      const selection = window.getSelection();
      const range = window.document.createRange();
      range.selectNodeContents(editableTextRef.current);
      selection?.removeAllRanges();
      selection?.addRange(range);
    }
  }, [editingAnnotation]);

  useEffect(() => {
    const renderPages = async () => {
      console.log('Starting PDF render, data length:', document.pdfData?.length);
      if (!document.pdfData || document.pdfData.length === 0) {
        console.error('No PDF data available');
        return;
      }
      try {
        const dataCopy = new Uint8Array(document.pdfData);
        const pdfDoc = await pdfjsLib.getDocument({ data: dataCopy }).promise;
        console.log('PDF loaded, pages:', pdfDoc.numPages);
        const newRenderedPages = new Map<number, HTMLCanvasElement>();

        for (let i = 1; i <= pdfDoc.numPages; i++) {
          const page = await pdfDoc.getPage(i);
          const viewport = page.getViewport({ scale, rotation: document.pages[i - 1]?.rotation || 0 });
          console.log(`Rendering page ${i}, viewport:`, viewport.width, 'x', viewport.height);

          const canvas = window.document.createElement('canvas');
          const context = canvas.getContext('2d');
          canvas.width = viewport.width;
          canvas.height = viewport.height;

          await page.render({
            canvasContext: context!,
            viewport,
          }).promise;

          newRenderedPages.set(i, canvas);
          console.log(`Page ${i} rendered successfully`);
        }

        setRenderedPages(newRenderedPages);
        console.log('All pages rendered, total:', newRenderedPages.size);
      } catch (error) {
        console.error('Failed to render PDF:', error);
      }
    };

    if (document.pdfData) {
      renderPages();
    }
  }, [document.pdfData, scale, document.pages]);

  const handleScroll = useCallback(() => {
    if (!containerRef.current) return;

    const container = containerRef.current;
    const children = container.querySelectorAll('.pdf-page-container');
    const containerRect = container.getBoundingClientRect();
    const containerCenter = containerRect.top + containerRect.height / 2;

    let closestPage = 1;
    let closestDistance = Infinity;

    children.forEach((child, index) => {
      const rect = child.getBoundingClientRect();
      const pageCenter = rect.top + rect.height / 2;
      const distance = Math.abs(pageCenter - containerCenter);

      if (distance < closestDistance) {
        closestDistance = distance;
        closestPage = index + 1;
      }
    });

    if (closestPage !== currentPage) {
      onPageChange(closestPage);
    }
  }, [currentPage, onPageChange]);

  useEffect(() => {
    const container = containerRef.current;
    if (container) {
      container.addEventListener('scroll', handleScroll);
      return () => container.removeEventListener('scroll', handleScroll);
    }
  }, [handleScroll]);

  useEffect(() => {
    const handleClickOutside = () => {
      if (contextMenu.isOpen) {
        setContextMenu(prev => ({ ...prev, isOpen: false }));
      }
    };
    window.addEventListener('click', handleClickOutside);
    return () => window.removeEventListener('click', handleClickOutside);
  }, [contextMenu.isOpen]);

  const handlePageMouseDown = (
    e: React.MouseEvent,
    pageNum: number
  ) => {
    if (currentTool !== 'highlight') return;

    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    setHighlightStart({ pageNum, x, y });
    setHighlightPreview(null);
  };

  const handlePageMouseMove = (
    e: React.MouseEvent,
    pageNum: number
  ) => {
    if (!highlightStart || highlightStart.pageNum !== pageNum) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const currentX = (e.clientX - rect.left) / scale;
    const currentY = (e.clientY - rect.top) / scale;

    const x = Math.min(highlightStart.x, currentX);
    const y = Math.min(highlightStart.y, currentY);
    const width = Math.abs(currentX - highlightStart.x);
    const height = Math.abs(currentY - highlightStart.y);

    setHighlightPreview({ x, y, width, height });
  };

  const handlePageMouseUp = (pageNum: number) => {
    if (!highlightStart || highlightStart.pageNum !== pageNum || !highlightPreview) {
      setHighlightStart(null);
      setHighlightPreview(null);
      return;
    }

    // Only create highlight if it's big enough
    if (highlightPreview.width > 5 && highlightPreview.height > 5) {
      onAddHighlight?.(pageNum, [highlightPreview]);
    }

    setHighlightStart(null);
    setHighlightPreview(null);
  };

  const handleAnnotationMouseDown = (
    e: React.MouseEvent,
    pageIndex: number,
    annotation: Annotation
  ) => {
    e.stopPropagation();

    // Handle eraser tool - delete annotation on click
    if (currentTool === 'erase') {
      onDeleteAnnotation(pageIndex, annotation.id);
      return;
    }

    if (currentTool !== 'select') return;

    if (contextMenu.isOpen) {
      setContextMenu(prev => ({ ...prev, isOpen: false }));
    }

    setSelectedAnnotation(annotation.id);

    if (annotation.type === 'text' || annotation.type === 'image') {
      setDragging({
        id: annotation.id,
        startX: e.clientX,
        startY: e.clientY,
        origX: annotation.position.x,
        origY: annotation.position.y,
      });
    }
  };

  const handleResizeMouseDown = (
    e: React.MouseEvent,
    annotation: Annotation,
    handle: ResizeHandle
  ) => {
    if (currentTool !== 'select') return;
    e.stopPropagation();
    e.preventDefault();

    let width: number;
    let height: number;

    if (annotation.type === 'image') {
      const imgAnnotation = annotation as ImageAnnotation;
      width = imgAnnotation.size.width;
      height = imgAnnotation.size.height;
    } else if (annotation.type === 'text') {
      const textAnnotation = annotation as TextAnnotation;
      width = textAnnotation.size?.width || 100;
      height = textAnnotation.size?.height || textAnnotation.fontSize * 1.5;
    } else {
      return;
    }

    setResizing({
      id: annotation.id,
      handle,
      startX: e.clientX,
      startY: e.clientY,
      origX: annotation.position.x,
      origY: annotation.position.y,
      origWidth: width,
      origHeight: height,
    });
  };

  const handleContextMenu = (
    e: React.MouseEvent,
    pageIndex: number,
    annotation: Annotation
  ) => {
    if (currentTool !== 'select') return;
    e.preventDefault();
    e.stopPropagation();

    setSelectedAnnotation(annotation.id);
    setContextMenu({
      isOpen: true,
      x: e.clientX,
      y: e.clientY,
      annotationId: annotation.id,
      pageIndex,
    });
  };

  const handleContextMenuAction = (action: 'delete' | 'duplicate' | 'bringToFront') => {
    const { annotationId, pageIndex } = contextMenu;

    switch (action) {
      case 'delete':
        onDeleteAnnotation(pageIndex, annotationId);
        setSelectedAnnotation(null);
        break;
      case 'duplicate':
        if (onDuplicateAnnotation) {
          onDuplicateAnnotation(pageIndex, annotationId);
        }
        break;
      case 'bringToFront':
        if (onBringToFront) {
          onBringToFront(pageIndex, annotationId);
        }
        break;
    }

    setContextMenu(prev => ({ ...prev, isOpen: false }));
  };

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (resizing) {
        const dx = (e.clientX - resizing.startX) / scale;
        const dy = (e.clientY - resizing.startY) / scale;

        const pageIndex = document.pages.findIndex((p) =>
          p.annotations.some((a) => a.id === resizing.id)
        );

        if (pageIndex !== -1) {
          let newX = resizing.origX;
          let newY = resizing.origY;
          let newWidth = resizing.origWidth;
          let newHeight = resizing.origHeight;

          switch (resizing.handle) {
            case 'nw':
              newX = resizing.origX + dx;
              newY = resizing.origY + dy;
              newWidth = resizing.origWidth - dx;
              newHeight = resizing.origHeight - dy;
              break;
            case 'n':
              newY = resizing.origY + dy;
              newHeight = resizing.origHeight - dy;
              break;
            case 'ne':
              newY = resizing.origY + dy;
              newWidth = resizing.origWidth + dx;
              newHeight = resizing.origHeight - dy;
              break;
            case 'e':
              newWidth = resizing.origWidth + dx;
              break;
            case 'se':
              newWidth = resizing.origWidth + dx;
              newHeight = resizing.origHeight + dy;
              break;
            case 's':
              newHeight = resizing.origHeight + dy;
              break;
            case 'sw':
              newX = resizing.origX + dx;
              newWidth = resizing.origWidth - dx;
              newHeight = resizing.origHeight + dy;
              break;
            case 'w':
              newX = resizing.origX + dx;
              newWidth = resizing.origWidth - dx;
              break;
          }

          if (newWidth < MIN_SIZE) {
            if (resizing.handle.includes('w')) {
              newX = resizing.origX + resizing.origWidth - MIN_SIZE;
            }
            newWidth = MIN_SIZE;
          }
          if (newHeight < MIN_SIZE) {
            if (resizing.handle.includes('n')) {
              newY = resizing.origY + resizing.origHeight - MIN_SIZE;
            }
            newHeight = MIN_SIZE;
          }

          onUpdateAnnotation(pageIndex + 1, resizing.id, {
            position: { x: newX, y: newY },
            size: { width: newWidth, height: newHeight },
          });
        }
        return;
      }

      if (dragging) {
        const dx = (e.clientX - dragging.startX) / scale;
        const dy = (e.clientY - dragging.startY) / scale;

        const pageIndex = document.pages.findIndex((p) =>
          p.annotations.some((a) => a.id === dragging.id)
        );

        if (pageIndex !== -1) {
          onUpdateAnnotation(pageIndex + 1, dragging.id, {
            position: {
              x: dragging.origX + dx,
              y: dragging.origY + dy,
            },
          });
        }
      }
    },
    [dragging, resizing, scale, document.pages, onUpdateAnnotation]
  );

  const handleMouseUp = useCallback(() => {
    setDragging(null);
    setResizing(null);
  }, []);

  useEffect(() => {
    if (dragging || resizing) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragging, resizing, handleMouseMove, handleMouseUp]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      // Don't handle delete if we're editing text
      if (editingAnnotation) return;

      if (e.key === 'Delete' && selectedAnnotation) {
        const pageIndex = document.pages.findIndex((p) =>
          p.annotations.some((a) => a.id === selectedAnnotation)
        );
        if (pageIndex !== -1) {
          onDeleteAnnotation(pageIndex + 1, selectedAnnotation);
          setSelectedAnnotation(null);
        }
      }
      if (e.key === 'Escape') {
        setSelectedAnnotation(null);
        setEditingAnnotation(null);
        setContextMenu(prev => ({ ...prev, isOpen: false }));
      }
    },
    [selectedAnnotation, editingAnnotation, document.pages, onDeleteAnnotation]
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  const handleTextChange = (pageIndex: number, annotationId: string, content: string) => {
    onUpdateAnnotation(pageIndex, annotationId, { content });
    setEditingAnnotation(null);
  };

  const handleAnnotationDoubleClick = (
    e: React.MouseEvent,
    annotation: Annotation
  ) => {
    console.log('Double-click detected on annotation:', annotation.id, 'type:', annotation.type, 'currentTool:', currentTool);
    if (currentTool !== 'select') {
      console.log('Not in select mode, ignoring double-click');
      return;
    }
    e.stopPropagation();

    if (annotation.type === 'text') {
      console.log('Entering edit mode for text annotation:', annotation.id);
      setEditingAnnotation(annotation.id);
      setSelectedAnnotation(annotation.id);
    }
  };

  const handleTextItemDoubleClick = (
    e: React.MouseEvent,
    pageNum: number,
    textItem: PDFTextItem
  ) => {
    if (currentTool !== 'select') return;
    e.stopPropagation();
    e.preventDefault();

    console.log('Double-click on PDF text item:', textItem.id, textItem.str);

    setTextEditDialog({
      isOpen: true,
      pageNum,
      textItemId: textItem.id,
      originalText: textItem.str,
      editedText: textItem.str,
    });
  };

  const handleDialogSave = () => {
    if (textEditDialog.editedText !== textEditDialog.originalText) {
      onUpdateTextItem(textEditDialog.pageNum, textEditDialog.textItemId, textEditDialog.editedText);
    }
    setTextEditDialog(prev => ({ ...prev, isOpen: false }));
  };

  const handleDialogCancel = () => {
    setTextEditDialog(prev => ({ ...prev, isOpen: false }));
  };

  const handleDialogKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleDialogSave();
    }
    if (e.key === 'Escape') {
      handleDialogCancel();
    }
  };

  const handleTextItemBlur = (
    pageNum: number,
    textItemId: string,
    newText: string
  ) => {
    console.log('Text item blur:', textItemId, 'new text:', newText);
    const page = document.pages[pageNum - 1];
    const textItem = page?.textItems?.find((t) => t.id === textItemId);
    if (textItem && newText !== textItem.str) {
      onUpdateTextItem(pageNum, textItemId, newText);
    }
    setEditingTextItem(null);
  };

  const renderTextItem = (pageNum: number, textItem: PDFTextItem) => {
    const isEditable = true;

    return (
      <div
        key={textItem.id}
        className={`pdf-text-item ${textItem.isEdited ? 'edited' : ''} ${isEditable ? 'editable' : ''}`}
        style={{
          left: textItem.x * scale,
          top: textItem.y * scale,
          fontSize: textItem.fontSize * scale,
          width: textItem.width * scale,
          height: textItem.height * scale,
          cursor: currentTool === 'select' && isEditable ? 'pointer' : 'default',
        }}
        onDoubleClick={(e) => handleTextItemDoubleClick(e, pageNum, textItem)}
      >
        {textItem.str}
      </div>
    );
  };

  const renderResizeHandles = (annotation: Annotation) => {
    const handles: ResizeHandle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

    return handles.map((handle) => (
      <div
        key={handle}
        className={`resize-handle ${handle}`}
        onMouseDown={(e) => handleResizeMouseDown(e, annotation, handle)}
      />
    ));
  };

  const renderAnnotation = (pageIndex: number, annotation: Annotation) => {
    const isSelected = selectedAnnotation === annotation.id;
    const isEditing = editingAnnotation === annotation.id;
    const isDraggingThis = dragging?.id === annotation.id;
    const isResizingThis = resizing?.id === annotation.id;

    if (annotation.type === 'text') {
      const textAnnotation = annotation as TextAnnotation;
      const hasSize = textAnnotation.size && textAnnotation.size.width > 0;

      return (
        <div
          key={annotation.id}
          ref={isEditing ? editableTextRef : undefined}
          className={`editable-text ${isSelected ? 'selected' : ''} ${isEditing ? 'editing' : ''} ${isDraggingThis ? 'dragging' : ''} ${isResizingThis ? 'resizing' : ''}`}
          style={{
            left: textAnnotation.position.x * scale,
            top: textAnnotation.position.y * scale,
            fontSize: textAnnotation.fontSize * scale,
            fontFamily: textAnnotation.fontFamily,
            color: textAnnotation.color,
            cursor: currentTool === 'erase' ? 'pointer' : (isEditing ? 'text' : (currentTool === 'select' ? 'move' : 'default')),
            ...(hasSize ? {
              width: textAnnotation.size!.width * scale,
              height: textAnnotation.size!.height * scale,
            } : {}),
          }}
          onMouseDown={(e) => !isEditing && handleAnnotationMouseDown(e, pageIndex, annotation)}
          onDoubleClick={(e) => handleAnnotationDoubleClick(e, annotation)}
          onContextMenu={(e) => handleContextMenu(e, pageIndex, annotation)}
          contentEditable={isEditing}
          suppressContentEditableWarning
          onBlur={(e) => {
            if (isEditing) {
              handleTextChange(pageIndex, annotation.id, e.currentTarget.textContent || '');
            }
          }}
          onKeyDown={(e) => {
            if (isEditing && e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.blur();
            }
            if (isEditing && e.key === 'Escape') {
              e.preventDefault();
              setEditingAnnotation(null);
            }
          }}
        >
          {textAnnotation.content}
          {isSelected && !isEditing && renderResizeHandles(annotation)}
        </div>
      );
    }

    if (annotation.type === 'image') {
      const imageAnnotation = annotation as ImageAnnotation;
      return (
        <div
          key={annotation.id}
          className={`editable-image ${isSelected ? 'selected' : ''} ${isDraggingThis ? 'dragging' : ''} ${isResizingThis ? 'resizing' : ''}`}
          style={{
            left: imageAnnotation.position.x * scale,
            top: imageAnnotation.position.y * scale,
            width: imageAnnotation.size.width * scale,
            height: imageAnnotation.size.height * scale,
            cursor: currentTool === 'erase' ? 'pointer' : (currentTool === 'select' ? 'move' : 'default'),
          }}
          onMouseDown={(e) => handleAnnotationMouseDown(e, pageIndex, annotation)}
          onContextMenu={(e) => handleContextMenu(e, pageIndex, annotation)}
        >
          <img
            src={`data:image/${imageAnnotation.imageType};base64,${imageAnnotation.data}`}
            alt="Annotation"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            draggable={false}
          />
          {isSelected && renderResizeHandles(annotation)}
        </div>
      );
    }

    if (annotation.type === 'highlight') {
      const highlightAnnotation = annotation as HighlightAnnotation;
      return (
        <div key={annotation.id} className="highlight-annotation-container">
          {highlightAnnotation.rects.map((rect, idx) => (
            <div
              key={`${annotation.id}-${idx}`}
              className={`highlight-rect ${isSelected ? 'selected' : ''}`}
              style={{
                left: rect.x * scale,
                top: rect.y * scale,
                width: rect.width * scale,
                height: rect.height * scale,
                backgroundColor: highlightAnnotation.color,
                cursor: currentTool === 'erase' ? 'pointer' : (currentTool === 'select' ? 'pointer' : 'default'),
              }}
              onMouseDown={(e) => handleAnnotationMouseDown(e, pageIndex, annotation)}
              onContextMenu={(e) => handleContextMenu(e, pageIndex, annotation)}
            />
          ))}
        </div>
      );
    }

    return null;
  };

  return (
    <div className="pdf-viewer" ref={containerRef}>
      {loading && (
        <div className="loading-overlay">
          <div className="spinner" />
        </div>
      )}

      {Array.from(renderedPages.entries()).map(([pageNum, canvas]) => {
        const page = document.pages[pageNum - 1];
        return (
          <div
            key={pageNum}
            className={`pdf-page-container ${currentTool === 'highlight' ? 'highlight-mode' : ''}`}
            style={{
              width: canvas.width,
              height: canvas.height,
            }}
            onClick={() => { setSelectedAnnotation(null); setEditingAnnotation(null); setEditingTextItem(null); }}
            onMouseDown={(e) => handlePageMouseDown(e, pageNum)}
            onMouseMove={(e) => handlePageMouseMove(e, pageNum)}
            onMouseUp={() => handlePageMouseUp(pageNum)}
            onMouseLeave={() => { if (highlightStart) { setHighlightStart(null); setHighlightPreview(null); } }}
          >
            <canvas
              className="pdf-page-canvas"
              ref={(el) => {
                if (el) {
                  const ctx = el.getContext('2d');
                  el.width = canvas.width;
                  el.height = canvas.height;
                  ctx?.drawImage(canvas, 0, 0);
                }
              }}
            />
            <div
              className={`annotation-layer ${currentTool !== 'select' ? '' : 'active'}`}
            >
              {page?.annotations.map((annotation) =>
                renderAnnotation(pageNum, annotation)
              )}
            </div>
            <div className="text-layer">
              {page?.textItems?.map((textItem) => renderTextItem(pageNum, textItem))}
            </div>
            {/* Highlight preview while drawing */}
            {highlightStart && highlightStart.pageNum === pageNum && highlightPreview && (
              <div
                className="highlight-preview"
                style={{
                  left: highlightPreview.x * scale,
                  top: highlightPreview.y * scale,
                  width: highlightPreview.width * scale,
                  height: highlightPreview.height * scale,
                }}
              />
            )}
          </div>
        );
      })}


      {/* Context Menu */}
      {contextMenu.isOpen && (
        <div
          className="annotation-context-menu"
          style={{
            position: 'fixed',
            left: contextMenu.x,
            top: contextMenu.y,
          }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            className="context-menu-item"
            onClick={() => handleContextMenuAction('delete')}
          >
            Delete
          </button>
          {onDuplicateAnnotation && (
            <button
              className="context-menu-item"
              onClick={() => handleContextMenuAction('duplicate')}
            >
              Duplicate
            </button>
          )}
          {onBringToFront && (
            <button
              className="context-menu-item"
              onClick={() => handleContextMenuAction('bringToFront')}
            >
              Bring to Front
            </button>
          )}
        </div>
      )}

      {/* Text Edit Dialog */}
      {textEditDialog.isOpen && (
        <div className="text-edit-dialog-overlay" onClick={handleDialogCancel}>
          <div className="text-edit-dialog" onClick={(e) => e.stopPropagation()}>
            <div className="text-edit-dialog-header">
              <h3>Edit Text</h3>
              <button className="dialog-close-btn" onClick={handleDialogCancel}>×</button>
            </div>
            <div className="text-edit-dialog-body">
              <label>Original:</label>
              <div className="original-text">{textEditDialog.originalText}</div>
              <label>New text:</label>
              <input
                type="text"
                className="text-edit-input"
                value={textEditDialog.editedText}
                onChange={(e) => setTextEditDialog(prev => ({ ...prev, editedText: e.target.value }))}
                onKeyDown={handleDialogKeyDown}
                autoFocus
              />
            </div>
            <div className="text-edit-dialog-footer">
              <button className="dialog-btn cancel" onClick={handleDialogCancel}>Cancel</button>
              <button className="dialog-btn save" onClick={handleDialogSave}>Save</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default PDFViewer;
