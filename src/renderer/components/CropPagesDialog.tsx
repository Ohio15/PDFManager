import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Crop, Loader2, RotateCcw } from 'lucide-react';
import Modal from './Modal';
import type { PDFDocument } from '../types';
import { PDFJS_DOCUMENT_OPTIONS } from '../utils/pdfjsConfig';
import {
  CropMargins,
  MIN_CROP_SIZE,
  PageGeometry,
  readPageGeometries,
  userBoxToMargins,
} from '../utils/pageStructure';
import { formatPageRange, parsePageRange } from '../utils/pageSelectionModel';
import '../styles/pageTools.css';

interface CropPagesDialogProps {
  isOpen: boolean;
  onClose: () => void;
  document: PDFDocument;
  /** 0-based pages the dialog opens targeting (the sidebar selection). */
  initialPages: number[];
  /** Apply margins (null = reset to the full page) to 0-based pages. */
  onApply: (zeroIndices: number[], margins: CropMargins | null) => Promise<void>;
}

type Scope = 'preview' | 'selection' | 'all' | 'custom';
type DragMode = 'move' | 'nw' | 'ne' | 'sw' | 'se' | 'n' | 's' | 'e' | 'w';

const PREVIEW_MAX_W = 420;
const PREVIEW_MAX_H = 480;
const SIDES: Array<keyof CropMargins> = ['top', 'right', 'bottom', 'left'];

function round(n: number): number {
  return Math.round(n * 10) / 10;
}

/** Displayed (rotated) MediaBox size of a page. */
function displayedMediaSize(geo: PageGeometry): { w: number; h: number } {
  const swap = geo.rotation % 180 === 90;
  return swap
    ? { w: geo.mediaBox.height, h: geo.mediaBox.width }
    : { w: geo.mediaBox.width, h: geo.mediaBox.height };
}

const CropPagesDialog: React.FC<CropPagesDialogProps> = ({ isOpen, onClose, document, initialPages, onApply }) => {
  const pageCount = document.pages.length;
  const previewIndex = initialPages.length > 0 ? Math.min(initialPages[0], pageCount - 1) : 0;
  const [geometries, setGeometries] = useState<PageGeometry[] | null>(null);
  const [margins, setMargins] = useState<CropMargins>({ top: 0, right: 0, bottom: 0, left: 0 });
  const [scope, setScope] = useState<Scope>(initialPages.length > 1 ? 'selection' : 'preview');
  const [customRange, setCustomRange] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const dragRef = useRef<{ mode: DragMode; x: number; y: number; start: CropMargins } | null>(null);

  const geo = geometries?.[previewIndex] ?? null;
  const media = geo ? displayedMediaSize(geo) : null;
  const scale = media ? Math.min(PREVIEW_MAX_W / media.w, PREVIEW_MAX_H / media.h) : 1;

  // Load geometry (pdf-lib) and seed margins from the page's current crop.
  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    setError(null);
    setGeometries(null);
    setScope(initialPages.length > 1 ? 'selection' : 'preview');
    setCustomRange(formatPageRange(initialPages));
    readPageGeometries(document.pdfData)
      .then((geos) => {
        if (cancelled) return;
        setGeometries(geos);
        const g = geos[previewIndex];
        if (g) {
          const m = userBoxToMargins(g.mediaBox, g.rotation, g.box);
          setMargins({ top: round(m.top), right: round(m.right), bottom: round(m.bottom), left: round(m.left) });
        }
      })
      .catch((e) => { if (!cancelled) setError(`Could not read page sizes: ${(e as Error).message}`); });
    return () => { cancelled = true; };
    // initialPages identity changes on every App render; key the load on the open event and page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, document.pdfData, previewIndex]);

  // Render the WHOLE MediaBox (not just the current crop) so the user can
  // widen a crop as well as tighten it.
  useEffect(() => {
    if (!isOpen || !geo) return;
    let cancelled = false;
    let proxy: pdfjsLib.PDFDocumentProxy | null = null;
    (async () => {
      try {
        proxy = await pdfjsLib.getDocument({ ...PDFJS_DOCUMENT_OPTIONS, data: new Uint8Array(document.pdfData) }).promise;
        const page = await proxy.getPage(previewIndex + 1);
        const base = page.getViewport({ scale, rotation: geo.rotation });
        const ViewportCtor = base.constructor as new (args: Record<string, unknown>) => typeof base;
        const m = geo.mediaBox;
        const viewport = new ViewportCtor({
          viewBox: [m.x, m.y, m.x + m.width, m.y + m.height],
          userUnit: (base as unknown as { userUnit?: number }).userUnit ?? 1,
          scale,
          rotation: geo.rotation,
          offsetX: 0,
          offsetY: 0,
          dontFlip: false,
        });
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        canvas.width = Math.round(viewport.width);
        canvas.height = Math.round(viewport.height);
        const ctx = canvas.getContext('2d');
        if (!ctx) return;
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        await page.render({ canvasContext: ctx, viewport }).promise;
      } catch (e) {
        if (!cancelled) setError(`Could not render the page preview: ${(e as Error).message}`);
      } finally {
        proxy?.destroy().catch(() => {});
      }
    })();
    return () => { cancelled = true; };
  }, [isOpen, geo, scale, previewIndex, document.pdfData]);

  const clampMargins = useCallback(
    (m: CropMargins): CropMargins => {
      if (!media) return m;
      const out = { ...m };
      for (const k of SIDES) out[k] = Math.max(0, out[k]);
      out.left = Math.min(out.left, media.w - MIN_CROP_SIZE - out.right);
      out.right = Math.min(out.right, media.w - MIN_CROP_SIZE - out.left);
      out.top = Math.min(out.top, media.h - MIN_CROP_SIZE - out.bottom);
      out.bottom = Math.min(out.bottom, media.h - MIN_CROP_SIZE - out.top);
      for (const k of SIDES) out[k] = round(Math.max(0, out[k]));
      return out;
    },
    [media]
  );

  const onPointerDown = (mode: DragMode) => (e: React.PointerEvent) => {
    e.preventDefault();
    e.stopPropagation();
    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    dragRef.current = { mode, x: e.clientX, y: e.clientY, start: margins };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag || !media) return;
    const dx = (e.clientX - drag.x) / scale;
    const dy = (e.clientY - drag.y) / scale;
    const s = drag.start;
    const next = { ...s };
    if (drag.mode === 'move') {
      const mx = Math.max(-s.left, Math.min(dx, s.right));
      const my = Math.max(-s.top, Math.min(dy, s.bottom));
      next.left = s.left + mx; next.right = s.right - mx;
      next.top = s.top + my; next.bottom = s.bottom - my;
    } else {
      if (drag.mode.includes('n')) next.top = s.top + dy;
      if (drag.mode.includes('s')) next.bottom = s.bottom - dy;
      if (drag.mode.includes('w')) next.left = s.left + dx;
      if (drag.mode.includes('e')) next.right = s.right - dx;
    }
    setMargins(clampMargins(next));
  };

  const onPointerUp = () => { dragRef.current = null; };

  const targets = useMemo((): number[] | null => {
    switch (scope) {
      case 'preview': return [previewIndex];
      case 'selection': return initialPages.length > 0 ? initialPages : [previewIndex];
      case 'all': return Array.from({ length: pageCount }, (_, i) => i);
      case 'custom': return parsePageRange(customRange, pageCount);
    }
  }, [scope, previewIndex, initialPages, pageCount, customRange]);

  const run = useCallback(async (m: CropMargins | null) => {
    if (!targets || targets.length === 0) {
      setError(`Enter pages between 1 and ${pageCount}, e.g. 1,3,5-7`);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      await onApply(targets, m);
      onClose();
    } catch (e) {
      setError((e as Error).message || 'Crop failed');
    } finally {
      setBusy(false);
    }
  }, [targets, pageCount, onApply, onClose]);

  const resultW = media ? media.w - margins.left - margins.right : 0;
  const resultH = media ? media.h - margins.top - margins.bottom : 0;
  const handles: DragMode[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Crop Pages" width="760px">
      <div className="crop-dialog" data-testid="crop-dialog">
        <div className="crop-preview-wrap">
          {media ? (
            <div
              className="crop-preview"
              style={{ width: media.w * scale, height: media.h * scale }}
              onPointerMove={onPointerMove}
              onPointerUp={onPointerUp}
              onPointerCancel={onPointerUp}
            >
              <canvas ref={canvasRef} className="crop-preview-canvas" />
              <div
                className="crop-box"
                data-testid="crop-box"
                style={{
                  left: margins.left * scale,
                  top: margins.top * scale,
                  width: Math.max(0, resultW * scale),
                  height: Math.max(0, resultH * scale),
                }}
                onPointerDown={onPointerDown('move')}
              >
                {handles.map((h) => (
                  <span
                    key={h}
                    className={`crop-handle crop-handle-${h}`}
                    data-handle={h}
                    onPointerDown={onPointerDown(h)}
                  />
                ))}
              </div>
            </div>
          ) : (
            <div className="crop-preview-loading"><Loader2 size={20} className="spinning" /> Loading page…</div>
          )}
          <p className="form-help">Page {previewIndex + 1}. Drag the box or its handles, or type margins.</p>
        </div>

        <div className="crop-controls">
          <fieldset className="crop-fieldset">
            <legend>Margins (points, 72 pt = 1 in)</legend>
            {SIDES.map((side) => (
              <label key={side} className="crop-margin">
                <span>{side[0].toUpperCase() + side.slice(1)}</span>
                <input
                  type="number"
                  min={0}
                  step={1}
                  aria-label={`Crop ${side}`}
                  value={margins[side]}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setMargins(clampMargins({ ...margins, [side]: Number.isFinite(v) ? v : 0 }));
                  }}
                />
              </label>
            ))}
            <p className="form-help" data-testid="crop-result-size">
              Result: {round(resultW)} × {round(resultH)} pt ({(resultW / 72).toFixed(2)} × {(resultH / 72).toFixed(2)} in)
            </p>
          </fieldset>

          <fieldset className="crop-fieldset">
            <legend>Apply to</legend>
            <label className="crop-scope">
              <input type="radio" name="crop-scope" checked={scope === 'preview'} onChange={() => setScope('preview')} />
              Page {previewIndex + 1}
            </label>
            {initialPages.length > 1 && (
              <label className="crop-scope">
                <input type="radio" name="crop-scope" checked={scope === 'selection'} onChange={() => setScope('selection')} />
                Selected pages ({formatPageRange(initialPages)})
              </label>
            )}
            <label className="crop-scope">
              <input type="radio" name="crop-scope" checked={scope === 'all'} onChange={() => setScope('all')} />
              All pages (1-{pageCount})
            </label>
            <label className="crop-scope">
              <input type="radio" name="crop-scope" checked={scope === 'custom'} onChange={() => setScope('custom')} />
              Pages
              <input
                type="text"
                className="crop-range-input"
                aria-label="Crop page range"
                value={customRange}
                placeholder="e.g. 1,3,5-7"
                onFocus={() => setScope('custom')}
                onChange={(e) => { setCustomRange(e.target.value); setScope('custom'); }}
              />
            </label>
            <p className="form-help">Margins are measured from each page's full size, so pages of different sizes all lose the same border.</p>
          </fieldset>

          {error && <p className="dialog-error" role="alert">{error}</p>}

          <div className="dialog-actions">
            <button className="btn btn-ghost" onClick={() => run(null)} disabled={busy || !geometries} title="Remove the crop from the chosen pages">
              <RotateCcw size={14} /> Reset to full page
            </button>
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={() => run(margins)} disabled={busy || !geometries} data-testid="crop-apply">
              {busy ? <Loader2 size={16} className="spinning" /> : <Crop size={16} />}
              Apply crop
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default CropPagesDialog;
