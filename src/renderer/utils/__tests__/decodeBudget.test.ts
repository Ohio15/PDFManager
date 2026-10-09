/**
 * Decode bounds at the boundaries an attacker reaches: every filter chain is
 * capped while it runs, every decode of one document draws on one budget,
 * pdf-lib's load-time object-stream decode is bounded, and an overflow fails
 * the operation with DecodeLimitError instead of handing back encoded bytes.
 *
 * The crafted streams are real Flate data that expands to the sizes named;
 * the limits under test are the production constants.
 */
import { describe, it, expect } from 'vitest';
import * as pako from 'pako';
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from 'pdf-lib';
import {
  DecodeLimitError,
  MAX_DECODED_STREAM_BYTES,
  MAX_DOCUMENT_DECODED_BYTES,
  decodeBudgetFor,
  decodeRawStreamBounded,
} from '../boundedDecode';
import { decodeStream, updateStream } from '../pdfStreamUtils';
import { blankTextInContentStream } from '../blankText';
import { compressPdf, type ImageRecodec } from '../compress';

const MB = 1024 * 1024;
const latin1 = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const hex = (bytes: Uint8Array) => latin1(Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('') + '>');

/** Flate data that inflates to `size` bytes of PDF whitespace (zero bytes). */
const bombCache = new Map<number, Uint8Array>();
function zeroBomb(size: number): Uint8Array {
  let b = bombCache.get(size);
  if (!b) {
    b = pako.deflate(new Uint8Array(size));
    bombCache.set(size, b);
  }
  return b;
}

describe('decodeRawStreamBounded: every filter chain is capped while it runs', () => {
  it('caps FlateDecode with /DecodeParms (formerly decoded by pdf-lib with no cap)', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({ Filter: 'FlateDecode', DecodeParms: { Predictor: 1 } });
    const stream = PDFRawStream.of(dict, zeroBomb(8 * MB));
    let err: unknown;
    try {
      decodeRawStreamBounded(stream, 1 * MB);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeLimitError);
    expect((err as DecodeLimitError).scope).toBe('stream');
    // Stopped part-way: the budget saw about the cap, not the full 8 MB.
    expect(decodeBudgetFor(doc.context).consumed).toBeLessThan(2 * MB);
  });

  it('caps a multi-filter chain [/ASCIIHexDecode /FlateDecode]', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({ Filter: ['ASCIIHexDecode', 'FlateDecode'] });
    const stream = PDFRawStream.of(dict, hex(zeroBomb(8 * MB)));
    expect(() => decodeRawStreamBounded(stream, 1 * MB)).toThrow(DecodeLimitError);
    expect(decodeBudgetFor(doc.context).consumed).toBeLessThan(3 * MB);
  });

  it('caps a doubled Flate chain [/FlateDecode /FlateDecode]', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({ Filter: ['FlateDecode', 'FlateDecode'] });
    const stream = PDFRawStream.of(dict, pako.deflate(zeroBomb(64 * MB)));
    expect(() => decodeRawStreamBounded(stream, 1 * MB)).toThrow(DecodeLimitError);
  });

  it('decodes a legitimate multi-filter, predicted stream exactly', async () => {
    const doc = await PDFDocument.create();
    // Two rows of 4 bytes, PNG "Up" filter (type 2) on the second row.
    const rows = [Uint8Array.of(10, 20, 30, 40), Uint8Array.of(11, 22, 33, 44)];
    const predicted = Uint8Array.of(0, ...rows[0], 2, 1, 2, 3, 4);
    const dict = doc.context.obj({
      Filter: ['ASCIIHexDecode', 'FlateDecode'],
      DecodeParms: [null, { Predictor: 12, Columns: 4 }],
    });
    const stream = PDFRawStream.of(dict, hex(pako.deflate(predicted)));
    expect(Array.from(decodeRawStreamBounded(stream))).toEqual([...rows[0], ...rows[1]]);
  });
});

describe('predictor row geometry cannot drive allocation', () => {
  it('a 2-byte stream claiming 1 GiB rows (/Colors 32 /BitsPerComponent 16 /Columns 16777216) allocates at most its input', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({
      Filter: 'FlateDecode',
      DecodeParms: { Predictor: 12, Colors: 32, BitsPerComponent: 16, Columns: 16777216 },
    });
    const stream = PDFRawStream.of(dict, pako.deflate(Uint8Array.of(0, 7))); // decodes to 2 bytes
    const out = decodeRawStreamBounded(stream);
    expect(Array.from(out)).toEqual([7]);
    // The backing allocation, not just the view, is bounded by the input.
    expect(out.buffer.byteLength).toBeLessThanOrEqual(2);
    // Inflate (2 bytes) + predictor output (1 byte) charged; nothing near 1 GiB.
    expect(decodeBudgetFor(doc.context).consumed).toBe(3);
  });

  it('TIFF predictor output stays the size of its input', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({
      Filter: 'FlateDecode',
      DecodeParms: { Predictor: 2, Colors: 32, BitsPerComponent: 16, Columns: 16777216 },
    });
    const out = decodeRawStreamBounded(PDFRawStream.of(dict, pako.deflate(Uint8Array.of(1, 2))));
    expect(out.buffer.byteLength).toBeLessThanOrEqual(2);
  });
});

describe('per-document decode budget', () => {
  it('is shared by every decode of one document: the same stream decoded repeatedly runs it out', async () => {
    const doc = await PDFDocument.create();
    const size = MAX_DECODED_STREAM_BYTES - MB; // just under the per-stream cap
    const stream = PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), zeroBomb(size));
    const allowed = Math.floor(MAX_DOCUMENT_DECODED_BYTES / size);
    for (let i = 0; i < allowed; i++) expect(decodeStream(stream)?.length).toBe(size);
    let err: unknown;
    try {
      decodeStream(stream);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(DecodeLimitError);
    expect((err as DecodeLimitError).scope).toBe('document');
    // A different document has its own budget.
    const other = await PDFDocument.create();
    const fresh = PDFRawStream.of(other.context.obj({ Filter: 'FlateDecode' }), zeroBomb(size));
    expect(decodeStream(fresh)?.length).toBe(size);
  }, 120_000);
});

describe('decodeStream never returns encoded bytes as decoded', () => {
  it('throws on overflow and returns null for an undecodable filter', async () => {
    const doc = await PDFDocument.create();
    const bomb = PDFRawStream.of(doc.context.obj({ Filter: 'FlateDecode' }), zeroBomb(MAX_DECODED_STREAM_BYTES + MB));
    expect(() => decodeStream(bomb)).toThrow(DecodeLimitError);
    const jpeg = PDFRawStream.of(doc.context.obj({ Filter: 'DCTDecode' }), Uint8Array.of(0xff, 0xd8, 1, 2));
    expect(decodeStream(jpeg)).toBeNull();
  });

  it('updateStream drops the old chain parameters when it rewrites a stream as plain Flate', async () => {
    const doc = await PDFDocument.create();
    const stream = PDFRawStream.of(
      doc.context.obj({ Filter: 'FlateDecode', DecodeParms: { Predictor: 12, Columns: 4 } }),
      pako.deflate(Uint8Array.of(0, 1, 2, 3, 4))
    );
    updateStream(stream, 'BT ET', doc);
    expect(stream.dict.has(PDFName.of('DecodeParms'))).toBe(false);
    expect(new TextDecoder('latin1').decode(decodeStream(stream)!)).toBe('BT ET');
  });
});

/** A one-page PDF whose page content is `contents` (already encoded) under `dict`. */
async function pdfWithPageContent(dict: Record<string, unknown>, contents: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const page = doc.addPage([200, 200]);
  const ref = doc.context.register(PDFRawStream.of(doc.context.obj(dict as never) as unknown as PDFDict, contents));
  page.node.set(PDFName.of('Contents'), ref);
  return doc.save();
}

describe('operations fail with DecodeLimitError at the boundary', () => {
  it('text editing (blank pass of the save pipeline) rejects a parameterised Flate bomb instead of editing raw bytes', async () => {
    const bytes = await pdfWithPageContent(
      { Filter: 'FlateDecode', DecodeParms: { Predictor: 1 } },
      zeroBomb(MAX_DECODED_STREAM_BYTES + MB)
    );
    const doc = await PDFDocument.load(bytes);
    await expect(blankTextInContentStream(doc, 0, 'secret')).rejects.toBeInstanceOf(DecodeLimitError);
  });

  it('compress (image placement scan) stops once the document budget is spent across distinct Form XObjects', async () => {
    const doc = await PDFDocument.create();
    const page = doc.addPage([200, 200]);
    const size = MAX_DECODED_STREAM_BYTES - MB;
    const forms = Math.floor(MAX_DOCUMENT_DECODED_BYTES / size) + 1;
    const xobjects = doc.context.obj({}) as PDFDict;
    let paint = '';
    for (let i = 0; i < forms; i++) {
      const form = PDFRawStream.of(
        // A two-filter chain: recompressStreams skips it, so only the
        // placement scan's decode can spend the budget here.
        doc.context.obj({ Type: 'XObject', Subtype: 'Form', BBox: [0, 0, 1, 1], Filter: ['ASCIIHexDecode', 'FlateDecode'] }),
        hex(zeroBomb(size))
      );
      xobjects.set(PDFName.of(`Fm${i}`), doc.context.register(form));
      paint += `/Fm${i} Do\n`;
    }
    page.node.set(PDFName.of('Resources'), doc.context.obj({ XObject: xobjects }));
    page.node.set(PDFName.of('Contents'), doc.context.register(PDFRawStream.of(doc.context.obj({}), latin1(paint))));
    const bytes = await doc.save();
    const codec: ImageRecodec = {
      recode: async () => { throw new Error('codec must not be reached'); },
    };
    const err = await compressPdf(bytes, { lossy: { targetDpi: 150, jpegQuality: 0.8 } }, codec).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DecodeLimitError);
    expect((err as DecodeLimitError).scope).toBe('document');
    expect((err as Error).message).toMatch(/safety limit/);
  }, 120_000);
});

describe('PDFDocument.load: pdf-lib object-stream decoding is bounded', () => {
  it('rejects an object stream that expands past the per-stream cap', async () => {
    // Hand-built file: obj 1 is an ObjStm whose Flate data (with /DecodeParms,
    // which pdf-lib would decode with no cap) inflates past 128 MB.
    const objStm = zeroBomb(MAX_DECODED_STREAM_BYTES + MB);
    const head = latin1('%PDF-1.7\n1 0 obj\n<< /Type /ObjStm /N 1 /First 4 /Filter /FlateDecode /DecodeParms << /Predictor 1 >> /Length ' + objStm.length + ' >>\nstream\n');
    const tail = latin1('\nendstream\nendobj\n2 0 obj\n<< /Type /Catalog /Pages 3 0 R >>\nendobj\n3 0 obj\n<< /Type /Pages /Kids [] /Count 0 >>\nendobj\ntrailer\n<< /Root 2 0 R /Size 4 >>\n%%EOF\n');
    const file = new Uint8Array(head.length + objStm.length + tail.length);
    file.set(head, 0);
    file.set(objStm, head.length);
    file.set(tail, head.length + objStm.length);
    await expect(PDFDocument.load(file)).rejects.toBeInstanceOf(DecodeLimitError);
  });

  it('still loads documents that use object and cross-reference streams', async () => {
    const doc = await PDFDocument.create();
    doc.addPage([100, 100]);
    doc.addPage([100, 100]);
    const saved = await doc.save({ useObjectStreams: true });
    const reloaded = await PDFDocument.load(saved);
    expect(reloaded.getPageCount()).toBe(2);
    const refs = reloaded.getPages().map((p) => p.ref);
    expect(refs.every((r) => r instanceof PDFRef)).toBe(true);
    expect(reloaded.catalog.lookup(PDFName.of('Pages'))).toBeInstanceOf(PDFDict);
    expect(PDFArray).toBeDefined();
  });
});
