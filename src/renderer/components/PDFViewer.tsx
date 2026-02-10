import React, { useEffect, useRef, useCallback, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument, Annotation, TextAnnotation, ImageAnnotation, HighlightAnnotation, DrawingAnnotation, ShapeAnnotation, StickyNoteAnnotation, StampAnnotation, AnnotationStyle, PDFTextItem, Position, Size } from '../types';
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

// Configure PDF.js worker - imported with ?url suffix for proper bundling
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

// Minimum size for annotations
const MIN_SIZE = 20;

interface PDFViewerProps {
  document: PDFDocument;
  zoom: number;
  currentPage: number;
  onPageChange: (page: number) => void;
  currentTool: Tool;
  onToolChange?: (tool: Tool) => void;
  onUpdateAnnotation: (pageIndex: number, annotationId: string, updates: Partial<Annotation>) => void;
  onDeleteAnnotation: (pageIndex: number, annotationId: string) => void;
  onUpdateTextItem: (pageIndex: number, textItemId: string, newText: string) => void;
  onMarkTextDeleted?: (pageIndex: number, textItemId: string, isDeleted: boolean) => void;
  onDuplicateAnnotation?: (pageIndex: number, annotationId: string) => void;
  onBringToFront?: (pageIndex: number, annotationId: string) => void;
  onSelectionChange?: (annotationId: string | null) => void;
  onAddHighlight?: (pageIndex: number, rects: Array<{ x: number; y: number; width: number; height: number }>) => void;
  onAddText?: (pageIndex: number, position: { x: number; y: number }) => string | void;
  onAddDrawing?: (pageIndex: number, paths: DrawingAnnotation['paths']) => void;
  onAddShape?: (pageIndex: number, shapeType: ShapeAnnotation['shapeType'], position: Position, size: Size, strokeColor: string, fillColor: string, strokeWidth: number) => void;
  onAddStickyNote?: (pageIndex: number, position: Position, color?: string) => void;
  onAddStamp?: (pageIndex: number, position: Position, stampType: StampAnnotation['stampType'], text: string, color: string) => void;
  annotationStyle?: AnnotationStyle;
  loading: boolean;
}

const PDFViewer: React.FC<PDFViewerProps> = ({
  document,
  zoom,
  currentPage,
  onPageChange,
  currentTool,
  onToolChange,
  onUpdateAnnotation,
  onDeleteAnnotation,
  onUpdateTextItem,
  onMarkTextDeleted,
  onDuplicateAnnotation,
  onBringToFront,
  onSelectionChange,
  onAddHighlight,
  onAddText,
  onAddDrawing,
  onAddShape,
  onAddStickyNote,
  onAddStamp,
  annotationStyle,
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
  const [eraserStart, setEraserStart] = useState<{ pageNum: number; x: number; y: number } | null>(null);
  const [eraserPreview, setEraserPreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  // Drawing tool state
  const [drawingPoints, setDrawingPoints] = useState<Position[]>([]);
  const [drawingPageNum, setDrawingPageNum] = useState<number | null>(null);
  // Shape tool state
  const [shapeStart, setShapeStart] = useState<{ pageNum: number; x: number; y: number } | null>(null);
  const [shapePreview, setShapePreview] = useState<{ x: number; y: number; width: number; height: number } | null>(null);
  // Note editing state
  const [editingNote, setEditingNote] = useState<string | null>(null);

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
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / scale;
    const y = (e.clientY - rect.top) / scale;

    if (currentTool === 'text') {
      if (onAddText) {
        const newAnnotationId = onAddText(pageNum, { x, y });
        if (newAnnotationId) {
          setSelectedAnnotation(newAnnotationId);
          setTimeout(() => {
            setEditingAnnotation(newAnnotationId);
          }, 50);
        }
        onToolChange?.('select');
      }
    } else if (currentTool === 'highlight') {
      setHighlightStart({ pageNum, x, y });
      setHighlightPreview(null);
    } else if (currentTool === 'erase') {
      setEraserStart({ pageNum, x, y });
      setEraserPreview(null);
    } else if (currentTool === 'draw') {
      setDrawingPageNum(pageNum);
      setDrawingPoints([{ x, y }]);
    } else if (currentTool === 'shape') {
      setShapeStart({ pageNum, x, y });
      setShapePreview(null);
    } else if (currentTool === 'note') {
      if (onAddStickyNote) {
        onAddStickyNote(pageNum, { x, y }, annotationStyle?.noteColor);
      }
      onToolChange?.('select');
    } else if (currentTool === 'stamp') {
      if (onAddStamp && annotationStyle) {
        onAddStamp(pageNum, { x, y }, annotationStyle.stampType, annotationStyle.stampText, annotationStyle.color);
      }
      onToolChange?.('select');
    }
  };

  const handlePageMouseMove = (
    e: React.MouseEvent,
    pageNum: number
  ) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const currentX = (e.clientX - rect.left) / scale;
    const currentY = (e.clientY - rect.top) / scale;

    if (highlightStart && highlightStart.pageNum === pageNum) {
      const x = Math.min(highlightStart.x, currentX);
      const y = Math.min(highlightStart.y, currentY);
      const width = Math.abs(currentX - highlightStart.x);
      const height = Math.abs(currentY - highlightStart.y);
      setHighlightPreview({ x, y, width, height });
    }

    if (eraserStart && eraserStart.pageNum === pageNum) {
      const x = Math.min(eraserStart.x, currentX);
      const y = Math.min(eraserStart.y, currentY);
      const width = Math.abs(currentX - eraserStart.x);
      const height = Math.abs(currentY - eraserStart.y);
      setEraserPreview({ x, y, width, height });
    }

    // Drawing tool - collect points
    if (drawingPageNum === pageNum && drawingPoints.length > 0) {
      setDrawingPoints(prev => [...prev, { x: currentX, y: currentY }]);
    }

    // Shape tool - preview
    if (shapeStart && shapeStart.pageNum === pageNum) {
      const x = Math.min(shapeStart.x, currentX);
      const y = Math.min(shapeStart.y, currentY);
      const width = Math.abs(currentX - shapeStart.x);
      const height = Math.abs(currentY - shapeStart.y);
      setShapePreview({ x, y, width, height });
    }
  };

  const handlePageMouseUp = (pageNum: number) => {
    // Handle highlight tool
    if (highlightStart && highlightStart.pageNum === pageNum && highlightPreview) {
      if (highlightPreview.width > 5 && highlightPreview.height > 5) {
        onAddHighlight?.(pageNum, [highlightPreview]);
      }
      setHighlightStart(null);
      setHighlightPreview(null);
    }

    // Handle eraser region selection
    if (eraserStart && eraserStart.pageNum === pageNum && eraserPreview) {
      if (eraserPreview.width > 5 && eraserPreview.height > 5) {
        // Find all text items that intersect with the eraser region
        const page = document.pages[pageNum - 1];
        if (page?.textItems) {
          const itemsToErase: string[] = [];
          page.textItems.forEach((textItem) => {
            // Check if text item intersects with eraser region
            const itemRight = textItem.x + textItem.width;
            const itemBottom = textItem.y + textItem.height;
            const eraserRight = eraserPreview.x + eraserPreview.width;
            const eraserBottom = eraserPreview.y + eraserPreview.height;

            const intersects = !(
              textItem.x > eraserRight ||
              itemRight < eraserPreview.x ||
              textItem.y > eraserBottom ||
              itemBottom < eraserPreview.y
            );

            if (intersects && textItem.str && textItem.str.trim()) {
              itemsToErase.push(textItem.id);
            }
          });

          // Erase all intersecting items
          itemsToErase.forEach((itemId) => {
            onUpdateTextItem(pageNum, itemId, '');
          });
        }
      }
      setEraserStart(null);
      setEraserPreview(null);
    } else if (eraserStart) {
      setEraserStart(null);
      setEraserPreview(null);
    }

    if (highlightStart) {
      setHighlightStart(null);
      setHighlightPreview(null);
    }

    // Finalize drawing
    if (drawingPageNum === pageNum && drawingPoints.length > 2 && onAddDrawing && annotationStyle) {
      onAddDrawing(pageNum, [{
        points: drawingPoints,
        color: annotationStyle.strokeColor,
        width: annotationStyle.strokeWidth,
      }]);
    }
    setDrawingPoints([]);
    setDrawingPageNum(null);

    // Finalize shape
    if (shapeStart && shapeStart.pageNum === pageNum && shapePreview && onAddShape && annotationStyle) {
      if (shapePreview.width > 5 && shapePreview.height > 5) {
        onAddShape(
          pageNum,
          annotationStyle.shapeType,
          { x: shapePreview.x, y: shapePreview.y },
          { width: shapePreview.width, height: shapePreview.height },
          annotationStyle.strokeColor,
          annotationStyle.fillColor,
          annotationStyle.strokeWidth
        );
      }
    }
    setShapeStart(null);
    setShapePreview(null);
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
      // Don't handle delete if we're editing text or if text edit dialog is open
      if (editingAnnotation || textEditDialog.isOpen) return;

      // Delete key works regardless of current tool when something is selected
      if ((e.key === 'Delete' || e.key === 'Backspace') && selectedAnnotation) {
        e.preventDefault();
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
    [selectedAnnotation, editingAnnotation, textEditDialog.isOpen, document.pages, onDeleteAnnotation]
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

  const handleTextItemClick = (
    e: React.MouseEvent,
    pageNum: number,
    textItem: PDFTextItem
  ) => {
    // Handle eraser tool - delete/hide text item on click
    if (currentTool === 'erase') {
      e.stopPropagation();
      e.preventDefault();
      // "Delete" the text by setting it to empty string
      if (onMarkTextDeleted) { onMarkTextDeleted(pageNum, textItem.id, true); }
      return;
    }
  };

  const renderTextItem = (pageNum: number, textItem: PDFTextItem) => {
    const isEditable = true;
    // Don't render if text is empty (was "deleted"), marked as deleted, or in erased set
    if (!textItem.str || textItem.str.trim() === '' || textItem.isDeleted) return null;

    return (
      <div
        key={textItem.id}
        className={`pdf-text-item ${textItem.isEdited ? 'edited' : ''} ${isEditable ? 'editable' : ''} ${textItem.isDeleted ? 'deleted' : ''}`}
        style={{
          left: textItem.x * scale,
          top: textItem.y * scale,
          fontSize: textItem.fontSize * scale,
          width: textItem.width * scale,
          height: textItem.height * scale,
          cursor: currentTool === 'erase' ? 'pointer' : (currentTool === 'select' && isEditable ? 'pointer' : 'default'),
          pointerEvents: currentTool === 'erase' ? 'auto' : undefined,
        }}
        onClick={(e) => handleTextItemClick(e, pageNum, textItem)}
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

    if (annotation.type === 'drawing') {
      const drawAnnotation = annotation as DrawingAnnotation;
      return (
        <svg
          key={annotation.id}
          className={`drawing-annotation ${isSelected ? 'selected' : ''}`}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
          }}
          onClick={(e) => { e.stopPropagation(); }}
        >
          {drawAnnotation.paths.map((path, pathIdx) => {
            if (path.points.length < 2) return null;
            const d = path.points
              .map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x * scale} ${p.y * scale}`)
              .join(' ');
            return (
              <path
                key={`${annotation.id}-path-${pathIdx}`}
                d={d}
                stroke={path.color}
                strokeWidth={path.width * scale}
                fill="none"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ pointerEvents: 'stroke', cursor: currentTool === 'erase' ? 'pointer' : (currentTool === 'select' ? 'pointer' : 'default') }}
                onMouseDown={(e) => {
                  const mouseEvent = e as unknown as React.MouseEvent;
                  handleAnnotationMouseDown(mouseEvent, pageIndex, annotation);
                }}
                onContextMenu={(e) => {
                  const mouseEvent = e as unknown as React.MouseEvent;
                  handleContextMenu(mouseEvent, pageIndex, annotation);
                }}
              />
            );
          })}
        </svg>
      );
    }

    if (annotation.type === 'shape') {
      const shapeAnnotation = annotation as ShapeAnnotation;
      const sx = shapeAnnotation.position.x * scale;
      const sy = shapeAnnotation.position.y * scale;
      const sw = shapeAnnotation.size.width * scale;
      const sh = shapeAnnotation.size.height * scale;

      let shapeEl: React.ReactNode = null;
      const commonProps = {
        stroke: shapeAnnotation.strokeColor,
        strokeWidth: shapeAnnotation.strokeWidth * scale,
        fill: shapeAnnotation.fillColor === 'transparent' ? 'none' : shapeAnnotation.fillColor,
        fillOpacity: shapeAnnotation.fillColor === 'transparent' ? 0 : 0.3,
        style: { pointerEvents: 'stroke' as const, cursor: currentTool === 'erase' ? 'pointer' : (currentTool === 'select' ? 'move' : 'default') },
      };

      if (shapeAnnotation.shapeType === 'rectangle') {
        shapeEl = <rect x={sx} y={sy} width={sw} height={sh} {...commonProps} />;
      } else if (shapeAnnotation.shapeType === 'ellipse') {
        shapeEl = <ellipse cx={sx + sw / 2} cy={sy + sh / 2} rx={sw / 2} ry={sh / 2} {...commonProps} />;
      } else if (shapeAnnotation.shapeType === 'line') {
        shapeEl = <line x1={sx} y1={sy} x2={sx + sw} y2={sy + sh} {...commonProps} />;
      } else if (shapeAnnotation.shapeType === 'arrow') {
        const markerId = `arrow-${annotation.id}`;
        shapeEl = (
          <>
            <defs>
              <marker
                id={markerId}
                markerWidth="10"
                markerHeight="7"
                refX="10"
                refY="3.5"
                orient="auto"
              >
                <polygon
                  points="0 0, 10 3.5, 0 7"
                  fill={shapeAnnotation.strokeColor}
                />
              </marker>
            </defs>
            <line
              x1={sx}
              y1={sy}
              x2={sx + sw}
              y2={sy + sh}
              markerEnd={`url(#${markerId})`}
              {...commonProps}
            />
          </>
        );
      }

      return (
        <svg
          key={annotation.id}
          className={`shape-annotation ${isSelected ? 'selected' : ''}`}
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width: '100%',
            height: '100%',
            pointerEvents: 'none',
            overflow: 'visible',
          }}
        >
          <g
            onMouseDown={(e) => {
              const mouseEvent = e as unknown as React.MouseEvent;
              handleAnnotationMouseDown(mouseEvent, pageIndex, annotation);
            }}
            onContextMenu={(e) => {
              const mouseEvent = e as unknown as React.MouseEvent;
              handleContextMenu(mouseEvent, pageIndex, annotation);
            }}
          >
            {shapeEl}
          </g>
        </svg>
      );
    }

    if (annotation.type === 'note') {
      const noteAnnotation = annotation as StickyNoteAnnotation;
      const isEditingThis = editingNote === annotation.id;

      return (
        <div
          key={annotation.id}
          className={`sticky-note-annotation ${isSelected ? 'selected' : ''} ${isEditingThis ? 'expanded' : ''}`}
          style={{
            left: noteAnnotation.position.x * scale,
            top: noteAnnotation.position.y * scale,
          }}
          onMouseDown={(e) => handleAnnotationMouseDown(e, pageIndex, annotation)}
          onContextMenu={(e) => handleContextMenu(e, pageIndex, annotation)}
          onDoubleClick={(e) => {
            e.stopPropagation();
            if (currentTool === 'select') {
              setEditingNote(annotation.id);
              setSelectedAnnotation(annotation.id);
            }
          }}
        >
          <div className="sticky-note-icon" style={{ backgroundColor: noteAnnotation.color }}>
            <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
              <polyline points="14 2 14 8 20 8" />
              <line x1="16" y1="13" x2="8" y2="13" />
              <line x1="16" y1="17" x2="8" y2="17" />
            </svg>
          </div>
          {isEditingThis && (
            <div className="sticky-note-editor" style={{ backgroundColor: noteAnnotation.color }}>
              <textarea
                className="sticky-note-textarea"
                value={noteAnnotation.content}
                onChange={(e) => {
                  onUpdateAnnotation(pageIndex, annotation.id, { content: e.target.value });
                }}
                onBlur={() => setEditingNote(null)}
                onKeyDown={(e) => {
                  if (e.key === 'Escape') setEditingNote(null);
                }}
                placeholder="Type your note..."
                autoFocus
              />
            </div>
          )}
          {!isEditingThis && noteAnnotation.content && (
            <div className="sticky-note-preview" style={{ backgroundColor: noteAnnotation.color }}>
              {noteAnnotation.content.slice(0, 50)}{noteAnnotation.content.length > 50 ? '...' : ''}
            </div>
          )}
        </div>
      );
    }

    if (annotation.type === 'stamp') {
      const stampAnnotation = annotation as StampAnnotation;
      return (
        <div
          key={annotation.id}
          className={`stamp-annotation ${isSelected ? 'selected' : ''}`}
          style={{
            left: stampAnnotation.position.x * scale,
            top: stampAnnotation.position.y * scale,
            width: stampAnnotation.size.width * scale,
            height: stampAnnotation.size.height * scale,
            borderColor: stampAnnotation.color,
            color: stampAnnotation.color,
            cursor: currentTool === 'erase' ? 'pointer' : (currentTool === 'select' ? 'move' : 'default'),
            fontSize: `${14 * scale}px`,
          }}
          onMouseDown={(e) => handleAnnotationMouseDown(e, pageIndex, annotation)}
          onContextMenu={(e) => handleContextMenu(e, pageIndex, annotation)}
        >
          {stampAnnotation.text}
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
            className={`pdf-page-container ${currentTool === 'highlight' ? 'highlight-mode' : ''} ${currentTool === 'erase' ? 'erase-mode' : ''} ${currentTool === 'text' ? 'text-mode' : ''} ${currentTool === 'draw' ? 'draw-mode' : ''} ${currentTool === 'shape' ? 'shape-mode' : ''} ${currentTool === 'note' ? 'note-mode' : ''} ${currentTool === 'stamp' ? 'stamp-mode' : ''}`}
            style={{
              width: canvas.width,
              height: canvas.height,
            }}
            onClick={() => { setSelectedAnnotation(null); setEditingAnnotation(null); setEditingTextItem(null); setEditingNote(null); }}
            onMouseDown={(e) => handlePageMouseDown(e, pageNum)}
            onMouseMove={(e) => handlePageMouseMove(e, pageNum)}
            onMouseUp={() => handlePageMouseUp(pageNum)}
            onMouseLeave={() => {
              if (highlightStart) { setHighlightStart(null); setHighlightPreview(null); }
              if (eraserStart) { setEraserStart(null); setEraserPreview(null); }
              if (drawingPoints.length > 0) { setDrawingPoints([]); setDrawingPageNum(null); }
              if (shapeStart) { setShapeStart(null); setShapePreview(null); }
            }}
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
              className={`annotation-layer ${currentTool === 'select' || currentTool === 'erase' ? 'active' : ''}`}
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
            {/* Eraser region preview while dragging */}
            {eraserStart && eraserStart.pageNum === pageNum && eraserPreview && (
              <div
                className="eraser-preview"
                style={{
                  left: eraserPreview.x * scale,
                  top: eraserPreview.y * scale,
                  width: eraserPreview.width * scale,
                  height: eraserPreview.height * scale,
                }}
              />
            )}
            {/* Drawing preview while freehand drawing */}
            {drawingPageNum === pageNum && drawingPoints.length > 1 && (
              <svg className="drawing-preview" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none' }}>
                <path
                  d={drawingPoints.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x * scale} ${p.y * scale}`).join(' ')}
                  stroke={annotationStyle?.strokeColor || '#FF0000'}
                  strokeWidth={(annotationStyle?.strokeWidth || 2) * scale}
                  fill="none"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                />
              </svg>
            )}
            {/* Shape preview while dragging */}
            {shapeStart && shapeStart.pageNum === pageNum && shapePreview && (
              <svg className="shape-preview" style={{ position: 'absolute', top: 0, left: 0, width: '100%', height: '100%', pointerEvents: 'none', overflow: 'visible' }}>
                {annotationStyle?.shapeType === 'rectangle' && (
                  <rect
                    x={shapePreview.x * scale}
                    y={shapePreview.y * scale}
                    width={shapePreview.width * scale}
                    height={shapePreview.height * scale}
                    stroke={annotationStyle?.strokeColor || '#FF0000'}
                    strokeWidth={(annotationStyle?.strokeWidth || 2) * scale}
                    fill={annotationStyle?.fillColor === 'transparent' ? 'none' : annotationStyle?.fillColor}
                    fillOpacity={annotationStyle?.fillColor === 'transparent' ? 0 : 0.3}
                    strokeDasharray="5,5"
                  />
                )}
                {annotationStyle?.shapeType === 'ellipse' && (
                  <ellipse
                    cx={(shapePreview.x + shapePreview.width / 2) * scale}
                    cy={(shapePreview.y + shapePreview.height / 2) * scale}
                    rx={(shapePreview.width / 2) * scale}
                    ry={(shapePreview.height / 2) * scale}
                    stroke={annotationStyle?.strokeColor || '#FF0000'}
                    strokeWidth={(annotationStyle?.strokeWidth || 2) * scale}
                    fill={annotationStyle?.fillColor === 'transparent' ? 'none' : annotationStyle?.fillColor}
                    fillOpacity={annotationStyle?.fillColor === 'transparent' ? 0 : 0.3}
                    strokeDasharray="5,5"
                  />
                )}
                {(annotationStyle?.shapeType === 'line' || annotationStyle?.shapeType === 'arrow') && (
                  <line
                    x1={shapeStart.x * scale}
                    y1={shapeStart.y * scale}
                    x2={(shapeStart.x + (shapePreview.x < shapeStart.x ? -shapePreview.width : shapePreview.width)) * scale}
                    y2={(shapeStart.y + (shapePreview.y < shapeStart.y ? -shapePreview.height : shapePreview.height)) * scale}
                    stroke={annotationStyle?.strokeColor || '#FF0000'}
                    strokeWidth={(annotationStyle?.strokeWidth || 2) * scale}
                    strokeDasharray="5,5"
                  />
                )}
              </svg>
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
