import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { Droplets, PanelTop, Hash, FileDigit, Loader2, Trash2, Type, Image, Info } from 'lucide-react';
import Modal from './Modal';
import { PDFJS_DOCUMENT_OPTIONS } from '../utils/pdfjsConfig';
import {
  applyStamp,
  removeStamps,
  listStampKinds,
  renderStampPreview,
  isStampValidationError,
  STAMP_FONTS,
  STAMP_KIND_LABELS,
  GRID_POSITIONS,
  SLOT_POSITIONS,
  type StampKind,
  type StampRequest,
  type StampContext,
  type TextStyle,
  type GridPosition,
  type SlotPosition,
  type PageNumberPreset,
  type StampFont,
} from '../utils/stamping';
import '../styles/stamping.css';

/** Picked image as returned by the existing open-image-dialog IPC. */
export interface PickedImage {
  path: string;
  data: string; // base64
  type: string;
}

interface StampingDialogProps {
  isOpen: boolean;
  onClose: () => void;
  pdfData: Uint8Array;
  pageCount: number;
  fileName: string;
  currentPage: number;
  /**
   * Commit a byte transform to the open document (undoable). Provided by the
   * document hook so the stamp is rendered by the real viewer immediately.
   */
  applyTransform: (type: string, transform: (pdfData: Uint8Array) => Promise<Uint8Array>) => Promise<void>;
  pickImage: () => Promise<PickedImage | null>;
  onDone: (message: string) => void;
}

const TABS: Array<{ kind: StampKind; icon: React.ReactNode }> = [
  { kind: 'Watermark', icon: <Droplets size={16} /> },
  { kind: 'HeaderFooter', icon: <PanelTop size={16} /> },
  { kind: 'PageNumbers', icon: <Hash size={16} /> },
  { kind: 'Bates', icon: <FileDigit size={16} /> },
];

const SLOT_LABELS: Record<SlotPosition, string> = {
  'header-left': 'Header left',
  'header-center': 'Header center',
  'header-right': 'Header right',
  'footer-left': 'Footer left',
  'footer-center': 'Footer center',
  'footer-right': 'Footer right',
};

const GRID_LABELS: Record<GridPosition, string> = {
  'top-left': 'Top left', 'top-center': 'Top center', 'top-right': 'Top right',
  'middle-left': 'Middle left', center: 'Center', 'middle-right': 'Middle right',
  'bottom-left': 'Bottom left', 'bottom-center': 'Bottom center', 'bottom-right': 'Bottom right',
};

const PRESET_LABELS: Record<PageNumberPreset, string> = {
  n: '1, 2, 3',
  'page-n-of-total': 'Page 1 of N',
  roman: 'i, ii, iii',
};

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function numberOr(value: string, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

const TextStyleFields: React.FC<{ style: TextStyle; onChange: (s: TextStyle) => void; idPrefix: string }> = ({
  style,
  onChange,
  idPrefix,
}) => (
  <div className="stamp-row">
    <div className="stamp-field">
      <label htmlFor={`${idPrefix}-font`}>Font</label>
      <select
        id={`${idPrefix}-font`}
        value={style.font}
        onChange={(e) => onChange({ ...style, font: e.target.value as StampFont })}
      >
        {STAMP_FONTS.map((f) => (
          <option key={f} value={f}>{f}</option>
        ))}
      </select>
    </div>
    <div className="stamp-field stamp-field-narrow">
      <label htmlFor={`${idPrefix}-size`}>Size</label>
      <input
        id={`${idPrefix}-size`}
        type="number"
        min={4}
        max={400}
        value={style.fontSize}
        onChange={(e) => onChange({ ...style, fontSize: numberOr(e.target.value, style.fontSize) })}
      />
    </div>
    <div className="stamp-field stamp-field-narrow">
      <label htmlFor={`${idPrefix}-color`}>Color</label>
      <input
        id={`${idPrefix}-color`}
        type="color"
        value={style.color}
        onChange={(e) => onChange({ ...style, color: e.target.value })}
      />
    </div>
  </div>
);

type Margins = { top: number; bottom: number; left: number; right: number };

const MarginFields: React.FC<{ margins: Margins; onChange: (m: Margins) => void; idPrefix: string }> = ({
  margins,
  onChange,
  idPrefix,
}) => (
  <div className="stamp-row">
    {(['top', 'bottom', 'left', 'right'] as const).map((side) => (
      <div className="stamp-field stamp-field-narrow" key={side}>
        <label htmlFor={`${idPrefix}-m-${side}`}>{side} (pt)</label>
        <input
          id={`${idPrefix}-m-${side}`}
          type="number"
          min={0}
          value={margins[side]}
          onChange={(e) => onChange({ ...margins, [side]: numberOr(e.target.value, margins[side]) })}
        />
      </div>
    ))}
  </div>
);

const StampingDialog: React.FC<StampingDialogProps> = ({
  isOpen,
  onClose,
  pdfData,
  pageCount,
  fileName,
  currentPage,
  applyTransform,
  pickImage,
  onDone,
}) => {
  const [tab, setTab] = useState<StampKind>('Watermark');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [previewError, setPreviewError] = useState<string | null>(null);
  // True when the preview failed because the input is invalid (Apply would fail
  // the same way); false for transient render failures that should not block.
  const [previewBlocks, setPreviewBlocks] = useState(false);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [previewPage, setPreviewPage] = useState(1);
  const [existingKinds, setExistingKinds] = useState<StampKind[]>([]);
  const [replaceExisting, setReplaceExisting] = useState(true);

  // Watermark
  const [wmSource, setWmSource] = useState<'text' | 'image'>('text');
  const [wmText, setWmText] = useState('CONFIDENTIAL');
  const [wmStyle, setWmStyle] = useState<TextStyle>({ font: 'Helvetica-Bold', fontSize: 72, color: '#c00000' });
  const [wmImage, setWmImage] = useState<{ name: string; bytes: Uint8Array } | null>(null);
  const [wmScale, setWmScale] = useState(50);
  const [wmOpacity, setWmOpacity] = useState(30);
  const [wmRotation, setWmRotation] = useState(45);
  const [wmPosition, setWmPosition] = useState<GridPosition>('center');
  const [wmTile, setWmTile] = useState(false);
  const [wmBehind, setWmBehind] = useState(false);
  const [wmRange, setWmRange] = useState('all');
  const [wmMargin, setWmMargin] = useState(36);

  // Header / footer
  const [hfSlots, setHfSlots] = useState<Partial<Record<SlotPosition, string>>>({
    'header-left': '{filename}',
    'header-right': '{date}',
    'footer-center': 'Page {page} of {pages}',
  });
  const [hfStyle, setHfStyle] = useState<TextStyle>({ font: 'Helvetica', fontSize: 10, color: '#000000' });
  const [hfMargins, setHfMargins] = useState<Margins>({ top: 24, bottom: 24, left: 36, right: 36 });
  const [hfRange, setHfRange] = useState('all');
  const [hfSkipFirst, setHfSkipFirst] = useState(false);

  // Page numbers
  const [pnPreset, setPnPreset] = useState<PageNumberPreset>('page-n-of-total');
  const [pnPosition, setPnPosition] = useState<SlotPosition>('footer-center');
  const [pnStyle, setPnStyle] = useState<TextStyle>({ font: 'Helvetica', fontSize: 10, color: '#000000' });
  const [pnMargins, setPnMargins] = useState<Margins>({ top: 24, bottom: 24, left: 36, right: 36 });
  const [pnRange, setPnRange] = useState('all');
  const [pnSkipFirst, setPnSkipFirst] = useState(false);
  const [pnStart, setPnStart] = useState(1);

  // Bates
  const [btPrefix, setBtPrefix] = useState('');
  const [btSuffix, setBtSuffix] = useState('');
  const [btStart, setBtStart] = useState(1);
  const [btDigits, setBtDigits] = useState(6);
  const [btPosition, setBtPosition] = useState<SlotPosition>('footer-right');
  const [btStyle, setBtStyle] = useState<TextStyle>({ font: 'Helvetica', fontSize: 10, color: '#000000' });
  const [btMargins, setBtMargins] = useState<Margins>({ top: 24, bottom: 24, left: 36, right: 36 });
  const [btRange, setBtRange] = useState('all');

  const canvasRef = useRef<HTMLCanvasElement>(null);

  // The date is fixed when the dialog opens so the preview and the applied
  // stamp show the same {date}.
  const stampContext = useMemo<StampContext>(() => ({ fileName, date: new Date() }), [fileName, isOpen]);

  useEffect(() => {
    if (isOpen) {
      setPreviewPage(Math.min(Math.max(currentPage, 1), pageCount));
      setError(null);
    }
  }, [isOpen, currentPage, pageCount]);

  useEffect(() => {
    if (!isOpen) return;
    let cancelled = false;
    listStampKinds(pdfData)
      .then((kinds) => {
        if (!cancelled) setExistingKinds(kinds);
      })
      .catch(() => {
        if (!cancelled) setExistingKinds([]);
      });
    return () => {
      cancelled = true;
    };
  }, [isOpen, pdfData]);

  /** The request for the active tab, or a user-facing reason it can't be built. */
  const request = useMemo<StampRequest | { error: string }>(() => {
    switch (tab) {
      case 'Watermark':
        if (wmSource === 'image' && !wmImage) return { error: 'Choose a PNG or JPEG image.' };
        return {
          kind: 'Watermark',
          options: {
            source: wmSource === 'text'
              ? { type: 'text', text: wmText, style: wmStyle }
              : { type: 'image', bytes: wmImage!.bytes, scale: wmScale / 100 },
            opacity: wmOpacity / 100,
            rotation: wmRotation,
            position: wmPosition,
            tile: wmTile,
            behind: wmBehind,
            pageRange: wmRange,
            margin: wmMargin,
          },
        };
      case 'HeaderFooter':
        return {
          kind: 'HeaderFooter',
          options: {
            slots: hfSlots,
            style: hfStyle,
            margins: hfMargins,
            pageRange: hfRange,
            skipFirstPage: hfSkipFirst,
            startNumber: 1,
            numberFormat: 'arabic',
          },
        };
      case 'PageNumbers':
        return {
          kind: 'PageNumbers',
          options: {
            preset: pnPreset,
            position: pnPosition,
            style: pnStyle,
            margins: pnMargins,
            pageRange: pnRange,
            skipFirstPage: pnSkipFirst,
            startNumber: pnStart,
          },
        };
      case 'Bates':
        return {
          kind: 'Bates',
          options: {
            prefix: btPrefix,
            suffix: btSuffix,
            startNumber: btStart,
            digits: btDigits,
            position: btPosition,
            style: btStyle,
            margins: btMargins,
            pageRange: btRange,
          },
        };
    }
  }, [
    tab, wmSource, wmText, wmStyle, wmImage, wmScale, wmOpacity, wmRotation, wmPosition, wmTile, wmBehind, wmRange, wmMargin,
    hfSlots, hfStyle, hfMargins, hfRange, hfSkipFirst,
    pnPreset, pnPosition, pnStyle, pnMargins, pnRange, pnSkipFirst, pnStart,
    btPrefix, btSuffix, btStart, btDigits, btPosition, btStyle, btMargins, btRange,
  ]);

  // Live preview: stamp the preview page for real and render it with pdf.js.
  useEffect(() => {
    if (!isOpen) return;
    if ('error' in request) {
      setPreviewError(request.error);
      setPreviewBlocks(true);
      return;
    }
    let cancelled = false;
    let loadingTask: ReturnType<typeof pdfjsLib.getDocument> | null = null;
    let renderTask: ReturnType<pdfjsLib.PDFPageProxy['render']> | null = null;
    const timer = window.setTimeout(async () => {
      setPreviewLoading(true);
      try {
        const bytes = await renderStampPreview(pdfData, request, stampContext, previewPage - 1, { replaceExisting });
        if (cancelled) return;
        loadingTask = pdfjsLib.getDocument({ ...PDFJS_DOCUMENT_OPTIONS, data: bytes });
        const doc = await loadingTask.promise;
        if (cancelled) return;
        const page = await doc.getPage(1);
        const canvas = canvasRef.current;
        if (!canvas || cancelled) return;
        const base = page.getViewport({ scale: 1 });
        const scale = Math.min(300 / base.width, 380 / base.height);
        const dpr = window.devicePixelRatio || 1;
        const viewport = page.getViewport({ scale: scale * dpr });
        canvas.width = Math.floor(viewport.width);
        canvas.height = Math.floor(viewport.height);
        canvas.style.width = `${Math.floor(viewport.width / dpr)}px`;
        canvas.style.height = `${Math.floor(viewport.height / dpr)}px`;
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('Canvas 2D context unavailable');
        renderTask = page.render({ canvasContext: ctx, viewport });
        await renderTask.promise;
        if (!cancelled) {
          setPreviewError(null);
          setPreviewBlocks(false);
        }
      } catch (e) {
        if (cancelled) return;
        const name = (e as { name?: string })?.name;
        if (name === 'RenderingCancelledException') return;
        const invalid = isStampValidationError(e);
        setPreviewError(invalid ? (e as Error).message : `Preview failed: ${(e as Error).message}`);
        setPreviewBlocks(invalid);
      } finally {
        if (!cancelled) setPreviewLoading(false);
      }
    }, 250);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      renderTask?.cancel();
      void loadingTask?.destroy();
    };
  }, [isOpen, request, pdfData, previewPage, stampContext, replaceExisting]);

  const handlePickImage = useCallback(async () => {
    setError(null);
    try {
      const picked = await pickImage();
      if (!picked) return;
      const name = picked.path.split(/[\\/]/).pop() || picked.path;
      setWmImage({ name, bytes: base64ToBytes(picked.data) });
    } catch (e) {
      setError(`Could not open the image: ${(e as Error).message}`);
    }
  }, [pickImage]);

  const handleApply = useCallback(async () => {
    if ('error' in request) {
      setError(request.error);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      let stampedCount = 0;
      await applyTransform(`stamp:${request.kind}`, async (bytes) => {
        const result = await applyStamp(bytes, request, stampContext, { replaceExisting });
        stampedCount = result.stampedPages.length;
        return result.bytes;
      });
      onDone(`${STAMP_KIND_LABELS[request.kind]} added to ${stampedCount} page${stampedCount === 1 ? '' : 's'}`);
      onClose();
    } catch (e) {
      setError(isStampValidationError(e) ? e.message : `Could not apply: ${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }, [request, applyTransform, stampContext, replaceExisting, onDone, onClose]);

  const handleRemove = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      await applyTransform(`removeStamp:${tab}`, async (bytes) => {
        const result = await removeStamps(bytes, tab);
        if (result.removed === 0) {
          throw new Error(`No ${STAMP_KIND_LABELS[tab].toLowerCase()} added by PDF Manager was found.`);
        }
        return result.bytes;
      });
      onDone(`${STAMP_KIND_LABELS[tab]} removed`);
      onClose();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }, [tab, applyTransform, onDone, onClose]);

  const hasExisting = existingKinds.includes(tab);

  return (
    <Modal isOpen={isOpen} onClose={busy ? () => {} : onClose} title="Stamp Pages" width="900px">
      <div className="stamp-dialog" data-testid="stamping-dialog">
        <div className="stamp-tabs" role="tablist">
          {TABS.map((t) => (
            <button
              key={t.kind}
              role="tab"
              aria-selected={tab === t.kind}
              className={`stamp-tab${tab === t.kind ? ' active' : ''}`}
              onClick={() => {
                setTab(t.kind);
                setError(null);
              }}
              data-stamp-tab={t.kind}
            >
              {t.icon}
              <span>{STAMP_KIND_LABELS[t.kind]}</span>
            </button>
          ))}
        </div>

        <div className="stamp-body">
          <div className="stamp-form">
            {tab === 'Watermark' && (
              <>
                <div className="stamp-segment" role="radiogroup" aria-label="Watermark source">
                  <button className={wmSource === 'text' ? 'active' : ''} onClick={() => setWmSource('text')}>
                    <Type size={14} /> Text
                  </button>
                  <button className={wmSource === 'image' ? 'active' : ''} onClick={() => setWmSource('image')}>
                    <Image size={14} /> Image
                  </button>
                </div>
                {wmSource === 'text' ? (
                  <>
                    <div className="stamp-field">
                      <label htmlFor="wm-text">Text</label>
                      <input id="wm-text" type="text" value={wmText} onChange={(e) => setWmText(e.target.value)} />
                    </div>
                    <TextStyleFields style={wmStyle} onChange={setWmStyle} idPrefix="wm" />
                  </>
                ) : (
                  <div className="stamp-row">
                    <div className="stamp-field">
                      <label>Image (PNG or JPEG)</label>
                      <button className="btn btn-secondary" onClick={handlePickImage}>
                        {wmImage ? wmImage.name : 'Choose image…'}
                      </button>
                    </div>
                    <div className="stamp-field stamp-field-narrow">
                      <label htmlFor="wm-scale">Width %</label>
                      <input id="wm-scale" type="number" min={1} max={100} value={wmScale}
                        onChange={(e) => setWmScale(numberOr(e.target.value, wmScale))} />
                    </div>
                  </div>
                )}
                <div className="stamp-row">
                  <div className="stamp-field">
                    <label htmlFor="wm-opacity">Opacity {wmOpacity}%</label>
                    <input id="wm-opacity" type="range" min={1} max={100} value={wmOpacity}
                      onChange={(e) => setWmOpacity(numberOr(e.target.value, wmOpacity))} />
                  </div>
                  <div className="stamp-field stamp-field-narrow">
                    <label htmlFor="wm-rotation">Rotation°</label>
                    <input id="wm-rotation" type="number" min={-360} max={360} value={wmRotation}
                      onChange={(e) => setWmRotation(numberOr(e.target.value, wmRotation))} />
                  </div>
                </div>
                <div className="stamp-row">
                  <div className="stamp-field">
                    <label htmlFor="wm-position">Position</label>
                    <select id="wm-position" value={wmPosition} disabled={wmTile}
                      onChange={(e) => setWmPosition(e.target.value as GridPosition)}>
                      {GRID_POSITIONS.map((p) => <option key={p} value={p}>{GRID_LABELS[p]}</option>)}
                    </select>
                  </div>
                  <div className="stamp-field stamp-field-narrow">
                    <label htmlFor="wm-margin">Margin (pt)</label>
                    <input id="wm-margin" type="number" min={0} value={wmMargin}
                      onChange={(e) => setWmMargin(numberOr(e.target.value, wmMargin))} />
                  </div>
                </div>
                <div className="stamp-checks">
                  <label><input type="checkbox" checked={wmTile} onChange={(e) => setWmTile(e.target.checked)} /> Tile across the page</label>
                  <label><input type="checkbox" checked={wmBehind} onChange={(e) => setWmBehind(e.target.checked)} /> Place behind page content</label>
                </div>
                <div className="stamp-field">
                  <label htmlFor="wm-range">Pages</label>
                  <input id="wm-range" type="text" value={wmRange} onChange={(e) => setWmRange(e.target.value)} />
                </div>
              </>
            )}

            {tab === 'HeaderFooter' && (
              <>
                <div className="stamp-slot-grid">
                  {SLOT_POSITIONS.map((slot) => (
                    <div className="stamp-field" key={slot}>
                      <label htmlFor={`hf-${slot}`}>{SLOT_LABELS[slot]}</label>
                      <input id={`hf-${slot}`} type="text" value={hfSlots[slot] ?? ''}
                        onChange={(e) => setHfSlots({ ...hfSlots, [slot]: e.target.value })} />
                    </div>
                  ))}
                </div>
                <p className="form-help">Tokens: {'{page}'} {'{pages}'} {'{date}'} {'{filename}'}</p>
                <TextStyleFields style={hfStyle} onChange={setHfStyle} idPrefix="hf" />
                <MarginFields margins={hfMargins} onChange={setHfMargins} idPrefix="hf" />
                <div className="stamp-field">
                  <label htmlFor="hf-range">Pages</label>
                  <input id="hf-range" type="text" value={hfRange} onChange={(e) => setHfRange(e.target.value)} />
                </div>
                <div className="stamp-checks">
                  <label><input type="checkbox" checked={hfSkipFirst} onChange={(e) => setHfSkipFirst(e.target.checked)} /> Skip the first page</label>
                </div>
              </>
            )}

            {tab === 'PageNumbers' && (
              <>
                <div className="stamp-row">
                  <div className="stamp-field">
                    <label htmlFor="pn-format">Format</label>
                    <select id="pn-format" value={pnPreset} onChange={(e) => setPnPreset(e.target.value as PageNumberPreset)}>
                      {(Object.keys(PRESET_LABELS) as PageNumberPreset[]).map((p) => (
                        <option key={p} value={p}>{PRESET_LABELS[p]}</option>
                      ))}
                    </select>
                  </div>
                  <div className="stamp-field">
                    <label htmlFor="pn-position">Position</label>
                    <select id="pn-position" value={pnPosition} onChange={(e) => setPnPosition(e.target.value as SlotPosition)}>
                      {SLOT_POSITIONS.map((s) => <option key={s} value={s}>{SLOT_LABELS[s]}</option>)}
                    </select>
                  </div>
                  <div className="stamp-field stamp-field-narrow">
                    <label htmlFor="pn-start">Start at</label>
                    <input id="pn-start" type="number" min={pnPreset === 'roman' ? 1 : 0} value={pnStart}
                      onChange={(e) => setPnStart(Math.trunc(numberOr(e.target.value, pnStart)))} />
                  </div>
                </div>
                <TextStyleFields style={pnStyle} onChange={setPnStyle} idPrefix="pn" />
                <MarginFields margins={pnMargins} onChange={setPnMargins} idPrefix="pn" />
                <div className="stamp-field">
                  <label htmlFor="pn-range">Pages</label>
                  <input id="pn-range" type="text" value={pnRange} onChange={(e) => setPnRange(e.target.value)} />
                </div>
                <div className="stamp-checks">
                  <label><input type="checkbox" checked={pnSkipFirst} onChange={(e) => setPnSkipFirst(e.target.checked)} /> Skip the first page</label>
                </div>
              </>
            )}

            {tab === 'Bates' && (
              <>
                <div className="stamp-notice">
                  <Info size={14} />
                  <span>Bates numbering applies to this document only. Numbering a set of files in sequence is not supported.</span>
                </div>
                <div className="stamp-row">
                  <div className="stamp-field">
                    <label htmlFor="bt-prefix">Prefix</label>
                    <input id="bt-prefix" type="text" value={btPrefix} onChange={(e) => setBtPrefix(e.target.value)} />
                  </div>
                  <div className="stamp-field stamp-field-narrow">
                    <label htmlFor="bt-start">Start</label>
                    <input id="bt-start" type="number" min={0} value={btStart}
                      onChange={(e) => setBtStart(Math.trunc(numberOr(e.target.value, btStart)))} />
                  </div>
                  <div className="stamp-field stamp-field-narrow">
                    <label htmlFor="bt-digits">Digits</label>
                    <input id="bt-digits" type="number" min={0} max={15} value={btDigits}
                      onChange={(e) => setBtDigits(Math.trunc(numberOr(e.target.value, btDigits)))} />
                  </div>
                  <div className="stamp-field">
                    <label htmlFor="bt-suffix">Suffix</label>
                    <input id="bt-suffix" type="text" value={btSuffix} onChange={(e) => setBtSuffix(e.target.value)} />
                  </div>
                </div>
                <div className="stamp-field">
                  <label htmlFor="bt-position">Position</label>
                  <select id="bt-position" value={btPosition} onChange={(e) => setBtPosition(e.target.value as SlotPosition)}>
                    {SLOT_POSITIONS.map((s) => <option key={s} value={s}>{SLOT_LABELS[s]}</option>)}
                  </select>
                </div>
                <TextStyleFields style={btStyle} onChange={setBtStyle} idPrefix="bt" />
                <MarginFields margins={btMargins} onChange={setBtMargins} idPrefix="bt" />
                <div className="stamp-field">
                  <label htmlFor="bt-range">Pages</label>
                  <input id="bt-range" type="text" value={btRange} onChange={(e) => setBtRange(e.target.value)} />
                </div>
              </>
            )}

            <p className="form-help">Pages: "all", "odd", "even", or a list such as 1-3,5.</p>
            <div className="stamp-checks">
              <label>
                <input type="checkbox" checked={replaceExisting} onChange={(e) => setReplaceExisting(e.target.checked)} />
                Replace an existing {STAMP_KIND_LABELS[tab].toLowerCase()} added by PDF Manager
              </label>
            </div>
          </div>

          <div className="stamp-preview">
            <div className="stamp-preview-header">
              <span>Preview</span>
              <label htmlFor="stamp-preview-page">
                Page
                <input
                  id="stamp-preview-page"
                  type="number"
                  min={1}
                  max={pageCount}
                  value={previewPage}
                  onChange={(e) => setPreviewPage(Math.min(Math.max(Math.trunc(numberOr(e.target.value, 1)), 1), pageCount))}
                />
                / {pageCount}
              </label>
            </div>
            <div className="stamp-preview-canvas-wrap">
              <canvas ref={canvasRef} className="stamp-preview-canvas" data-testid="stamp-preview-canvas" hidden={!!previewError} />
              {previewError && <p className="stamp-preview-error" data-testid="stamp-preview-error">{previewError}</p>}
              {previewLoading && !previewError && <Loader2 size={20} className="spinning stamp-preview-spinner" />}
            </div>
          </div>
        </div>

        {error && <p className="dialog-error" data-testid="stamp-error">{error}</p>}

        <div className="dialog-actions">
          {hasExisting ? (
            <button className="btn btn-ghost stamp-remove" onClick={handleRemove} disabled={busy} data-testid="stamp-remove">
              <Trash2 size={16} />
              Remove {STAMP_KIND_LABELS[tab].toLowerCase()}
            </button>
          ) : (
            <span />
          )}
          <div className="dialog-actions-right">
            <button className="btn btn-ghost" onClick={onClose} disabled={busy}>Cancel</button>
            <button className="btn btn-primary" onClick={handleApply} disabled={busy || previewBlocks} data-testid="stamp-apply">
              {busy ? (<><Loader2 size={16} className="spinning" /> Applying…</>) : 'Apply'}
            </button>
          </div>
        </div>
      </div>
    </Modal>
  );
};

export default StampingDialog;
