import React, { useEffect, useRef, useState, useCallback, useMemo } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { FileText, Bookmark, ChevronRight, ChevronDown, MessageSquare, Type, Image, Highlighter, Pencil, Shapes, StickyNote, Stamp, Trash2, AlertCircle, Link, Eye, RotateCcw, RotateCw, Copy, Crop, FileOutput, FilePlus2, FileInput, Replace } from 'lucide-react';
import { PDFDocument, Annotation, PDFSourceAnnotation } from '../types';
import { PDFJS_DOCUMENT_OPTIONS } from '../utils/pdfjsConfig';
import { dropGap, PageClickModifiers } from '../utils/pageSelectionModel';
import '../styles/pageTools.css';

/** Drag payload type for moving pages within the sidebar (never set by external drags). */
const PAGE_DRAG_MIME = 'application/x-pdfmanager-pages';

export type SidebarTab = 'pages' | 'bookmarks' | 'annotations';

interface OutlineItem {
  title: string;
  pageIndex: number;
  children: OutlineItem[];
  expanded: boolean;
}

interface SidebarProps {
  visible: boolean;
  document: PDFDocument | null;
  currentPage: number;
  onPageSelect: (page: number) => void;
  onReorderPages?: (fromIndex: number, toIndex: number) => void;
  onDeleteAnnotation?: (pageIndex: number, annotationId: string) => void;
  onSelectAnnotation?: (annotationId: string) => void;
  onInsertBlankPage?: (afterPageIndex: number) => void;
  onReplacePage?: (pageIndex: number) => void;
  onDeletePage?: (pageIndex: number) => void;
  // --- Page tools (all indices 0-based) ---
  /** Explicitly selected pages. */
  selectedPages?: number[];
  /** Thumbnail click with modifiers; when set it replaces onPageSelect for clicks. */
  onPageClick?: (index: number, mods: PageClickModifiers) => void;
  onSelectAll?: () => void;
  /** Move pages into gap `beforeIndex` (0..pageCount). Preferred over onReorderPages. */
  onMovePages?: (indices: number[], beforeIndex: number) => void;
  onRotatePages?: (indices: number[], delta: number) => void;
  onDuplicatePages?: (indices: number[]) => void;
  onDeletePages?: (indices: number[]) => void;
  onExtractPages?: (indices: number[]) => void;
  onCropPages?: (indices: number[]) => void;
  /** Insert another PDF's pages into gap `beforeIndex`. */
  onInsertPdfAt?: (beforeIndex: number) => void;
}

const Sidebar: React.FC<SidebarProps> = ({
  visible,
  document,
  currentPage,
  onPageSelect,
  onReorderPages,
  onDeleteAnnotation,
  onSelectAnnotation,
  onInsertBlankPage,
  onReplacePage,
  onDeletePage,
  selectedPages,
  onPageClick,
  onSelectAll,
  onMovePages,
  onRotatePages,
  onDuplicatePages,
  onDeletePages,
  onExtractPages,
  onCropPages,
  onInsertPdfAt,
}) => {
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [dropGapIndex, setDropGapIndex] = useState<number | null>(null);
  const dragSetRef = useRef<number[] | null>(null);
  const selectedSet = useMemo(() => new Set(selectedPages ?? []), [selectedPages]);
  const [activeTab, setActiveTab] = useState<SidebarTab>('pages');
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(200);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const [annotationFilter, setAnnotationFilter] = useState<string>('all');
  const [pageContextMenu, setPageContextMenu] = useState<{ isOpen: boolean; x: number; y: number; pageIndex: number }>({
    isOpen: false, x: 0, y: 0, pageIndex: 0,
  });
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Compute flat annotation list across all pages
  const allAnnotations = useMemo(() => {
    if (!document) return [];
    const items: Array<{ annotation: Annotation; pageIndex: number }> = [];
    document.pages.forEach((page, idx) => {
      page.annotations.forEach((ann) => {
        items.push({ annotation: ann, pageIndex: idx + 1 });
      });
    });
    if (annotationFilter !== 'all') {
      return items.filter((item) => item.annotation.type === annotationFilter);
    }
    return items;
  }, [document, annotationFilter]);

  // Compute source (PDF-embedded) annotations across all pages
  const sourceAnnotations = useMemo(() => {
    if (!document) return [];
    const items: Array<{ annotation: PDFSourceAnnotation; pageIndex: number }> = [];
    document.pages.forEach((page, idx) => {
      if (page.sourceAnnotations) {
        page.sourceAnnotations.forEach((ann) => {
          items.push({ annotation: ann, pageIndex: idx + 1 });
        });
      }
    });
    return items;
  }, [document]);

  // Generate thumbnails
  useEffect(() => {
    if (!document) {
      setThumbnails([]);
      return;
    }

    const generateThumbnails = async () => {
      try {
        const dataCopy = new Uint8Array(document.pdfData);
        const pdfDoc = await pdfjsLib.getDocument({ ...PDFJS_DOCUMENT_OPTIONS, data: dataCopy }).promise;
        const newThumbnails: string[] = [];

        for (let i = 1; i <= pdfDoc.numPages; i++) {
          const page = await pdfDoc.getPage(i);
          const viewport = page.getViewport({ scale: 0.2 });

          const canvas = window.document.createElement('canvas');
          const context = canvas.getContext('2d');
          canvas.width = viewport.width;
          canvas.height = viewport.height;

          await page.render({
            canvasContext: context!,
            viewport,
          }).promise;

          newThumbnails.push(canvas.toDataURL());
        }

        setThumbnails(newThumbnails);
      } catch (error) {
        console.error('Failed to generate thumbnails:', error);
      }
    };

    generateThumbnails();
  }, [document]);

  // Extract bookmarks/outline from PDF
  useEffect(() => {
    if (!document) {
      setOutline([]);
      return;
    }

    const extractOutline = async () => {
      try {
        const dataCopy = new Uint8Array(document.pdfData);
        const pdfDoc = await pdfjsLib.getDocument({ ...PDFJS_DOCUMENT_OPTIONS, data: dataCopy }).promise;
        const rawOutline = await pdfDoc.getOutline();

        if (!rawOutline || rawOutline.length === 0) {
          setOutline([]);
          return;
        }

        const convertOutline = async (items: any[]): Promise<OutlineItem[]> => {
          const result: OutlineItem[] = [];
          for (const item of items) {
            let pageIndex = 0;
            try {
              if (item.dest) {
                let dest = item.dest;
                if (typeof dest === 'string') {
                  dest = await pdfDoc.getDestination(dest);
                }
                if (dest && dest[0]) {
                  const pageRef = dest[0];
                  const pageIdx = await pdfDoc.getPageIndex(pageRef);
                  pageIndex = pageIdx;
                }
              }
            } catch {
              pageIndex = 0;
            }

            const children = item.items ? await convertOutline(item.items) : [];
            result.push({
              title: item.title,
              pageIndex: pageIndex + 1,
              children,
              expanded: false,
            });
          }
          return result;
        };

        const converted = await convertOutline(rawOutline);
        setOutline(converted);
      } catch (error) {
        console.error('Failed to extract outline:', error);
        setOutline([]);
      }
    };

    extractOutline();
  }, [document]);

  // Auto-scroll to current page thumbnail
  useEffect(() => {
    if (containerRef.current && currentPage > 0 && activeTab === 'pages') {
      const thumbnail = containerRef.current.children[currentPage - 1] as HTMLElement;
      if (thumbnail) {
        thumbnail.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      }
    }
  }, [currentPage, activeTab]);

  // Resize handler
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsResizing(true);
    resizeRef.current = { startX: e.clientX, startWidth: sidebarWidth };

    const handleMouseMove = (ev: MouseEvent) => {
      if (resizeRef.current) {
        const delta = ev.clientX - resizeRef.current.startX;
        const newWidth = Math.max(150, Math.min(400, resizeRef.current.startWidth + delta));
        setSidebarWidth(newWidth);
      }
    };

    const handleMouseUp = () => {
      setIsResizing(false);
      resizeRef.current = null;
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
  }, [sidebarWidth]);

  // Close page context menu on click outside
  useEffect(() => {
    if (!pageContextMenu.isOpen) return;
    const handleClick = () => setPageContextMenu(prev => ({ ...prev, isOpen: false }));
    window.addEventListener('click', handleClick);
    return () => window.removeEventListener('click', handleClick);
  }, [pageContextMenu.isOpen]);

  // Page reorder drag handlers
  /** Pages an action on `index` applies to: the selection if it contains it, else just that page. */
  const targetsFor = useCallback((index: number): number[] => {
    if (selectedSet.has(index) && selectedSet.size > 0) return [...selectedSet].sort((a, b) => a - b);
    return [index];
  }, [selectedSet]);

  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    const moving = onMovePages ? targetsFor(index) : [index];
    if (onPageClick && !selectedSet.has(index)) onPageClick(index, { ctrl: false, shift: false });
    dragSetRef.current = moving;
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    // A private MIME type marks an internal page move, so drags of external
    // files over the thumbnails are never mistaken for one.
    e.dataTransfer.setData(PAGE_DRAG_MIME, JSON.stringify(moving));
    e.dataTransfer.setData('text/plain', String(index));
  }, [onMovePages, onPageClick, selectedSet, targetsFor]);

  const handleDragEnd = useCallback(() => {
    dragSetRef.current = null;
    setDragIndex(null);
    setDropIndex(null);
    setDropGapIndex(null);
  }, []);

  const isPageDrag = (e: React.DragEvent) => e.dataTransfer.types.includes(PAGE_DRAG_MIME);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    if (!isPageDrag(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    setDropIndex(index);
    setDropGapIndex(dropGap(index, e.clientY < rect.top + rect.height / 2));
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    if (!isPageDrag(e)) return;
    e.preventDefault();
    e.stopPropagation();
    const moving = dragSetRef.current;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const gap = dropGap(toIndex, e.clientY < rect.top + rect.height / 2);
    if (moving && onMovePages) {
      onMovePages(moving, gap);
    } else if (dragIndex !== null && dragIndex !== toIndex && onReorderPages) {
      onReorderPages(dragIndex, toIndex);
    }
    handleDragEnd();
  }, [dragIndex, onMovePages, onReorderPages, handleDragEnd]);

  const handleThumbnailClick = useCallback((e: React.MouseEvent, index: number) => {
    if (onPageClick) {
      onPageClick(index, { ctrl: e.ctrlKey || e.metaKey, shift: e.shiftKey });
    } else {
      onPageSelect(index + 1);
    }
  }, [onPageClick, onPageSelect]);

  const handlePagesKeyDown = useCallback((e: React.KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a' && onSelectAll) {
      e.preventDefault();
      e.stopPropagation();
      onSelectAll();
    } else if (e.key === 'Delete' && onDeletePages && document) {
      const targets = targetsFor(currentPage - 1);
      e.preventDefault();
      e.stopPropagation();
      if (targets.length < document.pages.length) onDeletePages(targets);
    }
  }, [onSelectAll, onDeletePages, document, targetsFor, currentPage]);

  // Toggle outline item expansion
  const toggleOutlineItem = useCallback((path: number[]) => {
    setOutline(prev => {
      const newOutline = JSON.parse(JSON.stringify(prev));
      let current = newOutline;
      for (let i = 0; i < path.length - 1; i++) {
        current = current[path[i]].children;
      }
      current[path[path.length - 1]].expanded = !current[path[path.length - 1]].expanded;
      return newOutline;
    });
  }, []);

  const renderOutlineItems = (items: OutlineItem[], path: number[] = [], depth: number = 0): React.ReactNode => {
    return items.map((item, index) => {
      const currentPath = [...path, index];
      const hasChildren = item.children.length > 0;

      return (
        <React.Fragment key={currentPath.join('-')}>
          <button
            className={`outline-item ${item.pageIndex === currentPage ? 'active' : ''}`}
            style={{ paddingLeft: `${12 + depth * 16}px` }}
            onClick={() => {
              if (hasChildren) {
                toggleOutlineItem(currentPath);
              }
              onPageSelect(item.pageIndex);
            }}
            title={`${item.title} (Page ${item.pageIndex})`}
          >
            {hasChildren && (
              <span className="outline-toggle">
                {item.expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
              </span>
            )}
            <span className="outline-title">{item.title}</span>
            <span className="outline-page">{item.pageIndex}</span>
          </button>
          {hasChildren && item.expanded && renderOutlineItems(item.children, currentPath, depth + 1)}
        </React.Fragment>
      );
    });
  };

  const getAnnotationIcon = (type: string) => {
    switch (type) {
      case 'text': return <Type size={13} />;
      case 'image': return <Image size={13} />;
      case 'highlight': return <Highlighter size={13} />;
      case 'drawing': return <Pencil size={13} />;
      case 'shape': return <Shapes size={13} />;
      case 'note': return <StickyNote size={13} />;
      case 'stamp': return <Stamp size={13} />;
      default: return <MessageSquare size={13} />;
    }
  };

  const getAnnotationLabel = (ann: Annotation): string => {
    switch (ann.type) {
      case 'text': return ann.content.slice(0, 30) || 'Text';
      case 'image': return 'Image';
      case 'highlight': return 'Highlight';
      case 'drawing': return `Drawing (${ann.paths.length} stroke${ann.paths.length !== 1 ? 's' : ''})`;
      case 'shape': return ann.shapeType.charAt(0).toUpperCase() + ann.shapeType.slice(1);
      case 'note': return ann.content.slice(0, 30) || 'Empty note';
      case 'stamp': return ann.text;
      default: return 'Annotation';
    }
  };

  if (!visible) {
    return null;
  }

  return (
    <div className="sidebar" style={{ width: sidebarWidth }}>
      {/* Tabs */}
      <div className="sidebar-tabs">
        <button
          className={`sidebar-tab ${activeTab === 'pages' ? 'active' : ''}`}
          onClick={() => setActiveTab('pages')}
          title="Page thumbnails"
        >
          <FileText size={14} />
          <span>Pages</span>
        </button>
        <button
          className={`sidebar-tab ${activeTab === 'bookmarks' ? 'active' : ''}`}
          onClick={() => setActiveTab('bookmarks')}
          title="Bookmarks / Outline"
        >
          <Bookmark size={14} />
          <span>Bookmarks</span>
        </button>
        <button
          className={`sidebar-tab ${activeTab === 'annotations' ? 'active' : ''}`}
          onClick={() => setActiveTab('annotations')}
          title="Annotations"
        >
          <MessageSquare size={14} />
          <span>Annotations</span>
        </button>
      </div>

      {/* Pages Tab */}
      {activeTab === 'pages' && (
        <div
          className="sidebar-content pages-content"
          ref={containerRef}
          tabIndex={0}
          onKeyDown={handlePagesKeyDown}
          aria-label="Page thumbnails"
          aria-multiselectable={!!onPageClick}
          role="listbox"
        >
          {(document?.pages || []).map((_page, index) => {
            const thumbnail = thumbnails[index];
            const isSelected = selectedSet.has(index);
            const showGap = dragIndex !== null && dropIndex === index && dropGapIndex !== null;
            return (
              <div
                key={index}
                data-page-index={index}
                role="option"
                aria-selected={isSelected || currentPage === index + 1}
                className={`page-thumbnail ${currentPage === index + 1 ? 'active' : ''} ${isSelected ? 'selected' : ''} ${dragIndex === index ? 'dragging-source' : ''} ${showGap && dropGapIndex === index ? 'drop-before' : ''} ${showGap && dropGapIndex === index + 1 ? 'drop-after' : ''}`}
                onClick={(e) => handleThumbnailClick(e, index)}
                draggable={!!(onMovePages || onReorderPages)}
                onDragStart={(e) => handleDragStart(e, index)}
                onDragEnd={handleDragEnd}
                onDragOver={(e) => handleDragOver(e, index)}
                onDrop={(e) => handleDrop(e, index)}
                onContextMenu={(e) => {
                  e.preventDefault();
                  e.stopPropagation();
                  // Right-clicking outside the selection retargets it to this page.
                  if (onPageClick && !isSelected) onPageClick(index, { ctrl: false, shift: false });
                  setPageContextMenu({ isOpen: true, x: e.clientX, y: e.clientY, pageIndex: index + 1 });
                }}
              >
                {thumbnail ? (
                  // The thumbnail is rendered by pdf.js from bytes that already
                  // carry /Rotate, so it must not be rotated again with CSS.
                  <img src={thumbnail} alt={`Page ${index + 1}`} draggable={false} />
                ) : (
                  <div className="thumbnail-skeleton">
                    <div className="thumbnail-skeleton-shimmer" />
                  </div>
                )}
                {isSelected && selectedSet.size > 1 && <span className="page-select-badge">✓</span>}
                <span className="page-number">{index + 1}</span>
              </div>
            );
          })}
        </div>
      )}

      {/* Bookmarks Tab */}
      {activeTab === 'bookmarks' && (
        <div className="sidebar-content outline-content">
          {outline.length > 0 ? (
            renderOutlineItems(outline)
          ) : (
            <div className="outline-empty">
              <Bookmark size={24} />
              <p>No bookmarks</p>
              <span>This document has no outline or table of contents.</span>
            </div>
          )}
        </div>
      )}

      {/* Annotations Tab */}
      {activeTab === 'annotations' && (
        <div className="sidebar-content annotations-content">
          {/* Filter bar */}
          <div className="annotations-filter">
            <select
              className="annotations-filter-select"
              value={annotationFilter}
              onChange={(e) => setAnnotationFilter(e.target.value)}
            >
              <option value="all">All Types</option>
              <option value="text">Text</option>
              <option value="highlight">Highlights</option>
              <option value="drawing">Drawings</option>
              <option value="shape">Shapes</option>
              <option value="note">Notes</option>
              <option value="stamp">Stamps</option>
              <option value="image">Images</option>
            </select>
            <span className="annotations-count">{allAnnotations.length}</span>
          </div>

          {/* PDF Source Annotations */}
          {sourceAnnotations.length > 0 && (
            <div className="source-annotations-section">
              <div className="source-annotations-header">
                <Eye size={13} />
                <span>PDF Annotations ({sourceAnnotations.length})</span>
              </div>
              <div className="annotations-list">
                {sourceAnnotations.map(({ annotation: ann, pageIndex }) => (
                  <div
                    key={ann.id}
                    className="annotation-list-item source-annotation"
                    onClick={() => onPageSelect(pageIndex)}
                    title={ann.contents || ann.subtype}
                  >
                    <span className="annotation-list-icon">
                      {ann.subtype === 'Link' ? <Link size={13} /> :
                       ann.subtype === 'Text' ? <MessageSquare size={13} /> :
                       ann.subtype === 'FreeText' ? <Type size={13} /> :
                       ann.subtype === 'Highlight' ? <Highlighter size={13} /> :
                       ann.subtype === 'Underline' ? <Type size={13} /> :
                       ann.subtype === 'StrikeOut' ? <Type size={13} /> :
                       ann.subtype === 'Stamp' ? <Stamp size={13} /> :
                       <AlertCircle size={13} />}
                    </span>
                    <div className="annotation-list-info">
                      <span className="annotation-list-label">
                        {ann.contents ? ann.contents.slice(0, 40) : ann.subtype}
                        {ann.author ? ` — ${ann.author}` : ''}
                      </span>
                      <span className="annotation-list-page">
                        Page {pageIndex} · {ann.subtype}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          {allAnnotations.length > 0 ? (
            <div className="annotations-list">
              {allAnnotations.map(({ annotation, pageIndex }) => (
                <div
                  key={annotation.id}
                  className="annotation-list-item"
                  onClick={() => {
                    onPageSelect(pageIndex);
                    onSelectAnnotation?.(annotation.id);
                  }}
                >
                  <span className="annotation-list-icon">
                    {getAnnotationIcon(annotation.type)}
                  </span>
                  <div className="annotation-list-info">
                    <span className="annotation-list-label">
                      {getAnnotationLabel(annotation)}
                    </span>
                    <span className="annotation-list-page">
                      Page {pageIndex}
                    </span>
                  </div>
                  {onDeleteAnnotation && (
                    <button
                      className="annotation-list-delete"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDeleteAnnotation(pageIndex, annotation.id);
                      }}
                      title="Delete annotation"
                    >
                      <Trash2 size={12} />
                    </button>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="outline-empty">
              <MessageSquare size={24} />
              <p>No annotations</p>
              <span>{annotationFilter !== 'all' ? 'No matching annotations found.' : 'Use the toolbar to add annotations.'}</span>
            </div>
          )}
        </div>
      )}

      {/* Page Context Menu */}
      {pageContextMenu.isOpen && (() => {
        const clicked = pageContextMenu.pageIndex - 1;
        const targets = targetsFor(clicked);
        const many = targets.length > 1;
        const label = many ? `${targets.length} pages` : 'page';
        const total = document?.pages.length ?? 0;
        const close = () => setPageContextMenu(prev => ({ ...prev, isOpen: false }));
        const act = (fn: () => void) => () => { fn(); close(); };
        const first = targets[0];
        const last = targets[targets.length - 1];
        return (
          <div
            className="page-context-menu"
            role="menu"
            style={{ position: 'fixed', left: pageContextMenu.x, top: pageContextMenu.y, zIndex: 1000 }}
            onClick={(e) => e.stopPropagation()}
          >
            {many && <div className="context-menu-header">{targets.length} pages selected</div>}
            {onRotatePages && (
              <>
                <button className="context-menu-item" role="menuitem" onClick={act(() => onRotatePages(targets, -90))}>
                  <RotateCcw size={13} /> Rotate {label} left
                </button>
                <button className="context-menu-item" role="menuitem" onClick={act(() => onRotatePages(targets, 90))}>
                  <RotateCw size={13} /> Rotate {label} right
                </button>
              </>
            )}
            {onDuplicatePages && (
              <button className="context-menu-item" role="menuitem" onClick={act(() => onDuplicatePages(targets))}>
                <Copy size={13} /> Duplicate {label}
              </button>
            )}
            {onCropPages && (
              <button className="context-menu-item" role="menuitem" onClick={act(() => onCropPages(targets))}>
                <Crop size={13} /> Crop {label}…
              </button>
            )}
            {onExtractPages && (
              <button className="context-menu-item" role="menuitem" onClick={act(() => onExtractPages(targets))}>
                <FileOutput size={13} /> Extract {label} to new PDF…
              </button>
            )}
            <div className="context-menu-separator" />
            {onInsertBlankPage && (
              <>
                <button className="context-menu-item" role="menuitem" onClick={act(() => onInsertBlankPage(first))}>
                  <FilePlus2 size={13} /> Insert blank page before
                </button>
                <button className="context-menu-item" role="menuitem" onClick={act(() => onInsertBlankPage(last + 1))}>
                  <FilePlus2 size={13} /> Insert blank page after
                </button>
              </>
            )}
            {onInsertPdfAt && (
              <>
                <button className="context-menu-item" role="menuitem" onClick={act(() => onInsertPdfAt(first))}>
                  <FileInput size={13} /> Insert pages from PDF before…
                </button>
                <button className="context-menu-item" role="menuitem" onClick={act(() => onInsertPdfAt(last + 1))}>
                  <FileInput size={13} /> Insert pages from PDF after…
                </button>
              </>
            )}
            {onReplacePage && !many && (
              <button className="context-menu-item" role="menuitem" onClick={act(() => onReplacePage(pageContextMenu.pageIndex))}>
                <Replace size={13} /> Replace page…
              </button>
            )}
            {(onDeletePages || onDeletePage) && (
              <>
                <div className="context-menu-separator" />
                <button
                  className="context-menu-item danger"
                  role="menuitem"
                  disabled={targets.length >= total}
                  title={targets.length >= total ? 'A document must keep at least one page' : undefined}
                  onClick={act(() => {
                    if (onDeletePages) onDeletePages(targets);
                    else onDeletePage?.(pageContextMenu.pageIndex);
                  })}
                >
                  <Trash2 size={13} /> Delete {label}
                </button>
              </>
            )}
          </div>
        );
      })()}


      {/* Resize handle */}
      <div
        className={`sidebar-resize-handle ${isResizing ? 'active' : ''}`}
        onMouseDown={handleResizeStart}
      />
    </div>
  );
};

export default Sidebar;
