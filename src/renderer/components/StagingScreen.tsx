import React from 'react';
import { FileText, FileType2, Upload, ArrowLeft, AlertCircle } from 'lucide-react';
import { describeFormat, getExtension } from '../utils/supportedFormats';

export interface StagedDocument {
  path: string;
  name: string;
}

interface StagingScreenProps {
  doc: StagedDocument;
  libreOfficeAvailable: boolean;
  onConvertToPdf: () => void;
  onOpenDifferent: () => void;
  onBack: () => void;
}

const StagingScreen: React.FC<StagingScreenProps> = ({
  doc,
  libreOfficeAvailable,
  onConvertToPdf,
  onOpenDifferent,
  onBack,
}) => {
  const formatLabel = describeFormat(doc.path);
  const ext = getExtension(doc.path).toUpperCase();

  return (
    <div className="pdf-viewer">
      <div className="welcome-screen staging-screen">
        <FileType2 className="welcome-icon" />
        <h1 className="welcome-title">{doc.name}</h1>
        <p className="welcome-text">
          {formatLabel} ready to convert. This format can be turned into a PDF.
        </p>

        <div className="staged-file-card" title={doc.path}>
          <FileText size={20} className="staged-file-icon" />
          <div className="staged-file-info">
            <span className="staged-file-name">{doc.name}</span>
            <span className="staged-file-path">{doc.path}</span>
          </div>
          <span className="staged-file-badge">{ext}</span>
        </div>

        <div className="welcome-buttons">
          <button
            className="welcome-btn"
            onClick={onConvertToPdf}
            disabled={!libreOfficeAvailable}
            title={libreOfficeAvailable ? 'Convert this document to PDF' : 'LibreOffice required to convert'}
          >
            <FileText size={20} />
            Convert to PDF
          </button>
          <button className="welcome-btn welcome-btn-secondary" onClick={onOpenDifferent}>
            <Upload size={20} />
            Open a Different File
          </button>
        </div>

        {!libreOfficeAvailable && (
          <div className="tools-notice" style={{ maxWidth: 480 }}>
            <div className="tools-notice-header">
              <AlertCircle size={16} />
              <span>LibreOffice Required</span>
            </div>
            <p>Converting documents to PDF requires LibreOffice on your system.</p>
            <button
              className="tools-notice-link"
              onClick={() => window.electronAPI.openExternal('https://www.libreoffice.org/download/download/')}
            >
              Download LibreOffice
            </button>
          </div>
        )}

        <button className="staging-back-link" onClick={onBack}>
          <ArrowLeft size={14} />
          Back
        </button>
      </div>
    </div>
  );
};

export default StagingScreen;
