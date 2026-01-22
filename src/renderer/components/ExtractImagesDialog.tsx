import React, { useState, useCallback } from 'react';
import Modal from './Modal';
import { Loader2, FolderOpen, CheckCircle } from 'lucide-react';

interface ExtractImagesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onExtract: (outputDir: string) => Promise<{ count: number; folder: string }>;
  fileName: string;
  filePath: string;
}

const ExtractImagesDialog: React.FC<ExtractImagesDialogProps> = ({
  isOpen,
  onClose,
  onExtract,
  fileName,
  filePath,
}) => {
  const [outputDir, setOutputDir] = useState<string>('');

  // Default output directory to source file's directory when dialog opens
  React.useEffect(() => {
    if (isOpen && !outputDir && filePath) {
      const lastSlashIndex = Math.max(filePath.lastIndexOf('/'), filePath.lastIndexOf('\\'));
      if (lastSlashIndex > 0) {
        setOutputDir(filePath.substring(0, lastSlashIndex));
      }
    }
  }, [isOpen, filePath, outputDir]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<{ count: number; folder: string } | null>(null);

  const handleSelectFolder = useCallback(async () => {
    const dir = await window.electronAPI.selectOutputDirectory();
    if (dir) {
      setOutputDir(dir);
      setError(null);
    }
  }, []);

  const handleExtract = useCallback(async () => {
    if (!outputDir) {
      setError('Please select an output folder');
      return;
    }

    setLoading(true);
    setError(null);
    setResult(null);
    try {
      const extractResult = await onExtract(outputDir);
      setResult(extractResult);
    } catch (e) {
      setError((e as Error).message || 'Failed to extract images');
    } finally {
      setLoading(false);
    }
  }, [outputDir, onExtract]);

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
    <Modal isOpen={isOpen} onClose={handleClose} title="Extract Images" width="500px">
      <div className="extract-images-dialog">
        {result ? (
          <div className="result-view">
            <CheckCircle size={48} className="success-icon" />
            <h3>Extraction Complete</h3>
            <p>
              Extracted <strong>{result.count}</strong> image{result.count !== 1 ? 's' : ''} from{' '}
              <strong>{fileName}</strong>
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
              Extract all embedded images from <strong>{fileName}</strong>.
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
                <button className="btn btn-secondary" onClick={handleSelectFolder}>
                  <FolderOpen size={16} />
                  Browse
                </button>
              </div>
            </div>

            <div className="info-box">
              <p>
                Images will be extracted in their original format (PNG, JPEG, etc.)
                with names like <code>{fileName.replace('.pdf', '')}_page1_img1.png</code>
              </p>
            </div>

            {error && <p className="dialog-error">{error}</p>}

            <div className="dialog-actions">
              <button className="btn btn-ghost" onClick={handleClose}>
                Cancel
              </button>
              <button
                className="btn btn-primary"
                onClick={handleExtract}
                disabled={!outputDir || loading}
              >
                {loading ? (
                  <>
                    <Loader2 size={16} className="spinning" />
                    Extracting...
                  </>
                ) : (
                  'Extract Images'
                )}
              </button>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

export default ExtractImagesDialog;
