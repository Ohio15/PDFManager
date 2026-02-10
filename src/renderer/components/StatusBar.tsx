import React, { useState, useRef, useEffect, useCallback } from 'react';
import { PDFDocument } from '../types';

interface StatusBarProps {
  document: PDFDocument | null;
  currentPage: number;
  zoom: number;
  modified: boolean;
  onPageChange?: (page: number) => void;
  onZoomChange?: (zoom: number) => void;
}

const StatusBar: React.FC<StatusBarProps> = ({
  document,
  currentPage,
  zoom,
  modified,
  onPageChange,
  onZoomChange,
}) => {
  const [editingPage, setEditingPage] = useState(false);
  const [pageInput, setPageInput] = useState('');
  const pageInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editingPage && pageInputRef.current) {
      pageInputRef.current.focus();
      pageInputRef.current.select();
    }
  }, [editingPage]);

  const handlePageClick = useCallback(() => {
    if (document && onPageChange) {
      setPageInput(String(currentPage));
      setEditingPage(true);
    }
  }, [document, currentPage, onPageChange]);

  const commitPageChange = useCallback(() => {
    const page = parseInt(pageInput, 10);
    if (!isNaN(page) && document && page >= 1 && page <= document.pageCount) {
      onPageChange?.(page);
    }
    setEditingPage(false);
  }, [pageInput, document, onPageChange]);

  const handlePageKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key === 'Enter') {
      commitPageChange();
    } else if (e.key === 'Escape') {
      setEditingPage(false);
    }
  }, [commitPageChange]);

  if (!document) {
    return (
      <div className="status-bar">
        <span>No document open</span>
      </div>
    );
  }

  return (
    <div className="status-bar">
      <span>
        {document.fileName}
        {modified && <span className="modified-indicator" />}
      </span>
      <span
        className={`status-page-indicator ${onPageChange ? 'clickable' : ''}`}
        onClick={handlePageClick}
        title={onPageChange ? 'Click to go to page' : undefined}
      >
        {editingPage ? (
          <>
            <input
              ref={pageInputRef}
              type="number"
              className="status-page-input"
              value={pageInput}
              onChange={(e) => setPageInput(e.target.value)}
              onBlur={commitPageChange}
              onKeyDown={handlePageKeyDown}
              min={1}
              max={document.pageCount}
            />
            <span>of {document.pageCount}</span>
          </>
        ) : (
          <>
            Page {currentPage} of {document.pageCount}
          </>
        )}
      </span>
      <span>Zoom: {zoom}%</span>
      {document.filePath && (
        <span style={{ marginLeft: 'auto', opacity: 0.7 }}>
          {document.filePath}
        </span>
      )}
    </div>
  );
};

export default StatusBar;
