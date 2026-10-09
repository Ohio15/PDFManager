import * as pako from 'pako';
import {
  decodePDFRawStream,
  PDFArray,
  PDFDict,
  PDFName,
  PDFNumber,
  PDFDocument,
  PDFObjectStreamParser,
  PDFRawStream,
  PDFXRefStreamParser,
} from 'pdf-lib';

/**
 * Bounded stream decoding for untrusted PDFs.
 *
 * A few hundred bytes of compressed data can expand to gigabytes ("Flate
 * bomb"), and the same small stream can be referenced from thousands of
 * places, so two limits apply to every decode of attacker-supplied content:
 *
 *  - a per-stream cap on the decoded size of any one stream, enforced while
 *    each filter in the chain runs (every filter, every /DecodeParms), and
 *  - a per-document budget on the total bytes decoded, shared by every decode
 *    site in the app (page content, Form XObjects, fonts, images, recompress)
 *    and by pdf-lib's own object-stream decoding during PDFDocument.load.
 *
 * The budget is keyed on the document's PDFContext, so it lives exactly as
 * long as the loaded document; each operation loads its own document.
 *
 * Exceeding either limit throws DecodeLimitError. Nothing in this module ever
 * hands back still-encoded bytes as if they were decoded.
 */

/** Largest decoded stream accepted from an untrusted PDF. */
export const MAX_DECODED_STREAM_BYTES = 128 * 1024 * 1024;

/**
 * Total bytes the app will decode for one loaded document, across every
 * stream and every decode site. Bounds the work a hostile file can demand
 * (repeated references to one bomb, thousands of moderately sized bombs).
 */
export const MAX_DOCUMENT_DECODED_BYTES = 1024 * 1024 * 1024;

/** Longest filter chain accepted; real files use one or two filters. */
const MAX_FILTER_CHAIN = 8;

const PULL_CHUNK = 64 * 1024;

function formatBytes(n: number): string {
  return n >= 1024 * 1024 * 1024 ? `${n / (1024 * 1024 * 1024)} GB` : `${Math.round(n / (1024 * 1024))} MB`;
}

/**
 * A decode stopped because it would exceed a safety limit. `scope` says which:
 * one stream's decoded size, or the document's total decode budget. The
 * message is written for the user; dialogs display it as-is.
 */
export class DecodeLimitError extends Error {
  readonly scope: 'stream' | 'document';
  readonly limit: number;

  constructor(scope: 'stream' | 'document', limit: number) {
    super(
      scope === 'stream'
        ? `This PDF contains a compressed stream whose decoded size exceeds the ${formatBytes(limit)} safety limit. The operation was stopped to protect PDF Manager.`
        : `This PDF contains more compressed data than PDF Manager will decode in one operation: the total exceeds the ${formatBytes(limit)} safety limit. The operation was stopped to protect PDF Manager.`
    );
    this.name = 'DecodeLimitError';
    this.scope = scope;
    this.limit = limit;
  }
}

/** A stream uses a filter or predictor this module cannot decode. */
export class UnsupportedStreamEncodingError extends Error {
  constructor(what: string) {
    super(`Unsupported stream encoding: ${what}`);
    this.name = 'UnsupportedStreamEncodingError';
  }
}

/**
 * Decode budget for one document. `charge` is called as output is produced,
 * so an overflow stops the decode that caused it rather than after it ends.
 */
export class DecodeBudget {
  private used = 0;

  constructor(readonly limit: number = MAX_DOCUMENT_DECODED_BYTES) {}

  get consumed(): number {
    return this.used;
  }

  /** Records `bytes` of decoded output; throws once the total passes the limit. */
  charge(bytes: number): void {
    this.used += bytes;
    if (this.used > this.limit) throw new DecodeLimitError('document', this.limit);
  }
}

const budgets = new WeakMap<object, DecodeBudget>();

/** The decode budget of the document that owns `context` (a PDFContext). */
export function decodeBudgetFor(context: object): DecodeBudget {
  let budget = budgets.get(context);
  if (!budget) {
    budget = new DecodeBudget();
    budgets.set(context, budget);
  }
  return budget;
}

/** The decode budget of the document that owns `stream`. */
export function decodeBudgetForStream(stream: PDFRawStream): DecodeBudget {
  return decodeBudgetFor(stream.dict.context);
}

/** True for any decode-limit overflow; such errors must fail the operation. */
export function isDecodeLimitError(e: unknown): e is DecodeLimitError {
  return e instanceof DecodeLimitError;
}

/**
 * Rethrows decode-limit errors. Call at the top of any catch that would
 * otherwise swallow a decode failure, so an overflow fails the operation.
 */
export function rethrowDecodeLimit(e: unknown): void {
  if (e instanceof DecodeLimitError) throw e;
}

/**
 * Rethrows only a document-budget overflow. For sites where one oversized
 * object can be safely skipped (left byte-identical), but the document as a
 * whole must stop once its budget is spent.
 */
export function rethrowDocumentDecodeLimit(e: unknown): void {
  if (e instanceof DecodeLimitError && e.scope === 'document') throw e;
}

/**
 * pako inflate with a hard output cap, charged to `budget` as it runs. Throws
 * DecodeLimitError once the output would exceed `maxBytes` or the budget;
 * input is fed in slices so an overflow stops the work early instead of after
 * the whole bomb has been expanded.
 */
export function inflateCapped(data: Uint8Array, maxBytes: number, budget?: DecodeBudget): Uint8Array {
  const inflator = new pako.Inflate();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let failure: DecodeLimitError | null = null;
  inflator.onData = (chunk: Uint8Array) => {
    if (failure) return;
    total += chunk.length;
    if (total > maxBytes) {
      failure = new DecodeLimitError('stream', maxBytes);
      return;
    }
    try {
      budget?.charge(chunk.length);
    } catch (e) {
      failure = e as DecodeLimitError;
      return;
    }
    chunks.push(chunk);
  };
  for (let i = 0; i < data.length && !failure; i += PULL_CHUNK) {
    inflator.push(data.subarray(i, Math.min(i + PULL_CHUNK, data.length)), i + PULL_CHUNK >= data.length);
    // pdf.js and pdf-lib do not verify the zlib Adler-32 trailer; the check
    // runs after every byte has been emitted, so a bad checksum alone keeps
    // the (complete) output for parity with how the page is rendered.
    if (inflator.err && inflator.msg !== 'incorrect data check') {
      throw new Error(inflator.msg || 'corrupt Flate data');
    }
  }
  if (failure) throw failure;
  return concat(chunks, total);
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  if (chunks.length === 1) return chunks[0];
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.length;
  }
  return out;
}

interface FilterStage {
  name: string;
  parms: PDFDict | undefined;
}

function filterChain(dict: PDFDict): FilterStage[] {
  const filter = dict.lookup(PDFName.of('Filter'));
  const parms = dict.lookup(PDFName.of('DecodeParms'));
  if (filter === undefined) return [];
  if (filter instanceof PDFName) {
    const p = parms instanceof PDFDict ? parms : parms instanceof PDFArray ? parms.lookupMaybe(0, PDFDict) : undefined;
    return [{ name: filter.decodeText(), parms: p }];
  }
  if (filter instanceof PDFArray) {
    if (filter.size() > MAX_FILTER_CHAIN) {
      throw new UnsupportedStreamEncodingError(`filter chain of ${filter.size()} filters`);
    }
    const stages: FilterStage[] = [];
    for (let i = 0; i < filter.size(); i++) {
      const name = filter.lookup(i);
      if (!(name instanceof PDFName)) throw new UnsupportedStreamEncodingError('non-name /Filter entry');
      const p = parms instanceof PDFArray ? parms.lookupMaybe(i, PDFDict) : i === 0 && parms instanceof PDFDict ? parms : undefined;
      stages.push({ name: name.decodeText(), parms: p });
    }
    return stages;
  }
  throw new UnsupportedStreamEncodingError('/Filter is neither a name nor an array');
}

/**
 * Runs one pdf-lib decoder (LZW, ASCII85, ASCIIHex, RunLength) by pulling its
 * output in chunks, so the cap and budget stop it part-way through.
 */
function pullCapped(stage: FilterStage, input: Uint8Array, context: PDFDict['context'], maxBytes: number, budget: DecodeBudget): Uint8Array {
  const dict = PDFDict.withContext(context);
  dict.set(PDFName.of('Filter'), PDFName.of(stage.name));
  if (stage.parms) dict.set(PDFName.of('DecodeParms'), stage.parms);
  const decoder = decodePDFRawStream(PDFRawStream.of(dict, input));
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    // forceClamped is false, so pdf-lib returns a plain Uint8Array.
    const chunk = decoder.getBytes(PULL_CHUNK) as Uint8Array;
    if (chunk.length === 0) break;
    total += chunk.length;
    if (total > maxBytes) throw new DecodeLimitError('stream', maxBytes);
    budget.charge(chunk.length);
    chunks.push(chunk);
  }
  return concat(chunks, total);
}

function parmNumber(parms: PDFDict, key: string, fallback: number): number {
  const v = parms.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

/**
 * Undoes a /Predictor (ISO 32000-1 §7.4.4.4) after Flate or LZW. Output is
 * never larger than the input, so the stage cap already bounds it.
 */
export function applyPredictor(data: Uint8Array, parms: PDFDict | undefined): Uint8Array {
  if (!parms) return data;
  const predictor = parmNumber(parms, 'Predictor', 1);
  if (predictor === 1) return data;
  const colors = parmNumber(parms, 'Colors', 1);
  const bpc = parmNumber(parms, 'BitsPerComponent', 8);
  const columns = parmNumber(parms, 'Columns', 1);
  if (!Number.isInteger(colors) || colors < 1 || colors > 32
      || ![1, 2, 4, 8, 16].includes(bpc)
      || !Number.isInteger(columns) || columns < 1 || columns > 1 << 24) {
    throw new UnsupportedStreamEncodingError('invalid predictor parameters');
  }
  const rowBytes = Math.ceil((colors * bpc * columns) / 8);
  if (predictor === 2) return undoTiffPredictor(data, rowBytes, colors, bpc, columns);
  if (predictor >= 10 && predictor <= 15) {
    return undoPngPredictor(data, rowBytes, Math.max(1, Math.ceil((colors * bpc) / 8)));
  }
  throw new UnsupportedStreamEncodingError(`Predictor ${predictor}`);
}

function undoPngPredictor(data: Uint8Array, rowBytes: number, bpp: number): Uint8Array {
  const rows = Math.ceil(data.length / (rowBytes + 1));
  const out = new Uint8Array(rows * rowBytes);
  let produced = 0;
  for (let r = 0; r < rows; r++) {
    const src = r * (rowBytes + 1);
    const type = data[src];
    const avail = Math.min(rowBytes, data.length - src - 1);
    const dst = r * rowBytes;
    for (let i = 0; i < avail; i++) {
      const x = data[src + 1 + i];
      const left = i >= bpp ? out[dst + i - bpp] : 0;
      const up = r > 0 ? out[dst - rowBytes + i] : 0;
      const upLeft = r > 0 && i >= bpp ? out[dst - rowBytes + i - bpp] : 0;
      let v: number;
      switch (type) {
        case 0: v = x; break;
        case 1: v = x + left; break;
        case 2: v = x + up; break;
        case 3: v = x + ((left + up) >> 1); break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          v = x + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: throw new UnsupportedStreamEncodingError(`PNG row filter ${type}`);
      }
      out[dst + i] = v & 0xff;
    }
    produced = dst + Math.max(0, avail);
  }
  return out.subarray(0, produced);
}

function undoTiffPredictor(data: Uint8Array, rowBytes: number, colors: number, bpc: number, columns: number): Uint8Array {
  const out = new Uint8Array(data);
  const rows = Math.floor(out.length / rowBytes);
  if (bpc === 8) {
    for (let r = 0; r < rows; r++) {
      const base = r * rowBytes;
      for (let i = colors; i < rowBytes; i++) out[base + i] = (out[base + i] + out[base + i - colors]) & 0xff;
    }
    return out;
  }
  if (bpc === 16) {
    const stride = colors * 2;
    for (let r = 0; r < rows; r++) {
      const base = r * rowBytes;
      for (let i = stride; i + 1 < rowBytes; i += 2) {
        const sum = ((out[base + i] << 8) | out[base + i + 1]) + ((out[base + i - stride] << 8) | out[base + i - stride + 1]);
        out[base + i] = (sum >> 8) & 0xff;
        out[base + i + 1] = sum & 0xff;
      }
    }
    return out;
  }
  // 1, 2 or 4 bits per component: samples are packed MSB-first within each row.
  const mask = (1 << bpc) - 1;
  const read = (base: number, idx: number): number => {
    const bit = idx * bpc;
    return (out[base + (bit >> 3)] >> (8 - bpc - (bit & 7))) & mask;
  };
  const write = (base: number, idx: number, value: number): void => {
    const bit = idx * bpc;
    const shift = 8 - bpc - (bit & 7);
    const at = base + (bit >> 3);
    out[at] = (out[at] & ~(mask << shift)) | ((value & mask) << shift);
  };
  const samples = colors * columns;
  for (let r = 0; r < rows; r++) {
    const base = r * rowBytes;
    for (let s = colors; s < samples; s++) write(base, s, read(base, s) + read(base, s - colors));
  }
  return out;
}

/**
 * Decode a raw stream through its whole filter chain with the output of every
 * stage capped at `maxBytes` and charged to the owning document's budget.
 * Throws DecodeLimitError on overflow, UnsupportedStreamEncodingError for
 * filters it cannot decode (DCT, JPX, JBIG2, CCITT, Crypt...), or Error for
 * corrupt data. Never returns still-encoded bytes.
 */
export function decodeRawStreamBounded(stream: PDFRawStream, maxBytes = MAX_DECODED_STREAM_BYTES): Uint8Array {
  const stages = filterChain(stream.dict);
  if (stages.length === 0) {
    // Unfiltered bytes are already in the file: no amplification to budget.
    if (stream.contents.length > maxBytes) throw new DecodeLimitError('stream', maxBytes);
    return stream.contents;
  }
  const budget = decodeBudgetForStream(stream);
  let data = stream.contents;
  for (const stage of stages) {
    switch (stage.name) {
      case 'FlateDecode':
        data = applyPredictor(inflateCapped(data, maxBytes, budget), stage.parms);
        break;
      case 'LZWDecode':
        data = applyPredictor(pullCapped(stage, data, stream.dict.context, maxBytes, budget), stage.parms);
        break;
      case 'ASCII85Decode':
      case 'ASCIIHexDecode':
      case 'RunLengthDecode':
        data = pullCapped(stage, data, stream.dict.context, maxBytes, budget);
        break;
      default:
        throw new UnsupportedStreamEncodingError(stage.name);
    }
  }
  return data;
}

/**
 * The same raw stream with its contents fully decoded under the bounds and
 * /Filter and /DecodeParms removed, so pdf-lib's parsers read it without
 * running their own unbounded decoders.
 */
function boundedPlainCopy(stream: PDFRawStream): PDFRawStream {
  const decoded = decodeRawStreamBounded(stream);
  const dict = stream.dict.clone(stream.dict.context);
  dict.delete(PDFName.of('Filter'));
  dict.delete(PDFName.of('DecodeParms'));
  return PDFRawStream.of(dict, decoded);
}

/**
 * Load-time decode-limit failures, by document context. pdf-lib's parser
 * catches every error thrown while parsing an indirect object and stores the
 * object as invalid, so an overflow inside an object stream would otherwise
 * leave a silently incomplete document; the wrapped PDFDocument.load rethrows.
 */
const loadFailures = new WeakMap<object, DecodeLimitError>();

function boundedForLoad(stream: PDFRawStream): PDFRawStream {
  try {
    return boundedPlainCopy(stream);
  } catch (e) {
    if (e instanceof DecodeLimitError && !loadFailures.has(stream.dict.context)) {
      loadFailures.set(stream.dict.context, e);
    }
    throw e;
  }
}

/**
 * pdf-lib decodes object streams and cross-reference streams inside
 * PDFDocument.load with no limit (ByteStream.fromPDFRawStream). Its parser
 * looks both factories up on the exported classes at call time, as every
 * caller does PDFDocument.load, so replacing the three statics covers every
 * load in the app. Installed once, when this module is first imported (the
 * renderer entry imports it, as does every module that decodes streams).
 */
let loadTimeBoundsInstalled = false;
export function installLoadTimeDecodeBounds(): void {
  if (loadTimeBoundsInstalled) return;
  loadTimeBoundsInstalled = true;
  const objStm = PDFObjectStreamParser.forStream;
  PDFObjectStreamParser.forStream = (rawStream, shouldWaitForTick) => objStm(boundedForLoad(rawStream), shouldWaitForTick);
  const xrefStm = PDFXRefStreamParser.forStream;
  PDFXRefStreamParser.forStream = (rawStream) => xrefStm(boundedForLoad(rawStream));
  const load = PDFDocument.load;
  PDFDocument.load = async (pdf, options) => {
    const doc = await load.call(PDFDocument, pdf, options);
    const failure = loadFailures.get(doc.context);
    if (failure) throw failure;
    return doc;
  };
}

installLoadTimeDecodeBounds();
