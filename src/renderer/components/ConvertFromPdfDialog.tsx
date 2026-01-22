import React, { useState, useCallback } from 'react';
import Modal from './Modal';
import { Loader2, FolderOpen, CheckCircle, Image } from 'lucide-react';

interface ConvertFromPdfDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onConvert: (outputDir: string, format: 'png' | 'jpeg', quality: number) => Promise<{ count: number; folder: string }>;
  fileName: string;
  pageCount: number;
  filePath: string;
}

const ConvertFromPdfDialog: React.FC<ConvertFromPdfDialogProps> = ({
  isOpen,
  onClose,
  onConvert,
  fileName,
  pageCount,
  filePath,
}) => {
  const [outputDir, setOutputDir] = useState<string>('');
  const [format, setFormat] = useState<'png' | 'jpeg'>('png');
  const [quality, setQuality] = useState<number>(90);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ count: number; folder: string } | null>(null);

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
      const convertResult = await onConvert(outputDir, format, quality);
      setResult(convertResult);
    } catch (e) {
      setError((e as Error).message || 'Failed to convert PDF');
    } finally {
      setLoading(false);
    }
  }, [outputDir, format, quality, onConvert]);

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

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Convert PDF to Images" width="500px">
      <div className="convert-from-dialog">
        {result ? (
          <div className="result-view">
            <CheckCircle size={48} className="success-icon" />
            <h3>Conversion Complete</h3>
            <p>
              Converted <strong>{result.count}</strong> page{result.count !== 1 ? 's' : ''} from{' '}
              <strong>{fileName}</strong> to {format.toUpperCase()} images
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
              Convert <strong>{fileName}</strong> ({pageCount} page{pageCount !== 1 ? 's' : ''}) to images.
            </p>

            <div className="form-group">
              <label>Output Format</label>
              <div className="format-options">
                <label className={`format-option ${format === 'png' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="format"
                    value="png"
                    checked={format === 'png'}
                    onChange={() => setFormat('png')}
                  />
                  <Image size={20} />
                  <span>PNG</span>
                  <small>Lossless, larger files</small>
                </label>
                <label className={`format-option ${format === 'jpeg' ? 'selected' : ''}`}>
                  <input
                    type="radio"
                    name="format"
                    value="jpeg"
                    checked={format === 'jpeg'}
                    onChange={() => setFormat('jpeg')}
                  />
                  <Image size={20} />
                  <span>JPEG</span>
                  <small>Smaller files, adjustable quality</small>
                </label>
              </div>
            </div>

            {format === 'jpeg' && (
              <div className="form-group">
                <label>Quality: {quality}%</label>
                <input
                  type="range"
                  min="10"
                  max="100"
                  value={quality}
                  onChange={(e) => setQuality(parseInt(e.target.value))}
                  className="quality-slider"
                />
              </div>
            )}

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
                Files will be named: <code>{fileName.replace('.pdf', '')}_page_1.{format}</code>,{' '}
                <code>{fileName.replace('.pdf', '')}_page_2.{format}</code>, etc.
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
                  `Convert ${pageCount} Page${pageCount !== 1 ? 's' : ''}`
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default ConvertFromPdfDialog;
