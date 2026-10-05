/**
 * compress — shrink a PDF without changing what it shows (lossless), and
 * optionally downsample oversized images (lossy).
 *
 * Lossless passes (pdf-lib, run on every compress):
 *   1. drop objects unreachable from the trailer (superseded revisions, orphaned
 *      form fields/fonts, unused images);
 *   2. merge byte-identical streams, then identical Font / FontDescriptor /
 *      ExtGState dictionaries (fixpoint, because merging font files makes their
 *      descriptors identical);
 *   3. Flate-compress uncompressed streams and re-deflate existing Flate streams
 *      at level 9 when that is smaller (decoded bytes are untouched, so
 *      /DecodeParms predictors stay valid);
 *   4. write with cross-reference + object streams.
 *
 * Lossy pass (needs an ImageRecodec — the renderer supplies a canvas one):
 *   images whose effective resolution on the page exceeds the target DPI are
 *   decoded, resampled and re-encoded as JPEG. Effective DPI comes from the
 *   CTM at every `Do` that paints the image, including inside Form XObjects;
 *   an image shown at several sizes uses its largest placement. Anything we
 *   cannot decode and re-encode faithfully is skipped and reported: JBIG2, JPX,
 *   CCITT, non-8-bit, Indexed, CMYK, Lab, Separation/DeviceN, custom /Decode,
 *   colour-key masks, stencil masks and images used as another image's mask.
 *   Soft-masked images are handled: the /SMask is kept as-is (its resolution is
 *   independent of the base image, PDF 32000-1 §11.6.5.3).
 */

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFNumber,
  PDFRawStream,
  PDFStream,
  PDFObject,
  PDFBool,
} from 'pdf-lib';
import * as pako from 'pako';
import { removeUnreachableObjects, rewriteReferences } from './pdfObjectGraph';
import { decodeRawStreamBounded, inflateCapped, MAX_DECODED_STREAM_BYTES as MAX_INFLATE_BYTES } from './boundedDecode';

export interface LossyOptions {
  /** Downsample images whose effective resolution exceeds this. */
  targetDpi: number;
  /** JPEG quality, 0.1–1. */
  jpegQuality: number;
}

export interface CompressOptions {
  lossy?: LossyOptions;
}

export type RecodeSource =
  | { kind: 'jpeg'; bytes: Uint8Array }
  | { kind: 'rgba'; data: Uint8ClampedArray<ArrayBuffer>; width: number; height: number };

export interface RecodeRequest {
  source: RecodeSource;
  targetWidth: number;
  targetHeight: number;
  quality: number;
}

/** Decodes, resamples and JPEG-encodes one image. Implemented on canvas in the renderer. */
export interface ImageRecodec {
  recode(request: RecodeRequest): Promise<Uint8Array>;
}

export interface ImageReport {
  ref: string;
  width: number;
  height: number;
  effectiveDpi: number | null;
  action: 'downsampled' | 'unchanged' | 'skipped';
  reason?: string;
  newWidth?: number;
  newHeight?: number;
  bytesBefore: number;
  bytesAfter: number;
}

export interface CompressResult {
  bytes: Uint8Array;
  originalSize: number;
  compressedSize: number;
  /** False when no pass produced a smaller file; `bytes` is then the input. */
  improved: boolean;
  removedObjects: number;
  dedupedObjects: number;
  recompressedStreams: number;
  images: ImageReport[];
}

export class CompressError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CompressError';
  }
}

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];
const MAX_FORM_DEPTH = 12;
/**
 * Total Form XObject interpretations per document. Depth alone does not bound
 * work: a form that invokes the next form N times per level costs N^depth.
 */
const MAX_FORM_INVOCATIONS = 5000;
const DPI_TOLERANCE = 1.05;
const MIN_STREAM_FOR_DEFLATE = 64;
/** Longest operator/name we decode; longer runs are binary noise, not syntax. */
const MAX_TOKEN = 256;

type Matrix = [number, number, number, number, number, number];

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function multiply(m: Matrix, n: Matrix): Matrix {
  return [
    m[0] * n[0] + m[1] * n[2],
    m[0] * n[1] + m[1] * n[3],
    m[2] * n[0] + m[3] * n[2],
    m[2] * n[1] + m[3] * n[3],
    m[4] * n[0] + m[5] * n[2] + n[4],
    m[4] * n[1] + m[5] * n[3] + n[5],
  ];
}

function readMatrix(arr: PDFArray | undefined): Matrix {
  if (!arr || arr.size() !== 6) return IDENTITY;
  const out: number[] = [];
  for (let i = 0; i < 6; i++) {
    const v = arr.lookup(i);
    if (!(v instanceof PDFNumber)) return IDENTITY;
    out.push(v.asNumber());
  }
  return out as Matrix;
}

function nameOf(obj: PDFObject | undefined): string | undefined {
  return obj instanceof PDFName ? obj.decodeText() : undefined;
}

function filterNames(dict: PDFDict): string[] {
  const filter = dict.lookup(PDFName.of('Filter'));
  if (filter instanceof PDFName) return [filter.decodeText()];
  if (filter instanceof PDFArray) {
    const names: string[] = [];
    for (let i = 0; i < filter.size(); i++) {
      const n = nameOf(filter.lookup(i));
      if (n) names.push(n);
    }
    return names;
  }
  return [];
}

function numberIn(dict: PDFDict | undefined, key: string, fallback: number): number {
  const v = dict?.lookup(PDFName.of(key));
  return v instanceof PDFNumber ? v.asNumber() : fallback;
}

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

function fnv1a(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function lookupByDecodedName(dict: PDFDict | undefined, name: string): PDFObject | undefined {
  if (!dict) return undefined;
  for (const [key, value] of dict.entries()) {
    if (key.decodeText() === name) return value;
  }
  return undefined;
}

function decodeContent(stream: PDFObject | undefined): Uint8Array | null {
  if (!(stream instanceof PDFRawStream)) return null;
  try {
    return decodeRawStreamBounded(stream);
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Content scanning: where is each image painted, and how large?
// ---------------------------------------------------------------------------

const WHITESPACE = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
const DELIMITERS = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

type Operand = { t: 'num'; v: number } | { t: 'name'; v: string } | { t: 'other' };

function decodeNameToken(raw: string): string {
  return raw.replace(/#([0-9a-fA-F]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * Minimal content-stream interpreter: tracks q/Q/cm and reports every `Do`
 * with the CTM in force. Strings, arrays, dicts and inline images are skipped
 * structurally so binary data can never be misread as operators.
 */
function interpretContent(
  data: Uint8Array,
  onDo: (name: string, ctm: Matrix) => void,
  initialCtm: Matrix
): void {
  let pos = 0;
  const len = data.length;
  let ctm = initialCtm;
  const stack: Matrix[] = [];
  let operands: Operand[] = [];

  const skipString = () => {
    let depth = 1;
    pos++;
    while (pos < len && depth > 0) {
      const c = data[pos];
      if (c === 0x5c) pos += 2;
      else {
        if (c === 0x28) depth++;
        else if (c === 0x29) depth--;
        pos++;
      }
    }
  };

  while (pos < len) {
    const c = data[pos];
    if (WHITESPACE.has(c)) { pos++; continue; }
    if (c === 0x25) { // comment
      while (pos < len && data[pos] !== 0x0a && data[pos] !== 0x0d) pos++;
      continue;
    }
    if (c === 0x28) { skipString(); operands.push({ t: 'other' }); continue; }
    if (c === 0x3c) {
      if (data[pos + 1] === 0x3c) { pos += 2; continue; } // dict start: contents are operands we ignore
      while (pos < len && data[pos] !== 0x3e) pos++;
      pos++;
      operands.push({ t: 'other' });
      continue;
    }
    if (c === 0x3e) { pos += data[pos + 1] === 0x3e ? 2 : 1; continue; }
    if (c === 0x5b || c === 0x5d || c === 0x7b || c === 0x7d) { pos++; continue; }
    if (c === 0x2f) {
      const start = ++pos;
      while (pos < len && !WHITESPACE.has(data[pos]) && !DELIMITERS.has(data[pos])) pos++;
      operands.push(pos - start > MAX_TOKEN
        ? { t: 'other' }
        : { t: 'name', v: decodeNameToken(String.fromCharCode(...data.subarray(start, pos))) });
      continue;
    }
    // number or keyword
    const start = pos;
    while (pos < len && !WHITESPACE.has(data[pos]) && !DELIMITERS.has(data[pos])) pos++;
    if (pos === start) { pos++; continue; }
    if (pos - start > MAX_TOKEN) { operands = []; continue; }
    const token = String.fromCharCode(...data.subarray(start, pos));
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(token)) {
      operands.push({ t: 'num', v: parseFloat(token) });
      continue;
    }
    switch (token) {
      case 'q':
        stack.push(ctm);
        break;
      case 'Q':
        if (stack.length > 0) ctm = stack.pop()!;
        break;
      case 'cm': {
        const nums = operands.slice(-6);
        if (nums.length === 6 && nums.every((o) => o.t === 'num')) {
          ctm = multiply(nums.map((o) => (o as { v: number }).v) as Matrix, ctm);
        }
        break;
      }
      case 'Do': {
        const last = operands[operands.length - 1];
        if (last && last.t === 'name') onDo(last.v, ctm);
        break;
      }
      case 'BI': {
        // Inline image: skip the dictionary up to ID, then binary data up to EI.
        const idIdx = findKeyword(data, pos, 'ID');
        if (idIdx < 0) { pos = len; break; }
        pos = idIdx + 3;
        const eiIdx = findInlineImageEnd(data, pos);
        pos = eiIdx < 0 ? len : eiIdx + 2;
        break;
      }
      default:
        break;
    }
    operands = [];
  }
}

function isBoundary(data: Uint8Array, idx: number): boolean {
  return idx < 0 || idx >= data.length || WHITESPACE.has(data[idx]) || DELIMITERS.has(data[idx]);
}

function findKeyword(data: Uint8Array, from: number, keyword: string): number {
  const k0 = keyword.charCodeAt(0);
  const k1 = keyword.charCodeAt(1);
  for (let i = from; i < data.length - 1; i++) {
    if (data[i] === k0 && data[i + 1] === k1 && isBoundary(data, i - 1) && isBoundary(data, i + 2)) return i;
  }
  return -1;
}

function findInlineImageEnd(data: Uint8Array, from: number): number {
  for (let i = from; i < data.length - 1; i++) {
    if (data[i] === 0x45 && data[i + 1] === 0x49 && WHITESPACE.has(data[i - 1]) && isBoundary(data, i + 2)) return i;
  }
  return -1;
}

/** Map image ref → smallest effective DPI across all placements. */
function scanImagePlacements(doc: PDFDocument): Map<string, number> {
  const context = doc.context;
  const minDpi = new Map<string, number>();
  let formInvocations = 0;
  let exhausted = false;

  const walk = (data: Uint8Array, resources: PDFDict | undefined, ctm: Matrix, depth: number, visiting: Set<string>) => {
    if (exhausted) return;
    interpretContent(data, (name, current) => {
      const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
      const entry = lookupByDecodedName(xobjects, name);
      if (!(entry instanceof PDFRef)) return;
      const stream = context.lookup(entry);
      if (!(stream instanceof PDFStream)) return;
      const subtype = nameOf(stream.dict.lookup(PDFName.of('Subtype')));
      const key = entry.toString();
      if (subtype === 'Image') {
        const w = numberIn(stream.dict, 'Width', 0);
        const h = numberIn(stream.dict, 'Height', 0);
        const widthPt = Math.hypot(current[0], current[1]);
        const heightPt = Math.hypot(current[2], current[3]);
        if (w <= 0 || h <= 0 || widthPt <= 0 || heightPt <= 0) return;
        const dpi = Math.min(w / (widthPt / 72), h / (heightPt / 72));
        const prev = minDpi.get(key);
        if (prev === undefined || dpi < prev) minDpi.set(key, dpi);
      } else if (subtype === 'Form' && depth < MAX_FORM_DEPTH && !visiting.has(key)) {
        if (++formInvocations > MAX_FORM_INVOCATIONS) {
          exhausted = true;
          return;
        }
        const decoded = decodeContent(stream);
        if (!decoded) return;
        const formResources = stream.dict.lookupMaybe(PDFName.of('Resources'), PDFDict) ?? resources;
        const formMatrix = readMatrix(stream.dict.lookupMaybe(PDFName.of('Matrix'), PDFArray));
        visiting.add(key);
        walk(decoded, formResources, multiply(formMatrix, current), depth + 1, visiting);
        visiting.delete(key);
      }
    }, ctm);
  };

  for (const page of doc.getPages()) {
    const resources = context.lookupMaybe(page.node.getInheritableAttribute(PDFName.of('Resources')), PDFDict);
    const contents = page.node.get(PDFName.of('Contents'));
    const resolved = contents instanceof PDFRef ? context.lookup(contents) : contents;
    const streams: PDFObject[] = [];
    if (resolved instanceof PDFArray) {
      for (let i = 0; i < resolved.size(); i++) {
        const part = resolved.lookup(i);
        if (part) streams.push(part);
      }
    } else if (resolved) {
      streams.push(resolved);
    }
    const parts: Uint8Array[] = [];
    let complete = true;
    for (const s of streams) {
      const decoded = decodeContent(s);
      if (!decoded) { complete = false; break; }
      parts.push(decoded);
    }
    // A page whose content we cannot fully decode gives no trustworthy sizes.
    if (!complete) continue;
    const total = parts.reduce((n, p) => n + p.length + 1, 0);
    const joined = new Uint8Array(total);
    let offset = 0;
    for (const p of parts) {
      joined.set(p, offset);
      offset += p.length;
      joined[offset++] = 0x0a;
    }
    walk(joined, resources, IDENTITY, 0, new Set());
    if (exhausted) break;
  }
  // Placements are incomplete once the budget runs out, so no image size can be
  // trusted: report none, which leaves every image unresampled.
  return exhausted ? new Map() : minDpi;
}

// ---------------------------------------------------------------------------
// Image decoding (Flate) and JPEG inspection
// ---------------------------------------------------------------------------

interface ColorInfo {
  components: 1 | 3;
  /** Colour space object to write on the re-encoded image (3-component JPEG output). */
  rgbSpace: PDFObject;
}

/** Classify an image colour space. Returns a skip reason string when unsupported. */
function classifyColorSpace(doc: PDFDocument, cs: PDFObject | undefined): ColorInfo | string {
  const context = doc.context;
  const resolved = cs instanceof PDFRef ? context.lookup(cs) : cs;
  if (resolved instanceof PDFName) {
    const n = resolved.decodeText();
    if (n === 'DeviceRGB') return { components: 3, rgbSpace: PDFName.of('DeviceRGB') };
    if (n === 'DeviceGray') return { components: 1, rgbSpace: PDFName.of('DeviceRGB') };
    if (n === 'DeviceCMYK') return 'CMYK colour space';
    return `${n} colour space`;
  }
  if (resolved instanceof PDFArray && resolved.size() > 0) {
    const family = nameOf(resolved.lookup(0)) ?? '';
    if (family === 'ICCBased') {
      const profile = resolved.lookup(1);
      const n = profile instanceof PDFStream ? numberIn(profile.dict, 'N', 0) : 0;
      if (n === 3) return { components: 3, rgbSpace: cs as PDFObject };
      if (n === 1) return { components: 1, rgbSpace: PDFName.of('DeviceRGB') };
      if (n === 4) return 'CMYK (ICC) colour space';
      return 'unsupported ICC profile';
    }
    if (family === 'CalRGB') return { components: 3, rgbSpace: cs as PDFObject };
    if (family === 'CalGray') return { components: 1, rgbSpace: PDFName.of('DeviceRGB') };
    if (family === 'Indexed') return 'Indexed colour space';
    return `${family || 'unknown'} colour space`;
  }
  return 'missing colour space';
}

export interface JpegInfo {
  width: number;
  height: number;
  components: number;
}

/** Read dimensions/components from the first SOF marker of a JPEG. */
export function readJpegInfo(bytes: Uint8Array): JpegInfo | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let pos = 2;
  while (pos + 4 <= bytes.length) {
    if (bytes[pos] !== 0xff) { pos++; continue; }
    const marker = bytes[pos + 1];
    if (marker === 0xff) { pos++; continue; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { pos += 2; continue; }
    const segLen = (bytes[pos + 2] << 8) | bytes[pos + 3];
    const isSof = marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isSof && pos + 9 < bytes.length) {
      return {
        height: (bytes[pos + 5] << 8) | bytes[pos + 6],
        width: (bytes[pos + 7] << 8) | bytes[pos + 8],
        components: bytes[pos + 9],
      };
    }
    if (marker === 0xda || marker === 0xd9) return null;
    pos += 2 + segLen;
  }
  return null;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/** Undo a /DecodeParms predictor for 8-bit samples. */
export function undoPredictor(data: Uint8Array, predictor: number, colors: number, columns: number): Uint8Array | null {
  if (predictor <= 1) return data;
  const rowLen = colors * columns;
  if (predictor === 2) {
    const out = new Uint8Array(data);
    for (let row = 0; row + rowLen <= out.length; row += rowLen) {
      for (let i = colors; i < rowLen; i++) out[row + i] = (out[row + i] + out[row + i - colors]) & 0xff;
    }
    return out;
  }
  if (predictor >= 10) {
    const stride = rowLen + 1;
    const rows = Math.floor(data.length / stride);
    const out = new Uint8Array(rows * rowLen);
    for (let r = 0; r < rows; r++) {
      const type = data[r * stride];
      const src = r * stride + 1;
      const dst = r * rowLen;
      for (let i = 0; i < rowLen; i++) {
        const x = data[src + i];
        const left = i >= colors ? out[dst + i - colors] : 0;
        const up = r > 0 ? out[dst - rowLen + i] : 0;
        const upLeft = r > 0 && i >= colors ? out[dst - rowLen + i - colors] : 0;
        let v: number;
        switch (type) {
          case 0: v = x; break;
          case 1: v = x + left; break;
          case 2: v = x + up; break;
          case 3: v = x + ((left + up) >> 1); break;
          case 4: v = x + paeth(left, up, upLeft); break;
          default: return null;
        }
        out[dst + i] = v & 0xff;
      }
    }
    return out;
  }
  return null;
}

function decodeFlateImageToRgba(
  stream: PDFRawStream,
  width: number,
  height: number,
  components: 1 | 3
): Uint8ClampedArray<ArrayBuffer> | string {
  let inflated: Uint8Array;
  try {
    // Row data plus one predictor byte per row is all a valid image can need.
    const expected = height * (width * components + 1);
    inflated = inflateCapped(stream.contents, Math.min(MAX_INFLATE_BYTES, expected + 64 * 1024));
  } catch {
    return 'corrupt or oversized Flate data';
  }
  const parmsObj = stream.dict.lookup(PDFName.of('DecodeParms'));
  const parms = parmsObj instanceof PDFDict ? parmsObj : parmsObj instanceof PDFArray ? (parmsObj.lookup(0) as PDFDict) : undefined;
  const predictor = numberIn(parms, 'Predictor', 1);
  const colors = numberIn(parms, 'Colors', 1);
  const columns = numberIn(parms, 'Columns', 1);
  const bpcParm = numberIn(parms, 'BitsPerComponent', 8);
  if (predictor > 1 && (colors !== components || columns !== width || bpcParm !== 8)) {
    return 'unsupported predictor parameters';
  }
  const samples = undoPredictor(inflated, predictor, components, width);
  if (!samples) return 'unsupported predictor';
  const pixelCount = width * height;
  if (samples.length < pixelCount * components) return 'truncated image data';

  const rgba = new Uint8ClampedArray(pixelCount * 4);
  for (let i = 0; i < pixelCount; i++) {
    if (components === 1) {
      const g = samples[i];
      rgba[i * 4] = g;
      rgba[i * 4 + 1] = g;
      rgba[i * 4 + 2] = g;
    } else {
      rgba[i * 4] = samples[i * 3];
      rgba[i * 4 + 1] = samples[i * 3 + 1];
      rgba[i * 4 + 2] = samples[i * 3 + 2];
    }
    rgba[i * 4 + 3] = 255;
  }
  return rgba;
}

// ---------------------------------------------------------------------------
// Lossy pass
// ---------------------------------------------------------------------------

interface ImageCandidate {
  ref: PDFRef;
  stream: PDFRawStream;
  width: number;
  height: number;
}

function collectMaskRefs(doc: PDFDocument): Set<string> {
  const masks = new Set<string>();
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    for (const key of ['SMask', 'Mask']) {
      const v = obj.dict.get(PDFName.of(key));
      if (v instanceof PDFRef) masks.add(v.toString());
    }
  }
  return masks;
}

function collectImages(doc: PDFDocument): ImageCandidate[] {
  const images: ImageCandidate[] = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    if (nameOf(obj.dict.lookup(PDFName.of('Subtype'))) !== 'Image') continue;
    images.push({
      ref,
      stream: obj,
      width: numberIn(obj.dict, 'Width', 0),
      height: numberIn(obj.dict, 'Height', 0),
    });
  }
  return images;
}

/** Reason the image cannot be resampled faithfully, or null when eligible. */
function ineligibility(image: ImageCandidate, maskRefs: Set<string>): string | null {
  const dict = image.stream.dict;
  if (maskRefs.has(image.ref.toString())) return 'used as a mask by another image';
  if (dict.lookup(PDFName.of('ImageMask')) === PDFBool.True) return 'stencil mask';
  if (dict.lookup(PDFName.of('Mask')) instanceof PDFArray) return 'colour-key mask';
  if (dict.has(PDFName.of('Decode'))) return 'custom /Decode array';
  if (image.width <= 0 || image.height <= 0) return 'invalid dimensions';
  const filters = filterNames(dict);
  if (filters.length !== 1 || (filters[0] !== 'DCTDecode' && filters[0] !== 'FlateDecode')) {
    const label = filters.join(' + ') || 'uncompressed';
    if (filters.includes('JBIG2Decode')) return 'JBIG2 image (unsupported)';
    if (filters.includes('JPXDecode')) return 'JPEG 2000 image (unsupported)';
    if (filters.includes('CCITTFaxDecode')) return 'CCITT fax image (unsupported)';
    return `${label} encoding (unsupported)`;
  }
  if (numberIn(dict, 'BitsPerComponent', 8) !== 8) return `${numberIn(dict, 'BitsPerComponent', 0)}-bit samples`;
  return null;
}

async function downsampleImages(
  doc: PDFDocument,
  lossy: LossyOptions,
  codec: ImageRecodec,
  reports: ImageReport[]
): Promise<void> {
  const placements = scanImagePlacements(doc);
  const maskRefs = collectMaskRefs(doc);
  const quality = Math.min(1, Math.max(0.1, lossy.jpegQuality));

  for (const image of collectImages(doc)) {
    const before = image.stream.contents.length;
    const report: ImageReport = {
      ref: image.ref.toString(),
      width: image.width,
      height: image.height,
      effectiveDpi: placements.has(image.ref.toString()) ? Math.round(placements.get(image.ref.toString())!) : null,
      action: 'skipped',
      bytesBefore: before,
      bytesAfter: before,
    };
    reports.push(report);

    const reason = ineligibility(image, maskRefs);
    if (reason) { report.reason = reason; continue; }
    const color = classifyColorSpace(doc, image.stream.dict.get(PDFName.of('ColorSpace')));
    if (typeof color === 'string') { report.reason = color; continue; }

    const dpi = placements.get(image.ref.toString());
    if (dpi === undefined) { report.reason = 'not painted by page content (resolution unknown)'; continue; }
    if (dpi <= lossy.targetDpi * DPI_TOLERANCE) {
      report.action = 'unchanged';
      report.reason = 'already at or below the target resolution';
      continue;
    }
    const scale = lossy.targetDpi / dpi;
    const targetWidth = Math.max(1, Math.round(image.width * scale));
    const targetHeight = Math.max(1, Math.round(image.height * scale));

    let source: RecodeSource;
    if (filterNames(image.stream.dict)[0] === 'DCTDecode') {
      const info = readJpegInfo(image.stream.contents);
      if (!info) { report.reason = 'unreadable JPEG header'; continue; }
      if (info.components !== color.components) { report.reason = `JPEG has ${info.components} components (CMYK/YCCK unsupported)`; continue; }
      source = { kind: 'jpeg', bytes: image.stream.contents };
    } else {
      const rgba = decodeFlateImageToRgba(image.stream, image.width, image.height, color.components);
      if (typeof rgba === 'string') { report.reason = rgba; continue; }
      source = { kind: 'rgba', data: rgba, width: image.width, height: image.height };
    }

    let encoded: Uint8Array;
    try {
      encoded = await codec.recode({ source, targetWidth, targetHeight, quality });
    } catch (e) {
      report.reason = `re-encode failed: ${e instanceof Error ? e.message : String(e)}`;
      continue;
    }
    const info = readJpegInfo(encoded);
    if (!info || (info.components !== 3 && info.components !== 1)) {
      report.reason = 're-encoder produced an invalid JPEG';
      continue;
    }
    if (encoded.length >= before) {
      report.action = 'unchanged';
      report.reason = 'resampled image was not smaller';
      continue;
    }

    const dict = image.stream.dict.clone(doc.context);
    dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
    dict.delete(PDFName.of('DecodeParms'));
    dict.set(PDFName.of('Width'), PDFNumber.of(info.width));
    dict.set(PDFName.of('Height'), PDFNumber.of(info.height));
    dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
    dict.set(PDFName.of('ColorSpace'), info.components === 1 ? PDFName.of('DeviceGray') : color.rgbSpace);
    dict.set(PDFName.of('Length'), PDFNumber.of(encoded.length));
    doc.context.assign(image.ref, PDFRawStream.of(dict, encoded));

    report.action = 'downsampled';
    report.reason = undefined;
    report.newWidth = info.width;
    report.newHeight = info.height;
    report.bytesAfter = encoded.length;
  }
}

// ---------------------------------------------------------------------------
// Lossless passes
// ---------------------------------------------------------------------------

function dictSignature(dict: PDFDict, skipLength: boolean): string {
  const parts: string[] = [];
  for (const [key, value] of dict.entries()) {
    if (skipLength && key === PDFName.of('Length')) continue;
    parts.push(`${key.toString()} ${value.toString()}`);
  }
  return parts.join('\n');
}

const DEDUPE_DICT_TYPES = new Set(['Font', 'FontDescriptor', 'ExtGState']);

function dedupeObjects(doc: PDFDocument): number {
  const context = doc.context;
  let total = 0;

  // Streams: identical dictionary (minus Length) and identical encoded bytes.
  {
    const groups = new Map<string, Array<{ ref: PDFRef; stream: PDFRawStream }>>();
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFRawStream)) continue;
      const key = `${obj.contents.length}|${fnv1a(obj.contents)}|${dictSignature(obj.dict, true)}`;
      const list = groups.get(key);
      if (list) list.push({ ref, stream: obj });
      else groups.set(key, [{ ref, stream: obj }]);
    }
    const mapping = new Map<string, PDFRef>();
    for (const list of groups.values()) {
      if (list.length < 2) continue;
      const canonical = list[0];
      for (const dup of list.slice(1)) {
        if (bytesEqual(dup.stream.contents, canonical.stream.contents)) mapping.set(dup.ref.toString(), canonical.ref);
      }
    }
    if (mapping.size > 0) {
      rewriteReferences(doc, mapping);
      total += mapping.size;
    }
  }

  // Fonts/descriptors/graphics states: identical after stream merging.
  for (let round = 0; round < 4; round++) {
    const seen = new Map<string, PDFRef>();
    const mapping = new Map<string, PDFRef>();
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
      if (!(obj instanceof PDFDict)) continue;
      const type = nameOf(obj.lookup(PDFName.of('Type')));
      if (!type || !DEDUPE_DICT_TYPES.has(type)) continue;
      const sig = dictSignature(obj, false);
      const canonical = seen.get(sig);
      if (canonical) mapping.set(ref.toString(), canonical);
      else seen.set(sig, ref);
    }
    if (mapping.size === 0) break;
    rewriteReferences(doc, mapping);
    total += mapping.size;
  }
  return total;
}

function recompressStreams(doc: PDFDocument): number {
  let count = 0;
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;
    const filters = filterNames(dict);
    const type = nameOf(dict.lookup(PDFName.of('Type')));
    let candidate: Uint8Array | null = null;
    let setFilter = false;

    if (filters.length === 0) {
      // XMP metadata stays readable by non-PDF tools (ISO 32000 §14.3.2).
      if (type === 'Metadata' || obj.contents.length < MIN_STREAM_FOR_DEFLATE) continue;
      if (dict.has(PDFName.of('DecodeParms'))) continue;
      candidate = pako.deflate(obj.contents, { level: 9 });
      setFilter = true;
    } else if (filters.length === 1 && filters[0] === 'FlateDecode') {
      try {
        candidate = pako.deflate(inflateCapped(obj.contents, MAX_INFLATE_BYTES), { level: 9 });
      } catch {
        continue;
      }
    } else {
      continue;
    }

    if (!candidate || candidate.length >= obj.contents.length) continue;
    const next = dict.clone(doc.context);
    if (setFilter) next.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));
    next.set(PDFName.of('Length'), PDFNumber.of(candidate.length));
    doc.context.assign(ref, PDFRawStream.of(next, candidate));
    count++;
  }
  return count;
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function compressPdf(
  bytes: Uint8Array,
  options: CompressOptions = {},
  codec?: ImageRecodec
): Promise<CompressResult> {
  if (options.lossy && !codec) throw new CompressError('Image downsampling needs an image re-encoder');
  if (options.lossy && !(options.lossy.targetDpi >= 36 && options.lossy.targetDpi <= 1200)) {
    throw new CompressError('Target resolution must be between 36 and 1200 DPI');
  }

  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const pageCount = doc.getPageCount();
  const images: ImageReport[] = [];

  if (options.lossy && codec) await downsampleImages(doc, options.lossy, codec, images);

  let removedObjects = removeUnreachableObjects(doc);
  const dedupedObjects = dedupeObjects(doc);
  removedObjects += removeUnreachableObjects(doc);
  const recompressedStreams = recompressStreams(doc);

  const output = new Uint8Array(await doc.save({ useObjectStreams: true, updateFieldAppearances: false }));

  // Never hand back something we cannot reopen with the same page count.
  const verify = await PDFDocument.load(output, { updateMetadata: false });
  if (verify.getPageCount() !== pageCount) {
    throw new CompressError(`Compressed output has ${verify.getPageCount()} pages, expected ${pageCount}`);
  }

  const improved = output.length < bytes.length;
  return {
    bytes: improved ? output : bytes,
    originalSize: bytes.length,
    compressedSize: improved ? output.length : bytes.length,
    improved,
    removedObjects,
    dedupedObjects,
    recompressedStreams,
    images,
  };
}
