/**
 * Pending annotations vs redaction marks (audit 2026-10-08, HIGH "Pending
 * annotations under a mark survive Apply on rotated or cropped pages").
 *
 * Every case runs on a REAL pdf-lib page with /Rotate 0/90/180/270, with and
 * without a CropBox offset. The page frame comes from pageStructure's
 * pageGeometry (the helper the hook and the save pipeline use). Placements are
 * checked against two independent oracles:
 *   - the real save pipeline (applyEditsAndAnnotations): its output content
 *     stream is interpreted here and the painted ink must lie inside the
 *     computed footprint, edge for edge where the geometry is exact;
 *   - pdf.js's own PageViewport (convertToPdfPoint) for the on-screen
 *     placement on rotated pages.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  PDFArray,
  PDFDict,
  PDFDocument as PDFLib,
  PDFFont,
  PDFHexString,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
  degrees,
} from 'pdf-lib';
import { applyEditsAndAnnotations } from '../pdfSavePipeline';
import { pageGeometry } from '../pageStructure';
import {
  AnnotationPageFrame,
  annotationFootprints,
  annotationPlacements,
  isUnderAnyMark,
  partitionByMarks,
} from '../annotationBounds';
import type { Annotation, PDFPage, PdfRect, TextMarkupAnnotation } from '../../types';

// ---------------------------------------------------------------- fixtures

const ROTATIONS = [0, 90, 180, 270] as const;
const MEDIA = { w: 600, h: 800 };
/** CropBox offset from the MediaBox origin (the crop tool produces exactly this shape). */
const CROP = { x0: 50, y0: 70, x1: 450, y1: 670 };
const CROPS = [false, true] as const;

/** 2×2 opaque PNG, so the image writer has a real XObject to embed. */
const PNG_2X2 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAAFklEQVR4nGP8z8DAwMDAxMDAwMDAAAANHQEDasKb6QAAAABJRU5ErkJggg==';

interface PageCase {
  rotation: number;
  cropped: boolean;
  bytes: Uint8Array;
  frame: AnnotationPageFrame;
  /** pdf.js viewport at scale 1 with the page's rotation (independent display oracle). */
  viewport: { convertToPdfPoint(x: number, y: number): number[]; viewBox: number[] };
}

async function makePage(rotation: number, cropped: boolean): Promise<Uint8Array> {
  const doc = await PDFLib.create();
  const page = doc.addPage([MEDIA.w, MEDIA.h]);
  if (cropped) page.setCropBox(CROP.x0, CROP.y0, CROP.x1 - CROP.x0, CROP.y1 - CROP.y0);
  page.setRotation(degrees(rotation));
  return new Uint8Array(await doc.save());
}

const cases: PageCase[] = [];
let helvetica: PDFFont;

beforeAll(async () => {
  const fontDoc = await PDFLib.create();
  helvetica = await fontDoc.embedFont(StandardFonts.Helvetica);
  for (const rotation of ROTATIONS) {
    for (const cropped of CROPS) {
      const bytes = await makePage(rotation, cropped);
      const lib = await PDFLib.load(bytes);
      const geo = pageGeometry(lib.getPage(0));
      const pdf = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false }).promise;
      const p = await pdf.getPage(1);
      const viewport = p.getViewport({ scale: 1 });
      await pdf.destroy();
      cases.push({ rotation, cropped, bytes, frame: { box: geo.box, rotation: geo.rotation }, viewport });
    }
  }
}, 60_000);

const pageCase = (rotation: number, cropped: boolean) => cases.find((c) => c.rotation === rotation && c.cropped === cropped)!;

// ------------------------------------------------------------- geometry

const rect = (x0: number, y0: number, x1: number, y1: number): PdfRect => ({ x0, y0, x1, y1 });
const overlaps = (a: PdfRect, b: PdfRect) => Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
const grow = (r: PdfRect, d: number): PdfRect => rect(r.x0 - d, r.y0 - d, r.x1 + d, r.y1 + d);
const union = (rs: PdfRect[]): PdfRect =>
  rect(Math.min(...rs.map((r) => r.x0)), Math.min(...rs.map((r) => r.y0)), Math.max(...rs.map((r) => r.x1)), Math.max(...rs.map((r) => r.y1)));
const centreMark = (r: PdfRect): PdfRect => {
  const cx = (r.x0 + r.x1) / 2, cy = (r.y0 + r.y1) / 2;
  return rect(cx - 2, cy - 2, cx + 2, cy + 2);
};

/**
 * Target placement in model space (top-left of the visible box): the
 * annotation's model rect is (MX, MY, MW, MH). Its saved user-space rect is
 * derived from the page's visible box, i.e. a KNOWN PDF-space position.
 */
const MX = 40, MY = 50, MW = 60, MH = 30;

/** Model-space extent each kind paints from (MX, MY): notes are a fixed 24pt marker, text is 'Hello' at 12pt. */
const extent = (kind?: Kind) => (kind === 'note' ? { w: 24, h: 24 } : kind === 'text' ? { w: 27, h: 12 } : { w: MW, h: MH });

function savedTarget(c: PageCase, kind?: Kind): PdfRect {
  const b = c.frame.box;
  const { w, h } = extent(kind);
  return rect(b.x + MX, b.y + b.height - MY - h, b.x + MX + w, b.y + b.height - MY);
}

/** Where pdf.js shows the model rect, in user space (independent of annotationBounds). */
function displayedTarget(c: PageCase, kind?: Kind): PdfRect {
  const x = MX, y = MY;
  const { w, h } = extent(kind);
  const pts = [[x, y], [x + w, y], [x, y + h], [x + w, y + h]].map(([vx, vy]) => c.viewport.convertToPdfPoint(vx, vy));
  return rect(Math.min(...pts.map((p) => p[0])), Math.min(...pts.map((p) => p[1])), Math.max(...pts.map((p) => p[0])), Math.max(...pts.map((p) => p[1])));
}

/** A 10×10 mark in a corner of the visible box that is far from every rect in `avoid`. */
function farMark(c: PageCase, avoid: PdfRect[]): PdfRect {
  const b = c.frame.box;
  const candidates = [
    rect(b.x + 2, b.y + 2, b.x + 12, b.y + 12),
    rect(b.x + b.width - 12, b.y + 2, b.x + b.width - 2, b.y + 12),
    rect(b.x + 2, b.y + b.height - 12, b.x + 12, b.y + b.height - 2),
    rect(b.x + b.width - 12, b.y + b.height - 12, b.x + b.width - 2, b.y + b.height - 2),
  ];
  const free = candidates.find((m) => avoid.every((a) => !overlaps(grow(a, 30), m)));
  if (!free) throw new Error('fixture: no free corner for a non-covering mark');
  return free;
}

// ---------------------------------------------------------- annotations

type Kind =
  | 'text' | 'image' | 'shape-rectangle' | 'shape-ellipse' | 'shape-line' | 'shape-arrow'
  | 'stamp' | 'note' | 'highlight' | 'drawing' | 'textMarkup';
const KINDS: Kind[] = ['text', 'image', 'shape-rectangle', 'shape-ellipse', 'shape-line', 'shape-arrow', 'stamp', 'note', 'highlight', 'drawing', 'textMarkup'];

const SECRET = 'SSN 123-45-6789';

/** textMarkup quads built the way MarkupRedactionLayer.boxToQuad does: display box → pdf.js convertToPdfPoint. */
function quadFromDisplay(c: PageCase): number[] {
  const v = c.viewport;
  const [ulx, uly] = v.convertToPdfPoint(MX, MY);
  const [urx, ury] = v.convertToPdfPoint(MX + MW, MY);
  const [llx, lly] = v.convertToPdfPoint(MX, MY + MH);
  const [lrx, lry] = v.convertToPdfPoint(MX + MW, MY + MH);
  return [ulx, uly, urx, ury, llx, lly, lrx, lry];
}

function build(kind: Kind, c: PageCase): Annotation {
  const base = { id: `a-${kind}`, pageIndex: 1 };
  const position = { x: MX, y: MY };
  const size = { width: MW, height: MH };
  switch (kind) {
    case 'text':
      return { ...base, type: 'text', position, content: 'Hello', fontSize: 12, fontFamily: 'Helvetica', color: '#000000' };
    case 'image':
      return { ...base, type: 'image', position, size, data: PNG_2X2, imageType: 'png' };
    case 'shape-rectangle':
    case 'shape-ellipse':
    case 'shape-line':
    case 'shape-arrow':
      return {
        ...base, type: 'shape', shapeType: kind.slice(6) as 'rectangle', position, size,
        strokeColor: '#ff0000', fillColor: 'transparent', strokeWidth: 3, opacity: 1,
      };
    case 'stamp':
      return { ...base, type: 'stamp', position, size, stampType: 'confidential', text: 'CONFIDENTIAL', color: '#ff0000' };
    case 'note':
      return { ...base, type: 'note', position, content: SECRET, color: '#ffeb3b' };
    case 'highlight':
      return { ...base, type: 'highlight', rects: [{ x: MX, y: MY, width: MW, height: MH }], color: 'rgba(255,235,59,0.4)' };
    case 'drawing':
      return { ...base, type: 'drawing', paths: [{ points: [{ x: MX, y: MY }, { x: MX + MW / 2, y: MY + MH }, { x: MX + MW, y: MY }], color: '#0000ff', width: 4 }] };
    case 'textMarkup':
      return { ...base, type: 'textMarkup', markupType: 'highlight', quads: [quadFromDisplay(c)], color: '#FFEB3B', opacity: 0.4, text: SECRET };
  }
}

function modelPage(c: PageCase, annotations: Annotation[]): PDFPage[] {
  const swap = c.rotation % 180 === 90;
  const b = c.frame.box;
  return [{
    index: 0,
    width: swap ? b.height : b.width,
    height: swap ? b.width : b.height,
    rotation: c.rotation,
    annotations,
    textItems: [],
    textEdits: [],
  }];
}

// ------------------------------------- content-stream ink (independent oracle)

type M = [number, number, number, number, number, number];
const mul = (a: M, b: M): M => [
  a[0] * b[0] + a[1] * b[2], a[0] * b[1] + a[1] * b[3],
  a[2] * b[0] + a[3] * b[2], a[2] * b[1] + a[3] * b[3],
  a[4] * b[0] + a[5] * b[2] + b[4], a[4] * b[1] + a[5] * b[3] + b[5],
];
const apply = (m: M, x: number, y: number): [number, number] => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]];

function tokens(src: string): Array<{ op?: string; num?: number; str?: string }> {
  const out: Array<{ op?: string; num?: number; str?: string }> = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i++; continue; }
    if (ch === '%') { while (i < src.length && src[i] !== '\n') i++; continue; }
    if (ch === '(') {
      let depth = 1, s = '';
      i++;
      while (i < src.length && depth > 0) {
        const c = src[i];
        if (c === '\\') { s += src[i + 1]; i += 2; continue; }
        if (c === '(') depth++;
        if (c === ')') { depth--; if (depth === 0) { i++; break; } }
        s += c; i++;
      }
      out.push({ str: s });
      continue;
    }
    if (ch === '<' && src[i + 1] !== '<') {
      const end = src.indexOf('>', i);
      const hex = src.slice(i + 1, end).replace(/\s/g, '');
      let s = '';
      for (let k = 0; k < hex.length; k += 2) s += String.fromCharCode(parseInt(hex.slice(k, k + 2).padEnd(2, '0'), 16));
      out.push({ str: s });
      i = end + 1;
      continue;
    }
    if (ch === '/') { const m = /^\/[^\s/<>()[\]{}%]*/.exec(src.slice(i))!; out.push({ str: m[0] }); i += m[0].length; continue; }
    const num = /^[+-]?(\d+\.?\d*|\.\d+)/.exec(src.slice(i));
    if (num) { out.push({ num: Number(num[0]) }); i += num[0].length; continue; }
    const op = /^[A-Za-z'"*]+/.exec(src.slice(i));
    if (op) { out.push({ op: op[0] }); i += op[0].length; continue; }
    i++; // [ ] { } and anything else carry no geometry here
  }
  return out;
}

/** Bounding box of everything painted by the page's content streams, in user space. */
function inkBounds(src: string): PdfRect | null {
  let ctm: M = [1, 0, 0, 1, 0, 0];
  let lw = 1;
  let tm: M = [1, 0, 0, 1, 0, 0];
  let fs = 0;
  const stack: Array<{ ctm: M; lw: number }> = [];
  let path: Array<[number, number]> = [];
  const ink: PdfRect[] = [];
  let operands: Array<{ num?: number; str?: string }> = [];
  const nums = () => operands.map((o) => o.num!).filter((n) => n !== undefined);
  const addPoints = (pts: Array<[number, number]>, pad: number) => {
    if (!pts.length) return;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    ink.push(rect(Math.min(...xs) - pad, Math.min(...ys) - pad, Math.max(...xs) + pad, Math.max(...ys) + pad));
  };
  for (const t of tokens(src)) {
    if (!t.op) { operands.push(t); continue; }
    const n = nums();
    switch (t.op) {
      case 'q': stack.push({ ctm, lw }); break;
      case 'Q': ({ ctm, lw } = stack.pop()!); break;
      case 'cm': ctm = mul(n as M, ctm); break;
      case 'w': lw = n[0]; break;
      case 'm': case 'l': path.push(apply(ctm, n[0], n[1])); break;
      case 'c': path.push(apply(ctm, n[0], n[1]), apply(ctm, n[2], n[3]), apply(ctm, n[4], n[5])); break;
      case 're': {
        const [x, y, w, h] = n;
        path.push(apply(ctm, x, y), apply(ctm, x + w, y), apply(ctm, x, y + h), apply(ctm, x + w, y + h));
        break;
      }
      case 'S': case 's': case 'B': case 'B*': case 'b': case 'b*':
        addPoints(path, lw / 2); path = []; break;
      case 'f': case 'F': case 'f*':
        addPoints(path, 0); path = []; break;
      case 'n': path = []; break;
      case 'BT': tm = [1, 0, 0, 1, 0, 0]; break;
      case 'Tf': fs = n[0]; break;
      case 'Tm': tm = n as M; break;
      case 'Tj': {
        const s = operands.find((o) => o.str !== undefined)!.str!;
        const width = helvetica.widthOfTextAtSize(s, fs);
        // Helvetica FontBBox y-range is -225..931 per 1000 em.
        const m = mul(tm, ctm);
        addPoints([apply(m, 0, -0.225 * fs), apply(m, width, -0.225 * fs), apply(m, 0, 0.931 * fs), apply(m, width, 0.931 * fs)], 0);
        break;
      }
      case 'Do':
        addPoints([apply(ctm, 0, 0), apply(ctm, 1, 0), apply(ctm, 0, 1), apply(ctm, 1, 1)], 0);
        break;
      default: break;
    }
    operands = [];
  }
  return ink.length ? union(ink) : null;
}

function pageContent(lib: PDFLib): string {
  const c = lib.context.lookup(lib.getPage(0).node.get(PDFName.of('Contents')));
  if (!c) return '';
  const streams = c instanceof PDFArray ? c.asArray().map((r) => lib.context.lookup(r)) : [c];
  return streams.map((s) => (s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString('latin1') : '')).join('\n');
}

function annotDicts(lib: PDFLib): PDFDict[] {
  const annots = lib.getPage(0).node.lookup(PDFName.of('Annots'));
  return annots instanceof PDFArray ? annots.asArray().map((r) => lib.context.lookup(r) as PDFDict) : [];
}

/** Every string value in every object of the file, decoded (object streams included). */
async function allStrings(bytes: Uint8Array): Promise<string[]> {
  const lib = await PDFLib.load(bytes);
  const out: string[] = [];
  const walk = (o: unknown): void => {
    if (o instanceof PDFHexString || o instanceof PDFString) out.push(o.decodeText());
    else if (o instanceof PDFArray) o.asArray().forEach(walk);
    else if (o instanceof PDFDict) for (const [, v] of o.entries()) walk(v);
  };
  for (const [, obj] of lib.context.enumerateIndirectObjects()) walk(obj instanceof PDFRawStream ? obj.dict : obj);
  return out;
}

const nums = (a: PDFArray) => a.asArray().map((n) => (n as PDFNumber).asNumber());

// ------------------------------------------------------------------ tests

describe('annotationBounds: page frames match pdf.js', () => {
  it.each(ROTATIONS.flatMap((r) => CROPS.map((cr) => [r, cr] as const)))('rotate %i cropped=%s: pageGeometry box == pdf.js view', (r, cr) => {
    const c = pageCase(r, cr);
    const b = c.frame.box;
    expect([b.x, b.y, b.x + b.width, b.y + b.height]).toEqual(Array.from(c.viewport.viewBox));
    expect(c.frame.rotation).toBe(r);
  });
});

describe.each(KINDS)('annotationBounds: %s', (kind) => {
  const matrix = ROTATIONS.flatMap((r) => CROPS.map((cr) => [r, cr] as const));

  it.each(matrix)('rotate %i cropped=%s: REMOVED when a mark covers where it is saved', (r, cr) => {
    const c = pageCase(r, cr);
    const target = kind === 'textMarkup' ? displayedTarget(c) : savedTarget(c, kind);
    const a = build(kind, c);
    const mark = centreMark(target);
    expect(isUnderAnyMark(a, c.frame, [mark])).toBe(true);
    expect(partitionByMarks([a], c.frame, [mark]).removed).toEqual([a]);
  });

  it.each(matrix)('rotate %i cropped=%s: REMOVED when a mark covers where pdf.js displays it', (r, cr) => {
    const c = pageCase(r, cr);
    const a = build(kind, c);
    expect(isUnderAnyMark(a, c.frame, [centreMark(displayedTarget(c, kind))])).toBe(true);
  });

  it.each(matrix)('rotate %i cropped=%s: KEPT when the only mark is elsewhere on the page', (r, cr) => {
    const c = pageCase(r, cr);
    const a = build(kind, c);
    const mark = farMark(c, [savedTarget(c), displayedTarget(c)]);
    expect(isUnderAnyMark(a, c.frame, [mark])).toBe(false);
    expect(partitionByMarks([a], c.frame, [mark]).kept).toEqual([a]);
  });

  it.each(matrix)('rotate %i cropped=%s: footprint agrees with what the real save pipeline writes', async (r, cr) => {
    const c = pageCase(r, cr);
    const a = build(kind, c);
    const fp = annotationFootprints(a, c.frame);
    expect(fp).not.toBeNull();
    const all = union(fp!);
    const out = await applyEditsAndAnnotations({ pdfData: c.bytes, pages: modelPage(c, [a]), annotationStorage: null, formFieldMappings: [] });
    const lib = await PDFLib.load(out);

    if (kind === 'textMarkup') {
      const d = annotDicts(lib).find((x) => (x.get(PDFName.of('Subtype')) as PDFName).decodeText() === 'Highlight')!;
      const qp = nums(d.get(PDFName.of('QuadPoints')) as PDFArray);
      const written = rect(Math.min(qp[0], qp[2], qp[4], qp[6]), Math.min(qp[1], qp[3], qp[5], qp[7]), Math.max(qp[0], qp[2], qp[4], qp[6]), Math.max(qp[1], qp[3], qp[5], qp[7]));
      for (const k of ['x0', 'y0', 'x1', 'y1'] as const) expect(all[k]).toBeCloseTo(written[k], 3);
      // The payload that makes a surviving markup a leak.
      expect((d.get(PDFName.of('Contents')) as PDFHexString).decodeText()).toBe(SECRET);
      return;
    }

    const ink = inkBounds(pageContent(lib));
    expect(ink, 'pipeline painted nothing').not.toBeNull();
    const saved = union(annotationPlacements(a, c.frame)!.saved);
    const eps = 1e-3;
    // 1. Everything the pipeline paints lies inside the saved footprint.
    expect(ink!.x0).toBeGreaterThanOrEqual(saved.x0 - eps);
    expect(ink!.y0).toBeGreaterThanOrEqual(saved.y0 - eps);
    expect(ink!.x1).toBeLessThanOrEqual(saved.x1 + eps);
    expect(ink!.y1).toBeLessThanOrEqual(saved.y1 + eps);
    // 2. ...and the footprint is not displaced: edges agree exactly for pure
    //    geometry; text and arrowheads are bounded by documented estimates.
    const slack: Record<Exclude<Kind, 'textMarkup'>, number> = {
      text: 12 * 0.4, // line box 1.4·fs vs glyph box 1.156·fs; width uses max(Helvetica, 0.6 em)
      image: eps, 'shape-rectangle': eps, 'shape-ellipse': eps, 'shape-line': eps,
      'shape-arrow': 15, // arrowhead allowance min(15, 0.2·diagonal)
      stamp: eps, note: eps, highlight: eps, drawing: eps,
    };
    const s = slack[kind as Exclude<Kind, 'textMarkup'>];
    const widthSlack = kind === 'text' ? 'Hello'.length * 12 * 0.6 : s;
    expect(Math.abs(ink!.x0 - saved.x0)).toBeLessThanOrEqual(s);
    expect(Math.abs(ink!.y1 - saved.y1)).toBeLessThanOrEqual(s);
    expect(Math.abs(ink!.x1 - saved.x1)).toBeLessThanOrEqual(widthSlack);
    expect(Math.abs(ink!.y0 - saved.y0)).toBeLessThanOrEqual(s);
    // The saved placement is offset by the visible box, not the MediaBox origin.
    if (cr) expect(saved.x0).toBeGreaterThan(CROP.x0);

    if (kind === 'note') {
      const d = annotDicts(lib).find((x) => (x.get(PDFName.of('Subtype')) as PDFName).decodeText() === 'Text')!;
      const [x0, y0, x1, y1] = nums(d.get(PDFName.of('Rect')) as PDFArray);
      expect(x0).toBeGreaterThanOrEqual(saved.x0);
      expect(y0).toBeGreaterThanOrEqual(saved.y0);
      expect(x1).toBeLessThanOrEqual(saved.x1);
      expect(y1).toBeLessThanOrEqual(saved.y1);
    }
  }, 30_000);
});

describe('annotationBounds: fail closed', () => {
  const matrix = ROTATIONS.flatMap((r) => CROPS.map((cr) => [r, cr] as const));

  it.each(matrix)('rotate %i cropped=%s: an unknown annotation type is REMOVED under any mark on the page', (r, cr) => {
    const c = pageCase(r, cr);
    const unknown = { id: 'u1', type: 'futureType', pageIndex: 1, position: { x: MX, y: MY } } as unknown as Annotation;
    const mark = farMark(c, [savedTarget(c), displayedTarget(c)]);
    expect(annotationFootprints(unknown, c.frame)).toBeNull();
    expect(isUnderAnyMark(unknown, c.frame, [mark])).toBe(true);
    expect(partitionByMarks([unknown], c.frame, [mark])).toEqual({ kept: [], removed: [unknown] });
  });

  it.each(matrix)('rotate %i cropped=%s: an annotation whose bounds throw is REMOVED', (r, cr) => {
    const c = pageCase(r, cr);
    const hostile = { id: 't1', type: 'text', pageIndex: 1, position: { x: MX, y: MY }, fontSize: 12, fontFamily: 'Helvetica', color: '#000' } as Record<string, unknown>;
    Object.defineProperty(hostile, 'content', { get() { throw new Error('boom'); }, enumerable: true });
    const mark = farMark(c, [savedTarget(c), displayedTarget(c)]);
    expect(isUnderAnyMark(hostile as unknown as Annotation, c.frame, [mark])).toBe(true);
  });

  it.each(matrix)('rotate %i cropped=%s: non-finite or empty geometry is REMOVED', (r, cr) => {
    const c = pageCase(r, cr);
    const mark = farMark(c, [savedTarget(c), displayedTarget(c)]);
    const nanImage = { ...build('image', c), position: { x: NaN, y: MY } } as Annotation;
    const emptyHighlight = { ...build('highlight', c), rects: [] } as Annotation;
    const emptyDrawing = { ...build('drawing', c), paths: [] } as Annotation;
    const emptyMarkup = { ...build('textMarkup', c), quads: [] } as Annotation;
    // One poisoned quad must not let the valid quads (and /Contents) through.
    const poisonedMarkup = { ...build('textMarkup', c), quads: [quadFromDisplay(c), [NaN, 0, 0, 0, 0, 0, 0, 0]] } as TextMarkupAnnotation;
    for (const a of [nanImage, emptyHighlight, emptyDrawing, emptyMarkup, poisonedMarkup]) {
      expect(isUnderAnyMark(a, c.frame, [mark]), a.id).toBe(true);
    }
  });

  it('a page without marks keeps everything (nothing to redact)', () => {
    const c = pageCase(90, true);
    const unknown = { id: 'u1', type: 'futureType', pageIndex: 1 } as unknown as Annotation;
    expect(isUnderAnyMark(unknown, c.frame, [])).toBe(false);
  });

  it('an unusable page frame fails closed', () => {
    const a = build('image', pageCase(0, false));
    const mark = rect(0, 0, 1, 1);
    expect(isUnderAnyMark(a, { box: { x: 0, y: 0, width: 0, height: 0 }, rotation: 0 }, [mark])).toBe(true);
    expect(isUnderAnyMark(a, { box: { x: 0, y: 0, width: 600, height: NaN }, rotation: 0 }, [mark])).toBe(true);
  });
});

describe('annotationBounds: the audit exploit, end to end', () => {
  it.each(ROTATIONS.flatMap((r) => CROPS.map((cr) => [r, cr] as const)))(
    'rotate %i cropped=%s: a highlight carrying the redacted text does not reach the saved file',
    async (r, cr) => {
      const c = pageCase(r, cr);
      const markup = build('textMarkup', c);
      const mark = grow(displayedTarget(c), 1);
      const save = async (annotations: Annotation[]) =>
        (await allStrings(await applyEditsAndAnnotations({ pdfData: c.bytes, pages: modelPage(c, annotations), annotationStorage: null, formFieldMappings: [] })))
          .some((t) => t.includes('123-45-6789'));

      // Control: kept, the secret IS in the output (so the probe can see it).
      expect(await save([markup])).toBe(true);
      // Fixed path: partitioned by the mark, the secret is absent.
      const { kept, removed } = partitionByMarks([markup], c.frame, [mark]);
      expect(removed).toEqual([markup]);
      expect(await save(kept)).toBe(false);
    },
    30_000
  );
});
