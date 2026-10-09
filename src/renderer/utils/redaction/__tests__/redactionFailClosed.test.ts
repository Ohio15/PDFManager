/**
 * Output-boundary tests for the 2026-10-08 audit MEDIUM/LOW findings on the
 * redaction verifier and engine:
 *  - the verifier is fail-closed with a named reason (pdf.js errors,
 *    unloadable fonts, ExtGState fonts, Type3 text under a mark, sub-1pt
 *    marks) and its verdict distinguishes "clean" from "not examined";
 *  - document-level copies of a must-be-absent term fail the verdict;
 *  - /ActualText, /Alt, /E (inline, named /Properties, structure tree) and
 *    unused /Font, /ExtGState, /Properties bindings are gone from the file;
 *  - strokes and curves crossing a mark with every vertex outside it fail
 *    verification and are removed by the engine.
 *
 * Engine tests build a real PDF with pdf-lib, run applyRedactions, and assert
 * on the SAVED bytes (raw and every decoded stream) and on a pdf.js re-parse.
 * Verifier tests feed hand-built bad outputs to verifyRedaction.
 */
import { describe, it, expect } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDict, PDFDocument as PDFLib, PDFName, PDFRawStream, PDFStream, PDFHexString, StandardFonts, decodePDFRawStream } from 'pdf-lib';
import { isNeutralFont } from '../resourceUsage';
import { applyRedactions, RedactionMarkTooSmallError, RedactionVerificationError } from '../redactionEngine';
import { openPdfjs, PdfjsEnv } from '../pdfjsEnv';
import { scanPdfjsPage } from '../pdfjsScan';
import { normalizeForSearch, verifyRedaction } from '../redactionVerifier';
import { Rect, polylineIntersectsAny, segmentIntersectsRect, verificationCore } from '../geometry';
import { findOccurrences } from '../textSearch';

const env: PdfjsEnv = { lib: pdfjs as unknown as PdfjsEnv['lib'] };
const BLACK = { r: 0, g: 0, b: 0 };
const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

async function decodedStreams(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFLib.load(bytes, { updateMetadata: false });
  const out: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    try {
      out.push(latin1(obj instanceof PDFRawStream ? decodePDFRawStream(obj).decode() : obj.getContents()));
    } catch {
      out.push(latin1(obj.getContents()));
    }
  }
  return out;
}

/**
 * Everything the file holds, as text: the raw bytes, every decoded stream,
 * and the serialisation of every parsed indirect object (objects packed in
 * compressed object streams are invisible in the raw bytes otherwise).
 */
async function everything(bytes: Uint8Array): Promise<string> {
  const doc = await PDFLib.load(bytes, { updateMetadata: false });
  const objects: string[] = [];
  for (const [, obj] of doc.context.enumerateIndirectObjects()) objects.push(obj instanceof PDFStream ? obj.dict.toString() : obj.toString());
  return [latin1(bytes), ...(await decodedStreams(bytes)), ...objects].join('\n');
}

async function expectAbsent(bytes: Uint8Array, marker: string): Promise<void> {
  expect(await everything(bytes)).not.toContain(marker);
}

async function expectPresent(bytes: Uint8Array, marker: string): Promise<void> {
  expect(await everything(bytes)).toContain(marker);
}

/** Hex digits of a UTF-16BE text string without the BOM (how /ActualText is usually written). */
const utf16Hex = (text: string) => PDFHexString.fromText(text).toString().slice(5, -1).toUpperCase();

/** One page with Helvetica as /F1 and the given content; `extra` may add resources/objects. */
async function pdfWith(content: string, extra?: (doc: PDFLib, resources: Record<string, unknown>) => void): Promise<Uint8Array> {
  const doc = await PDFLib.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const resources: Record<string, unknown> = { Font: { F1: font.ref } };
  extra?.(doc, resources);
  page.node.set(PDFName.of('Resources'), doc.context.obj(resources as never));
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
  return doc.save({ useObjectStreams: false });
}

const box = (m: Rect) => `q 0 0 0 rg ${m.x0} ${m.y0} ${m.x1 - m.x0} ${m.y1 - m.y0} re f Q`;
const MARK: Rect = { x0: 90, y0: 690, x1: 250, y1: 720 };

// ---------------------------------------------------------------------------
// 1. Verifier fail-closed
// ---------------------------------------------------------------------------
describe('verifier is fail-closed with named reasons', () => {
  it('a clean output has verdict "clean" (examined, nothing found)', async () => {
    const bytes = await pdfWith(`BT /F1 12 Tf 72 500 Td (elsewhere) Tj ET ${box(MARK)}`);
    const v = await verifyRedaction(bytes, new Map([[0, [MARK]]]), BLACK, env);
    expect(v.verdict).toBe('clean');
    expect(v.ok).toBe(true);
    expect(v.notExamined).toEqual([]);
  }, 60_000);

  it('text in a font pdf.js cannot load fails as font-unloadable (not zero glyphs)', async () => {
    // /F9 is not in the resources: strict pdf.js yields an ErrorFont (no glyphs).
    const bytes = await pdfWith(`BT /F9 12 Tf 100 700 Td (NOFONTSECRETd3) Tj ET ${box(MARK)}`);
    const v = await verifyRedaction(bytes, new Map([[0, [MARK]]]), BLACK, env);
    expect(v.ok).toBe(false);
    expect(v.notExamined.some((n) => n.reason === 'font-unloadable' && n.pageIndex === 0)).toBe(true);
  }, 60_000);

  it('the engine never ships text in an unloadable font under a mark (saved bytes)', async () => {
    const src = await pdfWith('BT /F9 12 Tf 100 700 Td (NOFONTSECRETd3) Tj ET BT /F1 12 Tf 72 500 Td (keep) Tj ET');
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [MARK] }], {}, env);
    expect(report.verification.verdict).toBe('clean');
    await expectAbsent(bytes, 'NOFONTSECRETd3');
  }, 60_000);

  it('a pdf.js evaluator error fails as pdfjs-error instead of a shorter, "clean" operator list', async () => {
    // An XObject stream with no /Subtype: pdf.js throws FormatError. Lenient
    // pdf.js swallows it and TRUNCATES the operator list, so the text after it
    // is never seen; strict pdf.js rejects, which must surface as NOT EXAMINED.
    const bytes = await pdfWith(`/Bad Do BT /F1 12 Tf 100 700 Td (AFTERERRORSECRET) Tj ET ${box(MARK)}`, (doc, res) => {
      res.XObject = { Bad: doc.context.register(doc.context.stream('0 0 m', { Type: 'XObject' })) };
    });
    const v = await verifyRedaction(bytes, new Map([[0, [MARK]]]), BLACK, env);
    expect(v.ok).toBe(false);
    expect(v.notExamined.some((n) => n.reason === 'pdfjs-error')).toBe(true);
  }, 60_000);

  it('text whose font comes from an ExtGState /Font entry fails as extgstate-font', async () => {
    const make = (content: string) =>
      pdfWith(content, (_doc, res) => {
        res.ExtGState = { GS1: { Type: 'ExtGState', Font: [(res.Font as { F1: unknown }).F1, 12] } };
      });
    const bytes = await make(`BT /F1 12 Tf ET q /GS1 gs BT 100 700 Td (GSFONTSECRETa8) Tj ET Q ${box(MARK)}`);
    const v = await verifyRedaction(bytes, new Map([[0, [MARK]]]), BLACK, env);
    expect(v.ok).toBe(false);
    expect(v.notExamined.some((n) => n.reason === 'extgstate-font')).toBe(true);

    // Engine: glyphs under the mark are removed, but text in the ExtGState
    // font is still on the page, which the oracle cannot pass as clean: the
    // page is redone as a raster and the secret is gone from the saved file.
    const src = await make('q /GS1 gs BT 100 700 Td (GSFONTSECRETa8) Tj ET BT 72 400 Td (kept gs text) Tj ET Q');
    const out = await applyRedactions(src, [{ pageIndex: 0, rects: [MARK] }], {}, env);
    expect(out.report.verification.ok).toBe(true);
    expect(out.report.rasterized.some((r) => r.scope === 'page' && r.reason.includes('extgstate-font'))).toBe(true);
    await expectAbsent(out.bytes, 'GSFONTSECRETa8');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 5. Type3 text under a mark
// ---------------------------------------------------------------------------
describe('Type3 text intersecting a mark fails as type3-font-under-mark', () => {
  /**
   * A Type3 font whose glyph procedure paints 14000 glyph units to the right
   * of a 500-unit advance (honestly declared in FontBBox, or hidden by an
   * all-zero FontBBox). The text sits well outside one em of the mark, so
   * the engine's advance-box reach never sees it.
   */
  async function lyingType3(fontBBox: number[]): Promise<Uint8Array> {
    const doc = await PDFLib.create();
    const glyph = doc.context.register(doc.context.stream('500 0 0 0 15000 700 d1 14000 0 1000 700 re f % T3INKMARKERu4'));
    const t3 = doc.context.register(doc.context.obj({
      Type: 'Font', Subtype: 'Type3', FontBBox: fontBBox, FontMatrix: [0.001, 0, 0, 0.001, 0, 0],
      CharProcs: { box: glyph }, Encoding: { Type: 'Encoding', Differences: [65, 'box'] }, FirstChar: 65, LastChar: 65, Widths: [500],
    }));
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { T3: t3 } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('BT /T3 20 Tf 20 700 Td (A) Tj ET')));
    return doc.save({ useObjectStreams: false });
  }
  // Ink lands at x = 20 + 14000*0.02 = 300 .. 320; the advance box is 20..30.
  const T3_MARK: Rect = { x0: 290, y0: 690, x1: 330, y1: 720 };

  for (const [label, bbox] of [['honest FontBBox', [0, 0, 15000, 700]], ['all-zero FontBBox', [0, 0, 0, 0]]] as const) {
    it(`${label}: the verifier fails the page and the engine ships no Type3 glyph procedure`, async () => {
      const src = await lyingType3([...bbox]);
      const pdf = await openPdfjs(env, src, { strict: true });
      const scan = await scanPdfjsPage(await pdf.getPage(1), env.lib.OPS, { marks: [verificationCore(T3_MARK)] });
      await pdf.destroy();
      expect(scan.unexamined.map((u) => u.reason)).toContain('type3-font-under-mark');

      const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [T3_MARK] }], {}, env);
      expect(report.verification.ok).toBe(true);
      // Success only via a whole-page raster that names the reason.
      expect(report.rasterized).toEqual([expect.objectContaining({ pageIndex: 0, scope: 'page' })]);
      expect(report.rasterized[0].reason).toContain('type3-font-under-mark');
      await expectAbsent(bytes, 'T3INKMARKERu4');
    }, 60_000);
  }
});

// ---------------------------------------------------------------------------
// 4a. Marks below 1 pt
// ---------------------------------------------------------------------------
describe('marks narrower or shorter than 1 pt are refused, never passed vacuously', () => {
  const THIN: Rect = { x0: 103, y0: 695, x1: 103.6, y1: 715 };

  it('the verifier fails a sub-1pt mark as mark-below-minimum', async () => {
    // A glyph whose centre is inside the thin mark: an inverted inset would pass it.
    const bytes = await pdfWith('BT /F1 12 Tf 100 700 Td (I) Tj ET');
    const v = await verifyRedaction(bytes, new Map([[0, [THIN]]]), BLACK, env);
    expect(v.ok).toBe(false);
    expect(v.notExamined.some((n) => n.reason === 'mark-below-minimum')).toBe(true);
  }, 60_000);

  it('Apply refuses a sub-1pt mark and returns no bytes', async () => {
    const src = await pdfWith('BT /F1 12 Tf 100 700 Td (THINSECRETr2) Tj ET');
    await expect(applyRedactions(src, [{ pageIndex: 0, rects: [THIN] }], {}, env)).rejects.toBeInstanceOf(RedactionMarkTooSmallError);
  }, 60_000);

  it('search hits on sub-1pt text are padded to a redactable mark and removed', async () => {
    const src = await pdfWith('BT /F1 0.5 Tf 100 700 Td (TINYTEXTSECRETj6) Tj ET BT /F1 12 Tf 72 500 Td (keep) Tj ET');
    const pdf = await openPdfjs(env, src);
    const occ = await findOccurrences(pdf, env, 'TINYTEXTSECRETj6');
    await pdf.destroy();
    expect(occ.length).toBe(1);
    for (const r of occ[0].rects) expect(r.y1 - r.y0).toBeGreaterThanOrEqual(1);
    const { bytes, report } = await applyRedactions(src, occ.map((o) => ({ pageIndex: o.pageIndex, rects: o.rects })), { mustBeAbsent: ['TINYTEXTSECRETj6'] }, env);
    expect(report.verification.ok).toBe(true);
    await expectAbsent(bytes, 'TINYTEXTSECRETj6');
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 4b. Path segments, not sampled points
// ---------------------------------------------------------------------------
describe('strokes and curves through a mark (every vertex outside)', () => {
  const PATH_MARK: Rect = { x0: 200, y0: 600, x1: 300, y1: 720 };
  // A line and a curve whose end and control points are all outside the mark.
  const LINE = '2 w 50 700 m 550 700 l S';
  const CURVE = '2 w 50 610 m 150 650 450 650 550 610 c S';

  it('geometry: segment and flattened-curve intersection', () => {
    expect(segmentIntersectsRect({ x: 50, y: 700 }, { x: 550, y: 700 }, PATH_MARK)).toBe(true);
    expect(segmentIntersectsRect({ x: 50, y: 750 }, { x: 550, y: 750 }, PATH_MARK)).toBe(false);
    // Along the boundary only: outside.
    expect(segmentIntersectsRect({ x: 200, y: 500 }, { x: 200, y: 800 }, PATH_MARK)).toBe(false);
  });

  it('the verifier fails a stroke that crosses a mark with no vertex inside', async () => {
    for (const path of [LINE, CURVE]) {
      const bytes = await pdfWith(`${path} ${box(PATH_MARK)}`);
      const v = await verifyRedaction(bytes, new Map([[0, [PATH_MARK]]]), BLACK, env);
      expect(v.ok).toBe(false);
      expect(v.verdict).toBe('violations');
      expect([...v.pageViolations.get(0)!].some((m) => m.includes('segments remain under a mark'))).toBe(true);
    }
  }, 60_000);

  it('the engine removes them: no painted segment of the saved page enters the mark', async () => {
    const src = await pdfWith(`${LINE} ${CURVE} BT /F1 12 Tf 72 400 Td (keep) Tj ET`);
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [PATH_MARK] }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.stats.pathsRemoved).toBeGreaterThanOrEqual(2);
    // Region rasters only: the page itself keeps its text layer.
    expect(report.rasterized.every((r) => r.scope === 'region')).toBe(true);
    for (const s of await decodedStreams(bytes)) {
      expect(s).not.toContain('550 700 l');
      expect(s).not.toContain('450 650 550 610 c');
    }
    const pdf = await openPdfjs(env, bytes);
    const scan = await scanPdfjsPage(await pdf.getPage(1), env.lib.OPS);
    await pdf.destroy();
    const core = verificationCore(PATH_MARK);
    expect(scan.paths.some((p) => p.painted && p.subpaths.some((sp) => polylineIntersectsAny(sp, [core])))).toBe(false);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 3. Marked-content text properties, structure tree, unused resources
// ---------------------------------------------------------------------------
describe('ActualText / Alt / E and unused resources are gone from the saved file', () => {
  it('inline /ActualText around a PATH under a mark (no glyph removed) is scrubbed', async () => {
    const src = await pdfWith(`/Figure <</ActualText (PATHACTUALq9) /MCID 0>> BDC 100 700 50 10 re f EMC ${'BT /F1 12 Tf 72 500 Td (keep) Tj ET'}`);
    await expectPresent(src, 'PATHACTUALq9');
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [MARK] }], {}, env);
    expect(report.verification.ok).toBe(true);
    await expectAbsent(bytes, 'PATHACTUALq9');
    // The MCID is kept so the structure tree still maps onto the region.
    expect((await decodedStreams(bytes)).some((s) => s.includes('/MCID 0'))).toBe(true);
  }, 60_000);

  it('/Alt around a glyph the mark only grazes (glyph kept) is scrubbed', async () => {
    // Mark covers the top of the line: the full glyph box touches it, the
    // shrunk removal box does not, so nothing is removed.
    const graze: Rect = { x0: 60, y0: 708.5, x1: 200, y1: 730 };
    const src = await pdfWith('/Span <</Alt (GRAZEALTn1)>> BDC BT /F1 12 Tf 72 700 Td (grazed) Tj ET EMC');
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [graze] }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.stats.glyphsRemoved).toBe(0);
    await expectAbsent(bytes, 'GRAZEALTn1');
  }, 60_000);

  it('a named /Properties list with /ActualText is rewritten inline and its entry pruned', async () => {
    const src = await pdfWith('/Span /P1 BDC 100 700 50 10 re f EMC', (_doc, res) => {
      res.Properties = { P1: { ActualText: PDFHexString.fromText('PROPACTUALz3'), MCID: 4 } };
    });
    await expectPresent(src, utf16Hex('PROPACTUALz3'));
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [MARK] }], {}, env);
    expect(report.verification.ok).toBe(true);
    const out = await PDFLib.load(bytes, { updateMetadata: false });
    const res = out.getPage(0).node.Resources()!;
    expect(res.get(PDFName.of('Properties'))).toBeUndefined();
    expect((await decodedStreams(bytes)).some((s) => s.includes('/MCID 4'))).toBe(true);
    await expectAbsent(bytes, utf16Hex('PROPACTUALz3'));
  }, 60_000);

  it('a sequence around a FORM drawn under a mark is scrubbed (form recursion propagates)', async () => {
    const src = await pdfWith('/Span <</ActualText (FORMACTUALw2)>> BDC /Fm0 Do EMC', (doc, res) => {
      const form = doc.context.register(doc.context.stream('BT /F1 12 Tf 100 700 Td (inside) Tj ET', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 612, 792], Resources: { Font: res.Font },
      } as never));
      res.XObject = { Fm0: form };
    });
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [MARK] }], {}, env);
    expect(report.verification.ok).toBe(true);
    await expectAbsent(bytes, 'FORMACTUALw2');
  }, 60_000);

  it('structure-element /ActualText /Alt /E for content under a mark are scrubbed', async () => {
    const src = await (async () => {
      const doc = await PDFLib.create();
      const page = doc.addPage([612, 792]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(
        '/Span <</MCID 0>> BDC BT /F1 12 Tf 100 700 Td (TAGGED) Tj ET EMC /Span <</MCID 1>> BDC BT /F1 12 Tf 72 400 Td (other) Tj ET EMC'
      )));
      const rootRef = doc.context.nextRef();
      const under = doc.context.register(doc.context.obj({ Type: 'StructElem', S: 'Span', P: rootRef, Pg: page.ref, K: 0, ActualText: PDFHexString.fromText('STRUCTACTUALk5'), Alt: 'STRUCTALTk5', E: 'STRUCTEk5' } as never));
      const other = doc.context.register(doc.context.obj({ Type: 'StructElem', S: 'Span', P: rootRef, Pg: page.ref, K: 1, Alt: 'KEEPALTb7' } as never));
      doc.context.assign(rootRef, doc.context.obj({ Type: 'StructTreeRoot', K: [under, other] }));
      doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
      return doc.save({ useObjectStreams: false });
    })();
    await expectPresent(src, 'STRUCTALTk5');
    await expectPresent(src, utf16Hex('STRUCTACTUALk5'));
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [MARK] }], {}, env);
    expect(report.verification.ok).toBe(true);
    await expectAbsent(bytes, 'STRUCTALTk5');
    await expectAbsent(bytes, 'STRUCTEk5');
    await expectAbsent(bytes, utf16Hex('STRUCTACTUALk5'));
    // The element tagging content outside the mark keeps its /Alt.
    await expectPresent(bytes, 'KEEPALTb7');
  }, 60_000);

  it('the verifier fails a structure element that still repeats content under a mark', async () => {
    const doc = await PDFLib.create();
    const page = doc.addPage([612, 792]);
    // MCID 0's content was removed: nothing on the page carries it any more.
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(box(MARK))));
    page.node.set(PDFName.of('Resources'), doc.context.obj({}));
    const rootRef = doc.context.nextRef();
    const el = doc.context.register(doc.context.obj({ Type: 'StructElem', S: 'Span', P: rootRef, Pg: page.ref, K: 0, Alt: 'LEFTALTc1' } as never));
    doc.context.assign(rootRef, doc.context.obj({ Type: 'StructTreeRoot', K: [el] }));
    doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);
    const bytes = await doc.save({ useObjectStreams: false });
    // MCID 0 has no content left (it was removed), so its /Alt describes removed content.
    const v = await verifyRedaction(bytes, new Map([[0, [MARK]]]), BLACK, env);
    expect(v.ok).toBe(false);
    expect([...v.pageViolations.get(0)!].some((m) => m.includes('Structure element') && m.includes('/Alt'))).toBe(true);
  }, 60_000);

  it('/Font, /ExtGState and /Properties bindings no remaining content uses are pruned', async () => {
    const src = await pdfWith('BT /F2 12 Tf 100 700 Td (ONLYTEXTINF2) Tj ET BT /F1 12 Tf 72 400 Td (keep) Tj ET', (doc, res) => {
      (res.Font as Record<string, unknown>).F2 = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier', FontMarker: 'UNUSEDFONTm8' } as never));
      res.ExtGState = { GS9: { Type: 'ExtGState', CA: 1, GsMarker: 'UNUSEDGSv1' } };
      res.Properties = { P9: { PropMarker: 'UNUSEDPROPx6' } };
    });
    for (const m of ['UNUSEDFONTm8', 'UNUSEDGSv1', 'UNUSEDPROPx6']) await expectPresent(src, m);
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [MARK] }], {}, env);
    expect(report.verification.ok).toBe(true);
    for (const m of ['UNUSEDFONTm8', 'UNUSEDGSv1', 'UNUSEDPROPx6', 'ONLYTEXTINF2']) await expectAbsent(bytes, m);
    // The font still showing text stays bound as it was; /F2 (its text all
    // removed, its Tf kept) is bound to a data-free standard-14 stub.
    const out = await PDFLib.load(bytes, { updateMetadata: false });
    const fonts = out.getPage(0).node.Resources()!.lookup(PDFName.of('Font'), PDFDict);
    expect(fonts.has(PDFName.of('F1'))).toBe(true);
    expect(isNeutralFont(out.context, fonts.get(PDFName.of('F2')))).toBe(true);
  }, 60_000);

  it('the verifier fails an unused /Font binding left on a marked page', async () => {
    const bytes = await pdfWith(`BT /F1 12 Tf 72 400 Td (keep) Tj ET ${box(MARK)}`, (doc, res) => {
      (res.Font as Record<string, unknown>).F2 = doc.context.register(doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Courier' } as never));
    });
    const v = await verifyRedaction(bytes, new Map([[0, [MARK]]]), BLACK, env);
    expect(v.ok).toBe(false);
    expect([...v.pageViolations.get(0)!].some((m) => m.includes('/Font /F2'))).toBe(true);
  }, 60_000);
});

// ---------------------------------------------------------------------------
// 2. Document-level copies fail the verdict
// ---------------------------------------------------------------------------
describe('document-level copies of a must-be-absent term fail the verdict', () => {
  it('a term left in a bookmark title fails verification and Apply returns no bytes', async () => {
    const src = await (async () => {
      const doc = await PDFLib.create();
      const page = doc.addPage([612, 792]);
      const font = await doc.embedFont(StandardFonts.Helvetica);
      page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('BT /F1 12 Tf 100 700 Td (OUTLINESECRET) Tj ET')));
      const outlinesRef = doc.context.nextRef();
      const item = doc.context.register(doc.context.obj({ Title: PDFHexString.fromText('Report on OUTLINESECRET'), Parent: outlinesRef, Dest: [page.ref, 'Fit'] } as never));
      doc.context.assign(outlinesRef, doc.context.obj({ Type: 'Outlines', First: item, Last: item, Count: 1 }));
      doc.catalog.set(PDFName.of('Outlines'), outlinesRef);
      return doc.save({ useObjectStreams: false });
    })();
    const pdf = await openPdfjs(env, src);
    const occ = await findOccurrences(pdf, env, 'OUTLINESECRET');
    await pdf.destroy();
    expect(occ.length).toBe(1);
    const err = await applyRedactions(src, occ.map((o) => ({ pageIndex: o.pageIndex, rects: o.rects })), { mustBeAbsent: ['OUTLINESECRET'] }, env).then(
      () => null,
      (e) => e
    );
    expect(err).toBeInstanceOf(RedactionVerificationError);
    const v = (err as RedactionVerificationError).verification;
    expect(v.verdict).toBe('violations');
    expect(v.globalViolations.some((m) => m.includes('OUTLINESECRET'.toLowerCase()) || m.includes('OUTLINESECRET'))).toBe(true);
  }, 60_000);

  it('a term in UTF-16 /ActualText in a content stream (hex string) fails verification', async () => {
    const hex = PDFHexString.fromText('HEXACTUALSECRET').toString();
    const bytes = await pdfWith(`/Span <</ActualText ${hex}>> BDC EMC ${box(MARK)}`);
    const v = await verifyRedaction(bytes, new Map([[0, [MARK]]]), BLACK, env, ['HEXACTUALSECRET']);
    expect(v.ok).toBe(false);
    expect(v.globalViolations.some((m) => m.includes('hexactualsecret'))).toBe(true);
  }, 60_000);

  it('a term in the Info dictionary (metadata kept) fails verification', async () => {
    const doc = await PDFLib.create();
    doc.addPage([612, 792]).node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(box(MARK))));
    doc.setTitle('About INFOSECRETt3');
    const bytes = await doc.save({ useObjectStreams: false });
    const v = await verifyRedaction(bytes, new Map([[0, [MARK]]]), BLACK, env, ['INFOSECRETt3']);
    expect(v.ok).toBe(false);
    expect(v.verdict).toBe('violations');
  }, 60_000);

  it('the verifier folds exactly as search does (foldForSearch, not NFKC)', () => {
    // Final sigma: whole-string lowercasing gives ς, search folds it to σ.
    expect(normalizeForSearch('ΟΔΟΣ')).toBe(normalizeForSearch('οδοσ'));
    // NFKD decomposes; the fold of a precomposed and a decomposed é agree.
    expect(normalizeForSearch('café')).toBe(normalizeForSearch('café'));
  });
});
