/**
 * Image Extractor
 *
 * Extracts original image bytes from PDF XObject streams using pdf-lib.
 * - DCTDecode (JPEG) streams: raw bytes ARE the JPEG — extracted directly
 * - FlateDecode (PNG-compatible) streams: decompressed and wrapped as PNG
 * - Preserves original format to avoid re-encoding bloat
 */

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFRawStream,
  PDFArray,
  PDFRef,
  PDFStream,
  decodePDFRawStream,
} from 'pdf-lib';
import pako from 'pako';
import type { ExtractedImage } from './types';

/** CRC-32 for PNG chunk integrity */
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

/**
 * Write a 4-byte big-endian unsigned integer into a buffer at the given offset.
 */
function writeUint32BE(buf: Uint8Array, value: number, offset: number): void {
  buf[offset] = (value >>> 24) & 0xFF;
  buf[offset + 1] = (value >>> 16) & 0xFF;
  buf[offset + 2] = (value >>> 8) & 0xFF;
  buf[offset + 3] = value & 0xFF;
}

/**
 * Wraps raw RGB/Gray pixel data into a valid PNG file.
 */
function wrapAsPng(
  rawPixels: Uint8Array,
  width: number,
  height: number,
  colorType: number,
  bitsPerComponent: number
): Uint8Array {
  // colorType: 0 = Grayscale, 2 = RGB, 6 = RGBA
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
  const bytesPerPixel = channels * (bitsPerComponent / 8);
  const rowBytes = Math.ceil(width * bytesPerPixel);

  // Add filter byte (0 = None) to each row
  const filteredData = new Uint8Array(height * (rowBytes + 1));
  for (let row = 0; row < height; row++) {
    filteredData[row * (rowBytes + 1)] = 0; // filter: None
    const srcOffset = row * rowBytes;
    const dstOffset = row * (rowBytes + 1) + 1;
    filteredData.set(rawPixels.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
  }

  const compressedData = pako.deflate(filteredData);

  // Build PNG file
  const pngSignature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

  // IHDR chunk (13 bytes data)
  const ihdrData = new Uint8Array(13);
  writeUint32BE(ihdrData, width, 0);
  writeUint32BE(ihdrData, height, 4);
  ihdrData[8] = bitsPerComponent; // bit depth
  ihdrData[9] = colorType;
  ihdrData[10] = 0; // compression method
  ihdrData[11] = 0; // filter method
  ihdrData[12] = 0; // interlace method

  const ihdrChunk = buildPngChunk('IHDR', ihdrData);
  const idatChunk = buildPngChunk('IDAT', compressedData);
  const iendChunk = buildPngChunk('IEND', new Uint8Array(0));

  // Concatenate
  const totalLength = pngSignature.length + ihdrChunk.length + idatChunk.length + iendChunk.length;
  const png = new Uint8Array(totalLength);
  let offset = 0;
  png.set(pngSignature, offset); offset += pngSignature.length;
  png.set(ihdrChunk, offset); offset += ihdrChunk.length;
  png.set(idatChunk, offset); offset += idatChunk.length;
  png.set(iendChunk, offset);

  return png;
}

function buildPngChunk(type: string, data: Uint8Array): Uint8Array {
  // chunk = length(4) + type(4) + data + crc(4)
  const chunk = new Uint8Array(12 + data.length);
  writeUint32BE(chunk, data.length, 0);

  // Type bytes
  for (let i = 0; i < 4; i++) {
    chunk[4 + i] = type.charCodeAt(i);
  }

  // Data
  chunk.set(data, 8);

  // CRC over type + data
  const crcInput = chunk.subarray(4, 8 + data.length);
  const crc = pngCrc32(crcInput);
  writeUint32BE(chunk, crc, 8 + data.length);

  return chunk;
}

/**
 * Resolve a value from a PDF dictionary, following PDFRef references.
 */
function resolveValue(dict: PDFDict, key: PDFName, pdfDoc: PDFDocument): any {
  const val = dict.get(key);
  if (!val) return undefined;
  if (val instanceof PDFRef) {
    return pdfDoc.context.lookup(val);
  }
  return val;
}

/**
 * Get a numeric value from a PDF object.
 */
function getNumber(obj: any): number | undefined {
  if (!obj) return undefined;
  if (typeof obj === 'number') return obj;
  if (obj && typeof obj.asNumber === 'function') return obj.asNumber();
  if (obj && typeof obj.value === 'function') return obj.value();
  if (obj && typeof obj.numberValue === 'function') return obj.numberValue();
  return undefined;
}

/**
 * Count unique colors in raw pixel data by sampling.
 * Samples up to ~10,000 pixels for performance on large images.
 * Returns the number of distinct colors found (capped once we exceed a threshold).
 */
function countUniqueColors(
  rawPixels: Uint8Array,
  width: number,
  height: number,
  channels: number
): number {
  const totalPixels = width * height;
  // Sample every Nth pixel — at most ~10,000 samples
  const step = Math.max(1, Math.floor(totalPixels / 10000));
  const colors = new Set<number>();

  for (let i = 0; i < totalPixels; i += step) {
    const offset = i * channels;
    if (offset + Math.min(channels, 3) > rawPixels.length) break;

    // Pack up to 3 color components into a single 24-bit number
    let color = 0;
    for (let c = 0; c < channels && c < 3; c++) {
      color = (color << 8) | rawPixels[offset + c];
    }
    colors.add(color);

    // Early exit: many colors = real content, no need to keep counting
    if (colors.size > 50) return colors.size;
  }

  return colors.size;
}

/**
 * Determine if a decoded image is UI chrome based on pixel color analysis.
 *
 * Rules (applied in order):
 * 1. Unique colors = 1 → always UI chrome. A single-color image is a solid fill.
 * 2. Unique colors ≤ 5 AND aspect ratio > 6:1 → UI chrome (borders, separators, thin bars).
 * 3. Unique colors ≤ 10 AND total pixels < 50,000 → UI chrome (dropdown arrows, checkbox outlines).
 * 4. Compressed size < 2000 AND widget-like dimensions → UI chrome (rasterized form elements).
 * 5. Everything else → real content.
 */
function isUIChromeByPixels(
  rawPixels: Uint8Array,
  width: number,
  height: number,
  channels: number,
  compressedSize: number
): boolean {
  const uniqueColors = countUniqueColors(rawPixels, width, height, channels);

  // Rule 1: Single color = solid fill — always UI chrome regardless of dimensions
  if (uniqueColors === 1) return true;

  // Rule 2: Very few colors + extreme aspect ratio = border/separator/thin fill bar
  const aspect = Math.max(width / height, height / width);
  if (uniqueColors <= 5 && aspect > 6) return true;

  // Rule 3: Few colors + small total pixel area = small UI element
  const totalPixels = width * height;
  if (uniqueColors <= 10 && totalPixels < 50000) return true;

  // Rule 4: Small compressed size + widget-like dimensions = rasterized input box/button
  if (compressedSize < 2000) {
    const isWidgetSized =
      (width >= 50 && width <= 500 && height >= 40 && height <= 100) ||
      (height >= 50 && height <= 500 && width >= 40 && width <= 100);
    if (isWidgetSized) return true;
  }

  // Rule 5: Pass everything else through
  return false;
}

/**
 * Check if a JPEG image is UI chrome using compression ratio as proxy.
 * Real photographs compress to ~0.5-3 bytes/pixel.
 * Solid-color or near-solid JPEGs compress to < 0.01 bytes/pixel.
 */
function isUIChromeJpeg(
  jpegData: Uint8Array,
  width: number,
  height: number
): boolean {
  const totalPixels = width * height;
  if (totalPixels === 0) return true;
  const bytesPerPixel = jpegData.length / totalPixels;

  // Extremely low compression ratio → near-solid fill
  if (bytesPerPixel < 0.02) return true;

  // Very thin or very small
  if (width <= 3 || height <= 3) return true;
  if (width <= 15 && height <= 15) return true;

  return false;
}

/**
 * Extract all images from a single PDF page.
 */
export async function extractPageImages(
  pdfDoc: PDFDocument,
  pageIndex: number
): Promise<ExtractedImage[]> {
  const images: ExtractedImage[] = [];
  const pages = pdfDoc.getPages();
  if (pageIndex >= pages.length) return images;

  const page = pages[pageIndex];
  const pageNode = page.node;

  // Get Resources → XObject dictionary
  const resources = pageNode.get(PDFName.of('Resources'));
  if (!resources) return images;

  const resourcesDict = resources instanceof PDFRef
    ? pdfDoc.context.lookup(resources) as PDFDict
    : resources as PDFDict;

  if (!resourcesDict || !(resourcesDict instanceof PDFDict)) return images;

  const xObjectRef = resourcesDict.get(PDFName.of('XObject'));
  if (!xObjectRef) return images;

  const xObjectDict = xObjectRef instanceof PDFRef
    ? pdfDoc.context.lookup(xObjectRef) as PDFDict
    : xObjectRef as PDFDict;

  if (!xObjectDict || !(xObjectDict instanceof PDFDict)) return images;

  // Iterate all XObjects
  const entries = xObjectDict.entries();
  let imageIndex = 0;

  for (const [nameObj, valueObj] of entries) {
    try {
      const ref = valueObj instanceof PDFRef ? valueObj : null;
      const stream = ref
        ? pdfDoc.context.lookup(ref)
        : valueObj;

      if (!stream || !(stream instanceof PDFRawStream || stream instanceof PDFStream)) continue;

      const dict = stream instanceof PDFRawStream ? stream.dict : (stream as any).dict;
      if (!dict) continue;

      // Check subtype is Image
      const subtype = dict.get(PDFName.of('Subtype'));
      if (!subtype || subtype.toString() !== '/Image') continue;

      // Get image dimensions
      const widthObj = dict.get(PDFName.of('Width'));
      const heightObj = dict.get(PDFName.of('Height'));
      const width = getNumber(widthObj) ?? 0;
      const height = getNumber(heightObj) ?? 0;
      if (width === 0 || height === 0) continue;

      // Determine filter type
      const filterObj = dict.get(PDFName.of('Filter'));
      const filterName = filterObj ? filterObj.toString() : '';

      // Get color space for PNG wrapping
      const colorSpaceObj = dict.get(PDFName.of('ColorSpace'));
      const colorSpaceName = colorSpaceObj ? colorSpaceObj.toString() : '/DeviceRGB';

      const bpcObj = dict.get(PDFName.of('BitsPerComponent'));
      const bitsPerComponent = getNumber(bpcObj) ?? 8;

      let imageData: Uint8Array;
      let mimeType: 'image/jpeg' | 'image/png';

      if (filterName === '/DCTDecode' || filterName.includes('DCTDecode')) {
        // JPEG: raw stream bytes ARE the JPEG
        if (stream instanceof PDFRawStream) {
          imageData = stream.contents;
        } else {
          const decoded = decodePDFRawStream(stream as PDFRawStream);
          imageData = decoded.decode();
        }

        // Filter UI chrome JPEGs using compression ratio
        if (isUIChromeJpeg(imageData, width, height)) continue;

        mimeType = 'image/jpeg';
      } else {
        // Other filters (FlateDecode, etc.) — decode and wrap as PNG
        let rawPixels: Uint8Array;
        try {
          if (stream instanceof PDFRawStream) {
            if (filterName === '/FlateDecode' || filterName.includes('FlateDecode')) {
              rawPixels = pako.inflate(stream.contents);
            } else {
              const decoded = decodePDFRawStream(stream);
              rawPixels = decoded.decode();
            }
          } else {
            const decoded = decodePDFRawStream(stream as PDFRawStream);
            rawPixels = decoded.decode();
          }
        } catch {
          continue; // Skip images we can't decode
        }

        // Determine PNG color type from PDF color space
        let colorType = 2; // RGB default
        let channels = 3;
        if (colorSpaceName === '/DeviceGray' || colorSpaceName.includes('DeviceGray')) {
          colorType = 0; // Grayscale
          channels = 1;
        } else if (colorSpaceName === '/DeviceCMYK' || colorSpaceName.includes('DeviceCMYK')) {
          // Convert CMYK to RGB
          rawPixels = cmykToRgb(rawPixels, width, height);
          colorType = 2;
          channels = 3;
        }

        // Get compressed size for Rule 4 heuristic
        const compressedStreamSize = stream instanceof PDFRawStream
          ? stream.contents.length : 0;

        // Filter UI chrome using pixel color analysis
        if (isUIChromeByPixels(rawPixels, width, height, channels, compressedStreamSize)) continue;

        imageData = wrapAsPng(rawPixels, width, height, colorType, bitsPerComponent);
        mimeType = 'image/png';
      }

      const name = nameObj instanceof PDFName ? nameObj.decodeText() : `Image${imageIndex}`;

      images.push({
        name,
        data: imageData,
        mimeType,
        width,
        height,
        x: 0, // Position will be refined if CTM data is available
        y: imageIndex * height, // Stack vertically by default
      });

      imageIndex++;
    } catch {
      // Skip problematic images silently
      continue;
    }
  }

  return images;
}

/**
 * Convert CMYK pixel data to RGB.
 */
function cmykToRgb(cmykData: Uint8Array, width: number, height: number): Uint8Array {
  const pixelCount = width * height;
  const rgbData = new Uint8Array(pixelCount * 3);

  for (let i = 0; i < pixelCount; i++) {
    const c = cmykData[i * 4] / 255;
    const m = cmykData[i * 4 + 1] / 255;
    const y = cmykData[i * 4 + 2] / 255;
    const k = cmykData[i * 4 + 3] / 255;

    rgbData[i * 3] = Math.round(255 * (1 - c) * (1 - k));
    rgbData[i * 3 + 1] = Math.round(255 * (1 - m) * (1 - k));
    rgbData[i * 3 + 2] = Math.round(255 * (1 - y) * (1 - k));
  }

  return rgbData;
}
