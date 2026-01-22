import React, { useState, useCallback } from 'react';
import Modal from './Modal';
import { Loader2 } from 'lucide-react';

interface ExtractPagesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onExtract: (pageRange: string) => Promise<void>;
  pageCount: number;
}

const ExtractPagesDialog: React.FC<ExtractPagesDialogProps> = ({
  isOpen,
  onClose,
  onExtract,
  pageCount,
}) => {
  const [pageRange, setPageRange] = useState<string>('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const validatePageRange = useCallback(
    (range: string): boolean => {
      if (!range.trim()) return false;

      const parts = range.split(',');
      for (const part of parts) {
        const trimmed = part.trim();
        if (trimmed.includes('-')) {
          const [start, end] = trimmed.split('-').map((s) => parseInt(s.trim()));
          if (isNaN(start) || isNaN(end) || start < 1 || end > pageCount || start > end) {
            return false;
          }
        } else {
          const num = parseInt(trimmed);
          if (isNaN(num) || num < 1 || num > pageCount) {
            return false;
          }
        }
      }
      return true;
    },
    [pageCount]
  );

  const handleExtract = useCallback(async () => {
    if (!validatePageRange(pageRange)) {
      setError(`Invalid page range. Use numbers 1-${pageCount}, separated by commas or ranges (e.g., 1,3,5-7)`);
      return;
    }

    setLoading(true);
    setError(null);
    try {
      await onExtract(pageRange);
      setPageRange('');
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Failed to extract pages');
    } finally {
      setLoading(false);
    }
  }, [pageRange, validatePageRange, onExtract, onClose]);

  const handleClose = useCallback(() => {
    setPageRange('');
    setError(null);
    onClose();
  }, [onClose]);

  return (
    <Modal isOpen={isOpen} onClose={handleClose} title="Extract Pages" width="450px">
      <div className="extract-dialog">
        <p className="dialog-description">
          Extract specific pages to a new PDF file.
        </p>

        <div className="form-group">
          <label>Page Range (1-{pageCount})</label>
          <input
            type="text"
            value={pageRange}
            onChange={(e) => {
              setPageRange(e.target.value);
              setError(null);
            }}
            placeholder="e.g., 1,3,5-7"
          />
          <p className="form-help">
            Use commas to separate pages, dashes for ranges
          </p>
        </div>

        <div className="quick-select">
          <span>Quick select:</span>
          <button onClick={() => setPageRange('1')}>First page</button>
          <button onClick={() => setPageRange(String(pageCount))}>Last page</button>
          <button onClick={() => setPageRange(`1-${Math.ceil(pageCount / 2)}`)}>
            First half
          </button>
          <button onClick={() => setPageRange(`${Math.ceil(pageCount / 2) + 1}-${pageCount}`)}>
            Second half
          </button>
        </div>

        {error && <p className="dialog-error">{error}</p>}

        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={handleClose}>
            Cancel
          </button>
          <button
            className="btn btn-primary"
            onClick={handleExtract}
            disabled={!pageRange.trim() || loading}
          >
            {loading ? (
              <>
                <Loader2 size={16} className="spinning" />
                Extracting...
              </>
            ) : (
              'Extract Pages'
            )}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default ExtractPagesDialog;
