import React, { useState } from 'react';
import { BoxSelect, TextSelect, ScanSearch, ShieldAlert, CaseSensitive, WholeWord, Loader2 } from 'lucide-react';
import Modal from './Modal';
import type { AnnotationStyle } from '../types';
import type { RedactionReport } from '../utils/redaction/redactionEngine';
import type { ApplyRedactionsRequest } from '../hooks/useMarkupRedaction';

interface RedactionToolbarProps {
  style: AnnotationStyle;
  onStyleChange: (updates: Partial<AnnotationStyle>) => void;
  /** Number of pending (unapplied) redaction marks in the document. */
  markCount: number;
  onMarkSearch: (term: string, options: { caseSensitive: boolean; wholeWord: boolean }) => Promise<number>;
  onApply: (request: ApplyRedactionsRequest) => Promise<RedactionReport>;
  notify: { success: (m: string) => void; error: (m: string) => void; warning: (m: string) => void; info: (m: string) => void };
}

function hexToRgb01(hex: string): { r: number; g: number; b: number } {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return { r: 0, g: 0, b: 0 };
  return { r: parseInt(m[1], 16) / 255, g: parseInt(m[2], 16) / 255, b: parseInt(m[3], 16) / 255 };
}

const RedactionToolbar: React.FC<RedactionToolbarProps> = ({ style, onStyleChange, markCount, onMarkSearch, onApply, notify }) => {
  const mode = style.redactMode ?? 'area';
  const [term, setTerm] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [searching, setSearching] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [fillColor, setFillColor] = useState('#000000');
  const [stripMetadata, setStripMetadata] = useState(true);
  const [applying, setApplying] = useState(false);
  const [report, setReport] = useState<RedactionReport | null>(null);
  const [failure, setFailure] = useState<string | null>(null);

  const runSearch = async () => {
    if (!term.trim() || searching) return;
    setSearching(true);
    try {
      const count = await onMarkSearch(term, { caseSensitive, wholeWord });
      if (count === 0) notify.info(`No occurrences of "${term}" found in the document text`);
      else notify.success(`Marked ${count} occurrence${count === 1 ? '' : 's'} of "${term}" for redaction`);
    } catch (e) {
      notify.error(`Search failed: ${(e as Error).message}`);
    } finally {
      setSearching(false);
    }
  };

  const apply = async () => {
    setApplying(true);
    setFailure(null);
    try {
      const r = await onApply({ fill: hexToRgb01(fillColor), stripMetadata });
      setReport(r);
    } catch (e) {
      setFailure((e as Error).message);
    } finally {
      setApplying(false);
    }
  };

  const closeDialog = () => {
    if (applying) return;
    setDialogOpen(false);
    setReport(null);
    setFailure(null);
  };

  const rasterPages = report ? [...new Set(report.rasterized.map((r) => r.pageIndex + 1))].sort((a, b) => a - b) : [];

  return (
    <div className="annotation-toolbar redaction-toolbar" data-testid="redaction-toolbar">
      <div className="annotation-toolbar-section">
        <span className="annotation-toolbar-label">Mark</span>
        <div className="shape-type-selector">
          <button className={`annotation-toolbar-btn ${mode === 'area' ? 'active' : ''}`} onClick={() => onStyleChange({ redactMode: 'area' })} title="Mark an area (drag a rectangle)" aria-label="Redact area">
            <BoxSelect size={14} />
          </button>
          <button className={`annotation-toolbar-btn ${mode === 'text' ? 'active' : ''}`} onClick={() => onStyleChange({ redactMode: 'text' })} title="Mark text (select it)" aria-label="Redact text selection">
            <TextSelect size={14} />
          </button>
        </div>
      </div>

      <div className="annotation-toolbar-section">
        <span className="annotation-toolbar-label">Find</span>
        <input
          className="stamp-custom-input redaction-search-input"
          value={term}
          placeholder="Text to redact everywhere"
          aria-label="Text to redact"
          onChange={(e) => setTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void runSearch();
          }}
        />
        <button className={`annotation-toolbar-btn ${caseSensitive ? 'active' : ''}`} onClick={() => setCaseSensitive((v) => !v)} title="Match case" aria-label="Match case">
          <CaseSensitive size={14} />
        </button>
        <button className={`annotation-toolbar-btn ${wholeWord ? 'active' : ''}`} onClick={() => setWholeWord((v) => !v)} title="Whole words only" aria-label="Whole words">
          <WholeWord size={14} />
        </button>
        <button className="redaction-btn" onClick={() => void runSearch()} disabled={!term.trim() || searching} aria-label="Mark all occurrences">
          {searching ? <Loader2 size={14} className="spin" /> : <ScanSearch size={14} />}
          <span>Mark all</span>
        </button>
      </div>

      <div className="annotation-toolbar-section">
        <span className="redaction-count" data-testid="redaction-count">{markCount} pending mark{markCount === 1 ? '' : 's'}</span>
        <button className="redaction-btn danger" disabled={markCount === 0} onClick={() => setDialogOpen(true)} aria-label="Apply redactions">
          <ShieldAlert size={14} />
          <span>Apply redactions…</span>
        </button>
      </div>

      <Modal isOpen={dialogOpen} onClose={closeDialog} title="Apply redactions" width="520px">
        {!report && (
          <div className="redaction-dialog" data-testid="apply-redactions-dialog">
            <p className="redaction-warning">
              <strong>This permanently removes content.</strong> Text, vector graphics and image pixels under the {markCount} mark
              {markCount === 1 ? '' : 's'} are deleted from the document, and annotations under them are removed. Undo works until you
              close the document; once saved, the removed content cannot be recovered.
            </p>
            <p className="redaction-note">
              Where content cannot be removed glyph-by-glyph (e.g. text drawn as outlines or Type3 fonts), the affected area is
              replaced with an image. You will be told which pages this happened on.
            </p>
            <label className="redaction-option">
              <span>Box colour</span>
              <input type="color" value={fillColor} onChange={(e) => setFillColor(e.target.value)} aria-label="Redaction box colour" />
            </label>
            <label className="redaction-option">
              <input type="checkbox" checked={stripMetadata} onChange={(e) => setStripMetadata(e.target.checked)} aria-label="Strip metadata" />
              <span>Also remove document metadata (title, author, XMP)</span>
            </label>
            {failure && <div className="redaction-error" role="alert">{failure}</div>}
            <div className="redaction-dialog-actions">
              <button className="dialog-btn cancel" onClick={closeDialog} disabled={applying}>Cancel</button>
              <button className="dialog-btn danger" onClick={() => void apply()} disabled={applying} data-testid="confirm-apply-redactions">
                {applying ? 'Applying…' : 'Apply redactions'}
              </button>
            </div>
          </div>
        )}
        {report && (
          <div className="redaction-dialog" data-testid="redaction-report">
            <p className="redaction-success">
              Redaction verified on {report.pagesRedacted.length} page{report.pagesRedacted.length === 1 ? '' : 's'}.
            </p>
            <ul className="redaction-summary">
              <li>{report.stats.glyphsRemoved} text glyphs removed</li>
              <li>{report.stats.pathsRemoved} vector paths removed</li>
              <li>{report.stats.imagesRedacted + report.stats.inlineImagesRedacted} images redacted</li>
              <li>{report.annotationsRemoved} annotations removed</li>
              {report.metadataStripped && <li>Document metadata removed</li>}
            </ul>
            {rasterPages.length > 0 && (
              <p className="redaction-note" data-testid="redaction-raster-pages">
                Rasterized (replaced by an image) on page{rasterPages.length === 1 ? '' : 's'} {rasterPages.join(', ')}:{' '}
                {[...new Set(report.rasterized.map((r) => r.reason))].join('; ')}
              </p>
            )}
            {report.residualLocations.length > 0 && (
              <p className="redaction-warning">
                The searched text still appears outside the page content (e.g. bookmarks, form values or metadata):{' '}
                {report.residualLocations.slice(0, 3).join('; ')}
              </p>
            )}
            <p className="redaction-note">Save the document to make the redaction permanent on disk.</p>
            <div className="redaction-dialog-actions">
              <button className="dialog-btn save" onClick={closeDialog}>Done</button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
};

export default RedactionToolbar;
