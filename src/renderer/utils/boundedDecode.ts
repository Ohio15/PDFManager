import * as pako from 'pako';
import { decodePDFRawStream, PDFArray, PDFName, PDFRawStream } from 'pdf-lib';

/**
 * Bounded stream decoding for untrusted PDFs. A few hundred bytes of Flate
 * data can expand to gigabytes ("Flate bomb"), which hangs or crashes the
 * renderer, so every decode of attacker-supplied content goes through a cap.
 */

/** Largest decoded stream accepted from an untrusted PDF. */
export const MAX_DECODED_STREAM_BYTES = 128 * 1024 * 1024;

/**
 * pako inflate with a hard output cap. Throws once the output would exceed
 * `maxBytes`; input is fed in slices so an overflow stops the work early
 * instead of after the whole bomb has been expanded.
 */
export function inflateCapped(data: Uint8Array, maxBytes: number): Uint8Array {
  const inflator = new pako.Inflate();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let overflow = false;
  inflator.onData = (chunk: Uint8Array) => {
    if (overflow) return;
    total += chunk.length;
    if (total > maxBytes) {
      overflow = true;
      return;
    }
    chunks.push(chunk);
  };
  const SLICE = 64 * 1024;
  for (let i = 0; i < data.length && !overflow; i += SLICE) {
    inflator.push(data.subarray(i, Math.min(i + SLICE, data.length)), i + SLICE >= data.length);
    if (inflator.err) throw new Error(inflator.msg || 'corrupt Flate data');
  }
  if (overflow) throw new Error(`Decoded stream exceeds ${maxBytes} bytes`);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

/**
 * Decode a raw stream with the output capped. Plain FlateDecode (the common
 * case, and the bomb vector) is inflated incrementally under the cap. Other
 * filter chains go through pdf-lib and are rejected afterwards if oversized;
 * that bounds what downstream code processes but not pdf-lib's own peak memory.
 * Throws on unsupported filters, corrupt data, or overflow.
 */
export function decodeRawStreamBounded(stream: PDFRawStream, maxBytes = MAX_DECODED_STREAM_BYTES): Uint8Array {
  const filter = stream.dict.lookup(PDFName.of('Filter'));
  const single = filter instanceof PDFName
    ? filter
    : filter instanceof PDFArray && filter.size() === 1 ? filter.lookup(0) : undefined;
  if (filter === undefined) {
    if (stream.contents.length > maxBytes) throw new Error(`Stream exceeds ${maxBytes} bytes`);
    return stream.contents;
  }
  if (single instanceof PDFName && single.decodeText() === 'FlateDecode' && !stream.dict.has(PDFName.of('DecodeParms'))) {
    return inflateCapped(stream.contents, maxBytes);
  }
  const decoded = decodePDFRawStream(stream).decode();
  if (decoded.length > maxBytes) throw new Error(`Decoded stream exceeds ${maxBytes} bytes`);
  return decoded;
}
