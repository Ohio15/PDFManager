/**
 * Page tools (v2.14.11): every test drives the real byte op, reloads the
 * OUTPUT with pdf-lib (and pdf.js where rendering semantics matter) and
 * asserts page count/order/size, CropBox, rotation and form-field survival.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PDFDocument as PDFLib, PDFName, PDFArray, PDFDict, PDFRef, PDFNumber, PDFHexString, PDFRawStream, decodePDFRawStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  applyPdfPageOrder,
  deletePdfPage,
  deletePdfPages,
  duplicatePdfPages,
  movePdfPages,
  rotatePdfPages,
  setPdfPageCrop,
  setPdfPageRotation,
  insertPdfPages,
  replacePdfPage,
  reorderPdfPage,
  readPageGeometries,
  orderWithMove,
  orderWithDuplicates,
  orderWithout,
  marginsToUserBox,
  userBoxToMargins,
  EncryptedSourceError,
  MIN_CROP_SIZE,
} from './pageStructure';
import { applyEditsAndAnnotations } from './pdfSavePipeline';
import {
  reorderPageModel,
  cropPageModel,
  rotatePageModel,
  copyPositions,
  positionsOf,
} from './pageModelOps';
import { nextSelection, parsePageRange, formatPageRange, dropGap } from './pageSelectionModel';
import type { PDFPage } from '../types';

const fixture = (name: string) => new Uint8Array(readFileSync(join(process.cwd(), 'test-pdfs', name)));
const FORM = 'repair-calibration-form.pdf';

async function makeDoc(n: number): Promise<Uint8Array> {
  const d = await PDFLib.create();
  for (let i = 0; i < n; i++) d.addPage([100 + i, 200]);
  return new Uint8Array(await d.save());
}
async function widths(bytes: Uint8Array): Promise<number[]> {
  return (await PDFLib.load(bytes)).getPages().map((p) => Math.round(p.getSize().width));
}
async function fieldNames(bytes: Uint8Array): Promise<string[]> {
  return (await PDFLib.load(bytes)).getForm().getFields().map((f) => f.getName()).sort();
}
function cropArray(doc: PDFLib, i: number): number[] {
  const arr = doc.getPage(i).node.get(PDFName.of('CropBox')) as PDFArray;
  return arr.asArray().map((n) => Math.round((n as PDFNumber).asNumber() * 100) / 100);
}
async function pdfjsDoc(bytes: Uint8Array) {
  return pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
}

describe('page order planning', () => {
  it('orderWithMove places the moved block into the gap (original numbering)', () => {
    expect(orderWithMove(5, [0], 3)).toEqual([1, 2, 0, 3, 4]);
    expect(orderWithMove(5, [3, 4], 0)).toEqual([3, 4, 0, 1, 2]);
    expect(orderWithMove(5, [1, 3], 5)).toEqual([0, 2, 4, 1, 3]);
    expect(orderWithMove(5, [1, 2], 2)).toEqual([0, 1, 2, 3, 4]);
  });
  it('orderWithDuplicates puts each copy right after its original', () => {
    expect(orderWithDuplicates(4, [1, 3])).toEqual([0, 1, 1, 2, 3, 3]);
    expect(copyPositions([0, 1, 1, 2, 3, 3])).toEqual([2, 5]);
    expect(positionsOf([2, 0, 1], [0, 1])).toEqual([1, 2]);
  });
  it('orderWithout refuses to delete every page', () => {
    expect(() => orderWithout(3, [0, 1, 2])).toThrow(/every page/);
    expect(orderWithout(3, [1])).toEqual([0, 2]);
  });
});

describe('applyPdfPageOrder / bulk ops (bytes)', () => {
  it('deletes several pages and keeps the rest in order', async () => {
    const out = await deletePdfPages(await makeDoc(5), [0, 2, 4]);
    expect(await widths(out)).toEqual([101, 103]);
  });
  it('refuses to delete every page and leaves bytes untouched', async () => {
    await expect(deletePdfPages(await makeDoc(2), [0, 1])).rejects.toThrow(/every page/);
  });
  it('duplicates pages in place', async () => {
    const out = await duplicatePdfPages(await makeDoc(3), [0, 2]);
    expect(await widths(out)).toEqual([100, 100, 101, 102, 102]);
  });
  it('moves a non-contiguous selection to the end', async () => {
    const out = await movePdfPages(await makeDoc(5), [0, 2], 5);
    expect(await widths(out)).toEqual([101, 103, 104, 100, 102]);
  });
  it('rotates several pages relative to their own rotation', async () => {
    let bytes = await setPdfPageRotation(await makeDoc(3), 1, 90);
    bytes = await rotatePdfPages(bytes, [0, 1], -90);
    const rots = (await PDFLib.load(bytes)).getPages().map((p) => p.getRotation().angle);
    expect(rots).toEqual([270, 0, 0]);
  });
  it('rejects a rotation that is not a quarter turn', async () => {
    await expect(rotatePdfPages(await makeDoc(1), [0], 45)).rejects.toThrow(/multiple of 90/);
  });
  it('duplicated page has its own content stream (edits cannot leak between copies)', async () => {
    const out = await duplicatePdfPages(fixture('invoice.pdf'), [0]);
    const doc = await PDFLib.load(out);
    const c0 = doc.getPage(0).node.get(PDFName.of('Contents'));
    const c1 = doc.getPage(1).node.get(PDFName.of('Contents'));
    expect(String(c0)).not.toEqual(String(c1));
    // Same drawing operations on both pages.
    const pj = await pdfjsDoc(out);
    const ops = async (n: number) => (await (await pj.getPage(n)).getOperatorList()).fnArray;
    expect(await ops(2)).toEqual(await ops(1));
    expect((await ops(1)).length).toBeGreaterThan(20);
  });

  it('pins inherited MediaBox/Rotate so a moved page keeps its size', async () => {
    // Build a nested page tree: page 0 inherits MediaBox+Rotate from an intermediate node.
    const d = await PDFLib.create();
    d.addPage([100, 200]);
    d.addPage([300, 400]);
    const ctx = d.context;
    const root = d.catalog.Pages();
    const rootRef = d.catalog.get(PDFName.of('Pages')) as PDFRef;
    const [p0, p1] = d.getPages();
    p0.node.delete(PDFName.of('MediaBox'));
    const mid = ctx.obj({ Type: 'Pages', Kids: [p0.ref], Count: 1, Parent: rootRef, MediaBox: [0, 0, 500, 600], Rotate: 90 });
    const midRef = ctx.register(mid);
    p0.node.set(PDFName.of('Parent'), midRef);
    root.set(PDFName.of('Kids'), ctx.obj([midRef, p1.ref]));
    const nested = new Uint8Array(await d.save());
    const before = await readPageGeometries(nested);
    expect(before[0].mediaBox.width).toBe(500);
    expect(before[0].rotation).toBe(90);

    const moved = await reorderPdfPage(nested, 0, 1);
    const afterReorder = await readPageGeometries(moved);
    expect(afterReorder[1].mediaBox).toEqual(before[0].mediaBox);
    expect(afterReorder[1].rotation).toBe(90);

    const viaOrder = await applyPdfPageOrder(nested, [1, 0, 0]);
    const geos = await readPageGeometries(viaOrder);
    expect(geos.map((g) => g.mediaBox.width)).toEqual([300, 500, 500]);
    expect(geos.map((g) => g.rotation)).toEqual([0, 90, 90]);
  });

  it('keeps the document outline through duplicate/delete/move', async () => {
    const d = await PDFLib.load(await makeDoc(3));
    const ctx = d.context;
    const target = d.getPage(2).ref;
    const outlines = ctx.obj({ Type: 'Outlines', Count: 1 });
    const outlinesRef = ctx.register(outlines);
    const item = ctx.obj({ Title: PDFHexString.fromText('Chapter'), Parent: outlinesRef, Dest: [target, 'Fit'] });
    const itemRef = ctx.register(item);
    outlines.set(PDFName.of('First'), itemRef);
    outlines.set(PDFName.of('Last'), itemRef);
    d.catalog.set(PDFName.of('Outlines'), outlinesRef);
    let bytes: Uint8Array = new Uint8Array(await d.save());
    bytes = await duplicatePdfPages(bytes, [0]);
    bytes = await deletePdfPages(bytes, [1]);
    bytes = await movePdfPages(bytes, [2], 0);
    const pj = await pdfjsDoc(bytes);
    const outline = await pj.getOutline();
    expect(outline.map((o: any) => o.title)).toEqual(['Chapter']);
    const dest = outline[0].dest as any[];
    expect(await pj.getPageIndex(dest[0])).toBe(0); // the width-102 page, now first
    expect(await widths(bytes)).toEqual([102, 100, 101]);
  });
});

describe('AcroForm survival (repair-calibration-form.pdf, 47 merged field/widgets)', () => {
  it('duplicate links each widget to the SAME field: names unchanged, two widgets each', async () => {
    const src = fixture(FORM);
    const namesBefore = await fieldNames(src);
    expect(namesBefore.length).toBe(47);
    const out = await duplicatePdfPages(src, [0]);
    const doc = await PDFLib.load(out);
    expect(doc.getPageCount()).toBe(2);
    const fields = doc.getForm().getFields();
    expect(fields.map((f) => f.getName()).sort()).toEqual(namesBefore);
    const sigs = fields.filter((f) => f.constructor.name === 'PDFSignature').length;
    for (const f of fields) {
      if (f.constructor.name === 'PDFSignature') continue;
      expect(f.acroField.getWidgets().length).toBe(2);
    }
    expect(sigs).toBe(0);
    // pdf.js sees the copies on page 2 as widgets of the same field names.
    const pj = await pdfjsDoc(out);
    const w2 = (await (await pj.getPage(2)).getAnnotations()).filter((a: any) => a.subtype === 'Widget');
    expect(w2.length).toBe(47);
    expect(new Set(w2.map((a: any) => a.fieldName))).toEqual(new Set(namesBefore));
  });

  it('a value set on the field shows on both pages (linked, not copied)', async () => {
    const out = await duplicatePdfPages(fixture(FORM), [0]);
    const doc = await PDFLib.load(out);
    const tf = doc.getForm().getFields().find((f) => f.constructor.name === 'PDFTextField')!;
    (tf as any).setText('LINKED-VALUE');
    const saved = new Uint8Array(await doc.save());
    const pj = await pdfjsDoc(saved);
    for (const n of [1, 2]) {
      const w = (await (await pj.getPage(n)).getAnnotations()).find((a: any) => a.fieldName === tf.getName());
      expect(w.fieldValue).toBe('LINKED-VALUE');
    }
  });

  it('deleting a page removes its widgets from the field tree', async () => {
    const withBlank = await applyPdfPageOrder(await duplicatePdfPages(fixture(FORM), [0]), [0, 1]);
    // Drop the original: fields survive with exactly one widget each.
    const out = await deletePdfPage(withBlank, 0);
    const doc = await PDFLib.load(out);
    expect(doc.getPageCount()).toBe(1);
    const fields = doc.getForm().getFields();
    expect(fields.length).toBe(47);
    for (const f of fields) expect(f.acroField.getWidgets().length).toBe(1);

    // Deleting the only page that carries the form removes the fields.
    const formPlusBlank = await insertPdfPages(await makeDoc(1), 1, fixture(FORM));
    expect((await fieldNames(formPlusBlank.bytes)).length).toBe(47);
    const stripped = await deletePdfPages(formPlusBlank.bytes, [1]);
    const sdoc = await PDFLib.load(stripped);
    const af = sdoc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    expect((af.lookup(PDFName.of('Fields'), PDFArray)).size()).toBe(0);
  });

  it('rotate / move / crop keep all 47 fields', async () => {
    let bytes = await duplicatePdfPages(fixture(FORM), [0]);
    bytes = await rotatePdfPages(bytes, [0, 1], 90);
    bytes = await movePdfPages(bytes, [1], 0);
    bytes = await setPdfPageCrop(bytes, [0, 1], { top: 10, right: 10, bottom: 10, left: 10 });
    expect((await fieldNames(bytes)).length).toBe(47);
  });
});

describe('crop (CropBox; MediaBox untouched)', () => {
  it('sets the CropBox from displayed margins on invoice.pdf and keeps the MediaBox', async () => {
    const out = await setPdfPageCrop(fixture('invoice.pdf'), [0], { top: 36, right: 18, bottom: 72, left: 54 });
    const doc = await PDFLib.load(out);
    expect(cropArray(doc, 0)).toEqual([54, 72, 594, 756]);
    const m = doc.getPage(0).getMediaBox();
    expect([m.x, m.y, m.width, m.height]).toEqual([0, 0, 612, 792]);
    const [geo] = await readPageGeometries(out);
    expect([geo.width, geo.height]).toEqual([540, 684]);
    // pdf.js renders exactly the cropped size.
    const vp = (await (await pdfjsDoc(out)).getPage(1)).getViewport({ scale: 1 });
    expect([vp.width, vp.height]).toEqual([540, 684]);
  });

  it('null margins reset the crop to the full MediaBox', async () => {
    const cropped = await setPdfPageCrop(fixture('invoice.pdf'), [0], { top: 100, right: 0, bottom: 0, left: 0 });
    const reset = await setPdfPageCrop(cropped, [0], null);
    expect(cropArray(await PDFLib.load(reset), 0)).toEqual([0, 0, 612, 792]);
  });

  it('applies to a range, only to the listed pages', async () => {
    const out = await setPdfPageCrop(fixture('announcement.pdf'), [0, 2], { top: 10, right: 10, bottom: 10, left: 10 });
    const geos = await readPageGeometries(out);
    expect(geos.map((g) => [g.width, g.height])).toEqual([[592, 772], [612, 792], [592, 772]]);
  });

  it('refuses a crop smaller than MIN_CROP_SIZE and negative margins', async () => {
    await expect(setPdfPageCrop(fixture('invoice.pdf'), [0], { top: 400, right: 0, bottom: 390, left: 0 }))
      .rejects.toThrow(new RegExp(`at least ${MIN_CROP_SIZE}`));
    await expect(setPdfPageCrop(fixture('invoice.pdf'), [0], { top: -1, right: 0, bottom: 0, left: 0 }))
      .rejects.toThrow(/≥ 0/);
  });

  it.each([0, 90, 180, 270])('margins are DISPLAY-relative under /Rotate %i (checked against pdf.js)', async (rot) => {
    const rotated = await setPdfPageRotation(fixture('invoice.pdf'), 0, rot);
    const margins = { top: 30, right: 20, bottom: 50, left: 40 };
    const out = await setPdfPageCrop(rotated, [0], margins);
    const before = (await (await pdfjsDoc(rotated)).getPage(1)).getViewport({ scale: 1 });
    const after = (await (await pdfjsDoc(out)).getPage(1)).getViewport({ scale: 1 });
    // The crop's displayed top-left / bottom-right are the same user-space points.
    const tl0 = before.convertToPdfPoint(margins.left, margins.top);
    const tl1 = after.convertToPdfPoint(0, 0);
    const br0 = before.convertToPdfPoint(before.width - margins.right, before.height - margins.bottom);
    const br1 = after.convertToPdfPoint(after.width, after.height);
    for (const [a, b] of [[tl0, tl1], [br0, br1]]) {
      expect(a[0]).toBeCloseTo(b[0], 3);
      expect(a[1]).toBeCloseTo(b[1], 3);
    }
    expect(after.width).toBeCloseTo(before.width - 60, 3);
    expect(after.height).toBeCloseTo(before.height - 80, 3);
  });

  it('userBoxToMargins inverts marginsToUserBox for every rotation', () => {
    const media = { x: 10, y: 20, width: 600, height: 800 };
    const m = { top: 1, right: 2, bottom: 3, left: 4 };
    for (const r of [0, 90, 180, 270]) {
      expect(userBoxToMargins(media, r, marginsToUserBox(media, r, m))).toEqual(m);
    }
  });

  it('save pipeline writes annotations on a cropped page at the right place', async () => {
    // Crop 54pt off the left and 36pt off the top, then place a 20x10 shape at
    // viewer (10,10) — it must land at user x=64, top=792-36-10.
    const cropped = await setPdfPageCrop(fixture('invoice.pdf'), [0], { top: 36, right: 0, bottom: 72, left: 54 });
    const [geo] = await readPageGeometries(cropped);
    const page: PDFPage = {
      index: 0, width: geo.width, height: geo.height, rotation: 0, textItems: [], textEdits: [],
      annotations: [{
        id: 's1', type: 'shape', pageIndex: 1, shapeType: 'rectangle',
        position: { x: 10, y: 10 }, size: { width: 20, height: 10 },
        strokeColor: '#ff0000', fillColor: '#00ff00', strokeWidth: 1, opacity: 1,
      }],
    };
    const out = await applyEditsAndAnnotations({ pdfData: cropped, pages: [page], annotationStorage: null, formFieldMappings: [] });
    // The appended annotation stream (last /Contents entry) must translate by
    // the crop origin and draw the rectangle in crop-local coordinates.
    const doc = await PDFLib.load(out);
    const contents = doc.getPage(0).node.lookup(PDFName.of('Contents'), PDFArray);
    const last = contents.lookup(contents.size() - 1) as PDFRawStream;
    const text = new TextDecoder('latin1').decode(decodePDFRawStream(last).decode());
    expect(text).toMatch(/1 0 0 1 54 72 cm/);
    expect(text.indexOf('1 0 0 1 54 72 cm')).toBeLessThan(text.search(/ re\b/));
    expect(text).toMatch(new RegExp(`\\b10(\\.0+)? ${geo.height - 20}(\\.0+)? 20(\\.0+)? 10(\\.0+)? re\\b`));
    // And the same annotation on an UNcropped page gets no translation at all.
    const plain = await applyEditsAndAnnotations({ pdfData: fixture('invoice.pdf'), pages: [{ ...page, width: 612, height: 792 }], annotationStorage: null, formFieldMappings: [] });
    const pc = (await PDFLib.load(plain)).getPage(0).node.lookup(PDFName.of('Contents'), PDFArray);
    const plainText = new TextDecoder('latin1').decode(decodePDFRawStream(pc.lookup(pc.size() - 1) as PDFRawStream).decode());
    expect(plainText).not.toMatch(/1 0 0 1 [\d.]+ [\d.]+ cm/);
    expect(plainText).toMatch(/\b10(\.0+)? 772(\.0+)? 20(\.0+)? 10(\.0+)? re\b/);
  });
});

describe('insert pages from another PDF', () => {
  it('inserts all pages at a position (invoice + announcement)', async () => {
    const { bytes, inserted } = await insertPdfPages(fixture('invoice.pdf'), 1, fixture('announcement.pdf'));
    const doc = await PDFLib.load(bytes);
    expect(doc.getPageCount()).toBe(4);
    expect(inserted.length).toBe(3);
    expect(inserted.map((g) => [g.width, g.height])).toEqual([[612, 792], [612, 792], [612, 792]]);
    const pj = await pdfjsDoc(bytes);
    const text = async (n: number) => (await (await pj.getPage(n)).getTextContent()).items.map((i: any) => i.str).join(' ');
    const announce1 = (await (await (await pdfjsDoc(fixture('announcement.pdf'))).getPage(1)).getTextContent()).items.map((i: any) => i.str).join(' ');
    expect(await text(2)).toBe(announce1);
  });

  it('registers the inserted form fields in the target AcroForm', async () => {
    const { bytes } = await insertPdfPages(fixture('invoice.pdf'), 0, fixture(FORM));
    expect(await fieldNames(bytes)).toEqual(await fieldNames(fixture(FORM)));
    const doc = await PDFLib.load(bytes);
    const dr = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict).lookupMaybe(PDFName.of('DR'), PDFDict);
    expect(dr).toBeDefined();
  });

  it('keeps both forms independent when names collide', async () => {
    const { bytes } = await insertPdfPages(fixture(FORM), 1, fixture(FORM));
    const names = await fieldNames(bytes);
    expect(names.length).toBe(94);
    expect(new Set(names).size).toBe(94);
    const original = await fieldNames(fixture(FORM));
    for (const n of original) expect(names).toContain(`${n}_2`);
  });

  it('rejects an encrypted source with a clear error', async () => {
    await expect(insertPdfPages(fixture('invoice.pdf'), 0, fixture('encrypted-sample.pdf'))).rejects.toBeInstanceOf(EncryptedSourceError);
    await expect(insertPdfPages(fixture('invoice.pdf'), 0, fixture('encrypted-sample.pdf'))).rejects.toThrow(/password-protected/);
  });

  it('rejects a non-PDF source', async () => {
    await expect(insertPdfPages(fixture('invoice.pdf'), 0, new TextEncoder().encode('not a pdf'))).rejects.toThrow(/not a readable PDF/);
  });

  it('rejects an out-of-range position', async () => {
    await expect(insertPdfPages(fixture('invoice.pdf'), 5, fixture('invoice.pdf'))).rejects.toThrow(/out of range/);
  });
});

describe('replace page', () => {
  it('replaces in place, scales to the original size and keeps the page count', async () => {
    const { bytes, geometry } = await replacePdfPage(fixture('announcement.pdf'), 1, fixture('cleaning-services.pdf'));
    const doc = await PDFLib.load(bytes);
    expect(doc.getPageCount()).toBe(3);
    expect([geometry.width, geometry.height]).toEqual([612, 792]);
    expect(cropArray(doc, 1)).toEqual([0, 0, 612, 792]);
  });
});

describe('page model ops', () => {
  const page = (i: number): PDFPage => ({
    index: i, width: 100 + i, height: 200, rotation: 0, textEdits: [{ itemId: `t${i}`, pageIndex: i, originalText: 'a', newText: 'b' }],
    textItems: [{ id: `t${i}`, str: 'a', originalStr: 'a', x: 5, y: 6, width: 1, height: 1, fontName: 'f', fontSize: 10, transform: [10, 0, 0, 10, 5, 6], isEdited: true }],
    annotations: [{ id: `n${i}`, type: 'note', pageIndex: i + 1, position: { x: 1, y: 2 }, content: '', color: '#fff' }],
  });

  it('reorderPageModel mirrors the byte order, copies get fresh ids and re-pointed edits', () => {
    const pages = [page(0), page(1)];
    const out = reorderPageModel(pages, [1, 0, 0]);
    expect(out.map((p) => p.width)).toEqual([101, 100, 100]);
    expect(out.map((p) => p.index)).toEqual([0, 1, 2]);
    expect(out[2].annotations[0].id).not.toBe(out[1].annotations[0].id);
    expect(out[2].textEdits![0].itemId).toBe(out[2].textItems![0].id);
    expect(out[1]).toMatchObject({ annotations: pages[0].annotations });
  });

  it('rotatePageModel swaps the displayed size on quarter turns', () => {
    expect(rotatePageModel(page(0), 90)).toMatchObject({ rotation: 90, width: 200, height: 100 });
    expect(rotatePageModel(page(0), 180)).toMatchObject({ rotation: 180, width: 100, height: 200 });
    expect(rotatePageModel({ ...page(0), rotation: 90 }, -90).rotation).toBe(0);
  });

  it('cropPageModel keeps annotations over the same content', () => {
    const before = { x: 0, y: 0, width: 612, height: 792 };
    const after = { width: 540, height: 684, rotation: 0, box: { x: 54, y: 72, width: 540, height: 684 }, mediaBox: before };
    const out = cropPageModel(page(0), before, after);
    // Left edge moved right 54, top edge moved down 36.
    expect((out.annotations[0] as any).position).toEqual({ x: 1 - 54, y: 2 - 36 });
    expect(out.textItems![0]).toMatchObject({ x: 5 - 54, y: 6 - 36 });
    expect([out.width, out.height]).toEqual([540, 684]);
  });
});

describe('selection model', () => {
  it('plain, ctrl and shift clicks', () => {
    expect(nextSelection([2], 2, 4, { ctrl: false, shift: false }, 6)).toEqual({ selected: [4], anchor: 4 });
    expect(nextSelection([2], 2, 4, { ctrl: true, shift: false }, 6).selected).toEqual([2, 4]);
    expect(nextSelection([2, 4], 4, 2, { ctrl: true, shift: false }, 6).selected).toEqual([4]);
    expect(nextSelection([1], 1, 4, { ctrl: false, shift: true }, 6).selected).toEqual([1, 2, 3, 4]);
    expect(nextSelection([0], 3, 1, { ctrl: true, shift: true }, 6).selected).toEqual([0, 1, 2, 3]);
  });
  it('page range strings round-trip', () => {
    expect(parsePageRange('1, 3, 5-7', 8)).toEqual([0, 2, 4, 5, 6]);
    expect(parsePageRange('0', 3)).toBeNull();
    expect(parsePageRange('2-9', 3)).toBeNull();
    expect(parsePageRange('a', 3)).toBeNull();
    expect(formatPageRange([6, 0, 4, 5, 2])).toBe('1,3,5-7');
  });
  it('drop gap from thumbnail half', () => {
    expect(dropGap(3, true)).toBe(3);
    expect(dropGap(3, false)).toBe(4);
  });
});
