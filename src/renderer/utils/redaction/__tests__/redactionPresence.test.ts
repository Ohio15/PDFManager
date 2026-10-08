/**
 * Output-boundary tests for "removed means ABSENT, not merely undrawn".
 *
 * Every test builds a real PDF with pdf-lib, runs the real engine, takes the
 * SAVED bytes, and asserts on them: unique marker strings embedded in the
 * original image / form / pattern / annotation / XFA objects must not occur
 * anywhere in the file, and the re-parsed object graph must not hold the
 * original objects. Verifier tests feed hand-built "bad outputs" straight to
 * verifyRedaction and require it to fail closed.
 */
import { describe, it, expect } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  PDFArray,
  PDFDict,
  PDFDocument as PDFLib,
  PDFName,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  StandardFonts,
  decodePDFRawStream,
} from 'pdf-lib';
import { applyRedactions } from '../redactionEngine';
import { openPdfjs, PdfjsEnv } from '../pdfjsEnv';
import { scanPdfjsPage } from '../pdfjsScan';
import { verifyRedaction } from '../redactionVerifier';
import { Rect } from '../geometry';

const env: PdfjsEnv = { lib: pdfjs as unknown as PdfjsEnv['lib'] };
const BLACK = { r: 0, g: 0, b: 0 };

const latin1 = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

/** Every stream in the file, decompressed where possible, as latin1. */
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

/** The marker is in neither the raw saved bytes nor any decoded stream. */
async function expectAbsent(bytes: Uint8Array, marker: string): Promise<void> {
  expect(latin1(bytes)).not.toContain(marker);
  for (const s of await decodedStreams(bytes)) expect(s).not.toContain(marker);
}

async function pageText(bytes: Uint8Array, pageNumber = 1): Promise<string> {
  const doc = await openPdfjs(env, bytes);
  const tc = await (await doc.getPage(pageNumber)).getTextContent();
  await doc.destroy();
  return tc.items.map((it) => ('str' in it ? it.str : '')).join(' ');
}

/** Raw (unfiltered) 8x8 RGB image whose pixel bytes spell `marker` repeatedly. */
function markerImage(doc: PDFLib, marker: string, extra: Record<string, unknown> = {}): PDFRef {
  const size = 8 * 8 * 3;
  const pixels = marker.repeat(Math.ceil(size / marker.length)).slice(0, size);
  return doc.context.register(
    doc.context.stream(pixels, { Type: 'XObject', Subtype: 'Image', Width: 8, Height: 8, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, ...extra })
  );
}

function xobjectNames(doc: PDFLib, pageIndex: number): string[] {
  const res = doc.getPage(pageIndex).node.Resources();
  const xo = res?.lookupMaybe(PDFName.of('XObject'), PDFDict);
  return xo ? xo.keys().map((k) => k.decodeText()) : [];
}

describe('replaced image / form XObjects are absent from the saved file', () => {
  it('a fully marked image: the original image stream and its /Im0 binding are gone', async () => {
    const MARKER = 'IMGMARKERq7Z';
    const doc = await PDFLib.create();
    const page = doc.addPage([612, 792]);
    const im = markerImage(doc, MARKER);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im0: im } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 200 0 0 200 100 100 cm /Im0 Do Q')));
    const src = await doc.save({ useObjectStreams: false });
    expect(latin1(src)).toContain(MARKER);

    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [{ x0: 90, y0: 90, x1: 310, y1: 310 }] }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.stats.imagesRedacted).toBe(1);
    // Removed at the object level, not hidden by a whole-page raster.
    expect(report.rasterized).toEqual([]);

    await expectAbsent(bytes, MARKER);
    const out = await PDFLib.load(bytes, { updateMetadata: false });
    expect(out.context.lookup(im)).toBeUndefined();
    expect(xobjectNames(out, 0)).not.toContain('Im0');
    expect(xobjectNames(out, 0).some((n) => n.startsWith('RdxIm'))).toBe(true);
  }, 60_000);

  it('a partly marked image: the original object is unreachable and unbound', async () => {
    const doc = await PDFLib.create();
    const page = doc.addPage([612, 792]);
    const im = markerImage(doc, 'PARTIALIMGk2');
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im0: im } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 200 0 0 200 100 100 cm /Im0 Do Q')));
    const src = await doc.save({ useObjectStreams: false });

    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [{ x0: 90, y0: 90, x1: 200, y1: 200 }] }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.rasterized).toEqual([]);
    expect(latin1(bytes)).not.toContain('PARTIALIMGk2');
    const out = await PDFLib.load(bytes, { updateMetadata: false });
    expect(out.context.lookup(im)).toBeUndefined();
    expect(xobjectNames(out, 0)).not.toContain('Im0');
  }, 60_000);

  it('an undecodable image under a mark: the dropped Do takes its binding with it', async () => {
    const MARKER = 'UNDECIMGMARKERp4';
    const doc = await PDFLib.create();
    const page = doc.addPage([612, 792]);
    // Claims Flate but is not zlib data: neither the engine nor pdf.js can decode it.
    const im = doc.context.register(
      doc.context.stream(MARKER.repeat(16), { Type: 'XObject', Subtype: 'Image', Width: 8, Height: 8, ColorSpace: 'DeviceRGB', BitsPerComponent: 8, Filter: 'FlateDecode' })
    );
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im0: im } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 200 0 0 200 100 100 cm /Im0 Do Q')));
    const src = await doc.save({ useObjectStreams: false });

    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [{ x0: 90, y0: 90, x1: 310, y1: 310 }] }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.rasterized.every((r) => r.scope === 'region')).toBe(true);
    expect(latin1(bytes)).not.toContain(MARKER);
    const out = await PDFLib.load(bytes, { updateMetadata: false });
    expect(out.context.lookup(im)).toBeUndefined();
    expect(xobjectNames(out, 0)).not.toContain('Im0');
  }, 60_000);

  it('a rewritten Form XObject: the original form stream (and the image it drew) are gone', async () => {
    const FORM_MARKER = 'FORMMARKERk3';
    const NESTED_MARKER = 'NESTEDIMGMARKERj6';
    const doc = await PDFLib.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const nested = markerImage(doc, NESTED_MARKER);
    const form = doc.context.register(
      doc.context.stream(`BT /F1 14 Tf 0 0 Td (${FORM_MARKER}) Tj ( and visible) Tj ET q 100 0 0 100 0 40 cm /Im0 Do Q`, {
        Type: 'XObject', Subtype: 'Form', BBox: [0, -5, 400, 150], Resources: { Font: { F1: font.ref }, XObject: { Im0: nested } },
      })
    );
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Fm0: form } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 1 0 0 1 72 500 cm /Fm0 Do Q')));
    const src = await doc.save({ useObjectStreams: false });
    expect(latin1(src)).toContain(FORM_MARKER);

    // Mark the marker word (x 72..~190, y ~496..~512) and the whole nested image (72..172 × 540..640).
    const marks: Rect[] = [{ x0: 70, y0: 494, x1: 175, y1: 515 }, { x0: 68, y0: 536, x1: 176, y1: 644 }];
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: marks }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.stats.formsRewritten).toBe(1);
    expect(report.rasterized).toEqual([]);

    await expectAbsent(bytes, FORM_MARKER);
    await expectAbsent(bytes, NESTED_MARKER);
    expect(await pageText(bytes)).toContain('and visible');
    const out = await PDFLib.load(bytes, { updateMetadata: false });
    expect(out.context.lookup(form)).toBeUndefined();
    expect(out.context.lookup(nested)).toBeUndefined();
    expect(xobjectNames(out, 0)).toEqual([expect.stringMatching(/^RdxFm/)]);
  }, 60_000);

  it('a shared form used by an unmarked page is kept for that page only', async () => {
    const doc = await PDFLib.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const form = doc.context.register(
      doc.context.stream('BT /F1 14 Tf 0 0 Td (SHAREDFORMb1) Tj ( tail) Tj ET', {
        Type: 'XObject', Subtype: 'Form', BBox: [0, -5, 300, 20], Resources: { Font: { F1: font.ref } },
      })
    );
    const shared = doc.context.obj({ XObject: { Fm0: form } });
    for (let i = 0; i < 2; i++) {
      const page = doc.addPage([612, 792]);
      page.node.set(PDFName.of('Resources'), shared);
      page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 1 0 0 1 72 600 cm /Fm0 Do Q')));
    }
    const src = await doc.save({ useObjectStreams: false });
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [{ x0: 70, y0: 594, x1: 180, y1: 615 }] }], {}, env);
    expect(report.verification.ok).toBe(true);
    const out = await PDFLib.load(bytes, { updateMetadata: false });
    expect(xobjectNames(out, 0)).not.toContain('Fm0');
    expect(xobjectNames(out, 1)).toEqual(['Fm0']);
    expect(await pageText(bytes, 1)).not.toContain('SHAREDFORMb1');
    expect(await pageText(bytes, 2)).toContain('SHAREDFORMb1');
  }, 60_000);

  it('a pattern fill dropped over a mark: the /Pattern binding and the pattern stream are gone', async () => {
    const MARKER = 'PATMARKERw2';
    const doc = await PDFLib.create();
    const pattern = doc.context.register(
      doc.context.stream(`% ${MARKER}\n0 0 1 rg 0 0 5 5 re f`, {
        Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 10, 10], XStep: 10, YStep: 10, Resources: {},
      })
    );
    const page = doc.addPage([612, 792]);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Pattern: { P0: pattern } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('/Pattern cs /P0 scn 100 100 400 400 re f')));
    const src = await doc.save({ useObjectStreams: false });
    expect(latin1(src)).toContain(MARKER);

    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [{ x0: 250, y0: 250, x1: 350, y1: 350 }] }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.rasterized).toEqual([expect.objectContaining({ scope: 'region' })]);
    await expectAbsent(bytes, MARKER);
    const out = await PDFLib.load(bytes, { updateMetadata: false });
    expect(out.context.lookup(pattern)).toBeUndefined();
    expect(out.getPage(0).node.Resources()?.get(PDFName.of('Pattern'))).toBeUndefined();
  }, 60_000);
});

describe('verifier: a bound-but-undrawn XObject on a marked page fails', () => {
  it('flags an original image left bound next to its replacement', async () => {
    const doc = await PDFLib.create();
    const page = doc.addPage([612, 792]);
    const original = markerImage(doc, 'LEFTBOUNDa1');
    const replacement = doc.context.register(
      doc.context.flateStream(new Uint8Array(8 * 8 * 3), { Type: 'XObject', Subtype: 'Image', Width: 8, Height: 8, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 } as never)
    );
    // What the engine wrote before the fix: draw the replacement, keep the original bound.
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im0: original, RdxIm1: replacement } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 200 0 0 200 100 100 cm /RdxIm1 Do Q q 0 0 0 rg 90 90 220 220 re f Q')));
    const bytes = await doc.save({ useObjectStreams: false });

    const v = await verifyRedaction(bytes, new Map([[0, [{ x0: 90, y0: 90, x1: 310, y1: 310 }]]]), BLACK, env);
    expect(v.ok).toBe(false);
    expect(v.pageViolations.get(0)!.some((m) => m.includes('/XObject /Im0') && m.includes('nothing draws it'))).toBe(true);
  }, 60_000);

  it('passes the same page once the original is unbound', async () => {
    const doc = await PDFLib.create();
    const page = doc.addPage([612, 792]);
    const replacement = doc.context.register(
      doc.context.flateStream(new Uint8Array(8 * 8 * 3), { Type: 'XObject', Subtype: 'Image', Width: 8, Height: 8, ColorSpace: 'DeviceRGB', BitsPerComponent: 8 } as never)
    );
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { RdxIm1: replacement } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 200 0 0 200 100 100 cm /RdxIm1 Do Q q 0 0 0 rg 90 90 220 220 re f Q')));
    const bytes = await doc.save({ useObjectStreams: false });
    const v = await verifyRedaction(bytes, new Map([[0, [{ x0: 90, y0: 90, x1: 310, y1: 310 }]]]), BLACK, env);
    expect(v.pageViolations.get(0) ?? []).toEqual([]);
    expect(v.ok).toBe(true);
  }, 60_000);
});

/**
 * A tagged, hybrid-XFA page carrying:
 *  - a sticky note under the mark (with a popup), tagged through the
 *    structure tree (OBJR + ParentTree) and replied to by a kept note (/IRT);
 *  - an orphan note under the mark that is NOT in /Annots, reachable only via
 *    the structure tree;
 *  - a filled field widget under the mark, listed in /Fields and /CO;
 *  - an XFA datasets stream holding the field value.
 */
async function taggedHybridForm() {
  const doc = await PDFLib.create();
  const page = doc.addPage([612, 792]);
  const ctx = doc.context;
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.node.set(PDFName.of('Resources'), ctx.obj({ Font: { F1: font.ref } }));
  page.node.set(PDFName.of('Contents'), ctx.register(ctx.stream('BT /F1 12 Tf 72 300 Td (unmarked body text) Tj ET')));

  const noteRef = ctx.nextRef();
  const popupRef = ctx.register(ctx.obj({ Type: 'Annot', Subtype: 'Popup', Rect: [300, 650, 450, 720], Parent: noteRef }));
  ctx.assign(noteRef, ctx.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [100, 700, 120, 720], P: page.ref, StructParent: 0, Popup: popupRef,
    Contents: PDFString.of('ANNOTMARKERx9'),
  }));
  const replyRef = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [500, 100, 520, 120], P: page.ref, IRT: noteRef, Contents: PDFString.of('reply stays'),
  }));
  const orphanRef = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Text', Rect: [130, 700, 150, 720], P: page.ref, Contents: PDFString.of('ORPHANMARKERu4'),
  }));
  const widgetRef = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of('ssn'), V: PDFString.of('FIELDMARKERv5'),
    Rect: [100, 600, 250, 620], P: page.ref, F: 4, DA: PDFString.of('/Helv 10 Tf 0 g'),
  }));
  const keptWidgetRef = ctx.register(ctx.obj({
    Type: 'Annot', Subtype: 'Widget', FT: 'Tx', T: PDFString.of('name'), V: PDFString.of('kept value'),
    Rect: [100, 100, 250, 120], P: page.ref, F: 4, DA: PDFString.of('/Helv 10 Tf 0 g'),
  }));
  page.node.set(PDFName.of('Annots'), ctx.obj([noteRef, popupRef, replyRef, widgetRef, keptWidgetRef]));

  const xfa = ctx.register(ctx.stream('<xfa:datasets><ssn>XFAMARKERd8</ssn></xfa:datasets>'));
  const acroForm = ctx.register(ctx.obj({ Fields: [widgetRef, keptWidgetRef], CO: [widgetRef], XFA: xfa, DA: PDFString.of('/Helv 10 Tf 0 g') }));
  doc.catalog.set(PDFName.of('AcroForm'), acroForm);
  doc.catalog.set(PDFName.of('NeedsRendering'), ctx.obj(false));

  // Structure tree: Document > [Annot elem (OBJR note), Annot elem (OBJR orphan), P elem (MCID 0)]
  const rootRef = ctx.nextRef();
  const docElemRef = ctx.nextRef();
  const noteElem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Annot', P: docElemRef, Alt: PDFString.of('NOTEALTMARKERr3'), K: { Type: 'OBJR', Obj: noteRef, Pg: page.ref } }));
  const orphanElem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'Annot', P: docElemRef, K: [{ Type: 'OBJR', Obj: orphanRef, Pg: page.ref }] }));
  const pElem = ctx.register(ctx.obj({ Type: 'StructElem', S: 'P', P: docElemRef, Pg: page.ref, K: 0 }));
  ctx.assign(docElemRef, ctx.obj({ Type: 'StructElem', S: 'Document', P: rootRef, K: [noteElem, orphanElem, pElem] }));
  ctx.assign(rootRef, ctx.obj({ Type: 'StructTreeRoot', K: docElemRef, ParentTree: { Nums: [0, noteElem, 1, [pElem]] } }));
  page.node.set(PDFName.of('StructParents'), ctx.obj(1));
  doc.catalog.set(PDFName.of('StructTreeRoot'), rootRef);

  const bytes = await doc.save({ useObjectStreams: false });
  return { bytes, refs: { noteRef, popupRef, replyRef, orphanRef, widgetRef, keptWidgetRef, noteElem, orphanElem, pElem, xfa } };
}

const FORM_MARKS: Rect[] = [{ x0: 90, y0: 590, x1: 260, y1: 725 }];

describe('removed annotations, widgets and field values are absent from the saved file', () => {
  it('cuts every inbound reference: structure tree, ParentTree, /IRT, /CO, /Fields, XFA', async () => {
    const { bytes: src, refs } = await taggedHybridForm();
    for (const m of ['ANNOTMARKERx9', 'ORPHANMARKERu4', 'FIELDMARKERv5', 'XFAMARKERd8', 'NOTEALTMARKERr3']) expect(latin1(src)).toContain(m);

    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: FORM_MARKS }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.annotationsRemoved).toBe(3); // note, orphan, widget (popup not counted)

    for (const m of ['ANNOTMARKERx9', 'ORPHANMARKERu4', 'FIELDMARKERv5', 'XFAMARKERd8', 'NOTEALTMARKERr3']) await expectAbsent(bytes, m);

    const out = await PDFLib.load(bytes, { updateMetadata: false });
    const ctx = out.context;
    for (const r of [refs.noteRef, refs.popupRef, refs.orphanRef, refs.widgetRef, refs.noteElem, refs.orphanElem, refs.xfa]) {
      expect(ctx.lookup(r)).toBeUndefined();
    }
    // Kept objects stay, with dangling edges cut.
    const reply = ctx.lookup(refs.replyRef, PDFDict);
    expect(reply.get(PDFName.of('IRT'))).toBeUndefined();
    expect(reply.lookup(PDFName.of('Contents'), PDFString).decodeText()).toBe('reply stays');
    expect(ctx.lookup(refs.pElem)).toBeInstanceOf(PDFDict);
    const acroForm = out.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect(acroForm.get(PDFName.of('XFA'))).toBeUndefined();
    expect(out.catalog.get(PDFName.of('NeedsRendering'))).toBeUndefined();
    expect(acroForm.lookup(PDFName.of('CO'), PDFArray).size()).toBe(0);
    expect(out.getForm().getFields().map((f) => f.getName())).toEqual(['name']);
    // ParentTree: the note's leaf (key 0) is gone; the page's MCID array keeps its slot.
    const root = out.catalog.lookup(PDFName.of('StructTreeRoot'), PDFDict);
    const nums = root.lookup(PDFName.of('ParentTree'), PDFDict).lookup(PDFName.of('Nums'), PDFArray);
    expect(nums.size()).toBe(2);
    expect(nums.lookup(1, PDFArray).get(0)).toBe(refs.pElem);
    // Structure: Document now holds only the P element.
    const docElem = ctx.lookup(root.get(PDFName.of('K')) as PDFRef, PDFDict);
    const kids = docElem.lookup(PDFName.of('K'), PDFArray);
    expect(kids.size()).toBe(1);
    expect(kids.get(0)).toBe(refs.pElem);
  }, 60_000);
});

describe('verifier: removed objects that are still present fail', () => {
  it('flags an annotation unlisted from /Annots but still reachable through the structure tree', async () => {
    const { bytes: src, refs } = await taggedHybridForm();
    // The pre-fix engine output: /Annots pruned, every other edge left in place.
    const doc = await PDFLib.load(src, { updateMetadata: false });
    doc.getPage(0).node.set(PDFName.of('Annots'), doc.context.obj([refs.replyRef, refs.keptWidgetRef]));
    doc.getPage(0).node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream('q 0 0 0 rg 90 590 170 135 re f Q')));
    const bytes = await doc.save({ useObjectStreams: false });

    const v = await verifyRedaction(bytes, new Map([[0, FORM_MARKS]]), BLACK, env, [], [
      { ref: refs.noteRef, kind: 'annotation' },
      { ref: refs.widgetRef, kind: 'widget' },
    ]);
    expect(v.ok).toBe(false);
    expect(v.globalViolations).toEqual(expect.arrayContaining([
      `Removed annotation ${refs.noteRef.toString()} is still present in the output`,
      `Removed widget ${refs.widgetRef.toString()} is still present in the output`,
      `Annotation ${refs.orphanRef.toString()} of a marked page overlaps a mark`,
      'AcroForm /XFA (an unredacted copy of the form and its values) is still present',
    ]));
  }, 60_000);
});

describe('zero-size text under a mark', () => {
  async function zeroSizePdf(): Promise<Uint8Array> {
    const doc = await PDFLib.create();
    const page = doc.addPage([612, 792]);
    const font = await doc.embedFont(StandardFonts.Helvetica);
    page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font.ref } }));
    page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(
      'BT /F1 0 Tf 100 700 Td (ZEROMARKERh1) Tj ET BT /F1 12 Tf 72 500 Td (visible keep) Tj ET'
    )));
    return doc.save({ useObjectStreams: false });
  }
  const MARK: Rect = { x0: 90, y0: 690, x1: 200, y1: 720 };

  it('is removed at the glyph level (no raster) and is absent from the saved file', async () => {
    const src = await zeroSizePdf();
    expect(await pageText(src)).toContain('ZEROMARKERh1'); // extractable before
    const { bytes, report } = await applyRedactions(src, [{ pageIndex: 0, rects: [MARK] }], {}, env);
    expect(report.verification.ok).toBe(true);
    expect(report.rasterized).toEqual([]);
    expect(report.stats.glyphsRemoved).toBeGreaterThan(0);
    await expectAbsent(bytes, 'ZEROMARKERh1');
    const text = await pageText(bytes);
    expect(text).not.toContain('ZEROMARKER');
    expect(text).toContain('visible keep');
  }, 60_000);

  it('the pdf.js oracle reports zero-size text under a mark as unexamined', async () => {
    const pdf = await openPdfjs(env, await zeroSizePdf());
    const page = await pdf.getPage(1);
    const under = await scanPdfjsPage(page, env.lib.OPS, { marks: [MARK] });
    expect(under.unexamined).toContain('Zero-size (invisible but extractable) text under a mark');
    const elsewhere = await scanPdfjsPage(page, env.lib.OPS, { marks: [{ x0: 300, y0: 300, x1: 400, y1: 400 }] });
    expect(elsewhere.unexamined).toEqual([]);
    await pdf.destroy();
  }, 60_000);
});
