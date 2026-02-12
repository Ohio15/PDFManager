/**
 * PageAnalyzer — Unified Scene Graph Builder
 *
 * ONE pass through the pdfjs-dist operator list builds a complete scene graph
 * for a single PDF page. Every visible element (text, rectangles, paths, images)
 * becomes a typed SceneElement with resolved coordinates in top-left origin.
 *
 * This replaces the old multi-pass architecture that did separate text/image/annotation
 * passes and generated hundreds of spurious PNG files for form-heavy documents.
 *
 * Architecture:
 *   page → getOperatorList()   → parseOperatorList()  → SceneElement[] (graphics)
 *   page → getTextContent()    → convertTextItems()   → TextElement[]
 *   page → getAnnotations()    → extractFormFields()   → FormField[]
 *   pdfLibDoc                  → extractImageData()    → image bytes for ImageElements
 *
 * NO rendering. NO canvas. Pure data extraction.
 */

import pako from 'pako';
import { PDFName, PDFNumber, PDFDict, PDFRawStream, PDFArray } from 'pdf-lib';
import type {
  SceneElement,
  TextElement,
  FormField,
  PageScene,
  RGB,
} from './types';

// ─── pdfjs-dist OPS constants ─────────────────────────────────────

const OPS = {
  setLineWidth: 2,
  save: 10,
  restore: 11,
  transform: 12,
  moveTo: 13,
  lineTo: 14,
  curveTo: 15,
  curveTo2: 16,
  curveTo3: 17,
  closePath: 18,
  rectangle: 19,
  stroke: 20,
  closeStroke: 21,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  closeFillStroke: 26,
  endPath: 28,
  setStrokeGray: 56,
  setFillGray: 57,
  setStrokeRGBColor: 58,
  setFillRGBColor: 59,
  setStrokeCMYKColor: 60,
  setFillCMYKColor: 61,
  paintJpegXObject: 82,
  paintImageXObject: 85,
} as const;

// ─── Affine Matrix Types and Math ─────────────────────────────────

/** 6-element affine transform: [a, b, c, d, e, f] */
type Matrix = [number, number, number, number, number, number];

const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

/**
 * Multiply two 6-element affine matrices.
 * Result = m1 * m2 (m2 applied first, then m1).
 *
 * | a1 b1 0 |   | a2 b2 0 |
 * | c1 d1 0 | * | c2 d2 0 |
 * | e1 f1 1 |   | e2 f2 1 |
 */
function multiplyMatrices(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

/** Apply an affine transform to a point. */
function applyTransform(point: { x: number; y: number }, ctm: Matrix): { x: number; y: number } {
  return {
    x: point.x * ctm[0] + point.y * ctm[2] + ctm[4],
    y: point.x * ctm[1] + point.y * ctm[3] + ctm[5],
  };
}

// ─── Color Conversion Helpers ─────────────────────────────────────

/** Convert CMYK (0-1 range) to RGB (0-1 range). */
function cmykToRgb(c: number, m: number, y: number, k: number): RGB {
  return {
    r: (1 - c) * (1 - k),
    g: (1 - m) * (1 - k),
    b: (1 - y) * (1 - k),
  };
}

/** Convert RGB (0-1 range) to hex string "RRGGBB". */
function rgbToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, '0');
  return `${toHex(r)}${toHex(g)}${toHex(b)}`;
}

// ─── Font Resolution ──────────────────────────────────────────────

/** Common PDF font name -> Word-safe font name */
const FONT_MAP: Record<string, string> = {
  'ArialMT': 'Arial',
  'Arial-BoldMT': 'Arial',
  'Arial-ItalicMT': 'Arial',
  'Arial-BoldItalicMT': 'Arial',
  'TimesNewRomanPSMT': 'Times New Roman',
  'TimesNewRomanPS-BoldMT': 'Times New Roman',
  'TimesNewRomanPS-ItalicMT': 'Times New Roman',
  'TimesNewRomanPS-BoldItalicMT': 'Times New Roman',
  'CourierNewPSMT': 'Courier New',
  'CourierNewPS-BoldMT': 'Courier New',
  'Helvetica': 'Arial',
  'Helvetica-Bold': 'Arial',
  'Helvetica-Oblique': 'Arial',
  'Helvetica-BoldOblique': 'Arial',
  'Symbol': 'Symbol',
  'ZapfDingbats': 'Wingdings',
};

/**
 * Resolve a PDF font name to a Word-safe family name.
 * Strips subset prefix (ABCDEF+), maps known names, strips style suffixes.
 */
function resolveFontFamily(pdfFontName: string): string {
  if (!pdfFontName) return 'Calibri';

  // Strip subset prefix like "BCDFGH+"
  let name = pdfFontName.replace(/^[A-Z]{6}\+/, '');

  // Check direct mapping first
  if (FONT_MAP[name]) return FONT_MAP[name];

  // Strip common style suffixes
  name = name.replace(
    /[-,](Bold|Italic|BoldItalic|Regular|Medium|Light|Semibold|Condensed|Narrow|Black|Heavy|Thin|ExtraBold|ExtraLight)$/i,
    ''
  );
  name = name.replace(/MT$/, '');
  name = name.replace(/PS$/, '');

  // Handle hyphenated compound names — if trailing part is a style, drop it
  if (name.includes('-')) {
    const parts = name.split('-');
    if (/^(Bold|Italic|Regular|Medium|Light|Semi|Extra|Condensed)$/i.test(parts[parts.length - 1])) {
      name = parts.slice(0, -1).join('-');
    }
  }

  return name || 'Calibri';
}

/** Detect bold from font name patterns */
function isBoldFont(fontName: string): boolean {
  const lower = fontName.toLowerCase();
  return lower.includes('bold') || lower.includes('-bd') || lower.endsWith('bd');
}

/** Detect italic from font name patterns */
function isItalicFont(fontName: string): boolean {
  const lower = fontName.toLowerCase();
  return lower.includes('italic') || lower.includes('oblique') || lower.includes('-it');
}

// ─── PNG Building Utilities ───────────────────────────────────────

const pngCrcTable: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    }
    table[n] = c;
  }
  return table;
})();

function pngCrc32(data: Uint8Array): number {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = pngCrcTable[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function writeUint32BE(buf: Uint8Array, value: number, offset: number): void {
  buf[offset] = (value >>> 24) & 0xFF;
  buf[offset + 1] = (value >>> 16) & 0xFF;
  buf[offset + 2] = (value >>> 8) & 0xFF;
  buf[offset + 3] = value & 0xFF;
}

function buildPngChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  writeUint32BE(chunk, data.length, 0);
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i);
  }
  chunk.set(data, 8);
  const crcInput = chunk.subarray(4, 8 + data.length);
  const crc = pngCrc32(crcInput);
  writeUint32BE(chunk, crc, 8 + data.length);
  return chunk;
}

/** Build a complete PNG file from IHDR params and pre-compressed IDAT data. */
function buildPng(
  width: number,
  height: number,
  bitDepth: number,
  colorType: number,
  idatData: Uint8Array,
): Uint8Array {
  const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdrData = new Uint8Array(13);
  writeUint32BE(ihdrData, width, 0);
  writeUint32BE(ihdrData, height, 4);
  ihdrData[8] = bitDepth;
  ihdrData[9] = colorType;
  ihdrData[10] = 0; // compression: deflate
  ihdrData[11] = 0; // filter: adaptive
  ihdrData[12] = 0; // interlace: none

  const ihdrChunk = buildPngChunk('IHDR', ihdrData);
  const idatChunk = buildPngChunk('IDAT', idatData);
  const iendChunk = buildPngChunk('IEND', new Uint8Array(0));

  const total = pngSignature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const png = new Uint8Array(total);
  let offset = 0;
  png.set(pngSignature, offset); offset += pngSignature.length;
  png.set(ihdrChunk, offset); offset += ihdrChunk.length;
  png.set(idatChunk, offset); offset += idatChunk.length;
  png.set(iendChunk, offset);
  return png;
}

/** Wrap raw RGBA pixels as a PNG (adds filter byte 0 per row, deflates). */
function wrapRgbaAsPng(
  rgbaPixels: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const rowBytes = width * 4;
  const filteredData = new Uint8Array(height * (rowBytes + 1));
  for (let row = 0; row < height; row++) {
    filteredData[row * (rowBytes + 1)] = 0; // filter byte: None
    const srcOffset = row * rowBytes;
    const dstOffset = row * (rowBytes + 1) + 1;
    filteredData.set(rgbaPixels.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
  }
  const compressedData = pako.deflate(filteredData);
  return buildPng(width, height, 8, 6, compressedData); // colorType 6 = RGBA
}

/** Wrap raw RGB pixels as a PNG (colorType 2, no alpha — 25% smaller than RGBA). */
function wrapRgbAsPng(
  rgbPixels: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const rowBytes = width * 3;
  const filteredData = new Uint8Array(height * (rowBytes + 1));
  for (let row = 0; row < height; row++) {
    filteredData[row * (rowBytes + 1)] = 0; // filter byte: None
    const srcOffset = row * rowBytes;
    const dstOffset = row * (rowBytes + 1) + 1;
    filteredData.set(rgbPixels.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
  }
  const compressedData = pako.deflate(filteredData);
  return buildPng(width, height, 8, 2, compressedData); // colorType 2 = RGB
}

/** Wrap raw grayscale pixels as a PNG (colorType 0 — 75% smaller than RGBA). */
function wrapGrayAsPng(
  grayPixels: Uint8Array,
  width: number,
  height: number,
): Uint8Array {
  const rowBytes = width;
  const filteredData = new Uint8Array(height * (rowBytes + 1));
  for (let row = 0; row < height; row++) {
    filteredData[row * (rowBytes + 1)] = 0; // filter byte: None
    const srcOffset = row * rowBytes;
    const dstOffset = row * (rowBytes + 1) + 1;
    filteredData.set(grayPixels.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
  }
  const compressedData = pako.deflate(filteredData);
  return buildPng(width, height, 8, 0, compressedData); // colorType 0 = Grayscale
}

// ─── PDF Color Space Resolution ───────────────────────────────────

/**
 * Resolve a PDF color space from an image dictionary to component count and PNG color type.
 */
function resolveColorSpace(
  dict: PDFDict,
  context: any,
  hintColors: number,
): { numComponents: number; pngColorType: number } {
  try {
    const csObj = dict.get(PDFName.of('ColorSpace'));

    if (csObj instanceof PDFName) {
      const n = csObj.asString();
      if (n === '/DeviceRGB') return { numComponents: 3, pngColorType: 2 };
      if (n === '/DeviceGray') return { numComponents: 1, pngColorType: 0 };
      if (n === '/DeviceCMYK') return { numComponents: 4, pngColorType: 2 };
    }

    if (csObj) {
      const resolved = csObj instanceof PDFArray ? csObj : context.lookup(csObj);
      if (resolved instanceof PDFArray && resolved.size() >= 2) {
        const first = context.lookup(resolved.get(0));
        if (first instanceof PDFName) {
          const csName = first.asString();
          if (csName === '/ICCBased') {
            const profileRef = resolved.get(1);
            if (profileRef) {
              const profile = context.lookup(profileRef);
              const profDict = profile instanceof PDFDict ? profile : profile?.dict;
              if (profDict instanceof PDFDict) {
                const nObj = profDict.get(PDFName.of('N'));
                if (nObj instanceof PDFNumber) {
                  const n = nObj.asNumber();
                  if (n === 1) return { numComponents: 1, pngColorType: 0 };
                  if (n === 3) return { numComponents: 3, pngColorType: 2 };
                  if (n === 4) return { numComponents: 4, pngColorType: 2 };
                }
              }
            }
          } else if (csName === '/Indexed') {
            // Indexed (palette-based): each pixel is a single index byte.
            // The base color space determines the actual colors, but for extraction
            // purposes, we treat this as 1 component (the palette index).
            // The pdfjs fallback handles palette lookup correctly; for direct extraction,
            // numComponents=1 causes rawPixelsToRgbaPng to treat indices as grayscale,
            // which is a reasonable fallback (better than black).
            return { numComponents: 1, pngColorType: 0 };
          } else if (csName === '/CalRGB') {
            return { numComponents: 3, pngColorType: 2 };
          } else if (csName === '/CalGray') {
            return { numComponents: 1, pngColorType: 0 };
          } else if (csName === '/Lab') {
            return { numComponents: 3, pngColorType: 2 };
          } else if (csName === '/Separation' || csName === '/DeviceN') {
            // Spot colors: typically 1 component per channel
            // Treat as grayscale for direct extraction; pdfjs fallback handles correctly
            return { numComponents: 1, pngColorType: 0 };
          }
        }
      }
    }
  } catch { /* fall through to defaults */ }

  // Fallback: use DecodeParms hint or default to RGB
  if (hintColors === 1) return { numComponents: 1, pngColorType: 0 };
  if (hintColors === 4) return { numComponents: 4, pngColorType: 2 };
  return { numComponents: 3, pngColorType: 2 };
}

// ─── Image Classification ─────────────────────────────────────────

/**
 * Classify whether an image is a genuine photo/diagram or UI chrome.
 *
 * The old architecture produced 234 PNGs from a 13-page form with zero photos.
 * This classifier prevents that by filtering out spacer pixels, decorative 1-bit
 * images, and tiny chrome elements.
 *
 * @param width       Display width in PDF points
 * @param height      Display height in PDF points
 * @param intrinsicW  Native pixel width of the image resource
 * @param intrinsicH  Native pixel height of the image resource
 * @param filterName  PDF stream filter name (e.g., "DCTDecode", "FlateDecode")
 * @param bitsPerComponent Bit depth (1, 2, 4, 8)
 * @returns true if the image is genuine content worth including in DOCX
 */
function classifyImage(
  _displayWidth: number,
  _displayHeight: number,
  intrinsicW: number,
  intrinsicH: number,
  filterName: string,
  bitsPerComponent: number = 8,
): boolean {
  // JPEG (DCTDecode) is always a genuine image — nobody encodes chrome as JPEG
  if (filterName === 'DCTDecode') return true;

  const intrinsicArea = intrinsicW * intrinsicH;

  // Tiny spacer pixels (1x1, 2x2, etc. — common form chrome)
  if (intrinsicArea < 16) return false;

  // 1-bit depth images under 5000 pixels are decorative (checkmarks, borders, bullets)
  if (bitsPerComponent === 1 && intrinsicArea < 5000) return false;

  // Large enough intrinsic area indicates real content
  if (intrinsicArea > 10000) return true;

  // Default: treat small ambiguous images as chrome
  return false;
}

// ─── Image Data Extraction from pdf-lib ───────────────────────────

interface ExtractedImageData {
  data: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
  intrinsicWidth: number;
  intrinsicHeight: number;
  filterName: string;
  bitsPerComponent: number;
}

/**
 * Convert raw pixel data to the most efficient PNG format.
 * Uses RGB (colorType 2) for 3-component, Grayscale (colorType 0) for 1-component,
 * and RGBA (colorType 6) only when alpha is needed.
 * @param invertCmyk If true, CMYK values are inverted (0=full ink, 255=none)
 */
function rawPixelsToRgbaPng(
  pixels: Uint8Array,
  width: number,
  height: number,
  numComponents: number,
  invertCmyk: boolean = false,
): Uint8Array | null {
  const pixelCount = width * height;

  if (numComponents === 4) {
    // CMYK -> RGB conversion (always outputs RGB, not RGBA)
    const rgb = new Uint8Array(pixelCount * 3);
    for (let p = 0; p < pixelCount; p++) {
      let c = pixels[p * 4] / 255;
      let m = pixels[p * 4 + 1] / 255;
      let y = pixels[p * 4 + 2] / 255;
      let k = pixels[p * 4 + 3] / 255;
      if (invertCmyk) { c = 1 - c; m = 1 - m; y = 1 - y; k = 1 - k; }
      rgb[p * 3] = Math.round(255 * (1 - c) * (1 - k));
      rgb[p * 3 + 1] = Math.round(255 * (1 - m) * (1 - k));
      rgb[p * 3 + 2] = Math.round(255 * (1 - y) * (1 - k));
    }
    return wrapRgbAsPng(rgb, width, height);
  } else if (numComponents === 3) {
    // RGB: use efficient RGB PNG (no alpha channel, 25% smaller)
    if (pixels.length >= pixelCount * 3) {
      return wrapRgbAsPng(pixels.subarray(0, pixelCount * 3), width, height);
    }
    return wrapRgbAsPng(pixels, width, height);
  } else if (numComponents === 1) {
    // Grayscale: use efficient grayscale PNG (75% smaller than RGBA)
    if (pixels.length >= pixelCount) {
      return wrapGrayAsPng(pixels.subarray(0, pixelCount), width, height);
    }
    return wrapGrayAsPng(pixels, width, height);
  }

  return null;
}

/**
 * Handle a FlateDecode image stream.
 * If PNG predictor is used with 8-bit RGB/Gray, the compressed bytes can be
 * wrapped directly as a PNG IDAT chunk (both use zlib + PNG row filters).
 * Otherwise, decompress, un-filter, and convert to RGBA PNG.
 */
function handleFlateImage(
  dict: PDFDict,
  rawBytes: Uint8Array,
  width: number,
  height: number,
  context: any,
): Uint8Array | null {
  let predictor = 1;
  let hintColors = 0;

  try {
    const dpObj = dict.get(PDFName.of('DecodeParms'));
    if (dpObj) {
      const dp = dpObj instanceof PDFDict ? dpObj : context.lookup(dpObj);
      if (dp instanceof PDFDict) {
        const predObj = dp.get(PDFName.of('Predictor'));
        if (predObj instanceof PDFNumber) predictor = predObj.asNumber();
        const colorsObj = dp.get(PDFName.of('Colors'));
        if (colorsObj instanceof PDFNumber) hintColors = colorsObj.asNumber();
      }
    }
  } catch { /* use defaults */ }

  const { numComponents, pngColorType } = resolveColorSpace(dict, context, hintColors);
  const bpcObj = dict.get(PDFName.of('BitsPerComponent'));
  const bpc = bpcObj instanceof PDFNumber ? bpcObj.asNumber() : 8;

  // Detect CMYK inversion from Decode array
  // Standard CMYK Decode: [0 1 0 1 0 1 0 1]
  // Inverted CMYK Decode: [1 0 1 0 1 0 1 0]
  let invertCmyk = false;
  if (numComponents === 4) {
    try {
      const decodeObj = dict.get(PDFName.of('Decode'));
      if (decodeObj instanceof PDFArray && decodeObj.size() >= 2) {
        const first = context.lookup(decodeObj.get(0));
        if (first instanceof PDFNumber && first.asNumber() === 1) {
          invertCmyk = true;
        }
      }
    } catch { /* use default */ }
  }

  console.log(`[handleFlateImage] ${width}x${height}, predictor=${predictor}, bpc=${bpc}, numComponents=${numComponents}, pngColorType=${pngColorType}, hintColors=${hintColors}, rawBytes=${rawBytes.length}, first2=[0x${rawBytes[0]?.toString(16)},0x${rawBytes[1]?.toString(16)}]`);

  // Always use the safe path: decompress, then re-encode as PNG.
  // The "fast path" (wrapping compressed bytes directly as IDAT) is unreliable
  // because pdf-lib getContents() may return data in a format incompatible with PNG IDAT.
  try {
    // Try decompression first; if getContents() returned already-decompressed data,
    // inflate will fail — fall back to using raw bytes directly.
    let decompressed: Uint8Array;
    try {
      decompressed = pako.inflate(rawBytes);
    } catch {
      // pdf-lib may return already-decompressed bytes for some PDF structures
      decompressed = rawBytes;
      console.log(`[handleFlateImage] inflate failed — treating rawBytes as already decompressed`);
    }
    const expectedRawSize = height * (1 + width * numComponents); // with predictor filter bytes
    const expectedPlainSize = width * height * numComponents; // without predictor filter bytes
    console.log(`[handleFlateImage] Decompressed: ${decompressed.length} bytes, expectedWithPredictor=${expectedRawSize}, expectedPlain=${expectedPlainSize}`);

    if (predictor >= 10) {
      // Data has PNG row filter bytes — un-filter
      const bytesPerPixel = Math.ceil(numComponents * (bpc / 8));
      const rowDataWidth = width * bytesPerPixel;
      const rowStride = 1 + rowDataWidth;

      // Verify size matches
      if (decompressed.length < height * rowStride) {
        console.warn(`[handleFlateImage] Decompressed size ${decompressed.length} < expected ${height * rowStride} for predictor path. Trying plain pixel path.`);
        // Fall through to plain pixel handling
        return rawPixelsToRgbaPng(decompressed, width, height, numComponents, invertCmyk);
      }

      const rawPixels = new Uint8Array(width * height * bytesPerPixel);
      const prevRow = new Uint8Array(rowDataWidth);

      for (let row = 0; row < height; row++) {
        const rowOffset = row * rowStride;
        const filterType = decompressed[rowOffset];
        const outOffset = row * rowDataWidth;

        for (let x = 0; x < rowDataWidth; x++) {
          const rawIdx = rowOffset + 1 + x;
          const raw = rawIdx < decompressed.length ? decompressed[rawIdx] : 0;
          const a = x >= bytesPerPixel ? rawPixels[outOffset + x - bytesPerPixel] : 0;
          const b = prevRow[x];
          const c = x >= bytesPerPixel ? prevRow[x - bytesPerPixel] : 0;

          let val: number;
          switch (filterType) {
            case 0: val = raw; break;                                   // None
            case 1: val = (raw + a) & 0xFF; break;                     // Sub
            case 2: val = (raw + b) & 0xFF; break;                     // Up
            case 3: val = (raw + Math.floor((a + b) / 2)) & 0xFF; break; // Average
            case 4: {                                                    // Paeth
              const p = a + b - c;
              const pa = Math.abs(p - a);
              const pb = Math.abs(p - b);
              const pc = Math.abs(p - c);
              const pr = (pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c);
              val = (raw + pr) & 0xFF;
              break;
            }
            default: val = raw; break;
          }
          rawPixels[outOffset + x] = val;
        }

        prevRow.set(rawPixels.subarray(outOffset, outOffset + rowDataWidth));
      }

      const result = rawPixelsToRgbaPng(rawPixels, width, height, numComponents, invertCmyk);
      if (result) {
        console.log(`[handleFlateImage] Predictor path produced ${result.length} byte PNG`);
      }
      return result;
    }

    // No predictor — decompressed data is raw pixels
    const result = rawPixelsToRgbaPng(decompressed, width, height, numComponents, invertCmyk);
    if (result) {
      console.log(`[handleFlateImage] Plain path produced ${result.length} byte PNG`);
    }
    return result;
  } catch (e) {
    console.error(`[handleFlateImage] Error:`, e);
    return null;
  }
}

/**
 * Extract raw image data for a single XObject resource from the pdf-lib document.
 *
 * Navigates: pdfLibDoc.getPage(pageIndex).node.Resources() -> XObject dict -> stream
 *
 * For DCTDecode: raw bytes ARE valid JPEG.
 * For FlateDecode: decompress and wrap as PNG, handling PNG predictors and color spaces.
 */
function extractImageData(
  pdfLibDoc: any,
  pageIndex: number,
  resourceName: string,
): ExtractedImageData | null {
  try {
    const pdfLibPage = pdfLibDoc.getPage(pageIndex);
    if (!pdfLibPage) return null;

    const context = pdfLibDoc.context;
    const resources = pdfLibPage.node.Resources();
    if (!resources) return null;

    const xObjEntry = resources.get(PDFName.of('XObject'));
    if (!xObjEntry) return null;

    const xObjectDict = xObjEntry instanceof PDFDict ? xObjEntry : context.lookup(xObjEntry);
    if (!(xObjectDict instanceof PDFDict)) return null;

    // Look up the specific resource by name
    const ref = xObjectDict.get(PDFName.of(resourceName));
    if (!ref) return null;

    const stream = context.lookup(ref);
    if (!(stream instanceof PDFRawStream)) return null;

    const dict = stream.dict;

    // Must be an Image XObject
    const subtype = dict.get(PDFName.of('Subtype'));
    if (!(subtype instanceof PDFName) || subtype !== PDFName.of('Image')) return null;

    // Get intrinsic dimensions
    const widthObj = dict.get(PDFName.of('Width'));
    const heightObj = dict.get(PDFName.of('Height'));
    const intrinsicWidth = widthObj instanceof PDFNumber ? widthObj.asNumber() : 0;
    const intrinsicHeight = heightObj instanceof PDFNumber ? heightObj.asNumber() : 0;
    if (intrinsicWidth <= 0 || intrinsicHeight <= 0) return null;

    // Bits per component
    const bpcObj = dict.get(PDFName.of('BitsPerComponent'));
    const bpc = bpcObj instanceof PDFNumber ? bpcObj.asNumber() : 8;

    // Determine filter
    const filterObj = dict.get(PDFName.of('Filter'));
    let filterName = '';
    let multiFilter = false;
    if (filterObj instanceof PDFName) {
      filterName = filterObj.asString().replace(/^\//, '');
    } else if (filterObj instanceof PDFArray) {
      if (filterObj.size() === 1) {
        const first = context.lookup(filterObj.get(0));
        if (first instanceof PDFName) filterName = first.asString().replace(/^\//, '');
      } else {
        multiFilter = true;
        const first = context.lookup(filterObj.get(0));
        if (first instanceof PDFName) filterName = first.asString().replace(/^\//, '');
      }
    }

    const rawBytes = stream.getContents();
    if (!rawBytes || rawBytes.length === 0) return null;

    if (filterName === 'DCTDecode' && !multiFilter) {
      // JPEG: raw bytes ARE a valid JPEG file
      if (rawBytes.length >= 2 && rawBytes[0] === 0xFF && rawBytes[1] === 0xD8) {
        return {
          data: new Uint8Array(rawBytes),
          mimeType: 'image/jpeg',
          intrinsicWidth,
          intrinsicHeight,
          filterName,
          bitsPerComponent: bpc,
        };
      }
    } else if (filterName === 'FlateDecode' && !multiFilter) {
      const pngResult = handleFlateImage(dict, rawBytes, intrinsicWidth, intrinsicHeight, context);
      if (pngResult) {
        return {
          data: pngResult,
          mimeType: 'image/png',
          intrinsicWidth,
          intrinsicHeight,
          filterName,
          bitsPerComponent: bpc,
        };
      }
    } else if (!filterName && !multiFilter) {
      // Uncompressed raw pixels
      if (bpc === 8) {
        const { numComponents } = resolveColorSpace(dict, context, 0);
        const pngResult = rawPixelsToRgbaPng(rawBytes, intrinsicWidth, intrinsicHeight, numComponents);
        if (pngResult) {
          return {
            data: pngResult,
            mimeType: 'image/png',
            intrinsicWidth,
            intrinsicHeight,
            filterName: '',
            bitsPerComponent: bpc,
          };
        }
      }
    }

    // Unsupported filter (CCITTFaxDecode, JBIG2Decode, JPXDecode, etc.)
    return null;
  } catch {
    return null;
  }
}

/**
 * Attempt to find all XObject image resource names on a page.
 * Returns a map of resource name -> { intrinsicWidth, intrinsicHeight, filterName, bpc }.
 */
function getPageImageResourceInfo(
  pdfLibDoc: any,
  pageIndex: number,
): Map<string, { intrinsicWidth: number; intrinsicHeight: number; filterName: string; bpc: number }> {
  const result = new Map<string, { intrinsicWidth: number; intrinsicHeight: number; filterName: string; bpc: number }>();

  try {
    const pdfLibPage = pdfLibDoc.getPage(pageIndex);
    if (!pdfLibPage) return result;

    const context = pdfLibDoc.context;
    const resources = pdfLibPage.node.Resources();
    if (!resources) return result;

    const xObjEntry = resources.get(PDFName.of('XObject'));
    if (!xObjEntry) return result;

    const xObjectDict = xObjEntry instanceof PDFDict ? xObjEntry : context.lookup(xObjEntry);
    if (!(xObjectDict instanceof PDFDict)) return result;

    for (const [nameObj, ref] of xObjectDict.entries()) {
      try {
        const name = nameObj instanceof PDFName
          ? nameObj.asString().replace(/^\//, '')
          : String(nameObj);

        const stream = context.lookup(ref);
        if (!(stream instanceof PDFRawStream)) continue;

        const dict = stream.dict;
        const subtype = dict.get(PDFName.of('Subtype'));
        if (!(subtype instanceof PDFName) || subtype !== PDFName.of('Image')) continue;

        const widthObj = dict.get(PDFName.of('Width'));
        const heightObj = dict.get(PDFName.of('Height'));
        const w = widthObj instanceof PDFNumber ? widthObj.asNumber() : 0;
        const h = heightObj instanceof PDFNumber ? heightObj.asNumber() : 0;
        if (w <= 0 || h <= 0) continue;

        const bpcObj = dict.get(PDFName.of('BitsPerComponent'));
        const bpc = bpcObj instanceof PDFNumber ? bpcObj.asNumber() : 8;

        const filterObj = dict.get(PDFName.of('Filter'));
        let filterName = '';
        if (filterObj instanceof PDFName) {
          filterName = filterObj.asString().replace(/^\//, '');
        } else if (filterObj instanceof PDFArray && filterObj.size() >= 1) {
          const first = context.lookup(filterObj.get(0));
          if (first instanceof PDFName) filterName = first.asString().replace(/^\//, '');
        }

        result.set(name, { intrinsicWidth: w, intrinsicHeight: h, filterName, bpc });
      } catch {
        // Skip problematic entries
      }
    }
  } catch {
    // Resource enumeration failed
  }

  return result;
}

// ─── pdfjs Fallback: Decoded Pixel Data ───────────────────────────

/**
 * Use pdfjs's internal image decoders as a universal fallback.
 *
 * pdfjs-dist can decode ALL PDF image formats (DCTDecode, FlateDecode,
 * CCITTFaxDecode, JBIG2Decode, JPXDecode, LZWDecode, etc.) because it
 * implements complete PDF rendering. When our direct extraction fails,
 * we can retrieve the fully decoded pixel data from pdfjs's object store.
 *
 * This is what makes us match Adobe Acrobat's image handling — every
 * image type is supported through pdfjs's decoders.
 *
 * @returns PNG bytes or null if pdfjs also can't decode it
 */
function extractImageFromPdfjs(
  pdfjsPage: any,
  objId: string,
): Uint8Array | null {
  try {
    // pdfjs resolves decoded images into page.objs or page.commonObjs
    let imgData: any = null;

    if (pdfjsPage.objs?.has(objId)) {
      imgData = pdfjsPage.objs.get(objId);
    } else if (pdfjsPage.commonObjs?.has(objId)) {
      imgData = pdfjsPage.commonObjs.get(objId);
    }

    if (!imgData || (!imgData.data && !imgData.bitmap)) {
      return null;
    }

    const width = imgData.width;
    const height = imgData.height;
    if (!width || !height) return null;

    // imgData.kind: 1=GRAYSCALE_1BPP, 2=RGB_24BPP, 3=RGBA_32BPP
    const kind = imgData.kind || 3;
    const pixels: Uint8Array = imgData.data;
    if (!pixels || pixels.length === 0) return null;

    // Use the most efficient PNG format based on pixel kind
    const pixelCount = width * height;

    if (kind === 1) {
      // 1-bit grayscale: unpack to 8-bit grayscale PNG
      const gray = new Uint8Array(pixelCount);
      for (let p = 0; p < pixelCount; p++) {
        const byteIdx = Math.floor(p / 8);
        const bitIdx = 7 - (p % 8);
        const bit = (pixels[byteIdx] >> bitIdx) & 1;
        gray[p] = bit ? 0 : 255; // In PDF, 1 = black, 0 = white
      }
      return wrapGrayAsPng(gray, width, height);
    } else if (kind === 2) {
      // RGB 24bpp — use RGB PNG directly (no alpha overhead)
      return wrapRgbAsPng(pixels.subarray(0, pixelCount * 3), width, height);
    } else {
      // RGBA 32bpp — only case that needs alpha
      return wrapRgbaAsPng(pixels.subarray(0, pixelCount * 4), width, height);
    }
  } catch (e) {
    console.warn(`[PageAnalyzer] pdfjs fallback failed for ${objId}:`, e);
    return null;
  }
}

// ─── Graphics State Machine ───────────────────────────────────────

interface GraphicsState {
  fillColor: RGB;
  strokeColor: RGB;
  lineWidth: number;
  ctm: Matrix;
}

interface PathOp {
  type: 'moveTo' | 'lineTo' | 'curveTo' | 'closePath' | 'rectangle';
  args: number[];
}

/**
 * Parse the pdfjs-dist operator list, maintaining a full graphics state machine,
 * and emit SceneElements for every visible graphic operation.
 *
 * Text is NOT handled here — pdfjs getTextContent() is far more accurate for text
 * extraction because it handles font encoding, CID maps, ToUnicode, etc.
 * This function handles: rectangles, paths, and images.
 */
function parseOperatorList(
  opList: { fnArray: number[]; argsArray: any[] },
  _pageWidth: number,
  pageHeight: number,
  pdfLibDoc: any,
  pageIndex: number,
  pdfjsPage: any,
): SceneElement[] {
  const elements: SceneElement[] = [];
  const { fnArray, argsArray } = opList;

  // Build resource info map for image classification (filter, bpc, etc.)
  let resourceInfo: Map<string, { intrinsicWidth: number; intrinsicHeight: number; filterName: string; bpc: number }>;
  try {
    resourceInfo = pdfLibDoc ? getPageImageResourceInfo(pdfLibDoc, pageIndex) : new Map();
  } catch {
    resourceInfo = new Map();
  }

  // Track used resource names to prevent collision when multiple images share dimensions
  const usedResourceNames = new Set<string>();

  // Graphics state
  const defaultState: GraphicsState = {
    fillColor: { r: 0, g: 0, b: 0 },
    strokeColor: { r: 0, g: 0, b: 0 },
    lineWidth: 1,
    ctm: [...IDENTITY] as Matrix,
  };

  let state: GraphicsState = { ...defaultState, ctm: [...IDENTITY] as Matrix };
  const stateStack: GraphicsState[] = [];

  // Path accumulator
  let pathOps: PathOp[] = [];

  /**
   * Flush accumulated path ops as either a RectElement or PathElement.
   * Called on stroke, fill, fillStroke, and variants.
   */
  function flushPath(doFill: boolean, doStroke: boolean): void {
    if (pathOps.length === 0) return;

    // Single rectangle op -> RectElement
    if (pathOps.length === 1 && pathOps[0].type === 'rectangle') {
      const [rx, ry, rw, rh] = pathOps[0].args;

      // Transform the rectangle corners through CTM
      const p0 = applyTransform({ x: rx, y: ry }, state.ctm);
      const p1 = applyTransform({ x: rx + rw, y: ry + rh }, state.ctm);

      const minX = Math.min(p0.x, p1.x);
      const minY = Math.min(p0.y, p1.y);
      const maxX = Math.max(p0.x, p1.x);
      const maxY = Math.max(p0.y, p1.y);

      const w = maxX - minX;
      const h = maxY - minY;

      // Flip Y: top-left origin
      const yTopLeft = pageHeight - maxY;

      elements.push({
        kind: 'rect',
        x: minX,
        y: yTopLeft,
        width: w,
        height: h,
        fillColor: doFill ? { ...state.fillColor } : null,
        strokeColor: doStroke ? { ...state.strokeColor } : null,
        lineWidth: state.lineWidth,
      });

      pathOps = [];
      return;
    }

    // General path -> PathElement
    const points: Array<{ x: number; y: number }> = [];
    let isClosed = false;

    for (const op of pathOps) {
      switch (op.type) {
        case 'moveTo': {
          const pt = applyTransform({ x: op.args[0], y: op.args[1] }, state.ctm);
          points.push({ x: pt.x, y: pageHeight - pt.y });
          break;
        }
        case 'lineTo': {
          const pt = applyTransform({ x: op.args[0], y: op.args[1] }, state.ctm);
          points.push({ x: pt.x, y: pageHeight - pt.y });
          break;
        }
        case 'curveTo': {
          // Cubic bezier: approximate with the endpoint for the scene graph
          // (Full bezier control points are rarely needed for DOCX conversion)
          // args = [x1, y1, x2, y2, x3, y3] (control1, control2, endpoint)
          const cp1 = applyTransform({ x: op.args[0], y: op.args[1] }, state.ctm);
          const cp2 = applyTransform({ x: op.args[2], y: op.args[3] }, state.ctm);
          const ep = applyTransform({ x: op.args[4], y: op.args[5] }, state.ctm);
          points.push({ x: cp1.x, y: pageHeight - cp1.y });
          points.push({ x: cp2.x, y: pageHeight - cp2.y });
          points.push({ x: ep.x, y: pageHeight - ep.y });
          break;
        }
        case 'rectangle': {
          // Multi-rect path: expand to 4 corners
          const [rx, ry, rw, rh] = op.args;
          const corners = [
            { x: rx, y: ry },
            { x: rx + rw, y: ry },
            { x: rx + rw, y: ry + rh },
            { x: rx, y: ry + rh },
          ];
          for (const corner of corners) {
            const pt = applyTransform(corner, state.ctm);
            points.push({ x: pt.x, y: pageHeight - pt.y });
          }
          isClosed = true;
          break;
        }
        case 'closePath': {
          isClosed = true;
          break;
        }
      }
    }

    if (points.length > 0) {
      elements.push({
        kind: 'path',
        points,
        fillColor: doFill ? { ...state.fillColor } : null,
        strokeColor: doStroke ? { ...state.strokeColor } : null,
        lineWidth: state.lineWidth,
        isClosed,
      });
    }

    pathOps = [];
  }

  // Walk the operator list
  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];

    switch (op) {
      // ── Graphics state stack ──
      case OPS.save: {
        stateStack.push({
          fillColor: { ...state.fillColor },
          strokeColor: { ...state.strokeColor },
          lineWidth: state.lineWidth,
          ctm: [...state.ctm] as Matrix,
        });
        break;
      }
      case OPS.restore: {
        const prev = stateStack.pop();
        if (prev) {
          state = prev;
        }
        break;
      }

      // ── Transform ──
      case OPS.transform: {
        const tm: Matrix = [args[0], args[1], args[2], args[3], args[4], args[5]];
        state.ctm = multiplyMatrices(state.ctm, tm);
        break;
      }

      // ── Line width ──
      case OPS.setLineWidth: {
        state.lineWidth = args[0];
        break;
      }

      // ── Color: Fill ──
      case OPS.setFillRGBColor: {
        state.fillColor = { r: args[0], g: args[1], b: args[2] };
        break;
      }
      case OPS.setFillGray: {
        const g = args[0];
        state.fillColor = { r: g, g: g, b: g };
        break;
      }
      case OPS.setFillCMYKColor: {
        state.fillColor = cmykToRgb(args[0], args[1], args[2], args[3]);
        break;
      }

      // ── Color: Stroke ──
      case OPS.setStrokeRGBColor: {
        state.strokeColor = { r: args[0], g: args[1], b: args[2] };
        break;
      }
      case OPS.setStrokeGray: {
        const g = args[0];
        state.strokeColor = { r: g, g: g, b: g };
        break;
      }
      case OPS.setStrokeCMYKColor: {
        state.strokeColor = cmykToRgb(args[0], args[1], args[2], args[3]);
        break;
      }

      // ── Path construction ──
      case OPS.moveTo: {
        pathOps.push({ type: 'moveTo', args: [args[0], args[1]] });
        break;
      }
      case OPS.lineTo: {
        pathOps.push({ type: 'lineTo', args: [args[0], args[1]] });
        break;
      }
      case OPS.curveTo: {
        pathOps.push({ type: 'curveTo', args: [args[0], args[1], args[2], args[3], args[4], args[5]] });
        break;
      }
      case OPS.curveTo2: {
        // curveTo2: current point as first control point
        // args = [x2, y2, x3, y3]
        // We need the current point — approximate by repeating first control point
        // In practice, use last accumulated point as cp1
        const lastPt = getLastPathPoint(pathOps);
        pathOps.push({
          type: 'curveTo',
          args: [lastPt.x, lastPt.y, args[0], args[1], args[2], args[3]],
        });
        break;
      }
      case OPS.curveTo3: {
        // curveTo3: endpoint as second control point
        // args = [x1, y1, x3, y3]
        pathOps.push({
          type: 'curveTo',
          args: [args[0], args[1], args[2], args[3], args[2], args[3]],
        });
        break;
      }
      case OPS.closePath: {
        pathOps.push({ type: 'closePath', args: [] });
        break;
      }
      case OPS.rectangle: {
        pathOps.push({ type: 'rectangle', args: [args[0], args[1], args[2], args[3]] });
        break;
      }

      // ── Path painting ──
      case OPS.stroke: {
        flushPath(false, true);
        break;
      }
      case OPS.closeStroke: {
        pathOps.push({ type: 'closePath', args: [] });
        flushPath(false, true);
        break;
      }
      case OPS.fill:
      case OPS.eoFill: {
        flushPath(true, false);
        break;
      }
      case OPS.fillStroke:
      case OPS.eoFillStroke: {
        flushPath(true, true);
        break;
      }
      case OPS.closeFillStroke: {
        pathOps.push({ type: 'closePath', args: [] });
        flushPath(true, true);
        break;
      }
      case OPS.endPath: {
        // Discard current path without painting
        pathOps = [];
        break;
      }

      // ── Images ──
      case OPS.paintImageXObject:
      case OPS.paintJpegXObject: {
        const objId: string = args[0] || '';
        // pdfjs passes intrinsic dimensions as args[1] and args[2] for paintJpegXObject
        const hintW: number = args[1] || 0;
        const hintH: number = args[2] || 0;

        // The CTM at image paint time defines the image's display geometry.
        // In PDF, images are painted into a 1x1 unit square, and the CTM
        // scales/positions them.
        const ctm = state.ctm;

        // Display dimensions from CTM (absolute values handle flipped images)
        const displayWidth = Math.sqrt(ctm[0] * ctm[0] + ctm[1] * ctm[1]);
        const displayHeight = Math.sqrt(ctm[2] * ctm[2] + ctm[3] * ctm[3]);

        // Position: CTM translation gives the bottom-left corner of the image
        const xPdf = ctm[4];
        const yPdf = ctm[5];

        // Handle negative scale (flipped images): adjust origin
        const effectiveHeight = Math.abs(ctm[3]) > 0.001 ? Math.abs(ctm[3]) : displayHeight;
        const yBottomLeft = ctm[3] < 0 ? yPdf + ctm[3] : yPdf;

        // Flip Y to top-left origin
        const yTopLeft = pageHeight - yBottomLeft - effectiveHeight;

        // Resolve resource name from objId.
        // pdfjs generates IDs like "img_p0_1" — we need the PDF resource name (e.g., "Im0").
        // Strategy: direct match first, then dimension match (tracking used resources to avoid collisions).
        let resourceName = objId;
        let intrinsicW = hintW;
        let intrinsicH = hintH;
        let filterName = '';
        let bpc = 8;

        // Try direct resource name match first (some pdfjs versions use the actual name)
        if (resourceInfo.has(objId)) {
          const info = resourceInfo.get(objId)!;
          intrinsicW = info.intrinsicWidth;
          intrinsicH = info.intrinsicHeight;
          filterName = info.filterName;
          bpc = info.bpc;
        } else {
          // Dimension-based matching: find resource with matching intrinsic dimensions.
          // Track already-matched resources to avoid collisions when multiple images share dimensions.
          let matched = false;
          for (const [name, info] of resourceInfo) {
            if (usedResourceNames.has(name)) continue; // Skip already-matched resources

            if (hintW > 0 && hintH > 0 && info.intrinsicWidth === hintW && info.intrinsicHeight === hintH) {
              resourceName = name;
              intrinsicW = info.intrinsicWidth;
              intrinsicH = info.intrinsicHeight;
              filterName = info.filterName;
              bpc = info.bpc;
              matched = true;
              break;
            }
          }
          // Last resort: if no dimension match, try first unused resource
          if (!matched && hintW === 0 && hintH === 0) {
            for (const [name, info] of resourceInfo) {
              if (usedResourceNames.has(name)) continue;
              resourceName = name;
              intrinsicW = info.intrinsicWidth;
              intrinsicH = info.intrinsicHeight;
              filterName = info.filterName;
              bpc = info.bpc;
              break;
            }
          }
        }
        usedResourceNames.add(resourceName);

        // For paintJpegXObject, filter is always DCTDecode
        if (op === OPS.paintJpegXObject) {
          filterName = 'DCTDecode';
        }

        // Classify the image
        const isGenuine = classifyImage(
          displayWidth,
          displayHeight,
          intrinsicW,
          intrinsicH,
          filterName,
          bpc,
        );

        // Extract actual image bytes: try pdf-lib direct extraction first, then pdfjs fallback
        let imageData: Uint8Array | null = null;
        let mimeType: 'image/jpeg' | 'image/png' = filterName === 'DCTDecode' ? 'image/jpeg' : 'image/png';

        console.log(`[PageAnalyzer] Image: objId=${objId}, resourceName=${resourceName}, intrinsic=${intrinsicW}x${intrinsicH}, display=${displayWidth.toFixed(1)}x${effectiveHeight.toFixed(1)}, filter=${filterName}, bpc=${bpc}, isGenuine=${isGenuine}`);

        if (isGenuine) {
          // Strategy 1: Direct extraction via pdf-lib (fastest, lossless for JPEG)
          if (pdfLibDoc) {
            const extracted = extractImageData(pdfLibDoc, pageIndex, resourceName);
            if (extracted) {
              imageData = extracted.data;
              mimeType = extracted.mimeType;
              intrinsicW = extracted.intrinsicWidth;
              intrinsicH = extracted.intrinsicHeight;
              console.log(`[PageAnalyzer]   -> Extracted ${extracted.mimeType}, ${extracted.data.length} bytes, ${intrinsicW}x${intrinsicH}`);
            }
          }

          // Strategy 2: pdfjs decoded pixel data fallback (handles ALL formats)
          // Used when pdf-lib can't extract (CCITTFaxDecode, JBIG2Decode, JPXDecode,
          // Indexed color spaces, multi-filter chains, LZWDecode, etc.)
          if (!imageData && pdfjsPage) {
            const fallbackPng = extractImageFromPdfjs(pdfjsPage, objId);
            if (fallbackPng) {
              imageData = fallbackPng;
              mimeType = 'image/png';
              console.log(`[PageAnalyzer]   -> pdfjs fallback: ${fallbackPng.length} bytes PNG`);
            } else {
              console.warn(`[PageAnalyzer]   -> BOTH extraction methods failed for "${resourceName}" (objId=${objId}) on page ${pageIndex}`);
            }
          }
        }

        elements.push({
          kind: 'image',
          x: xPdf,
          y: yTopLeft,
          width: displayWidth,
          height: effectiveHeight,
          resourceName,
          intrinsicWidth: intrinsicW,
          intrinsicHeight: intrinsicH,
          isGenuine,
          data: imageData,
          mimeType,
        });

        break;
      }

      // All other ops (text ops, color space setting, etc.) are ignored here.
      // Text is extracted separately via getTextContent() for accuracy.
      default:
        break;
    }
  }

  // Flush any remaining path ops (shouldn't happen in well-formed PDFs, but be safe)
  if (pathOps.length > 0) {
    flushPath(false, false);
  }

  return elements;
}

/**
 * Get the last point from accumulated path ops (for curveTo2 which needs current point).
 */
function getLastPathPoint(pathOps: PathOp[]): { x: number; y: number } {
  for (let i = pathOps.length - 1; i >= 0; i--) {
    const op = pathOps[i];
    switch (op.type) {
      case 'moveTo':
      case 'lineTo':
        return { x: op.args[0], y: op.args[1] };
      case 'curveTo':
        // Last point is the endpoint (args[4], args[5])
        return { x: op.args[4], y: op.args[5] };
      case 'rectangle':
        return { x: op.args[0], y: op.args[1] };
      case 'closePath':
        // closePath returns to the moveTo — keep searching backward
        continue;
    }
  }
  return { x: 0, y: 0 };
}

// ─── Text Extraction ──────────────────────────────────────────────

/**
 * Convert pdfjs-dist text content items into typed TextElements.
 *
 * pdfjs getTextContent() handles all the font encoding complexity:
 * CID maps, ToUnicode, ligatures, etc. We just extract position and formatting.
 */
function convertTextItems(
  textContent: any,
  pageHeight: number,
): TextElement[] {
  const results: TextElement[] = [];

  // Build font name resolution map from pdfjs styles metadata
  const fontNameMap: Record<string, string> = {};
  const styles = textContent.styles;
  if (styles && typeof styles === 'object') {
    for (const [internalId, styleObj] of Object.entries(styles)) {
      const s = styleObj as any;
      if (s && s.fontFamily) {
        fontNameMap[internalId] = s.fontFamily;
      }
    }
  }

  for (const item of textContent.items) {
    const ti = item as any;
    if (!ti.str || !ti.str.trim()) continue;

    const transform = ti.transform;
    if (!transform || transform.length < 6) continue;

    // Font size from the text matrix: sqrt(a^2 + b^2)
    const fontSize = Math.sqrt(transform[0] * transform[0] + transform[1] * transform[1]);
    if (fontSize <= 0) continue;

    const x = transform[4];
    const height = ti.height || fontSize * 1.2;
    // pdfjs uses bottom-left origin; convert to top-left
    const y = pageHeight - transform[5] - height;
    const width = ti.width || (ti.str.length * fontSize * 0.5);

    // Resolve internal font name to actual font family
    const rawFontName = ti.fontName || 'default';
    const resolvedFontFamily = fontNameMap[rawFontName] || rawFontName;
    const mappedFont = resolveFontFamily(resolvedFontFamily);

    const bold = isBoldFont(resolvedFontFamily);
    const italic = isItalicFont(resolvedFontFamily);

    // pdfjs textContent does not expose color directly; default to black.
    // The operator list could theoretically be cross-referenced for color,
    // but text positioning from textContent is far more reliable.
    const color = rgbToHex(0, 0, 0);

    results.push({
      kind: 'text',
      text: ti.str,
      x,
      y,
      width,
      height,
      fontName: mappedFont,
      fontSize,
      bold,
      italic,
      color,
    });
  }

  return results;
}

// ─── Form Field Extraction ────────────────────────────────────────

/**
 * Extract form fields from Widget annotations on a page.
 * Filters to Tx/Btn/Ch types, skips push buttons, resolves checked state.
 */
async function extractFormFields(
  page: any,
  pageHeight: number,
): Promise<FormField[]> {
  const fields: FormField[] = [];

  try {
    const annotations = await page.getAnnotations({ intent: 'display' });

    const widgetAnnotations = annotations.filter(
      (a: any) => a.subtype === 'Widget' && a.fieldType
    );

    for (const widget of widgetAnnotations) {
      if (!widget.rect || widget.rect.length < 4) continue;

      // Skip push buttons (submit/reset) — not form data
      if (widget.pushButton) continue;

      const [x1, y1, x2, y2] = widget.rect;

      // Determine checked state for Btn fields
      let isChecked = false;
      if (widget.fieldType === 'Btn') {
        isChecked = widget.fieldValue !== 'Off' && widget.fieldValue !== '' &&
                    widget.fieldValue !== undefined && widget.fieldValue !== null;
      }

      // Build options for Ch (choice) fields
      const options: Array<{ exportValue: string; displayValue: string }> = [];
      if (widget.options && Array.isArray(widget.options)) {
        for (const o of widget.options) {
          if (typeof o === 'string') {
            options.push({ exportValue: o, displayValue: o });
          } else {
            options.push({
              exportValue: o.exportValue || String(o),
              displayValue: o.displayValue || o.exportValue || String(o),
            });
          }
        }
      }

      fields.push({
        fieldType: widget.fieldType,
        fieldName: widget.fieldName || '',
        fieldValue: typeof widget.fieldValue === 'string' ? widget.fieldValue : '',
        isCheckBox: widget.checkBox === true,
        isRadioButton: widget.radioButton === true,
        isChecked,
        options,
        readOnly: widget.readOnly || false,
        rect: widget.rect as [number, number, number, number],
        x: x1,
        y: pageHeight - y2, // flip to top-left origin
        width: x2 - x1,
        height: y2 - y1,
        maxLength: widget.maxLen || 0,
      });
    }
  } catch {
    // Form field extraction failure is non-fatal
  }

  return fields;
}

// ─── Main Entry Point ─────────────────────────────────────────────

/**
 * Analyze a single PDF page and build its complete scene graph.
 *
 * This is the unified entry point that replaces the old multi-pass approach.
 * ONE call produces all text, graphics, images, and form fields for a page,
 * with every element positioned in a consistent top-left coordinate system.
 *
 * @param page        pdfjs-dist page proxy (from getDocument().getPage())
 * @param pdfLibDoc   pdf-lib PDFDocument (for original image stream bytes)
 * @param pageIndex   0-based page index
 * @returns Complete scene graph with all visible elements and form fields
 */
// ─── Test Exports ─────────────────────────────────────────────────
// These are exported for unit testing only. Do not use in production code.
export const _testExports = {
  multiplyMatrices,
  applyTransform,
  cmykToRgb,
  rgbToHex,
  resolveFontFamily,
  classifyImage,
  isBoldFont,
  isItalicFont,
};

export async function analyzePage(
  page: any,
  pdfLibDoc: any,
  pageIndex: number,
): Promise<PageScene> {
  const viewport = page.getViewport({ scale: 1 });
  const pageWidth = viewport.width;
  const pageHeight = viewport.height;

  // Run all three extraction passes in parallel for speed.
  // They are independent: operator list, text content, and annotations.
  const [opList, textContent, formFields] = await Promise.all([
    page.getOperatorList().catch(() => ({ fnArray: [], argsArray: [] })),
    page.getTextContent().catch(() => ({ items: [], styles: {} })),
    extractFormFields(page, pageHeight),
  ]);

  // Parse operator list for graphics (rects, paths, images)
  const graphicsElements = parseOperatorList(
    opList,
    pageWidth,
    pageHeight,
    pdfLibDoc,
    pageIndex,
    page,
  );

  // Convert text content items to TextElements
  const textElements = convertTextItems(textContent, pageHeight);

  // Merge all scene elements
  const elements: SceneElement[] = [
    ...textElements,
    ...graphicsElements,
  ];

  return {
    elements,
    formFields,
    width: pageWidth,
    height: pageHeight,
  };
}
