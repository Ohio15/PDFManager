/**
 * Text-markup save output: real /Highlight /Underline /StrikeOut /Squiggly
 * annotation dictionaries with exact QuadPoints and an appearance stream, and
 * NO copy burned into the page content (no double render).
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFArray, PDFDict, PDFDocument as PDFLib, PDFName, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib';
import { applyEditsAndAnnotations } from '../pdfSavePipeline';
import type { PDFPage, TextMarkupAnnotation, RedactionMarkAnnotation, TextMarkupType } from '../../types';

const fixture = () => new Uint8Array(fs.readFileSync('test-pdfs/announcement.pdf'));

function pageContent(lib: PDFLib, i: number): string {
  const c = lib.context.lookup(lib.getPage(i).node.get(PDFName.of('Contents')));
  const streams = c instanceof PDFArray ? c.asArray().map((r) => lib.context.lookup(r)) : [c];
  return streams
    .map((s) => (s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString('latin1') : ''))
    .join('\n');
}

describe('text markup annotations on save', () => {
  it('writes each markup type as a real annotation with QuadPoints and /AP, without touching page content', async () => {
    const src = fixture();
    const types: TextMarkupType[] = ['highlight', 'underline', 'strikeout', 'squiggly'];
    const markups: TextMarkupAnnotation[] = types.map((t, i) => ({
      id: `m-${t}`,
      type: 'textMarkup',
      pageIndex: 1,
      markupType: t,
      quads: [[100, 700 - i * 30, 250, 700 - i * 30, 100, 688 - i * 30, 250, 688 - i * 30]],
      color: t === 'highlight' ? '#FFEB3B' : '#FF0000',
      opacity: t === 'highlight' ? 0.4 : 1,
      text: `sample ${t}`,
    }));
    const mark: RedactionMarkAnnotation = { id: 'r1', type: 'redaction', pageIndex: 1, rects: [{ x0: 300, y0: 600, x1: 400, y1: 620 }], source: 'area' };

    const srcLib = await PDFLib.load(src);
    const pages: PDFPage[] = srcLib.getPages().map((p, i) => ({
      index: i, width: p.getWidth(), height: p.getHeight(), rotation: 0,
      annotations: i === 0 ? [...markups, mark] : [], textItems: [], textEdits: [],
    }));
    const contentBefore = pageContent(srcLib, 0);

    const out = await applyEditsAndAnnotations({ pdfData: src, pages, annotationStorage: null, formFieldMappings: [] });
    const lib = await PDFLib.load(out);
    // No content-stream copy of the markup (no double render).
    expect(pageContent(lib, 0)).toBe(contentBefore);

    const annots = lib.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const dicts = annots.asArray().map((r) => lib.context.lookup(r) as PDFDict);
    const bySubtype = new Map(dicts.map((d) => [(d.get(PDFName.of('Subtype')) as PDFName).decodeText(), d]));
    const expected: Record<TextMarkupType, string> = { highlight: 'Highlight', underline: 'Underline', strikeout: 'StrikeOut', squiggly: 'Squiggly' };
    for (const m of markups) {
      const d = bySubtype.get(expected[m.markupType]);
      expect(d, m.markupType).toBeTruthy();
      const qp = (d!.get(PDFName.of('QuadPoints')) as PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
      expect(qp).toEqual(m.quads[0]);
      const ap = d!.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'));
      expect(ap).toBeInstanceOf(PDFStream);
      expect((d!.get(PDFName.of('F')) as PDFNumber).asNumber()).toBe(4);
    }
    expect(bySubtype.get('Redact')).toBeTruthy();

    // pdf.js (an independent reader) sees them as markup with the same quads.
    const doc = await pdfjs.getDocument({ data: new Uint8Array(out), isEvalSupported: false }).promise;
    const seen = (await (await doc.getPage(1)).getAnnotations()) as Array<{ subtype: string; quadPoints?: Float32Array | number[] }>;
    for (const t of ['Highlight', 'Underline', 'StrikeOut', 'Squiggly', 'Redact']) expect(seen.some((a) => a.subtype === t)).toBe(true);
    const underline = seen.find((a) => a.subtype === 'Underline')!;
    expect(Array.from(underline.quadPoints!).map((v) => Math.round(v))).toEqual([100, 670, 250, 670, 100, 658, 250, 658]);
    await doc.destroy();
  }, 60_000);
});
