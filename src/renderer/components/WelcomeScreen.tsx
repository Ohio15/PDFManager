import React, { useState, useCallback } from 'react';
import { FileText, Upload, FileUp } from 'lucide-react';

interface WelcomeScreenProps {
  onOpenFile: () => void;
  onFileDropped?: (filePath: string) => void;
  onNonPdfDropped?: (filePath: string) => void;
  onConvertToPdf?: () => void;
  libreOfficeAvailable?: boolean;
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({
  onOpenFile,
  onFileDropped,
  onNonPdfDropped,
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
          console.log('Dropped PDF file:', filePath);
          if (onFileDropped) {
            onFileDropped(filePath);
          }
        } else if (convertibleExtensions.includes(extension) && onNonPdfDropped) {
          // Non-PDF file that can be converted
          console.log('Dropped convertible file:', filePath);
          onNonPdfDropped(filePath);
        } else {
          // Unsupported file type - could show a toast/message
          console.log('Unsupported file type:', extension);
        }
      }
    },
    [onOpenFile, onFileDropped, onNonPdfDropped, convertibleExtensions]
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
