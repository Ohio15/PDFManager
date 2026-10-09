/**
 * PDF-to-Word image extraction of an /Indexed image: the colour lookup table
 * is decoded (a Flate stream, or a hex string's bytes), not read as its
 * encoded bytes, so the extracted PNG has the palette's real colours.
 */
import { describe, it, expect } from 'vitest';
import * as pako from 'pako';
import { PDFDocument, PDFHexString, PDFName, PDFRawStream, type PDFObject } from 'pdf-lib';
import { _testExports } from '../PageAnalyzer';

const RED = [255, 0, 0];
const BLUE = [0, 0, 255];

/** Pixels of a PNG as RGB triples (handles RGB / RGBA, all five row filters). */
function pngPixels(png: Uint8Array): number[][] {
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const idat: Uint8Array[] = [];
  while (pos < png.length) {
    const len = view.getUint32(pos);
    const type = String.fromCharCode(...png.subarray(pos + 4, pos + 8));
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = view.getUint32(pos + 8);
      height = view.getUint32(pos + 12);
      colorType = png[pos + 17];
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const raw = pako.inflate(Uint8Array.from(idat.flatMap((c) => Array.from(c))));
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  const out = new Uint8Array(height * stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= bpp ? out[y * stride + x - bpp] : 0;
      const b = y > 0 ? out[(y - 1) * stride + x] : 0;
      const c = x >= bpp && y > 0 ? out[(y - 1) * stride + x - bpp] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      out[y * stride + x] = (v + [0, a, b, (a + b) >> 1, pr][f]) & 0xff;
    }
  }
  const pixels: number[][] = [];
  for (let i = 0; i < width * height; i++) pixels.push(Array.from(out.subarray(i * bpp, i * bpp + 3)));
  return pixels;
}

async function indexedImagePdf(lookup: (doc: PDFDocument) => PDFObject) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([100, 100]);
  const image = PDFRawStream.of(
    doc.context.obj({
      Type: 'XObject', Subtype: 'Image', Width: 2, Height: 1, BitsPerComponent: 8, Filter: 'FlateDecode',
      ColorSpace: [PDFName.of('Indexed'), PDFName.of('DeviceRGB'), 1, lookup(doc)],
    }),
    pako.deflate(Uint8Array.of(0, 1))
  );
  page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: { Im0: doc.context.register(image) } }));
  return doc;
}

describe('Indexed palette decoding in PDF-to-Word image extraction', () => {
  it('decodes a Flate-encoded lookup stream', async () => {
    const doc = await indexedImagePdf((d) =>
      d.context.register(PDFRawStream.of(d.context.obj({ Filter: 'FlateDecode' }), pako.deflate(Uint8Array.from([...RED, ...BLUE]))))
    );
    const out = _testExports.extractImageData(doc, 0, 'Im0');
    expect(out?.mimeType).toBe('image/png');
    expect(pngPixels(out!.data)).toEqual([RED, BLUE]);
  });

  it('uses a hex-string lookup table as bytes', async () => {
    const doc = await indexedImagePdf(() => PDFHexString.of('FF00000000FF'));
    const out = _testExports.extractImageData(doc, 0, 'Im0');
    expect(pngPixels(out!.data)).toEqual([RED, BLUE]);
  });
});
