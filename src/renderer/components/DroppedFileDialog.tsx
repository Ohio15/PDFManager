import React, { useState, useCallback, useEffect } from 'react';
import Modal from './Modal';
import { FileText, FileSpreadsheet, FileImage, Presentation, FileCode, File, Loader2, CheckCircle, AlertCircle, FolderOpen } from 'lucide-react';

interface DroppedFileDialogProps {
  isOpen: boolean;
  onClose: () => void;
  filePath: string;
  libreOfficeAvailable: boolean;
  onConvertAndOpen: (pdfPath: string, pdfData: string) => void;
}

type ConversionStatus = 'idle' | 'converting' | 'success' | 'error';

const getFileIcon = (ext: string) => {
  const extension = ext.toLowerCase();
  if (['doc', 'docx', 'odt', 'rtf', 'txt'].includes(extension)) {
    return <FileText size={48} className="file-icon doc" />;
  }
  if (['xls', 'xlsx', 'ods', 'csv'].includes(extension)) {
    return <FileSpreadsheet size={48} className="file-icon spreadsheet" />;
  }
  if (['ppt', 'pptx', 'odp'].includes(extension)) {
    return <Presentation size={48} className="file-icon presentation" />;
  }
  if (['jpg', 'jpeg', 'png', 'gif', 'bmp', 'webp', 'svg', 'tiff'].includes(extension)) {
    return <FileImage size={48} className="file-icon image" />;
  }
  if (['html', 'htm', 'xml', 'json', 'md'].includes(extension)) {
    return <FileCode size={48} className="file-icon code" />;
  }
  return <File size={48} className="file-icon generic" />;
};

const getFileTypeLabel = (ext: string): string => {
  const extension = ext.toLowerCase();
  const typeMap: Record<string, string> = {
    doc: 'Microsoft Word Document',
    docx: 'Microsoft Word Document',
    odt: 'OpenDocument Text',
    rtf: 'Rich Text Format',
    txt: 'Plain Text',
    xls: 'Microsoft Excel Spreadsheet',
    xlsx: 'Microsoft Excel Spreadsheet',
    ods: 'OpenDocument Spreadsheet',
    csv: 'CSV Spreadsheet',
    ppt: 'Microsoft PowerPoint',
    pptx: 'Microsoft PowerPoint',
    odp: 'OpenDocument Presentation',
    jpg: 'JPEG Image',
    jpeg: 'JPEG Image',
    png: 'PNG Image',
    gif: 'GIF Image',
    bmp: 'Bitmap Image',
    webp: 'WebP Image',
    svg: 'SVG Vector Image',
    tiff: 'TIFF Image',
    html: 'HTML Document',
    htm: 'HTML Document',
    xml: 'XML Document',
    json: 'JSON Document',
    md: 'Markdown Document',
  };
  return typeMap[extension] || `${extension.toUpperCase()} File`;
};

const DroppedFileDialog: React.FC<DroppedFileDialogProps> = ({
  isOpen,
  onClose,
  filePath,
  libreOfficeAvailable,
  onConvertAndOpen,
}) => {
  const [status, setStatus] = useState<ConversionStatus>('idle');
  const [error, setError] = useState<string | null>(null);
  const [outputPath, setOutputPath] = useState<string>('');

  // Extract file info
  const fileName = filePath.split(/[\\/]/).pop() || 'Unknown File';
  const extension = fileName.includes('.') ? fileName.split('.').pop() || '' : '';
  const fileDir = filePath.substring(0, Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\')));

  // Reset state when dialog opens with new file
  useEffect(() => {
    if (isOpen) {
      setStatus('idle');
      setError(null);
      setOutputPath('');
    }
  }, [isOpen, filePath]);

  const handleConvert = useCallback(async () => {
    if (!libreOfficeAvailable) {
      setError('LibreOffice is required to convert documents. Please install it first.');
      return;
    }

    setStatus('converting');
    setError(null);

    try {
      const result = await window.electronAPI.convertToPdf(filePath, fileDir);

      if (result.success && result.path && result.data) {
        setStatus('success');
        setOutputPath(result.path);
        // Auto-open the converted PDF after a brief delay
        setTimeout(() => {
          onConvertAndOpen(result.path!, result.data!);
        }, 500);
      } else {
        setStatus('error');
        setError(result.error || 'Conversion failed');
      }
    } catch (e) {
      setStatus('error');
      setError((e as Error).message || 'An unexpected error occurred');
    }
  }, [filePath, fileDir, libreOfficeAvailable, onConvertAndOpen]);

  const handleOpenFolder = useCallback(async () => {
    if (outputPath) {
      const dir = outputPath.substring(0, Math.max(outputPath.lastIndexOf('/'), outputPath.lastIndexOf('\\')));
      await window.electronAPI.openFolder(dir);
    }
  }, [outputPath]);

  const handleClose = useCallback(() => {
    setStatus('idle');
    setError(null);
    setOutputPath('');
    onClose();
  }, [onClose]);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Convert Document" width="480px">
      <div className="dropped-file-dialog">
        {status === 'success' ? (
          <div className="result-view">
            <CheckCircle size={48} className="success-icon" />
            <h3>Conversion Complete</h3>
            <p>
              <strong>{fileName}</strong> has been converted to PDF.
            </p>
            <p className="output-path">Opening the converted file...</p>
          </div>
        ) : (
          <>
            <div className="file-preview">
              {getFileIcon(extension)}
              <div className="file-info">
                <h3 className="file-name" title={fileName}>{fileName}</h3>
                <p className="file-type">{getFileTypeLabel(extension)}</p>
                <p className="file-path" title={filePath}>{fileDir}</p>
              </div>
            </div>

            {!libreOfficeAvailable && (
              <div className="warning-box">
                <AlertCircle size={20} />
                <div>
                  <strong>LibreOffice Required</strong>
                  <p>Document conversion requires LibreOffice to be installed.</p>
                  <a
                    href="https://www.libreoffice.org/download/"
                    onClick={(e) => {
                      e.preventDefault();
                      window.electronAPI.openExternal('https://www.libreoffice.org/download/');
                    }}
                    className="download-link"
                  >
                    Download LibreOffice
                  </a>
                </div>
              </div>
            )}

            {error && (
              <div className="error-box">
                <AlertCircle size={20} />
                <span>{error}</span>
              </div>
            )}

            <div className="conversion-info">
              <p>
                Convert this document to PDF format for viewing and editing in PDF Manager.
              </p>
              <p className="output-note">
                The PDF will be saved in the same folder as the original file.
              </p>
            </div>

            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={handleClose} disabled={status === 'converting'}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleConvert}
                disabled={!libreOfficeAvailable || status === 'converting'}
              >
                {status === 'converting' ? (
                  <>
                    <Loader2 size={16} className="spinning" />
                    Converting...
                  </>
                ) : (
                  'Convert to PDF'
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default DroppedFileDialog;
