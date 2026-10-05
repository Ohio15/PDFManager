/**
 * Writes text-markup and pending-redaction annotations as REAL PDF annotation
 * dictionaries with appearance streams.
 *
 * Design choice: markup is written ONLY as an annotation (with /AP), never also
 * burned into the page content stream. Every reader that draws annotations
 * (Acrobat, pdf.js, PDFium, Preview, and this app's own viewer, which renders
 * with annotationMode ENABLE_FORMS) would otherwise paint it twice — a 35%
 * highlight composites to ~58%, underlines double up — and a content copy can
 * no longer be edited or deleted as markup. The appearance stream guarantees
 * the same look in readers that do not synthesize markup appearances.
 *
 * Unapplied redaction marks become standard /Redact annotations (outline
 * appearance, /IC interior colour) so Acrobat can apply them later. They do
 * NOT remove content — only "Apply redactions" does.
 */
import { PDFArray, PDFDict, PDFDocument as PDFLib, PDFHexString, PDFName, PDFRef, PDFString } from 'pdf-lib';
import type { RedactionMarkAnnotation, TextMarkupAnnotation } from '../types';

const SUBTYPE: Record<TextMarkupAnnotation['markupType'], string> = {
  highlight: 'Highlight',
  underline: 'Underline',
  strikeout: 'StrikeOut',
  squiggly: 'Squiggly',
};

export function parseColor01(color: string): { r: number; g: number; b: number; a?: number } {
  const rgba = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i.exec(color);
  if (rgba) {
    return { r: +rgba[1] / 255, g: +rgba[2] / 255, b: +rgba[3] / 255, a: rgba[4] !== undefined ? +rgba[4] : undefined };
  }
  const hex = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(color.trim());
  if (hex) return { r: parseInt(hex[1], 16) / 255, g: parseInt(hex[2], 16) / 255, b: parseInt(hex[3], 16) / 255 };
  return { r: 1, g: 1, b: 0 };
}

function n(v: number): string {
  const r = Math.round(v * 1000) / 1000;
  return Object.is(r, -0) ? '0' : String(r);
}

interface Pt { x: number; y: number }

function quadPoints(q: number[]): { ul: Pt; ur: Pt; ll: Pt; lr: Pt } {
  return { ul: { x: q[0], y: q[1] }, ur: { x: q[2], y: q[3] }, ll: { x: q[4], y: q[5] }, lr: { x: q[6], y: q[7] } };
}

function lerp(a: Pt, b: Pt, t: number): Pt {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Appearance content for a markup annotation, drawn in default user space. */
export function markupAppearance(markupType: TextMarkupAnnotation['markupType'], quads: number[][], color: { r: number; g: number; b: number }): string {
  const rgb = `${n(color.r)} ${n(color.g)} ${n(color.b)}`;
  let s = '';
  if (markupType === 'highlight') {
    s += `/GS0 gs ${rgb} rg\n`;
    for (const q of quads) {
      const { ul, ur, ll, lr } = quadPoints(q);
      s += `${n(ll.x)} ${n(ll.y)} m ${n(lr.x)} ${n(lr.y)} l ${n(ur.x)} ${n(ur.y)} l ${n(ul.x)} ${n(ul.y)} l h\n`;
    }
    return s + 'f\n';
  }
  s += `${rgb} RG\n`;
  for (const q of quads) {
    const { ul, ur, ll, lr } = quadPoints(q);
    const h = Math.hypot(ul.x - ll.x, ul.y - ll.y);
    const w = Math.max(0.5, h / 14);
    if (markupType === 'underline') {
      const a = lerp(ll, ul, (w / 2) / (h || 1));
      const b = lerp(lr, ur, (w / 2) / (h || 1));
      s += `${n(w)} w ${n(a.x)} ${n(a.y)} m ${n(b.x)} ${n(b.y)} l S\n`;
    } else if (markupType === 'strikeout') {
      const a = lerp(ll, ul, 0.45);
      const b = lerp(lr, ur, 0.45);
      s += `${n(w)} w ${n(a.x)} ${n(a.y)} m ${n(b.x)} ${n(b.y)} l S\n`;
    } else {
      // Squiggly: zig-zag along the bottom of the quad.
      const amp = h / 10;
      const len = Math.hypot(lr.x - ll.x, lr.y - ll.y);
      const period = Math.max(h / 3, 1);
      const steps = Math.max(2, Math.round(len / (period / 2)));
      const up = { x: (ul.x - ll.x) / (h || 1), y: (ul.y - ll.y) / (h || 1) };
      s += `${n(Math.max(0.5, w * 0.8))} w `;
      for (let i = 0; i <= steps; i++) {
        const p = lerp(ll, lr, i / steps);
        const off = amp + (i % 2 === 0 ? 0 : amp);
        const x = p.x + up.x * off, y = p.y + up.y * off;
        s += `${n(x)} ${n(y)} ${i === 0 ? 'm' : 'l'} `;
      }
      s += 'S\n';
    }
  }
  return s;
}

function boundsOfQuads(quads: number[][], pad: number): [number, number, number, number] {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const q of quads) {
    for (let i = 0; i < 8; i += 2) {
      x0 = Math.min(x0, q[i]); x1 = Math.max(x1, q[i]);
      y0 = Math.min(y0, q[i + 1]); y1 = Math.max(y1, q[i + 1]);
    }
  }
  return [x0 - pad, y0 - pad, x1 + pad, y1 + pad];
}

function pdfDate(d: Date): string {
  const p = (v: number) => String(v).padStart(2, '0');
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function appendAnnot(pdfDoc: PDFLib, pageIndex: number, annotRef: PDFRef): void {
  const pageDict = pdfDoc.getPage(pageIndex).node;
  const existing = pageDict.lookup(PDFName.of('Annots'));
  if (existing instanceof PDFArray) existing.push(annotRef);
  else pageDict.set(PDFName.of('Annots'), pdfDoc.context.obj([annotRef]));
}

export function writeTextMarkupAnnotation(pdfDoc: PDFLib, pageIndex: number, a: TextMarkupAnnotation): PDFRef | null {
  const quads = a.quads.filter((q) => q.length === 8 && q.every(Number.isFinite));
  if (quads.length === 0) return null;
  const ctx = pdfDoc.context;
  const color = parseColor01(a.color);
  const opacity = Math.min(1, Math.max(0.05, a.opacity));
  const rect = boundsOfQuads(quads, a.markupType === 'squiggly' ? 2 : 1);

  const ap = ctx.flateStream(markupAppearance(a.markupType, quads, color), {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: rect,
    Resources: { ExtGState: { GS0: { Type: 'ExtGState', BM: 'Multiply', ca: opacity, CA: opacity } } },
  } as never);
  const apRef = ctx.register(ap);

  const dict = ctx.obj({
    Type: 'Annot',
    Subtype: SUBTYPE[a.markupType],
    Rect: rect,
    QuadPoints: quads.flat(),
    C: [color.r, color.g, color.b],
    CA: a.markupType === 'highlight' ? 1 : opacity,
    F: 4,
    M: PDFString.of(pdfDate(new Date())),
    NM: PDFString.of(a.id),
    P: pdfDoc.getPage(pageIndex).ref,
    AP: { N: apRef },
  } as never) as unknown as PDFDict;
  if (a.text) dict.set(PDFName.of('Contents'), PDFHexString.fromText(a.text));
  const ref = ctx.register(dict);
  appendAnnot(pdfDoc, pageIndex, ref);
  return ref;
}

export function writeRedactAnnotation(pdfDoc: PDFLib, pageIndex: number, a: RedactionMarkAnnotation): PDFRef | null {
  const rects = a.rects.filter((r) => r.x1 > r.x0 && r.y1 > r.y0);
  if (!rects.length) return null;
  const ctx = pdfDoc.context;
  const x0 = Math.min(...rects.map((r) => r.x0)), y0 = Math.min(...rects.map((r) => r.y0));
  const x1 = Math.max(...rects.map((r) => r.x1)), y1 = Math.max(...rects.map((r) => r.y1));
  let content = '0.86 0.15 0.15 RG 1 w [3 2] 0 d\n';
  for (const r of rects) content += `${n(r.x0 + 0.5)} ${n(r.y0 + 0.5)} ${n(r.x1 - r.x0 - 1)} ${n(r.y1 - r.y0 - 1)} re S\n`;
  const ap = ctx.register(ctx.flateStream(content, { Type: 'XObject', Subtype: 'Form', BBox: [x0, y0, x1, y1] } as never));
  const quads = rects.flatMap((r) => [r.x0, r.y1, r.x1, r.y1, r.x0, r.y0, r.x1, r.y0]);
  const ref = ctx.register(
    ctx.obj({
      Type: 'Annot',
      Subtype: 'Redact',
      Rect: [x0, y0, x1, y1],
      QuadPoints: quads,
      IC: [0, 0, 0],
      OC: [0.86, 0.15, 0.15],
      C: [0.86, 0.15, 0.15],
      F: 4,
      NM: PDFString.of(a.id),
      M: PDFString.of(pdfDate(new Date())),
      P: pdfDoc.getPage(pageIndex).ref,
      AP: { N: ap },
    } as never)
  );
  appendAnnot(pdfDoc, pageIndex, ref);
  return ref;
}

