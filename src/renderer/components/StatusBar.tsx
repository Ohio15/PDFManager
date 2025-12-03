import React from 'react';
import { PDFDocument } from '../types';

interface StatusBarProps {
  document: PDFDocument | null;
  currentPage: number;
  zoom: number;
  modified: boolean;
}

const StatusBar: React.FC<StatusBarProps> = ({
  document,
  currentPage,
  zoom,
  modified,
}) => {
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
        {modified && ' *'}
      </span>
      <span>
        Page {currentPage} of {document.pageCount}
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
