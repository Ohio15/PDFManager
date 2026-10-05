/**
 * True-redaction tests. Every assertion is made on the OUTPUT bytes:
 * re-extracted text (pdf.js getTextContent), raw decompressed streams,
 * decoded image pixels, annotation dictionaries and rendered pixels.
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFArray, PDFDict, PDFDocument as PDFLib, PDFName, PDFStream, StandardFonts, decodePDFRawStream, PDFRawStream } from 'pdf-lib';
import { applyRedactions, RedactionMarkInput } from '../redactionEngine';
import { findOccurrences } from '../textSearch';
import { openPdfjs, PdfjsEnv, imageDataToRgba } from '../pdfjsEnv';
import { scanPdfjsPage } from '../pdfjsScan';
import { Rect, applyToPoint, pointInRect, insetRect } from '../geometry';
import { parseContent } from '../contentTokenizer';

const env: PdfjsEnv = { lib: pdfjs as unknown as PdfjsEnv['lib'] };
const fixture = (name: string) => new Uint8Array(fs.readFileSync(`test-pdfs/${name}`));

async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await openPdfjs(env, bytes);
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push(tc.items.map((it) => ('str' in it ? it.str : '')).join(' '));
  }
  await doc.destroy();
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();

/** Every stream in the file, decompressed (undecodable image codecs skipped), as latin1. */
async function allDecodedStreams(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFLib.load(bytes, { updateMetadata: false });
  const out: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    try {
      const data = obj instanceof PDFRawStream ? decodePDFRawStream(obj).decode() : obj.getContents();
      out.push(Buffer.from(data).toString('latin1'));
    } catch {
      /* DCT etc. — not text-bearing */
    }
  }
  return out;
}

async function redactTerm(bytes: Uint8Array, term: string, opts: { wholeWord?: boolean } = {}) {
  const doc = await openPdfjs(env, bytes);
  const occ = await findOccurrences(doc, env, term, opts);
  await doc.destroy();
  const marks: RedactionMarkInput[] = occ.map((o) => ({ pageIndex: o.pageIndex, rects: o.rects }));
  const result = await applyRedactions(bytes, marks, { mustBeAbsent: [term] }, env);
  return { ...result, occurrences: occ };
}

/** A small text PDF using a standard-14 font with literal (WinAnsi) strings, so raw scans are meaningful. */
async function syntheticTextPdf(content: string, extra?: (doc: PDFLib, page: ReturnType<PDFLib['addPage']>) => void): Promise<Uint8Array> {
  const doc = await PDFLib.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
  extra?.(doc, page);
  return doc.save({ useObjectStreams: false });
}

describe('redaction on real fixtures', () => {
  it('announcement.pdf: search-and-redact removes the term everywhere and keeps adjacent text', async () => {
    const src = fixture('announcement.pdf');
    const before = await pageTexts(src);
    expect(squash(before.join(' '))).toContain('softball');

    const { bytes, report, occurrences } = await redactTerm(src, 'Softball');
    expect(occurrences.length).toBeGreaterThanOrEqual(5);
    expect(report.verification.ok).toBe(true);
    expect(report.stats.glyphsRemoved).toBeGreaterThan(0);

    const after = await pageTexts(bytes);
    expect(squash(after.join(' '))).not.toContain('softball');
    // Adjacent, unredacted text on the same line survives.
    expect(squash(after[0])).toContain(squash('Valley Youth League'));
    expect(squash(after[0])).toContain(squash('Board of Trustees'));
    for (const s of await allDecodedStreams(bytes)) expect(s.toLowerCase()).not.toContain('softball');
  }, 120_000);

  it('announcement.pdf: a word in the middle of a TJ line loses only its own glyphs', async () => {
    const src = fixture('announcement.pdf');
    const { bytes, report } = await redactTerm(src, 'foremost', { wholeWord: true });
    expect(report.verification.ok).toBe(true);
    const page1 = squash((await pageTexts(bytes))[0]);
    expect(page1).not.toContain('foremost');
    expect(page1).toContain(squash('first and'));
    expect(page1).toContain('protect');
  }, 120_000);

  it('invoice.pdf (text drawn as vector outlines): marked paths are gone, straddling outlines are rasterized and the area renders black', async () => {
    const src = fixture('invoice.pdf');
    const mark: Rect = { x0: 100, y0: 600, x1: 300, y1: 700 };
    const before = await scanPdfjsPage(await (await openPdfjs(env, src)).getPage(1), env.lib.OPS);
    const inner = insetRect(mark, 0.5);
    expect(before.paths.some((p) => p.points.some((pt) => pointInRect(pt, inner)))).toBe(true);

    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [mark] }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.stats.pathsRemoved).toBeGreaterThan(0);
    expect(report.rasterized.length).toBeGreaterThan(0);

    const outDoc = await openPdfjs(env, bytes);
    const page = await outDoc.getPage(1);
    const after = await scanPdfjsPage(page, env.lib.OPS);
    expect(after.paths.some((p) => p.points.some((pt) => pointInRect(pt, inner)))).toBe(false);
    // Paths away from the mark are untouched.
    expect(after.paths.length).toBeGreaterThan(100);

    // Rendered pixel at the centre of the mark is the fill colour.
    const viewport = page.getViewport({ scale: 1 });
    const factory = (outDoc as unknown as { canvasFactory: { create: (w: number, h: number) => { context: CanvasRenderingContext2D } } }).canvasFactory;
    const { context } = factory.create(Math.ceil(viewport.width), Math.ceil(viewport.height));
    await page.render({ canvasContext: context, viewport } as never).promise;
    const [cx, cy] = viewport.convertToViewportPoint(200, 650);
    const px = context.getImageData(Math.round(cx), Math.round(cy), 1, 1).data;
    expect([px[0], px[1], px[2]]).toEqual([0, 0, 0]);
    await outDoc.destroy();
  }, 120_000);

  it('test-with-images.pdf: image pixels under the mark are black after decode, pixels outside keep their colour', async () => {
    const src = fixture('test-with-images.pdf');
    const mark: Rect = { x0: 350, y0: 420, x1: 450, y1: 500 }; // inside the 120x90 RGB image placed at 300..540 × 400..580
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [mark] }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.stats.imagesRedacted).toBe(1);

    const doc = await openPdfjs(env, bytes);
    const scan = await scanPdfjsPage(await doc.getPage(1), env.lib.OPS);
    const img = scan.images.find((i) => i.bounds.x0 === 300 && i.bounds.y0 === 400)!;
    expect(img).toBeTruthy();
    const data = (await img.load())!;
    const rgba = imageDataToRgba(data);
    let inside = 0, insideBlack = 0, outsideNonBlack = 0;
    for (let y = 0; y < data.height; y++) {
      for (let x = 0; x < data.width; x++) {
        const p = applyToPoint(img.ctm, (x + 0.5) / data.width, 1 - (y + 0.5) / data.height);
        const o = (y * data.width + x) * 4;
        const black = rgba[o] === 0 && rgba[o + 1] === 0 && rgba[o + 2] === 0;
        if (pointInRect(p, insetRect(mark, 1))) {
          inside++;
          if (black) insideBlack++;
        } else if (!pointInRect(p, { x0: mark.x0 - 3, y0: mark.y0 - 3, x1: mark.x1 + 3, y1: mark.y1 + 3 }) && !black) {
          outsideNonBlack++;
        }
      }
    }
    expect(inside).toBeGreaterThan(100);
    expect(insideBlack).toBe(inside);
    expect(outsideNonBlack).toBeGreaterThan(100);
    await doc.destroy();
  }, 120_000);

  it('test-with-images.pdf: redacting a word keeps the rest of the line', async () => {
    const { bytes, report } = await redactTerm(fixture('test-with-images.pdf'), 'Images');
    expect(report.verification.ok).toBe(true);
    const text = squash((await pageTexts(bytes))[0]);
    expect(text).not.toContain('images');
    expect(text).toContain(squash('Test Page -'));
  }, 120_000);

  it('repair-calibration-form.pdf: annotations under a mark are deleted and their fields unlinked; others stay', async () => {
    const src = fixture('repair-calibration-form.pdf');
    const srcDoc = await openPdfjs(env, src);
    const annots = (await (await srcDoc.getPage(1)).getAnnotations()) as Array<{ rect: number[]; fieldName?: string }>;
    await srcDoc.destroy();
    const target = annots.find((a) => a.fieldName)!;
    const [x0, y0, x1, y1] = target.rect;
    const mark: Rect = { x0: Math.min(x0, x1) + 1, y0: Math.min(y0, y1) + 1, x1: Math.max(x0, x1) - 1, y1: Math.max(y0, y1) - 1 };

    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [mark] }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.annotationsRemoved).toBeGreaterThanOrEqual(1);

    const outDoc = await openPdfjs(env, bytes);
    const outAnnots = (await (await outDoc.getPage(1)).getAnnotations()) as Array<{ rect: number[]; fieldName?: string }>;
    await outDoc.destroy();
    expect(outAnnots.length).toBe(annots.length - report.annotationsRemoved);
    expect(outAnnots.some((a) => a.fieldName === target.fieldName && a.rect.join() === target.rect.join())).toBe(false);

    const lib = await PDFLib.load(bytes);
    const names = lib.getForm().getFields().map((f) => f.getName());
    expect(names.length).toBeGreaterThan(0);
  }, 120_000);
});

describe('redaction engine mechanics (synthetic documents)', () => {
  it('per-glyph TJ removal keeps kept glyphs at their original positions and leaves no raw trace', async () => {
    const content = 'BT /F1 12 Tf 72 700 Td [(Name: ) (SEC) -40 (RETX42) ( public tail)] TJ ET';
    const src = await syntheticTextPdf(content);
    const beforeScan = await scanPdfjsPage(await (await openPdfjs(env, src)).getPage(1), env.lib.OPS);
    const tailBefore = beforeScan.glyphs.find((g) => g.unicode === 't' && g.box.x0 > 150)!;

    const { bytes, report } = await redactTerm(src, 'SECRETX42');
    expect(report.verification.ok).toBe(true);
    const text = (await pageTexts(bytes))[0];
    expect(squash(text)).not.toContain('secretx42');
    expect(squash(text)).toContain('name:');
    expect(squash(text)).toContain('publictail');
    for (const s of await allDecodedStreams(bytes)) {
      expect(s).not.toContain('SECRETX42');
      expect(s).not.toContain('(SEC)');
    }
    const afterScan = await scanPdfjsPage(await (await openPdfjs(env, bytes)).getPage(1), env.lib.OPS);
    const tailAfter = afterScan.glyphs.find((g) => g.unicode === 't' && g.box.x0 > 150)!;
    expect(Math.abs(tailAfter.box.x0 - tailBefore.box.x0)).toBeLessThan(0.01);
  }, 60_000);

  it('redacts text inside a Form XObject recursively without altering the shared original for other pages', async () => {
    const src = await (async () => {
      const doc = await PDFLib.create();
      const font = await doc.embedFont(StandardFonts.Helvetica);
      const form = doc.context.register(
        doc.context.stream('BT /F1 14 Tf 0 0 Td (FORMSECRET and visible) Tj ET', {
          Type: 'XObject', Subtype: 'Form', BBox: [0, -5, 300, 20], Resources: { Font: { F1: font.ref } },
        })
      );
      for (let i = 0; i < 2; i++) {
        const page = doc.addPage([612, 792]);
        page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Fm0: form } }));
        page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 1 0 0 1 72 600 cm /Fm0 Do Q')));
      }
      return doc.save({ useObjectStreams: false });
    })();
    const doc = await openPdfjs(env, src);
    const occ = (await findOccurrences(doc, env, 'FORMSECRET')).filter((o) => o.pageIndex === 0);
    await doc.destroy();
    const { bytes, report } = await applyRedactions(src, occ.map((o) => ({ pageIndex: 0, rects: o.rects })), {}, env);
    expect(report.stats.formsRewritten).toBe(1);
    const texts = await pageTexts(bytes);
    expect(squash(texts[0])).not.toContain('formsecret');
    expect(squash(texts[0])).toContain('andvisible');
    expect(squash(texts[1])).toContain('formsecret'); // page 2 was not marked
  }, 60_000);

  it('removes ActualText that repeats redacted text', async () => {
    const src = await syntheticTextPdf('/Span <</ActualText (HIDDENNAME)>> BDC BT /F1 12 Tf 72 700 Td (HIDDENNAME) Tj ET EMC BT /F1 12 Tf 72 650 Td (keep me) Tj ET');
    const { bytes } = await redactTerm(src, 'HIDDENNAME');
    for (const s of await allDecodedStreams(bytes)) expect(s).not.toContain('HIDDENNAME');
    expect(squash((await pageTexts(bytes))[0])).toContain('keepme');
  }, 60_000);

  it('redacts inline images', async () => {
    const pixels = 'FF0000'.repeat(16);
    const src = await syntheticTextPdf(`q 100 0 0 100 100 500 cm BI /W 4 /H 4 /CS /RGB /BPC 8 /F /AHx ID ${pixels}> EI Q`);
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [{ x0: 90, y0: 490, x1: 210, y1: 610 }] }], {}, env);
    expect(report.stats.inlineImagesRedacted).toBe(1);
    expect(report.verification.ok).toBe(true);
    const scan = await scanPdfjsPage(await (await openPdfjs(env, bytes)).getPage(1), env.lib.OPS);
    const rgba = imageDataToRgba((await scan.images[0].load())!);
    for (let i = 0; i < rgba.length; i += 4) expect([rgba[i], rgba[i + 1], rgba[i + 2]]).toEqual([0, 0, 0]);
  }, 60_000);

  it('falls back to rasterizing a page whose content stream cannot be parsed, and still verifies', async () => {
    const src = await syntheticTextPdf('BT /F1 12 Tf 72 700 Td (BROKENSECRET) Tj ET BT /F1 12 Tf 72 650 Td (unterminated');
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [{ x0: 60, y0: 690, x1: 200, y1: 720 }] }], {}, env);
    expect(report.rasterized).toEqual([expect.objectContaining({ pageIndex: 0, scope: 'page' })]);
    expect(squash((await pageTexts(bytes))[0])).not.toContain('brokensecret');
    for (const s of await allDecodedStreams(bytes)) expect(s).not.toContain('BROKENSECRET');
  }, 60_000);

  it('Type3 text under a mark is removed and its area rasterized', async () => {
    const src = await (async () => {
      const doc = await PDFLib.create();
      const glyph = doc.context.register(doc.context.stream('500 0 0 0 500 700 d1 0 0 500 700 re f'));
      const t3 = doc.context.register(doc.context.obj({
        Type: 'Font', Subtype: 'Type3', FontBBox: [0, 0, 500, 700], FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
        CharProcs: { box: glyph }, Encoding: { Type: 'Encoding', Differences: [65, 'box'] }, FirstChar: 65, LastChar: 65, Widths: [500],
      }));
      const page = doc.addPage([612, 792]);
      page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T3: t3 } }));
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('BT /T3 20 Tf 72 700 Td (AAAA) Tj ET')));
      return doc.save({ useObjectStreams: false });
    })();
    const { report } = await applyRedactions(src, [{ pageIndex: 0, rects: [{ x0: 70, y0: 695, x1: 95, y1: 720 }] }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.rasterized.some((r) => r.reason.includes('Type3'))).toBe(true);
  }, 60_000);

  it('strips Info and XMP metadata when requested, and garbage-collects replaced objects', async () => {
    const base = await PDFLib.load(fixture('test-with-images.pdf'));
    base.setTitle('Confidential Title QZX');
    base.setAuthor('Secret Author QZX');
    base.catalog.set(PDFName.of('Metadata'), base.context.register(base.context.stream('<x:xmpmeta>QZX</x:xmpmeta>', { Type: 'Metadata', Subtype: 'XML' })));
    const src = await base.save();
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [{ x0: 350, y0: 420, x1: 450, y1: 500 }] }], { stripMetadata: true }, env);
    expect(report.metadataStripped).toBe(true);
    const out = await PDFLib.load(bytes, { updateMetadata: false });
    expect(out.getTitle()).toBeUndefined();
    expect(out.catalog.get(PDFName.of('Metadata'))).toBeUndefined();
    expect(Buffer.from(bytes).toString('latin1')).not.toContain('QZX');
    for (const s of await allDecodedStreams(bytes)) expect(s).not.toContain('QZX');
  }, 60_000);

  it('refuses to apply when there are no marks', async () => {
    await expect(applyRedactions(fixture('invoice.pdf'), [], {}, env)).rejects.toThrow(/No redaction marks/);
  });
});

describe('content tokenizer', () => {
  it('keeps byte spans and parses inline images without interpreting their payload', () => {
    const data = new TextEncoder().encode('q BI /W 2 /H 1 /CS /G /BPC 8 ID \x00Q\nEI Q (a\\)b) Tj [<0041> -20 (x)] TJ');
    const ops = parseContent(data);
    expect(ops.map((o) => o.op)).toEqual(['q', 'BI', 'Q', 'Tj', 'TJ']);
    const bi = ops[1];
    expect(bi.inlineData!.end - bi.inlineData!.start).toBe(2);
    const tj = ops[3];
    expect(tj.operands[0].type === 'str' && Buffer.from(tj.operands[0].bytes).toString('latin1')).toBe('a)b');
  });
});

describe('page tree sanity', () => {
  it('keeps every page and unmarked page content intact', async () => {
    const src = fixture('announcement.pdf');
    const before = await pageTexts(src);
    const { bytes } = await applyRedactions(src, [{ pageIndex: 0, rects: [{ x0: 72, y0: 700, x1: 300, y1: 760 }] }], {}, env);
    const after = await pageTexts(bytes);
    expect(after.length).toBe(before.length);
    expect(after[1]).toBe(before[1]);
    expect(after[2]).toBe(before[2]);
    const lib = await PDFLib.load(bytes);
    const annots = lib.getPage(0).node.lookup(PDFName.of('Annots'));
    expect(annots === undefined || annots instanceof PDFArray).toBe(true);
    expect(lib.getPage(0).node.lookup(PDFName.of('Resources'))).toBeInstanceOf(PDFDict);
  }, 120_000);
});

describe('shading fills', () => {
  it('a page with an sh shading fill under a mark falls back to a full raster and verifies clean', async () => {
    const src = await syntheticTextPdf(
      'q /Sh1 sh Q BT /F1 24 Tf 72 700 Td (TOPSECRET payload) Tj ET',
      (doc, page) => {
        const shading = doc.context.obj({
          ShadingType: 2,
          ColorSpace: 'DeviceRGB',
          Coords: [0, 0, 612, 792],
          Function: { FunctionType: 2, Domain: [0, 1], C0: [1, 1, 1], C1: [0.2, 0.4, 0.8], N: 1 },
        });
        const fontRes = page.node.Resources()!;
        fontRes.set(PDFName.of('Shading'), doc.context.obj({ Sh1: shading }));
      }
    );
    const { bytes, report } = await redactTerm(src, 'TOPSECRET');
    expect(report.verification.ok).toBe(true);
    // The shading's painted area cannot be bounded, so the whole page was rasterized.
    expect(report.rasterized).toEqual([expect.objectContaining({ pageIndex: 0, scope: 'page' })]);
    expect(squash((await pageTexts(bytes))[0])).not.toContain('topsecret');
    for (const s of await allDecodedStreams(bytes)) {
      expect(s).not.toContain('TOPSECRET');
      expect(s).not.toMatch(/\/Sh1\s+sh/);
    }
  }, 120_000);
});
