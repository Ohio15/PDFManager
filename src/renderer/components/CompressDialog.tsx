import React, { useEffect, useMemo, useState } from 'react';
import { Minimize2, Loader2, Gauge } from 'lucide-react';
import Modal from './Modal';
import type { CompressOptions } from '../utils/compress';
import type { CompressAnalysis } from '../hooks/useFinalizeActions';
import '../styles/forms-finalize.css';

interface CompressDialogProps {
  isOpen: boolean;
  onClose: () => void;
  onAnalyze: (options: CompressOptions) => Promise<CompressAnalysis | null>;
  onApply: (analysis: CompressAnalysis) => Promise<boolean>;
}

const DPI_CHOICES = [72, 96, 150, 200, 300];

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}

const CompressDialog: React.FC<CompressDialogProps> = ({ isOpen, onClose, onAnalyze, onApply }) => {
  const [lossy, setLossy] = useState(false);
  const [targetDpi, setTargetDpi] = useState(150);
  const [quality, setQuality] = useState(75);
  const [analysis, setAnalysis] = useState<CompressAnalysis | null>(null);
  const [working, setWorking] = useState<'analyze' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setAnalysis(null);
    setError(null);
  }, [isOpen]);

  // Changing an option invalidates the shown result.
  useEffect(() => {
    setAnalysis(null);
  }, [lossy, targetDpi, quality]);

  const handleAnalyze = async () => {
    setWorking('analyze');
    setError(null);
    try {
      const options: CompressOptions = lossy ? { lossy: { targetDpi, jpegQuality: quality / 100 } } : {};
      const result = await onAnalyze(options);
      if (!result) setError('No document is open.');
      setAnalysis(result);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setWorking(null);
    }
  };

  const handleApply = async () => {
    if (!analysis) return;
    setWorking('apply');
    setError(null);
    try {
      await onApply(analysis);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setAnalysis(null);
    } finally {
      setWorking(null);
    }
  };

  const imageSummary = useMemo(() => {
    if (!analysis) return null;
    const images = analysis.result.images;
    const downsampled = images.filter((i) => i.action === 'downsampled');
    const skipped = images.filter((i) => i.action === 'skipped');
    const reasons = new Map<string, number>();
    for (const img of skipped) reasons.set(img.reason ?? 'unknown', (reasons.get(img.reason ?? 'unknown') ?? 0) + 1);
    return { total: images.length, downsampled, skipped, reasons };
  }, [analysis]);

  const r = analysis?.result;
  const saved = r ? r.originalSize - r.compressedSize : 0;
  const pct = r && r.originalSize > 0 ? (saved / r.originalSize) * 100 : 0;

  return (
    <Modal isOpen={isOpen} onClose={working ? () => {} : onClose} title="Compress PDF" width="520px">
      <div className="finalize-dialog" data-testid="compress-dialog">
        <p className="dialog-description">
          Lossless compression always runs: unused objects are removed, identical streams and fonts are merged,
          streams are recompressed, and object streams are used.
        </p>

        <label className="finalize-option active compress-lossy-toggle">
          <input type="checkbox" checked={lossy} onChange={(e) => setLossy(e.target.checked)} data-testid="compress-lossy" />
          <div>
            <strong>Downsample large images (lossy)</strong>
            <span>Re-encode images above the target resolution as JPEG. CMYK, indexed, JBIG2, JPEG 2000 and masked images are left untouched.</span>
          </div>
        </label>

        {lossy && (
          <div className="compress-lossy-options">
            <div className="form-group">
              <label htmlFor="compress-dpi">Target resolution</label>
              <select id="compress-dpi" value={targetDpi} onChange={(e) => setTargetDpi(Number(e.target.value))}>
                {DPI_CHOICES.map((d) => <option key={d} value={d}>{d} DPI</option>)}
              </select>
            </div>
            <div className="form-group">
              <label htmlFor="compress-quality">JPEG quality: {quality}%</label>
              <input id="compress-quality" type="range" min={10} max={95} step={5} value={quality} onChange={(e) => setQuality(Number(e.target.value))} />
            </div>
          </div>
        )}

        {r && (
          <div className="compress-result" data-testid="compress-result">
            <div className="compress-sizes">
              <span data-testid="compress-before">{formatBytes(r.originalSize)}</span>
              <span className="arrow">→</span>
              <span data-testid="compress-after">{formatBytes(r.compressedSize)}</span>
              <span className={`compress-pct ${r.improved ? 'good' : ''}`}>
                {r.improved ? `−${pct.toFixed(1)}%` : 'no reduction'}
              </span>
            </div>
            <ul className="compress-details">
              <li>{r.removedObjects} unused object{r.removedObjects === 1 ? '' : 's'} removed, {r.dedupedObjects} duplicate{r.dedupedObjects === 1 ? '' : 's'} merged, {r.recompressedStreams} stream{r.recompressedStreams === 1 ? '' : 's'} recompressed</li>
              {imageSummary && analysis?.options.lossy && (
                <li>{imageSummary.downsampled.length} of {imageSummary.total} image{imageSummary.total === 1 ? '' : 's'} downsampled</li>
              )}
              {imageSummary && analysis?.options.lossy && [...imageSummary.reasons.entries()].map(([reason, count]) => (
                <li key={reason} className="muted">{count} skipped: {reason}</li>
              ))}
            </ul>
            {!r.improved && <p className="form-designer-hint">This file is already as small as these settings can make it.</p>}
          </div>
        )}

        {error && <p className="dialog-error">{error}</p>}

        <div className="dialog-actions">
          <button className="btn btn-ghost" onClick={onClose} disabled={!!working}>Cancel</button>
          <button className="btn btn-secondary" onClick={handleAnalyze} disabled={!!working} data-testid="compress-analyze">
            {working === 'analyze' ? <><Loader2 size={16} className="spinning" /> Analyzing…</> : <><Gauge size={16} /> Analyze</>}
          </button>
          <button className="btn btn-primary" onClick={handleApply} disabled={!!working || !r || !r.improved} data-testid="compress-apply">
            {working === 'apply' ? <><Loader2 size={16} className="spinning" /> Applying…</> : <><Minimize2 size={16} /> Apply</>}
          </button>
        </div>
      </div>
    </Modal>
  );
};

export default CompressDialog;
