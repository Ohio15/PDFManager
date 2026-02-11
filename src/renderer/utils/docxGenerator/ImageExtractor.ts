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
 * Heuristic: Is this image likely UI chrome (border, line, background, checkbox graphic)
 * rather than a real content image?
 *
 * Conservative — only filters things very unlikely to be real images.
 */
function isUIChrome(width: number, height: number, rawByteCount: number): boolean {
  // Very thin images (lines, borders, separators)
  // 3px or less on either dimension
  if (width <= 3 || height <= 3) return true;

  // Very small images (bullet dots, tiny icons, checkbox/radio graphics)
  // 15x15 or smaller
  if (width <= 15 && height <= 15) return true;

  // Extreme aspect ratios: lines and rules
  // >30:1 or <1:30 (e.g., 500x1 horizontal rule)
  const aspect = width / height;
  if (aspect > 30 || aspect < 1 / 30) return true;

  // Tiny byte count — nearly solid color fill or 1-bit pattern
  // Real photos/graphics have much more data even at small sizes
  // 500 bytes of pixel data for a >50px image is basically a solid rectangle
  if (rawByteCount < 500 && (width > 50 || height > 50)) return true;

  // Small image with very few unique pixels (solid backgrounds, single-color fills)
  // A 100x5 image that's < 200 bytes raw is likely a colored bar
  if (width * height < 1000 && rawByteCount < 200) return true;

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

      // Get raw stream byte count for UI chrome heuristic
      const rawStreamBytes = stream instanceof PDFRawStream
        ? stream.contents.length
        : 0;

      // Filter out UI chrome (lines, borders, tiny icons, solid fills)
      if (isUIChrome(width, height, rawStreamBytes)) continue;

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
          // Fallback: try to get raw contents
          const decoded = decodePDFRawStream(stream as PDFRawStream);
          imageData = decoded.decode();
        }
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
        if (colorSpaceName === '/DeviceGray' || colorSpaceName.includes('DeviceGray')) {
          colorType = 0; // Grayscale
        } else if (colorSpaceName === '/DeviceCMYK' || colorSpaceName.includes('DeviceCMYK')) {
          // Convert CMYK to RGB
          rawPixels = cmykToRgb(rawPixels, width, height);
          colorType = 2;
        }

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
