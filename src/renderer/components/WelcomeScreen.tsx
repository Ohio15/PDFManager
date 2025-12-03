import React, { useState, useCallback } from 'react';
import { FileText, Upload } from 'lucide-react';

interface WelcomeScreenProps {
  onOpenFile: () => void;
  onFileDropped?: (filePath: string) => void;
}

const WelcomeScreen: React.FC<WelcomeScreenProps> = ({ onOpenFile, onFileDropped }) => {
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
        <h1 className="welcome-title">PDF Editor</h1>
        <p className="welcome-text">
          Open a PDF file to start editing. You can add text, images, annotations,
          rotate pages, and more.
        </p>
        <button className="welcome-btn" onClick={onOpenFile}>
          <Upload size={20} />
          Open PDF File
        </button>
        <p className="welcome-text" style={{ fontSize: '14px', marginTop: '16px' }}>
          or drag and drop a PDF file here
        </p>
      </div>
    </div>
  );
};

export default WelcomeScreen;
