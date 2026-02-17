import React, { useState, useCallback } from 'react';
import { FileText, Upload, Clock, Trash2, FolderOpen } from 'lucide-react';

interface WelcomeScreenProps {
  onOpenFile: () => void;
  onBatchConvert?: () => void;
  onFileDropped?: (filePath: string) => void;
  recentFiles?: string[];
  onOpenRecentFile?: (filePath: string) => void;
  onClearRecentFiles?: () => void;
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  onOpenFile,
  onBatchConvert,
  onFileDropped,
  recentFiles = [],
  onOpenRecentFile,
  onClearRecentFiles,
}) => {
  const [isDragging, setIsDragging] = useState(false);

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  }, []);

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  }, []);

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      e.stopPropagation();
      setIsDragging(false);

      const files = e.dataTransfer.files;
      if (files.length > 0) {
        const file = files[0];
        const filePath = (file as any).path;
        const fileName = file.name.toLowerCase();

        if (!filePath) {
          // Fallback to dialog if path not available
          onOpenFile();
          return;
        }

        // Only accept PDF files
        if (file.type === 'application/pdf' || fileName.endsWith('.pdf')) {
          if (onFileDropped) {
            onFileDropped(filePath);
          }
        }
      }
    },
    [onOpenFile, onFileDropped]
  );

  const getFileName = (filePath: string) => {
    const parts = filePath.replace(/\\/g, '/').split('/');
    return parts[parts.length - 1];
  };

  const getFileDir = (filePath: string) => {
    const normalized = filePath.replace(/\\/g, '/');
    const lastSlash = normalized.lastIndexOf('/');
    return lastSlash > 0 ? normalized.substring(0, lastSlash) : '';
  };

  return (
    <div
      className={`pdf-viewer ${isDragging ? 'dragging' : ''}`}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <div className="welcome-screen">
        <FileText className="welcome-icon" />
        <h1 className="welcome-title">PDF Manager</h1>
        <p className="welcome-text">
          Open a PDF to edit, annotate, merge, split, and more.
        </p>
        <div className="welcome-buttons">
          <button className="welcome-btn" onClick={onOpenFile}>
            <Upload size={20} />
            Open PDF File
          </button>
          {onBatchConvert && (
            <button className="welcome-btn welcome-btn-secondary" onClick={onBatchConvert}>
              <FolderOpen size={20} />
              Batch Convert to Word
            </button>
          )}
        </div>

        {/* Recent Files */}
        {recentFiles.length > 0 && (
          <div className="recent-files-section">
            <div className="recent-files-header">
              <div className="recent-files-title">
                <Clock size={14} />
                <span>Recent Files</span>
              </div>
              {onClearRecentFiles && (
                <button
                  className="recent-files-clear"
                  onClick={onClearRecentFiles}
                  title="Clear recent files"
                >
                  <Trash2 size={12} />
                  Clear
                </button>
              )}
            </div>
            <div className="recent-files-list">
              {recentFiles.slice(0, 8).map((filePath, index) => (
                <button
                  key={index}
                  className="recent-file-item"
                  onClick={() => onOpenRecentFile?.(filePath)}
                  title={filePath}
                >
                  <FileText size={16} className="recent-file-icon" />
                  <div className="recent-file-info">
                    <span className="recent-file-name">{getFileName(filePath)}</span>
                    <span className="recent-file-path">{getFileDir(filePath)}</span>
                  </div>
                </button>
              ))}
            </div>
          </div>
        )}

        <p className="welcome-text" style={{ fontSize: '14px', marginTop: recentFiles.length > 0 ? '8px' : '16px' }}>
          Drag and drop a PDF here to open
        </p>
        <p className="welcome-text welcome-formats" style={{ fontSize: '12px', marginTop: '4px', opacity: 0.7 }}>
          Supports: PDF
        </p>
      </div>
    </div>
  );
};

export default WelcomeScreen;
