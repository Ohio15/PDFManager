import React, { useState, useCallback } from 'react';
import { FileText, Upload, FileUp } from 'lucide-react';

interface WelcomeScreenProps {
  onOpenFile: () => void;
  onFileDropped?: (filePath: string) => void;
  onConvertToPdf?: () => void;
  libreOfficeAvailable?: boolean;
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  onOpenFile,
  onFileDropped,
  onConvertToPdf,
  libreOfficeAvailable = false,
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
        // Check for PDF by extension or type
        if (file.type === 'application/pdf' || file.name.toLowerCase().endsWith('.pdf')) {
          // In Electron, files have a path property
          const filePath = (file as any).path;
          console.log('Dropped file path:', filePath);
          if (filePath && onFileDropped) {
            onFileDropped(filePath);
          } else {
            // Fallback to dialog if path not available
            onOpenFile();
          }
        }
      }
    },
    [onOpenFile, onFileDropped]
  );

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
        <p className="welcome-text" style={{ fontSize: '14px', marginTop: '16px' }}>
          Drag and drop a PDF file here to open
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
