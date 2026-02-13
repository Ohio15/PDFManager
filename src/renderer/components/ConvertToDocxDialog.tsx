import React, { useState, useCallback } from 'react';
import Modal from './Modal';
import { Loader2, FolderOpen, CheckCircle, FileText, Layout, Type } from 'lucide-react';
import type { ConversionMode } from '../utils/docxGenerator/types';

interface ConvertToDocxDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConvert: (outputDir: string, mode: ConversionMode) => Promise<{ count: number; folder: string }>;
  fileName: string;
  pageCount: number;
  filePath: string;
}

const ConvertToDocxDialog: React.FC<ConvertToDocxDialogProps> = ({
  isOpen,
  onClose,
  onConvert,
  fileName,
  pageCount,
  filePath,
}) => {
  const [outputDir, setOutputDir] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ count: number; folder: string } | null>(null);
  const [conversionMode, setConversionMode] = useState<ConversionMode>('flow');

  // Default output directory to source file's directory when dialog opens
  React.useEffect(() => {
    if (isOpen && !outputDir && filePath) {
      const lastSlashIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      if (lastSlashIndex > 0) {
        setOutputDir(filePath.substring(0, lastSlashIndex));
      }
    }
  }, [isOpen, filePath, outputDir]);

  const handleSelectFolder = useCallback(async () => {
    const dir = await window.electronAPI.selectOutputDirectory();
    if (dir) {
      setOutputDir(dir);
      setError(null);
    }
  }, []);

  const handleConvert = useCallback(async () => {
    if (!outputDir) {
      setError('Please select an output folder');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const convertResult = await onConvert(outputDir, conversionMode);
      setResult(convertResult);
    } catch (e) {
      setError((e as Error).message || 'Failed to convert PDF to Word');
    } finally {
      setLoading(false);
    }
  }, [outputDir, onConvert, conversionMode]);

  const handleOpenFolder = useCallback(async () => {
    if (result?.folder) {
      await window.electronAPI.openFolder(result.folder);
    }
  }, [result]);

  const handleClose = useCallback(() => {
    setOutputDir('');
    setError(null);
    setResult(null);
    onClose();
  }, [onClose]);

  const outputFileName = fileName.replace(/\.pdf$/i, '.docx');

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Convert PDF to Word" width="500px">
      <div className="convert-from-dialog">
        {result ? (
          <div className="result-view">
            <CheckCircle size={48} className="success-icon" />
            <h3>Conversion Complete</h3>
            <p>
              Converted <strong>{result.count}</strong> page{result.count !== 1 ? 's' : ''} from{' '}
              <strong>{fileName}</strong> to Word document
            </p>
            <div className="dialog-actions">
              <button className="btn btn-secondary" onClick={handleOpenFolder}>
                <FolderOpen size={16} />
                Open Folder
              </button>
              <button className="btn btn-primary" onClick={handleClose}>
                Done
              </button>
            </div>
          </div>
        ) : (
          <>
            <p className="dialog-description">
              Convert <strong>{fileName}</strong> ({pageCount} page{pageCount !== 1 ? 's' : ''}) to
              a Word document (.docx).
            </p>

            <div className="form-group" style={{ marginBottom: '16px' }}>
              <label style={{ marginBottom: '8px', display: 'block' }}>Conversion Mode</label>
              <div style={{
                display: 'flex',
                gap: '8px',
              }}>
                <button
                  type="button"
                  onClick={() => setConversionMode('flow')}
                  style={{
                    flex: 1,
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: conversionMode === 'flow'
                      ? '2px solid var(--accent-color, #4A90D9)'
                      : '2px solid var(--border-color, #3a3a3a)',
                    background: conversionMode === 'flow'
                      ? 'var(--accent-bg, rgba(74, 144, 217, 0.1))'
                      : 'var(--input-bg, #2a2a2a)',
                    color: 'var(--text-primary, #e0e0e0)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <Type size={16} style={{ opacity: 0.8 }} />
                    <strong style={{ fontSize: '13px' }}>Retain Flowing Text</strong>
                  </div>
                  <div style={{ fontSize: '11px', opacity: 0.6, lineHeight: 1.3 }}>
                    Editable paragraphs and tables. Text reflows when edited.
                  </div>
                </button>

                <button
                  type="button"
                  onClick={() => setConversionMode('positioned')}
                  style={{
                    flex: 1,
                    padding: '10px 12px',
                    borderRadius: '8px',
                    border: conversionMode === 'positioned'
                      ? '2px solid var(--accent-color, #4A90D9)'
                      : '2px solid var(--border-color, #3a3a3a)',
                    background: conversionMode === 'positioned'
                      ? 'var(--accent-bg, rgba(74, 144, 217, 0.1))'
                      : 'var(--input-bg, #2a2a2a)',
                    color: 'var(--text-primary, #e0e0e0)',
                    cursor: 'pointer',
                    textAlign: 'left',
                    transition: 'all 0.15s ease',
                  }}
                >
                  <div style={{ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '4px' }}>
                    <Layout size={16} style={{ opacity: 0.8 }} />
                    <strong style={{ fontSize: '13px' }}>Retain Page Layout</strong>
                  </div>
                  <div style={{ fontSize: '11px', opacity: 0.6, lineHeight: 1.3 }}>
                    1:1 visual match. Text positioned exactly as in PDF.
                  </div>
                </button>
              </div>
            </div>

            <div className="form-group">
              <label>Output Folder</label>
              <div className="input-with-button">
                <input
                  type="text"
                  value={outputDir}
                  readOnly
                  placeholder="Select output folder..."
                />
                <button className="btn btn-secondary" onClick={handleSelectFolder}>
                  <FolderOpen size={16} />
                  Browse
                </button>
              </div>
            </div>

            <div className="info-box">
              <p>
                Output file: <code>{outputFileName}</code>
              </p>
              <p style={{ marginTop: '4px', opacity: 0.7, fontSize: '12px' }}>
                Text, formatting, and images will be preserved. No VML or legacy markup.
              </p>
            </div>

            {error && <p className="dialog-error">{error}</p>}

            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={handleClose}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleConvert}
                disabled={!outputDir || loading}
              >
                {loading ? (
                  <>
                    <Loader2 size={16} className="spinning" />
                    Converting...
                  </>
                ) : (
                  <>
                    <FileText size={16} />
                    Convert to Word
                  </>
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default ConvertToDocxDialog;
