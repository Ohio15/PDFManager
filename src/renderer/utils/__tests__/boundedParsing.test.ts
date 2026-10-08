/**
 * Hostile-input bounds: each limit must turn an attack shape into a clean,
 * caught failure (which callers treat as "not examined"), not a hang, an
 * out-of-memory, or a stack overflow.
 */
import { describe, it, expect } from 'vitest';
import * as pako from 'pako';
import { PDFDocument, PDFName, PDFRawStream } from 'pdf-lib';
import { inflateCapped, decodeRawStreamBounded } from '../boundedDecode';
import { parseContent, ContentParseError } from '../redaction/contentTokenizer';

describe('inflateCapped', () => {
  it('round-trips data under the cap', () => {
    const data = new TextEncoder().encode('BT /F1 12 Tf (hello) Tj ET\n'.repeat(100));
    expect(inflateCapped(pako.deflate(data), 1 << 20)).toEqual(data);
  });

  it('rejects a Flate bomb before expanding it', () => {
    const bomb = pako.deflate(new Uint8Array(64 * 1024 * 1024)); // ~64 KB -> 64 MB
    expect(bomb.length).toBeLessThan(200 * 1024);
    expect(() => inflateCapped(bomb, 1024 * 1024)).toThrow(/exceeds/);
  });

  it('rejects corrupt data', () => {
    expect(() => inflateCapped(new Uint8Array([1, 2, 3, 4, 5]), 1 << 20)).toThrow();
  });
});

describe('decodeRawStreamBounded', () => {
  it('caps a FlateDecode stream', async () => {
    const doc = await PDFDocument.create();
    const dict = doc.context.obj({ Filter: 'FlateDecode' });
    const stream = PDFRawStream.of(dict, pako.deflate(new Uint8Array(4 * 1024 * 1024)));
    expect(() => decodeRawStreamBounded(stream, 1024 * 1024)).toThrow(/exceeds/);
    expect(decodeRawStreamBounded(stream, 8 * 1024 * 1024).length).toBe(4 * 1024 * 1024);
  });

  it('caps an unfiltered stream', async () => {
    const doc = await PDFDocument.create();
    const stream = PDFRawStream.of(doc.context.obj({}), new Uint8Array(2048));
    expect(() => decodeRawStreamBounded(stream, 1024)).toThrow(/exceeds/);
    expect(stream.dict.has(PDFName.of('Filter'))).toBe(false);
  });
});

describe('content tokenizer nesting', () => {
  it('turns pathological operand nesting into ContentParseError, not a stack overflow', () => {
    const deep = new TextEncoder().encode('['.repeat(100_000) + ' ] TJ');
    expect(() => parseContent(deep)).toThrow(ContentParseError);
  });

  it('still parses ordinary nested operands', () => {
    const ops = parseContent(new TextEncoder().encode('/P << /MCID 0 /A [1 [2 3]] >> BDC [(a) -120 (b)] TJ EMC'));
    expect(ops.map((o) => o.op)).toEqual(['BDC', 'TJ', 'EMC']);
  });
});
