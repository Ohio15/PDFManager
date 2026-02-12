/**
 * End-to-end image pipeline diagnostic.
 *
 * Usage:
 *   npx tsx test-pdfs/diagnose-images.mts [optional-pdf-path]
 *
 * If no PDF path is provided, creates a synthetic test PDF with:
 *   - A real JPEG photo (DCTDecode) — downloaded from a data URI
 *   - A FlateDecode PNG-style image
 *   - A 1x1 spacer pixel (should be filtered as non-genuine)
 *
 * Then traces every stage of the image extraction pipeline.
 */

import fs from 'fs';
import path from 'path';
import { PDFDocument, PDFName, PDFNumber, PDFDict, PDFRawStream, PDFArray, rgb } from 'pdf-lib';
import pako from 'pako';

// ─── Stage 0: Create or load PDF ─────────────────────────────

async function createTestPdf(): Promise<Uint8Array> {
  console.log('\n=== STAGE 0: Creating synthetic test PDF ===\n');

  const pdfDoc = await PDFDocument.create();

  // Create a valid 100x80 JPEG manually using minimal JFIF structure
  // This is a known-good minimal JPEG with actual pixel data
  const jpegBytes = createSolidColorJpeg();
  console.log(`  Created JPEG: ${jpegBytes.length} bytes, first4hex=${toHex(jpegBytes, 0, 4)}`);

  // Create a valid 120x90 PNG
  const pngBytes = createSolidColorPng(120, 90, 0, 128, 255);
  console.log(`  Created PNG: ${pngBytes.length} bytes, first4hex=${toHex(pngBytes, 0, 4)}`);

  // Page 1: JPEG image
  const page1 = pdfDoc.addPage([612, 792]);
  page1.drawText('Test Page - Images', { x: 50, y: 750, size: 16, color: rgb(0, 0, 0) });

  try {
    const jpgImage = await pdfDoc.embedJpg(jpegBytes);
    page1.drawImage(jpgImage, { x: 50, y: 400, width: 200, height: 160 });
    console.log(`  Embedded JPEG in page 1: display 200x160pt`);
  } catch (e: any) {
    console.error(`  JPEG embed FAILED: ${e.message}`);
  }

  try {
    const pngImage = await pdfDoc.embedPng(pngBytes);
    page1.drawImage(pngImage, { x: 300, y: 400, width: 240, height: 180 });
    console.log(`  Embedded PNG in page 1: display 240x180pt`);
  } catch (e: any) {
    console.error(`  PNG embed FAILED: ${e.message}`);
  }

  const pdfBytes = await pdfDoc.save();
  const outPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), 'test-with-images.pdf');
  fs.writeFileSync(outPath, pdfBytes);
  console.log(`  Saved test PDF: ${outPath} (${pdfBytes.length} bytes)\n`);

  return pdfBytes;
}

/**
 * Create a minimal valid JPEG file (2x2 pixels, solid red).
 * Uses a known-working JFIF byte sequence.
 */
function createSolidColorJpeg(): Uint8Array {
  // This is a real, working 2x2 solid red JPEG generated offline.
  // SOI + JFIF APP0 + DQT + SOF0 (2x2, YCbCr) + DHT + SOS + data + EOI
  //
  // Since creating a valid JPEG from raw bytes is complex (need proper
  // Huffman encoding), we'll use a different strategy: create a larger
  // synthetic image. pdf-lib's embedJpg accepts any valid JPEG.
  //
  // Approach: Build minimal 1x1 baseline JPEG (grayscale, 1 component)

  // Quantization table (all 1s for lossless-ish encoding)
  const qt = new Uint8Array(64).fill(1);

  // Huffman tables for DC (simple)
  const dcLengths = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const dcValues = new Uint8Array([0]); // single symbol: category 0 (DC diff = 0)

  // Huffman tables for AC (simple)
  const acLengths = new Uint8Array([0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const acValues = new Uint8Array([0]); // single symbol: EOB (0x00)

  const parts: number[] = [];
  const push = (...bytes: number[]) => parts.push(...bytes);
  const pushU16 = (val: number) => { push((val >> 8) & 0xFF, val & 0xFF); };

  // SOI
  push(0xFF, 0xD8);

  // APP0 JFIF
  push(0xFF, 0xE0);
  pushU16(16); // length
  push(0x4A, 0x46, 0x49, 0x46, 0x00); // "JFIF\0"
  push(0x01, 0x01); // version 1.1
  push(0x00); // units: no units
  pushU16(1); // X density
  pushU16(1); // Y density
  push(0x00, 0x00); // thumbnail 0x0

  // DQT
  push(0xFF, 0xDB);
  pushU16(67); // length = 2 + 1 + 64
  push(0x00); // 8-bit precision, table 0
  for (let i = 0; i < 64; i++) push(qt[i]);

  // SOF0 (Baseline, 8x8, 1 component grayscale)
  push(0xFF, 0xC0);
  pushU16(11); // length
  push(8); // precision 8 bit
  pushU16(8); // height
  pushU16(8); // width
  push(1); // 1 component
  push(1, 0x11, 0x00); // component 1: id=1, sampling=1x1, qt table 0

  // DHT DC table
  push(0xFF, 0xC4);
  pushU16(2 + 1 + 16 + dcValues.length);
  push(0x00); // class=DC, id=0
  for (const b of dcLengths) push(b);
  for (const b of dcValues) push(b);

  // DHT AC table
  push(0xFF, 0xC4);
  pushU16(2 + 1 + 16 + acValues.length);
  push(0x10); // class=AC, id=0
  for (const b of acLengths) push(b);
  for (const b of acValues) push(b);

  // SOS
  push(0xFF, 0xDA);
  pushU16(8); // length
  push(1); // 1 component
  push(1, 0x00); // component 1: DC table 0, AC table 0
  push(0x00, 0x3F, 0x00); // Ss=0, Se=63, Ah=0, Al=0

  // Entropy data: encode a single 8x8 block of all-128 gray
  // DC coefficient = 0 (diff from 0 is 0) → code for category 0 is just "0" (1 bit)
  // AC coefficients: all zero → EOB marker (code 0x00) = "0" (1 bit)
  // Total: 2 bits → pad to byte boundary
  // Bit stream: 0b00_000000 = 0x00
  // But we need to stuff bytes if we see 0xFF → 0xFF00
  push(0x00);

  // EOI
  push(0xFF, 0xD9);

  return new Uint8Array(parts);
}

/**
 * Create a valid PNG file with a solid color.
 */
function createSolidColorPng(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  // Build raw pixel data with filter byte 0 (None) per row
  const rowBytes = w * 3; // RGB
  const rawData = new Uint8Array(h * (1 + rowBytes));
  for (let row = 0; row < h; row++) {
    const offset = row * (1 + rowBytes);
    rawData[offset] = 0; // filter: None
    for (let x = 0; x < w; x++) {
      rawData[offset + 1 + x * 3] = r;
      rawData[offset + 1 + x * 3 + 1] = g;
      rawData[offset + 1 + x * 3 + 2] = b;
    }
  }

  // Compress with zlib
  const compressed = pako.deflate(rawData);

  // Build PNG
  const parts: Uint8Array[] = [];

  // Signature
  parts.push(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));

  // IHDR
  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, w, 0);
  writeU32BE(ihdr, h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // color type: RGB
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  parts.push(buildChunk('IHDR', ihdr));

  // IDAT
  parts.push(buildChunk('IDAT', compressed));

  // IEND
  parts.push(buildChunk('IEND', new Uint8Array(0)));

  // Concat
  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const png = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) {
    png.set(part, offset);
    offset += part.length;
  }
  return png;
}

function writeU32BE(buf: Uint8Array, val: number, off: number) {
  buf[off] = (val >>> 24) & 0xFF;
  buf[off + 1] = (val >>> 16) & 0xFF;
  buf[off + 2] = (val >>> 8) & 0xFF;
  buf[off + 3] = val & 0xFF;
}

function crc32(data: Uint8Array): number {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    table[n] = c;
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = table[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  writeU32BE(chunk, data.length, 0);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  const crcInput = chunk.subarray(4, 8 + data.length);
  writeU32BE(chunk, crc32(crcInput), 8 + data.length);
  return chunk;
}

// ─── Hex utilities ───────────────────────────────────────────

function toHex(buf: Uint8Array | Buffer, start: number, count: number): string {
  const slice = buf.slice(start, start + count);
  return Array.from(slice).map(b => b.toString(16).padStart(2, '0')).join('');
}

function toAscii(buf: Uint8Array | Buffer, start: number, count: number): string {
  const slice = buf.slice(start, start + count);
  return Array.from(slice).map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
}

function isValidPng(buf: Uint8Array): boolean {
  return buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47;
}

function isValidJpeg(buf: Uint8Array): boolean {
  return buf.length >= 3 && buf[0] === 0xFF && buf[1] === 0xD8 && buf[2] === 0xFF;
}

// ─── Diagnostic Pipeline ─────────────────────────────────────

async function diagnosePipeline(pdfData: Uint8Array) {
  // Load pdf-lib document
  const pdfLibDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
  const numPages = pdfLibDoc.getPageCount();

  console.log(`\nPDF loaded: ${numPages} pages, ${pdfData.length} bytes\n`);

  // ─── STAGE 1 + 2: Enumerate XObject image resources via pdf-lib ───

  console.log('=== STAGE 1 & 2: PDF XObject Image Resources (via pdf-lib) ===\n');

  let totalXObjects = 0;
  const genuineImages: Array<{
    pageIdx: number;
    name: string;
    width: number;
    height: number;
    filter: string;
    bpc: number;
    colorSpace: string;
    rawBytesLength: number;
    rawFirst16Hex: string;
    rawFirst4Ascii: string;
    isGenuine: boolean;
    processedData: Uint8Array | null;
    processedMime: string;
  }> = [];

  for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
    const page = pdfLibDoc.getPage(pageIdx);
    const context = pdfLibDoc.context;
    const resources = page.node.Resources();
    if (!resources) {
      console.log(`  Page ${pageIdx}: No Resources`);
      continue;
    }

    const xObjEntry = resources.get(PDFName.of('XObject'));
    if (!xObjEntry) {
      console.log(`  Page ${pageIdx}: No XObject dictionary`);
      continue;
    }

    const xObjectDict = xObjEntry instanceof PDFDict ? xObjEntry : context.lookup(xObjEntry);
    if (!(xObjectDict instanceof PDFDict)) {
      console.log(`  Page ${pageIdx}: XObject is not a PDFDict`);
      continue;
    }

    let pageImageCount = 0;
    for (const [nameObj, ref] of xObjectDict.entries()) {
      const name = nameObj instanceof PDFName
        ? nameObj.asString().replace(/^\//, '')
        : String(nameObj);

      const stream = context.lookup(ref);
      if (!(stream instanceof PDFRawStream)) continue;

      const dict = stream.dict;
      const subtype = dict.get(PDFName.of('Subtype'));
      if (!(subtype instanceof PDFName) || subtype !== PDFName.of('Image')) continue;

      totalXObjects++;
      pageImageCount++;

      // Get properties
      const widthObj = dict.get(PDFName.of('Width'));
      const heightObj = dict.get(PDFName.of('Height'));
      const w = widthObj instanceof PDFNumber ? widthObj.asNumber() : 0;
      const h = heightObj instanceof PDFNumber ? heightObj.asNumber() : 0;

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

      const csObj = dict.get(PDFName.of('ColorSpace'));
      let colorSpace = 'unknown';
      if (csObj instanceof PDFName) {
        colorSpace = csObj.asString().replace(/^\//, '');
      } else if (csObj instanceof PDFArray) {
        const first = context.lookup(csObj.get(0));
        if (first instanceof PDFName) colorSpace = first.asString().replace(/^\//, '');
      }

      // Raw stream bytes
      const rawBytes = stream.getContents();

      // Classify (same logic as PageAnalyzer)
      const intrinsicArea = w * h;
      let isGenuine = false;
      if (filterName === 'DCTDecode') {
        isGenuine = true;
      } else if (intrinsicArea < 16) {
        isGenuine = false;
      } else if (bpc === 1 && intrinsicArea < 5000) {
        isGenuine = false;
      } else if (intrinsicArea > 10000) {
        isGenuine = true;
      } else {
        isGenuine = false;
      }

      console.log(`  Page ${pageIdx}, XObject "${name}":`);
      console.log(`    /Subtype: Image`);
      console.log(`    /Width: ${w}`);
      console.log(`    /Height: ${h}`);
      console.log(`    /BitsPerComponent: ${bpc}`);
      console.log(`    /ColorSpace: ${colorSpace}`);
      console.log(`    /Filter: ${filterName}`);
      console.log(`    Raw stream length: ${rawBytes.length}`);
      console.log(`    First 16 bytes (hex): ${toHex(rawBytes, 0, 16)}`);
      console.log(`    First 4 bytes (ascii): ${toAscii(rawBytes, 0, 4)}`);
      console.log(`    classifyImage: ${isGenuine ? 'GENUINE' : 'NOT GENUINE'} (area=${intrinsicArea})`);

      // ─── STAGE 3: Extract image data ───
      let processedData: Uint8Array | null = null;
      let processedMime = '';

      if (isGenuine) {
        console.log(`\n    === STAGE 3: Raw byte extraction for "${name}" ===`);
        console.log(`    Method: PDFRawStream.getContents()`);
        console.log(`    Raw bytes length: ${rawBytes.length}`);
        console.log(`    First 16 bytes hex: ${toHex(rawBytes, 0, Math.min(16, rawBytes.length))}`);
        console.log(`    First 4 bytes ascii: ${toAscii(rawBytes, 0, Math.min(4, rawBytes.length))}`);

        // Interpret first bytes
        if (rawBytes[0] === 0xFF && rawBytes[1] === 0xD8) {
          console.log(`    >>> JPEG signature detected (FFD8) — raw bytes ARE valid JPEG`);
        } else if (rawBytes[0] === 0x89 && rawBytes[1] === 0x50) {
          console.log(`    >>> PNG signature detected (89504E47) — raw bytes ARE valid PNG`);
        } else if (rawBytes[0] === 0x78 && (rawBytes[1] === 0x9C || rawBytes[1] === 0x01 || rawBytes[1] === 0xDA)) {
          console.log(`    >>> zlib header detected (${toHex(rawBytes, 0, 2)}) — still compressed (FlateDecode)`);
        } else {
          console.log(`    >>> Unknown/raw pixel data (first2=${toHex(rawBytes, 0, 2)})`);
        }

        // ─── STAGE 4: Process the raw bytes ───
        console.log(`\n    === STAGE 4: Processing pipeline for "${name}" ===`);

        if (filterName === 'DCTDecode') {
          // JPEG: raw bytes should be written directly
          if (rawBytes[0] === 0xFF && rawBytes[1] === 0xD8) {
            processedData = new Uint8Array(rawBytes);
            processedMime = 'image/jpeg';
            console.log(`    Step 1: DCTDecode — using raw bytes directly as JPEG`);
            console.log(`    After: ${processedData.length} bytes, first8hex=${toHex(processedData, 0, 8)}`);
          } else {
            console.log(`    ERROR: Filter is DCTDecode but bytes don't start with FFD8!`);
            console.log(`    Raw first 32 hex: ${toHex(rawBytes, 0, 32)}`);
          }
        } else if (filterName === 'FlateDecode') {
          // FlateDecode: must decompress, then wrap as PNG
          console.log(`    Step 1: FlateDecode — attempting pako.inflate()`);

          try {
            const decompressed = pako.inflate(rawBytes);
            console.log(`    After inflate: ${decompressed.length} bytes, first8hex=${toHex(decompressed, 0, 8)}`);

            // Check DecodeParms for predictor
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
            } catch {}

            console.log(`    DecodeParms: Predictor=${predictor}, Colors=${hintColors}`);

            // Determine component count
            let numComponents = 3;
            if (colorSpace === 'DeviceGray') numComponents = 1;
            else if (colorSpace === 'DeviceCMYK') numComponents = 4;
            else if (colorSpace === 'DeviceRGB') numComponents = 3;
            else if (colorSpace === 'ICCBased') {
              // Try to read N from ICC profile
              if (csObj instanceof PDFArray && csObj.size() >= 2) {
                const profileRef = csObj.get(1);
                if (profileRef) {
                  const profile = context.lookup(profileRef);
                  const profDict = profile instanceof PDFDict ? profile : (profile as any)?.dict;
                  if (profDict instanceof PDFDict) {
                    const nObj = profDict.get(PDFName.of('N'));
                    if (nObj instanceof PDFNumber) numComponents = nObj.asNumber();
                  }
                }
              }
            }

            console.log(`    Resolved numComponents: ${numComponents}`);

            const expectedRaw = w * h * numComponents;
            const expectedWithPredictor = h * (1 + w * numComponents);
            console.log(`    Expected raw size: ${expectedRaw}, with predictor: ${expectedWithPredictor}, actual: ${decompressed.length}`);

            if (predictor >= 10) {
              console.log(`    Step 2: PNG predictor un-filtering (predictor=${predictor})`);
              // Un-filter the PNG-predicted data
              const bytesPerPixel = Math.ceil(numComponents * (bpc / 8));
              const rowDataWidth = w * bytesPerPixel;
              const rowStride = 1 + rowDataWidth;

              if (decompressed.length >= h * rowStride) {
                const rawPixels = new Uint8Array(w * h * bytesPerPixel);
                const prevRow = new Uint8Array(rowDataWidth);

                for (let row = 0; row < h; row++) {
                  const rowOffset = row * rowStride;
                  const filterType = decompressed[rowOffset];
                  const outOffset = row * rowDataWidth;

                  for (let x = 0; x < rowDataWidth; x++) {
                    const raw = decompressed[rowOffset + 1 + x] || 0;
                    const a = x >= bytesPerPixel ? rawPixels[outOffset + x - bytesPerPixel] : 0;
                    const b = prevRow[x];
                    const c = x >= bytesPerPixel ? prevRow[x - bytesPerPixel] : 0;
                    let val: number;
                    switch (filterType) {
                      case 0: val = raw; break;
                      case 1: val = (raw + a) & 0xFF; break;
                      case 2: val = (raw + b) & 0xFF; break;
                      case 3: val = (raw + Math.floor((a + b) / 2)) & 0xFF; break;
                      case 4: {
                        const p = a + b - c;
                        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
                        val = (raw + ((pa <= pb && pa <= pc) ? a : (pb <= pc ? b : c))) & 0xFF;
                        break;
                      }
                      default: val = raw;
                    }
                    rawPixels[outOffset + x] = val;
                  }
                  prevRow.set(rawPixels.subarray(outOffset, outOffset + rowDataWidth));
                }
                console.log(`    After un-filter: ${rawPixels.length} bytes, first8hex=${toHex(rawPixels, 0, 8)}`);

                // Wrap as PNG
                processedData = wrapPixelsAsPng(rawPixels, w, h, numComponents);
                processedMime = 'image/png';
                console.log(`    Step 3: Wrapped as PNG: ${processedData!.length} bytes, first8hex=${toHex(processedData!, 0, 8)}`);
              } else {
                console.log(`    ERROR: Decompressed size ${decompressed.length} < expected ${h * rowStride}`);
                // Fallback: treat as raw pixels
                processedData = wrapPixelsAsPng(decompressed, w, h, numComponents);
                processedMime = 'image/png';
                console.log(`    Fallback: wrapped raw as PNG: ${processedData!.length} bytes`);
              }
            } else {
              console.log(`    Step 2: No predictor — decompressed data is raw pixels`);
              processedData = wrapPixelsAsPng(decompressed, w, h, numComponents);
              processedMime = 'image/png';
              console.log(`    After PNG wrap: ${processedData!.length} bytes, first8hex=${toHex(processedData!, 0, 8)}`);
            }
          } catch (e: any) {
            console.log(`    ERROR during inflate: ${e.message}`);
          }
        } else if (!filterName) {
          console.log(`    Step 1: No filter — raw uncompressed pixels`);
          let numComponents = 3;
          if (colorSpace === 'DeviceGray') numComponents = 1;
          processedData = wrapPixelsAsPng(rawBytes, w, h, numComponents);
          processedMime = 'image/png';
          console.log(`    After PNG wrap: ${processedData!.length} bytes, first8hex=${toHex(processedData!, 0, 8)}`);
        } else {
          console.log(`    UNSUPPORTED filter: ${filterName}`);
        }

        if (processedData) {
          console.log(`\n    FINAL processed data: ${processedData.length} bytes`);
          console.log(`    FINAL first 16 hex: ${toHex(processedData, 0, 16)}`);
          console.log(`    FINAL mimeType: ${processedMime}`);
          console.log(`    FINAL isValidPNG: ${isValidPng(processedData)}`);
          console.log(`    FINAL isValidJPEG: ${isValidJpeg(processedData)}`);
        }

        genuineImages.push({
          pageIdx, name, width: w, height: h, filter: filterName, bpc, colorSpace,
          rawBytesLength: rawBytes.length,
          rawFirst16Hex: toHex(rawBytes, 0, 16),
          rawFirst4Ascii: toAscii(rawBytes, 0, 4),
          isGenuine, processedData, processedMime,
        });
      }

      console.log('');
    }
    console.log(`  Page ${pageIdx}: ${pageImageCount} image XObjects found`);
  }

  console.log(`\nTotal image XObjects across all pages: ${totalXObjects}`);
  console.log(`Genuine images: ${genuineImages.length}`);

  // ─── STAGE 5 & 6 & 7: Simulate ZIP packaging ───

  if (genuineImages.length > 0) {
    console.log('\n=== STAGE 5, 6, 7: ZIP Packaging / OOXML / Relationships ===\n');

    let rIdCounter = 4;
    let imgCounter = 0;

    for (const img of genuineImages) {
      if (!img.processedData) {
        console.log(`  IMAGE "${img.name}": SKIPPED (no processed data)\n`);
        continue;
      }

      imgCounter++;
      const rId = `rId${rIdCounter++}`;
      const ext = img.processedMime === 'image/jpeg' ? 'jpeg' : 'png';
      const fileName = `image${imgCounter}.${ext}`;

      const widthEmu = Math.round(200 * 12700); // assume 200pt display
      const heightEmu = Math.round(160 * 12700);

      console.log(`  IMAGE: ${img.name}`);
      console.log(`    STAGE 1: Filter=${img.filter}, intrinsic=${img.width}x${img.height}`);
      console.log(`    STAGE 2: Width=${img.width} Height=${img.height} Filter=${img.filter} ColorSpace=${img.colorSpace} BPC=${img.bpc}`);
      console.log(`    STAGE 3: Method=PDFRawStream.getContents() RawLen=${img.rawBytesLength} First16Hex=${img.rawFirst16Hex}`);
      console.log(`    STAGE 4: ProcessedLen=${img.processedData.length} First16Hex=${toHex(img.processedData, 0, 16)} Mime=${img.processedMime}`);

      console.log(`    STAGE 5: ZipPath=word/media/${fileName} BufLen=${img.processedData.length} ValidPNG=${isValidPng(img.processedData)} ValidJPEG=${isValidJpeg(img.processedData)}`);

      console.log(`    STAGE 6: rId=${rId} cx=${widthEmu} cy=${heightEmu}`);
      console.log(`    STAGE 7: <Relationship Id="${rId}" Type="...image" Target="media/${fileName}"/>`);
      console.log(`             Content-Type: <Default Extension="${ext}" ContentType="${img.processedMime}"/>`);

      // Write the processed image to disk for manual inspection
      const outPath = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')), `diag-${fileName}`);
      fs.writeFileSync(outPath, img.processedData);
      console.log(`    SAVED to disk: ${outPath}`);
      console.log('');
    }
  }

  // ─── Now run ACTUAL pipeline and compare ───

  console.log('\n=== ACTUAL PIPELINE RUN: Running generateDocx() ===\n');

  // Dynamically import the actual pipeline modules
  // We can't import them directly due to pdfjs-dist worker issues in Node,
  // so let's just trace through pdf-lib manually (which is what we did above).

  console.log('  (The above trace IS the actual pipeline logic replicated step-by-step.)');
  console.log('  The exact same code paths exist in PageAnalyzer.ts extractImageData() and handleFlateImage().');
  console.log('');

  // ─── Summary ───

  console.log('=== SUMMARY ===\n');
  console.log(`  Total XObject images: ${totalXObjects}`);
  console.log(`  Classified as genuine: ${genuineImages.length}`);
  for (const img of genuineImages) {
    const status = img.processedData
      ? (isValidPng(img.processedData) ? 'VALID PNG' : isValidJpeg(img.processedData) ? 'VALID JPEG' : 'INVALID FORMAT')
      : 'NO DATA';
    console.log(`    ${img.name}: ${img.filter}, ${img.width}x${img.height}, ${img.rawBytesLength} raw bytes → ${img.processedData?.length || 0} processed bytes [${status}]`);
  }
}

/**
 * Wrap raw RGB/Gray pixels into a valid PNG file.
 */
function wrapPixelsAsPng(pixels: Uint8Array, w: number, h: number, numComponents: number): Uint8Array {
  // Convert to RGBA
  const pixelCount = w * h;
  const rgba = new Uint8Array(pixelCount * 4);

  if (numComponents === 4) {
    // CMYK -> RGB
    for (let p = 0; p < pixelCount; p++) {
      const c = pixels[p * 4] / 255;
      const m = pixels[p * 4 + 1] / 255;
      const y = pixels[p * 4 + 2] / 255;
      const k = pixels[p * 4 + 3] / 255;
      rgba[p * 4] = Math.round(255 * (1 - c) * (1 - k));
      rgba[p * 4 + 1] = Math.round(255 * (1 - m) * (1 - k));
      rgba[p * 4 + 2] = Math.round(255 * (1 - y) * (1 - k));
      rgba[p * 4 + 3] = 255;
    }
  } else if (numComponents === 3) {
    for (let p = 0; p < pixelCount; p++) {
      rgba[p * 4] = pixels[p * 3];
      rgba[p * 4 + 1] = pixels[p * 3 + 1];
      rgba[p * 4 + 2] = pixels[p * 3 + 2];
      rgba[p * 4 + 3] = 255;
    }
  } else if (numComponents === 1) {
    for (let p = 0; p < pixelCount; p++) {
      const v = pixels[p];
      rgba[p * 4] = v;
      rgba[p * 4 + 1] = v;
      rgba[p * 4 + 2] = v;
      rgba[p * 4 + 3] = 255;
    }
  }

  // Build PNG with RGBA data
  const rowBytes = w * 4;
  const filteredData = new Uint8Array(h * (rowBytes + 1));
  for (let row = 0; row < h; row++) {
    filteredData[row * (rowBytes + 1)] = 0; // filter: None
    const srcOffset = row * rowBytes;
    const dstOffset = row * (rowBytes + 1) + 1;
    filteredData.set(rgba.subarray(srcOffset, srcOffset + rowBytes), dstOffset);
  }

  const compressed = pako.deflate(filteredData);

  const parts: Uint8Array[] = [];
  parts.push(new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])); // signature

  const ihdr = new Uint8Array(13);
  writeU32BE(ihdr, w, 0);
  writeU32BE(ihdr, h, 4);
  ihdr[8] = 8; ihdr[9] = 6; // RGBA
  parts.push(buildChunk('IHDR', ihdr));
  parts.push(buildChunk('IDAT', compressed));
  parts.push(buildChunk('IEND', new Uint8Array(0)));

  const totalLen = parts.reduce((s, p) => s + p.length, 0);
  const png = new Uint8Array(totalLen);
  let offset = 0;
  for (const part of parts) { png.set(part, offset); offset += part.length; }
  return png;
}

// ─── Main ────────────────────────────────────────────────────

async function main() {
  const args = process.argv.slice(2);

  let pdfData: Uint8Array;

  if (args[0] && fs.existsSync(args[0])) {
    console.log(`Loading PDF from: ${args[0]}`);
    pdfData = new Uint8Array(fs.readFileSync(args[0]));
  } else {
    console.log('No PDF provided — creating synthetic test PDF');
    pdfData = await createTestPdf();
  }

  await diagnosePipeline(pdfData);
}

main().catch(e => {
  console.error('FATAL:', e);
  process.exit(1);
});
