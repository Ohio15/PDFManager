import React, { useState, useCallback } from 'react';
import { FileText, Upload, FileUp, Clock, X, Trash2 } from 'lucide-react';

interface WelcomeScreenProps {
  onOpenFile: () => void;
  onFileDropped?: (filePath: string) => void;
  onNonPdfDropped?: (filePath: string) => void;
  onConvertToPdf?: () => void;
  libreOfficeAvailable?: boolean;
  recentFiles?: string[];
  onOpenRecentFile?: (filePath: string) => void;
  onClearRecentFiles?: () => void;
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  onOpenFile,
  onFileDropped,
  onNonPdfDropped,
  onConvertToPdf,
  libreOfficeAvailable = false,
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

  // Supported document formats for conversion
  const convertibleExtensions = [
    'doc', 'docx', 'odt', 'rtf', 'txt',
    'xls', 'xlsx', 'ods', 'csv',
    'ppt', 'pptx', 'odp',
    'html', 'htm', 'xml', 'md',
    'jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'tiff'
  ];

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
        const extension = fileName.includes('.') ? fileName.split('.').pop() || '' : '';

        if (!filePath) {
          // Fallback to dialog if path not available
          onOpenFile();
          return;
        }

        // Check for PDF by extension or type
        if (file.type === 'application/pdf' || fileName.endsWith('.pdf')) {
          if (onFileDropped) {
            onFileDropped(filePath);
          }
        } else if (convertibleExtensions.includes(extension) && onNonPdfDropped) {
          onNonPdfDropped(filePath);
        }
      }
    },
    [onOpenFile, onFileDropped, onNonPdfDropped, convertibleExtensions]
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
          Open a PDF to edit, or convert documents to PDF format.
          Add text, images, annotations, merge, split, and more.
        </p>
        <div className="welcome-buttons">
          <button className="welcome-btn" onClick={onOpenFile}>
            <Upload size={20} />
            Open PDF File
          </button>
          {onConvertToPdf && (
            <button
              className="welcome-btn welcome-btn-secondary"
              onClick={onConvertToPdf}
              disabled={!libreOfficeAvailable}
              title={libreOfficeAvailable ? 'Convert Word, Excel, PowerPoint to PDF' : 'LibreOffice required for conversion'}
            >
              <FileUp size={20} />
              Convert to PDF
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
          Drag and drop files here to open or convert
        </p>
        <p className="welcome-text welcome-formats" style={{ fontSize: '12px', marginTop: '4px', opacity: 0.7 }}>
          Supports: PDF, Word, Excel, PowerPoint, images, and more
        </p>
        {onConvertToPdf && !libreOfficeAvailable && (
          <p className="welcome-text welcome-hint" style={{ fontSize: '12px', marginTop: '8px', opacity: 0.7 }}>
            Install LibreOffice to enable document conversion (Word, Excel, etc.)
          </p>
        )}
      </div>
    </div>
  );
};

export default WelcomeScreen;
