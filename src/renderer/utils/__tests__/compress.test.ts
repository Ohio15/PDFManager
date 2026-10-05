import { describe, it, expect } from 'vitest';
import * as pako from 'pako';
import { PDFDocument, PDFName, PDFRawStream, PDFNumber, PDFArray } from 'pdf-lib';
import { compressPdf, readJpegInfo, undoPredictor, ImageRecodec, RecodeRequest } from '../compress';
import { fixture, allText, openPdfJs } from './formsFinalizeHelpers';

async function reopens(bytes: Uint8Array): Promise<number> {
  const pdf = await openPdfJs(bytes);
  try {
    for (let i = 1; i <= pdf.numPages; i++) await (await pdf.getPage(i)).getOperatorList();
    return pdf.numPages;
  } finally {
    await pdf.destroy();
  }
}

/** The real 8×8 greyscale JPEG embedded in test-with-images.pdf. */
async function fixtureJpeg(): Promise<Uint8Array> {
  const doc = await PDFDocument.load(fixture('test-with-images.pdf'));
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (obj instanceof PDFRawStream && obj.dict.lookup(PDFName.of('Filter'))?.toString() === '/DCTDecode') return obj.contents;
  }
  throw new Error('fixture JPEG not found');
}

describe('compress: lossless', () => {
  it('scan-document.pdf: smaller, same page count, same text, reopens', async () => {
    const input = fixture('scan-document.pdf');
    const result = await compressPdf(input);
    expect(result.improved).toBe(true);
    expect(result.bytes.length).toBeLessThan(input.length);
    expect(result.compressedSize).toBe(result.bytes.length);
    expect(await reopens(result.bytes)).toBe(9);
    expect(await allText(result.bytes)).toBe(await allText(input));
  });

  it('repair-calibration-form.pdf: drops unused objects and duplicates, keeps every field and all text', async () => {
    const input = fixture('repair-calibration-form.pdf');
    const result = await compressPdf(input);
    expect(result.bytes.length).toBeLessThan(input.length * 0.9);
    expect(result.removedObjects).toBeGreaterThan(0);
    expect(result.dedupedObjects).toBeGreaterThan(0);
    expect(await reopens(result.bytes)).toBe(1);
    expect(await allText(result.bytes)).toBe(await allText(input));
    expect((await PDFDocument.load(result.bytes)).getForm().getFields()).toHaveLength(47);
  });

  it('invoice.pdf and announcement.pdf: smaller with identical text', async () => {
    for (const name of ['invoice.pdf', 'announcement.pdf']) {
      const input = fixture(name);
      const result = await compressPdf(input);
      expect(result.bytes.length, name).toBeLessThan(input.length);
      expect(await allText(result.bytes), name).toBe(await allText(input));
    }
  });

  it('test-with-images.pdf is already minimal: reported as not improved and returned unchanged, never larger', async () => {
    const input = fixture('test-with-images.pdf');
    const result = await compressPdf(input);
    expect(result.improved).toBe(false);
    expect(result.bytes).toBe(input);
    expect(result.compressedSize).toBe(input.length);
    expect(await reopens(result.bytes)).toBe(1);
  });
});

describe('compress: lossy image pass', () => {
  it('measures effective DPI from page placement and only touches images above the target', async () => {
    const calls: RecodeRequest[] = [];
    const jpeg = await fixtureJpeg();
    // Test double: records requests, answers with a real (8×8 grey) JPEG so the
    // replacement path is exercised end to end. The canvas encoder itself is
    // covered by the Electron e2e spec.
    const codec: ImageRecodec = { recode: async (req) => { calls.push(req); return jpeg; } };

    const input = fixture('scan-document.pdf');
    const result = await compressPdf(input, { lossy: { targetDpi: 150, jpegQuality: 0.7 } }, codec);
    expect(result.images).toHaveLength(9);
    for (const img of result.images) {
      expect(img.effectiveDpi).toBeGreaterThan(280);
      expect(img.effectiveDpi).toBeLessThan(320);
      expect(img.action).toBe('downsampled');
    }
    expect(calls).toHaveLength(9);
    for (const call of calls) {
      expect(call.source.kind).toBe('jpeg');
      expect(call.quality).toBeCloseTo(0.7);
      // 2526 px at ~297 DPI → ~150 DPI
      expect(call.targetWidth).toBeGreaterThan(1200);
      expect(call.targetWidth).toBeLessThan(1350);
    }
    // Dictionary follows the encoded JPEG, not the request.
    const doc = await PDFDocument.load(result.bytes);
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream) || obj.dict.lookup(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
      expect((obj.dict.lookup(PDFName.of('Width')) as PDFNumber).asNumber()).toBe(8);
      expect(obj.dict.lookup(PDFName.of('ColorSpace'))?.toString()).toBe('/DeviceGray');
    }
    expect(doc.getPageCount()).toBe(9);
    expect(await reopens(result.bytes)).toBe(9);
    expect(result.bytes.length).toBeLessThan(input.length / 10);

    // Below target: nothing re-encoded.
    calls.length = 0;
    const high = await compressPdf(input, { lossy: { targetDpi: 300, jpegQuality: 0.7 } }, codec);
    expect(calls).toHaveLength(0);
    expect(high.images.every((i) => i.action === 'unchanged')).toBe(true);
  });

  it('skips and reports colour spaces and encodings it cannot re-encode faithfully', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const ctx = doc.context;
    const big = (n: number) => new Uint8Array(n).fill(128);
    const mk = (dict: Record<string, unknown>, data: Uint8Array) =>
      ctx.register(ctx.stream(data, { Type: 'XObject', Subtype: 'Image', Width: 400, Height: 400, BitsPerComponent: 8, ...dict } as never));
    const cmyk = mk({ ColorSpace: 'DeviceCMYK', Filter: 'FlateDecode' }, pako.deflate(big(400 * 400 * 4)));
    const indexed = mk({ ColorSpace: ['Indexed', 'DeviceRGB', 1, ctx.obj([0, 0, 0, 255, 255, 255]) as never] as never, Filter: 'FlateDecode' }, pako.deflate(big(400 * 400)));
    const jbig2 = mk({ ColorSpace: 'DeviceGray', BitsPerComponent: 1, Filter: 'JBIG2Decode' }, big(100));
    const jpx = mk({ ColorSpace: 'DeviceRGB', Filter: 'JPXDecode' }, big(100));
    const smask = mk({ ColorSpace: 'DeviceGray', Filter: 'FlateDecode' }, pako.deflate(big(400 * 400)));
    const withSmask = mk({ ColorSpace: 'DeviceRGB', Filter: 'FlateDecode', SMask: smask }, pako.deflate(big(400 * 400 * 3)));
    const colorKey = mk({ ColorSpace: 'DeviceRGB', Filter: 'FlateDecode', Mask: [0, 10, 0, 10, 0, 10] as never }, pako.deflate(big(400 * 400 * 3)));
    const names = { Cm: cmyk, Ix: indexed, Jb: jbig2, Jp: jpx, Sm: withSmask, Ck: colorKey };
    page.node.set(PDFName.of('Resources'), ctx.obj({ XObject: names as never }));
    // Paint every image at 1 inch (400 px → 400 DPI).
    const ops = Object.keys(names).map((n) => `q 72 0 0 72 0 0 cm /${n} Do Q`).join('\n');
    page.node.set(PDFName.of('Contents'), ctx.register(ctx.flateStream(ops)));
    const bytes = new Uint8Array(await doc.save());

    const recoded: RecodeRequest[] = [];
    const jpeg = await fixtureJpeg();
    const codec: ImageRecodec = { recode: async (req) => { recoded.push(req); return jpeg; } };
    const result = await compressPdf(bytes, { lossy: { targetDpi: 150, jpegQuality: 0.8 } }, codec);
    const reason = (ref: { toString(): string }) => result.images.find((i) => i.ref === ref.toString());

    expect(reason(cmyk)?.reason).toMatch(/CMYK/);
    expect(reason(indexed)?.reason).toMatch(/Indexed/);
    expect(reason(jbig2)?.reason).toMatch(/JBIG2/);
    expect(reason(jpx)?.reason).toMatch(/JPEG 2000/);
    expect(reason(smask)?.reason).toMatch(/mask/);
    expect(reason(colorKey)?.reason).toMatch(/colour-key/);
    // The soft-masked RGB image is handled: decoded from Flate, re-encoded, mask kept.
    expect(reason(withSmask)?.action).toBe('downsampled');
    expect(recoded).toHaveLength(1);
    expect(recoded[0].source.kind).toBe('rgba');

    const out = await PDFDocument.load(result.bytes);
    const smasked = out.context.lookup(withSmask) as PDFRawStream;
    expect(smasked.dict.get(PDFName.of('SMask'))?.toString()).toBe(smask.toString());
    expect(smasked.dict.lookup(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode');
    // Untouched images keep their original encoding.
    expect((out.context.lookup(cmyk) as PDFRawStream).dict.lookup(PDFName.of('ColorSpace'))?.toString()).toBe('/DeviceCMYK');
    expect((out.context.lookup(indexed) as PDFRawStream).dict.lookup(PDFName.of('ColorSpace'))).toBeInstanceOf(PDFArray);
  });

  it('requires a re-encoder for lossy mode and a sane DPI', async () => {
    const input = fixture('test-with-images.pdf');
    await expect(compressPdf(input, { lossy: { targetDpi: 150, jpegQuality: 0.7 } })).rejects.toThrow(/re-encoder/);
    const codec: ImageRecodec = { recode: async () => new Uint8Array() };
    await expect(compressPdf(input, { lossy: { targetDpi: 5, jpegQuality: 0.7 } }, codec)).rejects.toThrow(/between/);
  });
});

describe('compress: decoding primitives', () => {
  it('reads JPEG SOF dimensions and components', async () => {
    expect(readJpegInfo(await fixtureJpeg())).toEqual({ width: 8, height: 8, components: 1 });
    expect(readJpegInfo(new Uint8Array([1, 2, 3, 4]))).toBeNull();
  });

  it('undoes PNG Sub/Up/Average/Paeth and TIFF predictors', () => {
    // 2×2 RGB rows: [10,20,30, 40,50,60] / [11,22,33, 44,55,66]
    const raw = [10, 20, 30, 40, 50, 60, 11, 22, 33, 44, 55, 66];
    const sub = new Uint8Array([1, 10, 20, 30, 30, 30, 30, 2, 1, 2, 3, 4, 5, 6]);
    expect(Array.from(undoPredictor(sub, 15, 3, 2)!)).toEqual(raw);
    const paethRow = new Uint8Array([0, 10, 20, 30, 40, 50, 60, 4, 1, 2, 3, 4, 5, 6]);
    expect(Array.from(undoPredictor(paethRow, 15, 3, 2)!)).toEqual(raw);
    const avg = new Uint8Array([0, 10, 20, 30, 40, 50, 60, 3, 6, 12, 18, 19, 19, 20]);
    expect(Array.from(undoPredictor(avg, 15, 3, 2)!)).toEqual(raw);
    const tiff = new Uint8Array([10, 20, 30, 30, 30, 30, 11, 22, 33, 33, 33, 33]);
    expect(Array.from(undoPredictor(tiff, 2, 3, 2)!)).toEqual(raw);
  });
});
