import React, { useEffect, useRef, useState, useCallback } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { FileText, Bookmark, ChevronRight, ChevronDown } from 'lucide-react';
import { PDFDocument } from '../types';

export type SidebarTab = 'pages' | 'bookmarks';

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
}

const Sidebar: React.FC<SidebarProps> = ({
  visible,
  document,
  currentPage,
  onPageSelect,
  onReorderPages,
}) => {
  const [thumbnails, setThumbnails] = useState<string[]>([]);
  const [activeTab, setActiveTab] = useState<SidebarTab>('pages');
  const [outline, setOutline] = useState<OutlineItem[]>([]);
  const [sidebarWidth, setSidebarWidth] = useState(200);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);
  const resizeRef = useRef<{ startX: number; startWidth: number } | null>(null);

  // Generate thumbnails
  useEffect(() => {
    if (!document) {
      setThumbnails([]);
      return;
    }

    const generateThumbnails = async () => {
      try {
        const dataCopy = new Uint8Array(document.pdfData);
        const pdfDoc = await pdfjsLib.getDocument({ data: dataCopy }).promise;
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
        const pdfDoc = await pdfjsLib.getDocument({ data: dataCopy }).promise;
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

  // Page reorder drag handlers
  const handleDragStart = useCallback((e: React.DragEvent, index: number) => {
    setDragIndex(index);
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', String(index));
    const el = e.currentTarget as HTMLElement;
    el.style.opacity = '0.5';
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    const el = e.currentTarget as HTMLElement;
    el.style.opacity = '1';
    setDragIndex(null);
    setDropIndex(null);
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    setDropIndex(index);
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, toIndex: number) => {
    e.preventDefault();
    if (dragIndex !== null && dragIndex !== toIndex && onReorderPages) {
      onReorderPages(dragIndex, toIndex);
    }
    setDragIndex(null);
    setDropIndex(null);
  }, [dragIndex, onReorderPages]);

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
      </div>

      {/* Pages Tab */}
      {activeTab === 'pages' && (
        <div className="sidebar-content" ref={containerRef}>
          {thumbnails.map((thumbnail, index) => (
            <div
              key={index}
              className={`page-thumbnail ${currentPage === index + 1 ? 'active' : ''} ${dragIndex === index ? 'dragging-source' : ''} ${dropIndex === index && dragIndex !== index ? 'drop-target' : ''}`}
              onClick={() => onPageSelect(index + 1)}
              draggable={!!onReorderPages}
              onDragStart={(e) => handleDragStart(e, index)}
              onDragEnd={handleDragEnd}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={(e) => handleDrop(e, index)}
            >
              <img
                src={thumbnail}
                alt={`Page ${index + 1}`}
                style={{
                  transform: document?.pages[index]?.rotation
                    ? `rotate(${document.pages[index].rotation}deg)`
                    : undefined,
                }}
                draggable={false}
              />
              <span className="page-number">{index + 1}</span>
            </div>
          ))}
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

      {/* Resize handle */}
      <div
        className={`sidebar-resize-handle ${isResizing ? 'active' : ''}`}
        onMouseDown={handleResizeStart}
      />
    </div>
  );
};

export default Sidebar;
