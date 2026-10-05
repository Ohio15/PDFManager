import React, { useState, useCallback, useEffect } from 'react';
import Modal from './Modal';
import { Plus, Trash2, Loader2, FolderOpen, CheckCircle, AlertCircle, FileText } from 'lucide-react';
import { useDropZone } from '../hooks/useFileDrop';
import { isConvertibleToPdf } from '../utils/supportedFormats';
import type { DropResult } from '../../shared/ipc';

interface ConversionItem {
  path: string;
  name: string;
  status: 'pending' | 'converting' | 'success' | 'error';
  error?: string;
  outputPath?: string;
}

interface ConvertToPdfDialogProps {
  isOpen: boolean;
  onClose: () => void;
  libreOfficeAvailable: boolean;
  /** Pre-seed the file list (e.g. the currently staged document). */
  initialFiles?: string[];
  /** Called once with the first successfully converted PDF (path + base64 data). */
  onConverted?: (pdfPath: string, pdfData: string) => void;
}

const ConvertToPdfDialog: React.FC<ConvertToPdfDialogProps> = ({
  isOpen,
  onClose,
  libreOfficeAvailable,
  initialFiles,
  onConverted,
}) => {
  const [files, setFiles] = useState<ConversionItem[]>([]);
  const [outputDir, setOutputDir] = useState<string>('');
  const [converting, setConverting] = useState(false);
  const [completed, setCompleted] = useState(false);

  // Seed the dialog from a staged document when it opens.
  useEffect(() => {
    if (!isOpen || !initialFiles || initialFiles.length === 0) return;
    const items: ConversionItem[] = initialFiles.map((p) => ({
      path: p,
      name: p.split(/[\\/]/).pop() || 'Unknown',
      status: 'pending',
    }));
    setFiles(items);
    const first = initialFiles[0];
    const lastSlash = Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\'));
    if (lastSlash > 0) setOutputDir(first.substring(0, lastSlash));
  }, [isOpen, initialFiles]);

  const handleAddFiles = useCallback(async () => {
    const paths = await window.electronAPI.openDocumentsDialog();
    if (paths && paths.length > 0) {
      const newItems: ConversionItem[] = paths.map((p) => ({
        path: p,
        name: p.split(/[\\/]/).pop() || 'Unknown',
        status: 'pending',
      }));

      // Default output directory to source folder of first file if not set
      if (!outputDir) {
        const firstFilePath = paths[0];
        const lastSlashIndex = Math.max(firstFilePath.lastIndexOf('/'), firstFilePath.lastIndexOf('\\'));
        if (lastSlashIndex > 0) {
          setOutputDir(firstFilePath.substring(0, lastSlashIndex));
        }
      }

      setFiles((prev) => {
        const existingPaths = new Set(prev.map((f) => f.path));
        const unique = newItems.filter((f) => !existingPaths.has(f.path));
        return [...prev, ...unique];
      });
    }
  }, [outputDir]);

  const [dropNotice, setDropNotice] = useState<string | null>(null);

  // Trusted OS drops: each record is an exactly-blessed file, which main
  // accepts as a conversion input. With no output folder chosen yet, default
  // to the first file's own folder: main permits writing the converted
  // `<name>.pdf` beside an exactly-blessed input without blessing the folder.
  const handleDroppedFiles = useCallback(async (claim: Promise<DropResult>) => {
    try {
      const result = await claim;
      const docs = result.files.filter((f) => isConvertibleToPdf(f.path));
      const skipped = result.rejected + (result.files.length - docs.length);
      if (docs.length > 0) {
        const newItems: ConversionItem[] = docs.map((f) => ({ path: f.path, name: f.name, status: 'pending' }));
        setFiles((prev) => {
          const existingPaths = new Set(prev.map((f) => f.path));
          return [...prev, ...newItems.filter((f) => !existingPaths.has(f.path))];
        });
        setOutputDir((current) => {
          if (current) return current;
          const first = docs[0].path;
          const lastSlash = Math.max(first.lastIndexOf('/'), first.lastIndexOf('\\'));
          return lastSlash > 0 ? first.substring(0, lastSlash) : current;
        });
      }
      setDropNotice(skipped > 0 ? `${skipped} dropped file(s) skipped: not a convertible document` : null);
    } catch {
      setDropNotice('Failed to add dropped files');
    }
  }, []);

  const { isOver, bindings: dropBindings } = useDropZone(handleDroppedFiles, converting);

  const handleRemoveFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleSelectOutputDir = useCallback(async () => {
    const dir = await window.electronAPI.selectOutputDirectory();
    if (dir) {
      setOutputDir(dir);
    }
  }, []);

  const handleConvert = useCallback(async () => {
    if (!outputDir || files.length === 0) return;

    setConverting(true);
    setCompleted(false);
    let firstConverted = false;

    for (let i = 0; i < files.length; i++) {
      setFiles((prev) =>
        prev.map((f, idx) =>
          idx === i ? { ...f, status: 'converting' } : f
        )
      );

      try {
        const result = await window.electronAPI.convertToPdf(files[i].path, outputDir);
        setFiles((prev) =>
          prev.map((f, idx) =>
            idx === i
              ? {
                  ...f,
                  status: result.success ? 'success' : 'error',
                  error: result.error,
                  outputPath: result.path,
                }
              : f
          )
        );
        // Surface the first successful conversion so the caller can open it.
        if (result.success && result.path && result.data && !firstConverted) {
          firstConverted = true;
          onConverted?.(result.path, result.data);
        }
      } catch (e) {
        setFiles((prev) =>
          prev.map((f, idx) =>
            idx === i ? { ...f, status: 'error', error: (e as Error).message } : f
          )
        );
      }
    }

    setConverting(false);
    setCompleted(true);
  }, [files, outputDir, onConverted]);

  const handleOpenFolder = useCallback(async () => {
    if (outputDir) {
      await window.electronAPI.openFolder(outputDir);
    }
  }, [outputDir]);

  const handleClose = useCallback(() => {
    setFiles([]);
    setOutputDir('');
    setCompleted(false);
    setDropNotice(null);
    onClose();
  }, [onClose]);

  const successCount = files.filter((f) => f.status === 'success').length;
  const errorCount = files.filter((f) => f.status === 'error').length;

  const getStatusIcon = (status: ConversionItem['status']) => {
    switch (status) {
      case 'converting':
        return <Loader2 size={16} className="spinning" />;
      case 'success':
        return <CheckCircle size={16} className="success" />;
      case 'error':
        return <AlertCircle size={16} className="error" />;
      default:
        return <FileText size={16} />;
    }
  };

  if (!libreOfficeAvailable) {
    return (
      <Modal isOpen={isOpen} onClose={onClose} title="Convert to PDF" width="450px">
        <div className="convert-dialog">
          <div className="warning-box">
            <AlertCircle size={24} />
            <div>
              <h4>LibreOffice Required</h4>
              <p>
                Document conversion requires LibreOffice to be installed on your system.
              </p>
              <a
                href="https://www.libreoffice.org/download/"
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn-primary"
                style={{ marginTop: '12px', display: 'inline-block' }}
              >
                Download LibreOffice
              </a>
            </div>
          </div>
          <div className="dialog-actions">
            <button className="btn btn-ghost" onClick={onClose}>
              Close
            </button>
          </div>
        </div>
      </Modal>
    );
  }

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Convert Documents to PDF" width="600px">
      <div className="convert-dialog">
        {completed ? (
          <div className="result-summary">
            <CheckCircle size={48} className="success-icon" />
            <h3>Conversion Complete</h3>
            <p>
              <strong>{successCount}</strong> file{successCount !== 1 ? 's' : ''} converted successfully
              {errorCount > 0 && (
                <>, <strong>{errorCount}</strong> failed</>
              )}
            </p>
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={handleOpenFolder}>
                <FolderOpen size={16} />
                Open Output Folder
              </button>
              <button className="btn btn-primary" onClick={handleClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="dialog-description">
              Convert documents (Word, Excel, PowerPoint, etc.) to PDF format.
            </p>

            <div className="form-group">
              <label>Output Folder</label>
              <div className="input-with-button">
                <input
                  type="text"
                  value={outputDir}
                  readOnly
                  placeholder="Select output folder..."
                />
                <button className="btn btn-secondary" onClick={handleSelectOutputDir}>
                  <FolderOpen size={16} />
                  Browse
                </button>
              </div>
            </div>

            <div
              className={`file-list-container ${isOver ? 'drop-zone-active' : ''}`}
              data-testid="convert-drop-zone"
              {...dropBindings}
            >
              {files.length === 0 ? (
                <div className="file-list-empty">
                  <p>No files added. Drop documents here or click "Add Files"</p>
                  <p className="text-muted">
                    Supported: DOC, DOCX, ODT, RTF, PPT, PPTX, XLS, XLSX, HTML
                  </p>
                </div>
              ) : (
                <div className="file-list">
                  {files.map((file, index) => (
                    <div key={file.path} className={`file-list-item ${file.status}`}>
                      <span className="file-status">{getStatusIcon(file.status)}</span>
                      <span className="file-name" title={file.path}>
                        {file.name}
                      </span>
                      {file.error && (
                        <span className="file-error" title={file.error}>
                          {file.error}
                        </span>
                      )}
                      {!converting && file.status === 'pending' && (
                        <button
                          className="file-remove"
                          onClick={() => handleRemoveFile(index)}
                          title="Remove"
                        >
                          <Trash2 size={16} />
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>

            {dropNotice && <p className="dialog-error">{dropNotice}</p>}

            <div className="dialog-actions">
              <button
                className="btn btn-secondary"
                onClick={handleAddFiles}
                disabled={converting}
              >
                <Plus size={16} />
                Add Files
              </button>
              <div className="dialog-actions-right">
                <button className="btn btn-ghost" onClick={handleClose} disabled={converting}>
                  Cancel
                </button>
                <button
                  className="btn btn-primary"
                  onClick={handleConvert}
                  disabled={files.length === 0 || !outputDir || converting}
                >
                  {converting ? (
                    <>
                      <Loader2 size={16} className="spinning" />
                      Converting...
                    </>
                  ) : (
                    `Convert ${files.length} File${files.length !== 1 ? 's' : ''}`
                  )}
                </button>
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default ConvertToPdfDialog;
