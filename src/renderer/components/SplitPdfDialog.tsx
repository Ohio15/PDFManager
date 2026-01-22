import React, { useState, useCallback } from 'react';
import Modal from './Modal';
import { Loader2, FolderOpen } from 'lucide-react';

interface SplitPdfDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onSplit: (outputDir: string) => Promise<void>;
  pageCount: number;
  fileName: string;
  filePath: string;
}

const SplitPdfDialog: React.FC<SplitPdfDialogProps> = ({
  isOpen,
  onClose,
  onSplit,
  pageCount,
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

  const handleSelectFolder = useCallback(async () => {
    const dir = await window.electronAPI.selectOutputDirectory();
    if (dir) {
      setOutputDir(dir);
      setError(null);
    }
  }, []);

  const handleSplit = useCallback(async () => {
    if (!outputDir) {
      setError('Please select an output folder');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onSplit(outputDir);
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Failed to split PDF');
    } finally {
      setLoading(false);
    }
  }, [outputDir, onSplit, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Split PDF" width="500px">
      <div className="split-dialog">
        <p className="dialog-description">
          Split <strong>{fileName}</strong> into {pageCount} separate PDF files,
          one for each page.
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
            Files will be named: <code>{fileName.replace('.pdf', '')}_page_1.pdf</code>,{' '}
            <code>{fileName.replace('.pdf', '')}_page_2.pdf</code>, etc.
          </p>
        </div>

        {error && <p className="dialog-error">{error}</p>}

        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleSplit}
            disabled={!outputDir || loading}
          >
            {loading ? (
              <>
                <Loader2 size={16} className="spinning" />
                Splitting...
              </>
            ) : (
              `Split into ${pageCount} Files`
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default SplitPdfDialog;
