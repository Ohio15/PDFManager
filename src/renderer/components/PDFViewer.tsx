import React, { useEffect, useRef, useCallback, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument, Annotation, TextAnnotation, ImageAnnotation, PDFTextItem } from '../types';
import { Tool } from '../App';
interface TextEditDialogState {
  isOpen: boolean;
  pageNum: number;
  textItemId: string;
  originalText: string;
  editedText: string;
}


// Configure PDF.js worker
pdfjsLib.GlobalWorkerOptions.workerSrc = './pdf.worker.min.mjs';

interface PDFViewerProps {
  document: PDFDocument;
  zoom: number;
  currentPage: number;
  onPageChange: (page: number) => void;
  currentTool: Tool;
  onUpdateAnnotation: (pageIndex: number, annotationId: string, updates: Partial<Annotation>) => void;
  onDeleteAnnotation: (pageIndex: number, annotationId: string) => void;
  onUpdateTextItem: (pageIndex: number, textItemId: string, newText: string) => void;
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
  loading,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const [renderedPages, setRenderedPages] = useState<Map<number, HTMLCanvasElement>>(new Map());
  const [selectedAnnotation, setSelectedAnnotation] = useState<string | null>(null);
  const [editingAnnotation, setEditingAnnotation] = useState<string | null>(null);
  const [dragging, setDragging] = useState<{ id: string; startX: number; startY: number; origX: number; origY: number } | null>(null);
  const [editingTextItem, setEditingTextItem] = useState<string | null>(null);
  const [textEditDialog, setTextEditDialog] = useState<TextEditDialogState>({
    isOpen: false,
    pageNum: 0,
    textItemId: '',
    originalText: '',
    editedText: '',
  });

  const scale = zoom / 100;

  useEffect(() => {
    const renderPages = async () => {
      console.log('Starting PDF render, data length:', document.pdfData?.length);
      if (!document.pdfData || document.pdfData.length === 0) {
        console.error('No PDF data available');
        return;
      }
      try {
        // Copy the data to avoid ArrayBuffer detachment issues
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

  const handleAnnotationMouseDown = (
    e: React.MouseEvent,
    pageIndex: number,
    annotation: Annotation
  ) => {
    if (currentTool !== 'select') return;
    e.stopPropagation();

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

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!dragging) return;

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
    },
    [dragging, scale, document.pages, onUpdateAnnotation]
  );

  const handleMouseUp = useCallback(() => {
    setDragging(null);
  }, []);

  useEffect(() => {
    if (dragging) {
      window.addEventListener('mousemove', handleMouseMove);
      window.addEventListener('mouseup', handleMouseUp);
      return () => {
        window.removeEventListener('mousemove', handleMouseMove);
        window.removeEventListener('mouseup', handleMouseUp);
      };
    }
  }, [dragging, handleMouseMove, handleMouseUp]);

  const handleKeyDown = useCallback(
    (e: KeyboardEvent) => {
      if (e.key === 'Delete' && selectedAnnotation) {
        const pageIndex = document.pages.findIndex((p) =>
          p.annotations.some((a) => a.id === selectedAnnotation)
        );
        if (pageIndex !== -1) {
          onDeleteAnnotation(pageIndex + 1, selectedAnnotation);
          setSelectedAnnotation(null);
        }
      }
    },
    [selectedAnnotation, document.pages, onDeleteAnnotation]
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

    // Open dialog for editing
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
    // All text items are editable
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

  const renderAnnotation = (pageIndex: number, annotation: Annotation) => {
    const isSelected = selectedAnnotation === annotation.id;
    const isEditing = editingAnnotation === annotation.id;

    if (annotation.type === 'text') {
      const textAnnotation = annotation as TextAnnotation;
      return (
        <div
          key={annotation.id}
          className={`editable-text ${isSelected ? 'selected' : ''} ${isEditing ? 'editing' : ''}`}
          style={{
            left: textAnnotation.position.x * scale,
            top: textAnnotation.position.y * scale,
            fontSize: textAnnotation.fontSize * scale,
            fontFamily: textAnnotation.fontFamily,
            color: textAnnotation.color,
            cursor: isEditing ? 'text' : (currentTool === 'select' ? 'move' : 'default'),
          }}
          onMouseDown={(e) => !isEditing && handleAnnotationMouseDown(e, pageIndex, annotation)}
          onDoubleClick={(e) => handleAnnotationDoubleClick(e, annotation)}
          contentEditable={isEditing}
          suppressContentEditableWarning
          onBlur={(e) =>
            handleTextChange(pageIndex, annotation.id, e.currentTarget.textContent || '')
          }
        >
          {textAnnotation.content}
        </div>
      );
    }

    if (annotation.type === 'image') {
      const imageAnnotation = annotation as ImageAnnotation;
      return (
        <div
          key={annotation.id}
          className={`editable-image ${isSelected ? 'selected' : ''}`}
          style={{
            left: imageAnnotation.position.x * scale,
            top: imageAnnotation.position.y * scale,
            width: imageAnnotation.size.width * scale,
            height: imageAnnotation.size.height * scale,
            cursor: currentTool === 'select' ? 'move' : 'default',
          }}
          onMouseDown={(e) => handleAnnotationMouseDown(e, pageIndex, annotation)}
        >
          <img
            src={`data:image/${imageAnnotation.imageType};base64,${imageAnnotation.data}`}
            alt="Annotation"
            style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            draggable={false}
          />
          {isSelected && (
            <>
              <div className="resize-handle nw" />
              <div className="resize-handle ne" />
              <div className="resize-handle sw" />
              <div className="resize-handle se" />
            </>
          )}
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
            className="pdf-page-container"
            style={{
              width: canvas.width,
              height: canvas.height,
            }}
            onClick={() => { setSelectedAnnotation(null); setEditingAnnotation(null); setEditingTextItem(null); }}
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
          </div>
        );
      })}
    

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
