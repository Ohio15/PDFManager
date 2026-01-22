import React, { useState, useCallback } from 'react';
import Modal from './Modal';
import { Plus, Trash2, ArrowUp, ArrowDown, Loader2 } from 'lucide-react';

interface FileItem {
  path: string;
  name: string;
  data: string;
}

interface MergePdfsDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onMerge: (files: FileItem[]) => Promise<void>;
}

const MergePdfsDialog: React.FC<MergePdfsDialogProps> = ({
  isOpen,
  onClose,
  onMerge,
}) => {
  const [files, setFiles] = useState<FileItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleAddFiles = useCallback(async () => {
    try {
      const result = await window.electronAPI.openMultipleFilesDialog();
      if (result) {
        const newFiles: FileItem[] = result.map((f) => ({
          path: f.path,
          name: f.path.split(/[\\/]/).pop() || 'Untitled',
          data: f.data,
        }));
        setFiles((prev) => {
          // Filter out duplicates
          const existingPaths = new Set(prev.map((f) => f.path));
          const unique = newFiles.filter((f) => !existingPaths.has(f.path));
          return [...prev, ...unique];
        });
        setError(null);
      }
    } catch (e) {
      setError('Failed to add files');
    }
  }, []);

  const handleRemoveFile = useCallback((index: number) => {
    setFiles((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const handleMoveUp = useCallback((index: number) => {
    if (index === 0) return;
    setFiles((prev) => {
      const newFiles = [...prev];
      [newFiles[index - 1], newFiles[index]] = [newFiles[index], newFiles[index - 1]];
      return newFiles;
    });
  }, []);

  const handleMoveDown = useCallback((index: number) => {
    setFiles((prev) => {
      if (index === prev.length - 1) return prev;
      const newFiles = [...prev];
      [newFiles[index], newFiles[index + 1]] = [newFiles[index + 1], newFiles[index]];
      return newFiles;
    });
  }, []);

  const handleMerge = useCallback(async () => {
    if (files.length < 2) {
      setError('Please add at least 2 PDF files to merge');
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onMerge(files);
      setFiles([]);
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Failed to merge PDFs');
    } finally {
      setLoading(false);
    }
  }, [files, onMerge, onClose]);

  const handleClose = useCallback(() => {
    setFiles([]);
    setError(null);
    onClose();
  }, [onClose]);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Merge PDFs" width="600px">
      <div className="merge-dialog">
        <p className="dialog-description">
          Select PDF files to merge. Drag to reorder, then click Merge.
        </p>

        <div className="file-list-container">
          {files.length === 0 ? (
            <div className="file-list-empty">
              <p>No files added yet</p>
              <p className="text-muted">Click "Add Files" to select PDFs</p>
            </div>
          ) : (
            <div className="file-list">
              {files.map((file, index) => (
                <div key={file.path} className="file-list-item">
                  <span className="file-number">{index + 1}</span>
                  <span className="file-name" title={file.path}>
                    {file.name}
                  </span>
                  <div className="file-actions">
                    <button
                      onClick={() => handleMoveUp(index)}
                      disabled={index === 0}
                      title="Move Up"
                    >
                      <ArrowUp size={16} />
                    </button>
                    <button
                      onClick={() => handleMoveDown(index)}
                      disabled={index === files.length - 1}
                      title="Move Down"
                    >
                      <ArrowDown size={16} />
                    </button>
                    <button
                      onClick={() => handleRemoveFile(index)}
                      className="danger"
                      title="Remove"
                    >
                      <Trash2 size={16} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {error && <p className="dialog-error">{error}</p>}

        <div className="dialog-actions">
          <button className="btn btn-secondary" onClick={handleAddFiles}>
            <Plus size={16} />
            Add Files
          </button>
          <div className="dialog-actions-right">
            <button className="btn btn-ghost" onClick={handleClose}>
              Cancel
            </button>
            <button
              className="btn btn-primary"
              onClick={handleMerge}
              disabled={files.length < 2 || loading}
            >
              {loading ? (
                <>
                  <Loader2 size={16} className="spinning" />
                  Merging...
                </>
              ) : (
                `Merge ${files.length} Files`
              )}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default MergePdfsDialog;
