import React, { useEffect, useState } from 'react';
import { Layers, Loader2, AlertTriangle } from 'lucide-react';
import Modal from './Modal';
import type { FlattenScope } from '../utils/flatten';
import { countFlattenTargets } from '../utils/flatten';
import '../styles/forms-finalize.css';

interface FlattenDialogProps {
  isOpen: boolean;
  onClose: () => void;
  pdfData: Uint8Array | undefined;
  /** In-session annotations not yet written to the file. */
  pendingAnnotationCount: number;
  initialScope?: FlattenScope;
  onFlatten: (scope: FlattenScope) => Promise<void>;
}

const SCOPES: Array<{ scope: FlattenScope; label: string; description: string }> = [
  { scope: 'both', label: 'Annotations and form fields', description: 'Burn everything into the page.' },
  { scope: 'forms', label: 'Form fields only', description: 'Current values become page content; the fields are removed.' },
  { scope: 'annotations', label: 'Annotations only', description: 'Markup becomes page content; form fields stay fillable.' },
];

const FlattenDialog: React.FC<FlattenDialogProps> = ({
  isOpen,
  onClose,
  pdfData,
  pendingAnnotationCount,
  initialScope = 'both',
  onFlatten,
}) => {
  const [scope, setScope] = useState<FlattenScope>(initialScope);
  const [counts, setCounts] = useState<{ widgets: number; annotations: number } | null>(null);
  const [working, setWorking] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setScope(initialScope);
    setError(null);
    setCounts(null);
    if (!pdfData) return;
    let cancelled = false;
    countFlattenTargets(pdfData)
      .then((c) => { if (!cancelled) setCounts(c); })
      .catch((e) => { if (!cancelled) setError(`Could not read the document: ${e instanceof Error ? e.message : String(e)}`); });
    return () => { cancelled = true; };
  }, [isOpen, pdfData, initialScope]);

  const handleFlatten = async () => {
    setWorking(true);
    setError(null);
    try {
      await onFlatten(scope);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(false);
    }
  };

  const fields = counts?.widgets ?? 0;
  const annots = (counts?.annotations ?? 0) + pendingAnnotationCount;
  const nothing = counts !== null && (
    (scope === 'forms' && fields === 0) ||
    (scope === 'annotations' && annots === 0) ||
    (scope === 'both' && fields + annots === 0)
  );

  return (
    <Modal isOpen={isOpen} onClose={working ? () => {} : onClose} title="Flatten" width="480px">
      <div className="finalize-dialog" data-testid="flatten-dialog">
        <p className="dialog-description">
          Flattening draws the current appearance of annotations and form fields into the page so they can no longer be edited.
        </p>
        <div className="finalize-stats">
          <span>{counts ? fields : '…'} form widget{fields === 1 ? '' : 's'}</span>
          <span>{counts ? annots : '…'} annotation{annots === 1 ? '' : 's'}{pendingAnnotationCount > 0 ? ` (${pendingAnnotationCount} unsaved)` : ''}</span>
        </div>
        <div className="finalize-options" role="radiogroup" aria-label="What to flatten">
          {SCOPES.map((s) => (
            <label key={s.scope} className={`finalize-option ${scope === s.scope ? 'active' : ''}`}>
              <input type="radio" name="flatten-scope" value={s.scope} checked={scope === s.scope} onChange={() => setScope(s.scope)} />
              <div>
                <strong>{s.label}</strong>
                <span>{s.description}</span>
              </div>
            </label>
          ))}
        </div>
        <div className="info-box finalize-note">
          <AlertTriangle size={16} />
          <p>Links, attachments, media and unapplied redaction marks are kept. You can undo a flatten until you close the document.</p>
        </div>
        {error && <p className="dialog-error">{error}</p>}
        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={working}>Cancel</button>
          <button className="btn btn-primary" onClick={handleFlatten} disabled={working || nothing || !pdfData} data-testid="flatten-confirm">
            {working ? <><Loader2 size={16} className="spinning" /> Flattening…</> : <><Layers size={16} /> Flatten</>}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default FlattenDialog;
