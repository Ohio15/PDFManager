/**
 * Full Pipeline Diagnostic: Traces images through the complete generateDocx pipeline.
 *
 * Since DocxGenerator.ts uses Vite-specific pdfjs imports that don't work in Node,
 * this script replicates the pipeline logic using Node-compatible pdfjs-dist/legacy.
 *
 * Traces:
 *   1. Pre-pipeline: PDF XObject inspection via pdf-lib
 *   2. pdfjs operator list: What image ops are emitted
 *   3. Resource name resolution: pdfjs objId → pdf-lib resource name matching
 *   4. Classification: classifyImage() results
 *   5. Extraction: extractImageData() results and data validation
 *   6. Dedup + rId assignment: Which images get unique IDs
 *   7. OOXML generation: Drawing XML, relationships, content types
 *   8. ZIP packaging: Final file validation
 *
 * Usage:
 *   npx tsx test-pdfs/diagnose-pipeline.mts [optional-pdf-path]
 */

import fs from 'fs';
import path from 'path';
import { PDFDocument, PDFName, PDFNumber, PDFDict, PDFRawStream, PDFArray, rgb } from 'pdf-lib';
import pako from 'pako';

// Use legacy pdfjs-dist for Node.js compatibility
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';

// Import actual pipeline modules (PageAnalyzer, LayoutAnalyzer, OoxmlParts don't use Vite imports)
import { analyzePage } from '../src/renderer/utils/docxGenerator/PageAnalyzer';
import { buildPageLayout } from '../src/renderer/utils/docxGenerator/LayoutAnalyzer';
import { StyleCollector } from '../src/renderer/utils/docxGenerator/StyleCollector';
import { ZipBuilder } from '../src/renderer/utils/docxGenerator/ZipBuilder';
import {
  generateContentTypes,
  generateRootRels,
  generateDocumentRels,
  generateDocumentXml,
  generateStylesXml,
  generateSettingsXml,
  generateFontTableXml,
} from '../src/renderer/utils/docxGenerator/OoxmlParts';
import type { PageScene, PageLayout, ImageElement, ImageFile } from '../src/renderer/utils/docxGenerator/types';

// Inline constant to avoid ESM/CJS interop issues
const PT_TO_EMU = 12700;

// ─── Helpers ─────────────────────────────────────────────────────

function toHex(buf: Uint8Array, start: number, len: number): string {
  return Array.from(buf.slice(start, start + Math.min(len, buf.length - start))).map(b => b.toString(16).padStart(2, '0')).join('');
}

function fastHash(data: Uint8Array): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193);
  }
  return `${(hash >>> 0).toString(16)}-${data.length}`;
}

// ─── Minimal JPEG/PNG Builders ───────────────────────────────────

function createSolidColorJpeg(): Uint8Array {
  const width = 8, height = 8;
  const header: number[] = [];
  header.push(0xFF, 0xD8);
  header.push(0xFF, 0xE0);
  const jfif = [0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00];
  header.push((jfif.length + 2) >> 8, (jfif.length + 2) & 0xFF, ...jfif);
  header.push(0xFF, 0xDB, 0x00, 0x43, 0x00);
  header.push(...new Array(64).fill(1));
  header.push(0xFF, 0xC0, 0x00, 0x0B, 0x08);
  header.push((height >> 8) & 0xFF, height & 0xFF, (width >> 8) & 0xFF, width & 0xFF);
  header.push(0x01, 0x01, 0x11, 0x00);
  header.push(0xFF, 0xC4, 0x00, 0x1F, 0x00, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11);
  header.push(0xFF, 0xC4, 0x00, 0x1F, 0x10, 0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11);
  header.push(0xFF, 0xDA, 0x00, 0x08, 0x01, 0x01, 0x00, 0x00, 0x3F, 0x00);
  header.push(0xFC, 0xA5, 0x2A, 0x15, 0x0A, 0x85, 0x42, 0xA1, 0x50);
  header.push(0xFF, 0xD9);
  return new Uint8Array(header);
}

function createSolidColorPng(w: number, h: number, r: number, g: number, b: number): Uint8Array {
  const rowBytes = w * 3;
  const rawData = new Uint8Array(h * (1 + rowBytes));
  for (let row = 0; row < h; row++) {
    rawData[row * (1 + rowBytes)] = 0;
    for (let col = 0; col < w; col++) {
      const offset = row * (1 + rowBytes) + 1 + col * 3;
      rawData[offset] = r; rawData[offset + 1] = g; rawData[offset + 2] = b;
    }
  }
  const compressed = pako.deflate(rawData);
  const pngSig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = buildChunk('IHDR', makeIhdr(w, h, 8, 2));
  const idat = buildChunk('IDAT', compressed);
  const iend = buildChunk('IEND', new Uint8Array(0));
  const result = new Uint8Array(pngSig.length + ihdr.length + idat.length + iend.length);
  let off = 0;
  result.set(pngSig, off); off += pngSig.length;
  result.set(ihdr, off); off += ihdr.length;
  result.set(idat, off); off += idat.length;
  result.set(iend, off);
  return result;
}

function makeIhdr(w: number, h: number, bd: number, ct: number): Uint8Array {
  const buf = new Uint8Array(13);
  buf[0] = (w >>> 24); buf[1] = (w >>> 16); buf[2] = (w >>> 8); buf[3] = w;
  buf[4] = (h >>> 24); buf[5] = (h >>> 16); buf[6] = (h >>> 8); buf[7] = h;
  buf[8] = bd; buf[9] = ct;
  return buf;
}

const crcTable: Uint32Array = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1); t[n] = c; }
  return t;
})();

function crc32(data: Uint8Array): number {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) c = crcTable[(c ^ data[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function buildChunk(type: string, data: Uint8Array): Uint8Array {
  const chunk = new Uint8Array(12 + data.length);
  const dv = new DataView(chunk.buffer);
  dv.setUint32(0, data.length, false);
  for (let i = 0; i < 4; i++) chunk[4 + i] = type.charCodeAt(i);
  chunk.set(data, 8);
  dv.setUint32(8 + data.length, crc32(chunk.subarray(4, 8 + data.length)), false);
  return chunk;
}

// ─── ZIP Parser ──────────────────────────────────────────────────

interface ZipEntry { name: string; data: Uint8Array; }

function parseZip(data: Uint8Array): ZipEntry[] {
  const entries: ZipEntry[] = [];
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  let eocdOffset = -1;
  for (let i = data.length - 22; i >= 0; i--) {
    if (view.getUint32(i, true) === 0x06054B50) { eocdOffset = i; break; }
  }
  if (eocdOffset === -1) throw new Error('Cannot find EOCD');
  const cdOffset = view.getUint32(eocdOffset + 16, true);
  const cdEntries = view.getUint16(eocdOffset + 10, true);
  let pos = cdOffset;
  for (let e = 0; e < cdEntries; e++) {
    if (view.getUint32(pos, true) !== 0x02014B50) break;
    const method = view.getUint16(pos + 10, true);
    const compSize = view.getUint32(pos + 20, true);
    const nameLen = view.getUint16(pos + 28, true);
    const extraLen = view.getUint16(pos + 30, true);
    const commentLen = view.getUint16(pos + 32, true);
    const localOffset = view.getUint32(pos + 42, true);
    const name = new TextDecoder().decode(data.subarray(pos + 46, pos + 46 + nameLen));
    const localNameLen = view.getUint16(localOffset + 26, true);
    const localExtraLen = view.getUint16(localOffset + 28, true);
    const dataStart = localOffset + 30 + localNameLen + localExtraLen;
    const compData = data.subarray(dataStart, dataStart + compSize);
    let fileData: Uint8Array;
    if (method === 0) fileData = compData;
    else if (method === 8) fileData = pako.inflateRaw(compData);
    else fileData = new Uint8Array(0);
    entries.push({ name, data: fileData });
    pos += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

// ─── Create Synthetic Test PDF ───────────────────────────────────

async function createTestPdf(): Promise<Uint8Array> {
  console.log('\n=== Creating synthetic test PDF ===\n');
  const pdfDoc = await PDFDocument.create();
  const jpegBytes = createSolidColorJpeg();
  const pngBytes = createSolidColorPng(120, 90, 0, 128, 255);
  console.log(`  JPEG: ${jpegBytes.length} bytes, starts 0x${toHex(jpegBytes, 0, 4)}`);
  console.log(`  PNG: ${pngBytes.length} bytes, starts 0x${toHex(pngBytes, 0, 4)}`);

  const page1 = pdfDoc.addPage([612, 792]);
  page1.drawText('Test Page - Images', { x: 50, y: 750, size: 16, color: rgb(0, 0, 0) });

  try {
    const jpgImage = await pdfDoc.embedJpg(jpegBytes);
    page1.drawImage(jpgImage, { x: 50, y: 400, width: 200, height: 160 });
    console.log(`  Embedded JPEG: 200x160pt display`);
  } catch (e: any) { console.error(`  JPEG embed FAILED: ${e.message}`); }

  try {
    const pngImage = await pdfDoc.embedPng(pngBytes);
    page1.drawImage(pngImage, { x: 300, y: 400, width: 240, height: 180 });
    console.log(`  Embedded PNG: 240x180pt display`);
  } catch (e: any) { console.error(`  PNG embed FAILED: ${e.message}`); }

  // 1x1 spacer (should be filtered)
  try {
    const spacerImg = await pdfDoc.embedPng(createSolidColorPng(1, 1, 255, 255, 255));
    page1.drawImage(spacerImg, { x: 0, y: 0, width: 612, height: 1 });
    console.log(`  Embedded 1x1 spacer`);
  } catch (e: any) { console.error(`  Spacer embed FAILED: ${e.message}`); }

  return pdfDoc.save();
}

// ─── Main Diagnostic ─────────────────────────────────────────────

async function main() {
  const pdfPath = process.argv[2];
  let pdfData: Uint8Array;

  if (pdfPath) {
    console.log(`\nLoading PDF from: ${pdfPath}`);
    pdfData = new Uint8Array(fs.readFileSync(pdfPath));
    console.log(`  Size: ${pdfData.length} bytes`);
  } else {
    pdfData = await createTestPdf();
    const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));
    fs.writeFileSync(path.join(scriptDir, 'test-with-images.pdf'), pdfData);
    console.log(`  Saved test PDF`);
  }

  const scriptDir = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1'));

  // ─── STAGE A: Pre-pipeline PDF inspection ────────────────────
  console.log('\n\n========================================');
  console.log('STAGE A: Pre-pipeline PDF inspection (pdf-lib)');
  console.log('========================================\n');

  const pdfLibDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
  const numPdfLibPages = pdfLibDoc.getPageCount();
  console.log(`Pages: ${numPdfLibPages}`);

  for (let pageIdx = 0; pageIdx < numPdfLibPages; pageIdx++) {
    console.log(`\n--- Page ${pageIdx + 1} ---`);
    const page = pdfLibDoc.getPage(pageIdx);
    const context = pdfLibDoc.context;
    const resources = page.node.Resources();
    if (!resources) { console.log('  No resources'); continue; }

    const xObjEntry = resources.get(PDFName.of('XObject'));
    if (!xObjEntry) { console.log('  No XObject dictionary'); continue; }

    const xObjectDict = xObjEntry instanceof PDFDict ? xObjEntry : context.lookup(xObjEntry);
    if (!(xObjectDict instanceof PDFDict)) { console.log('  XObject is not a dict'); continue; }

    for (const [nameObj, ref] of xObjectDict.entries()) {
      const name = nameObj instanceof PDFName ? nameObj.asString().replace(/^\//, '') : String(nameObj);
      try {
        const stream = context.lookup(ref);
        if (!(stream instanceof PDFRawStream)) { console.log(`  ${name}: not PDFRawStream`); continue; }
        const dict = stream.dict;
        const subtype = dict.get(PDFName.of('Subtype'));
        if (!(subtype instanceof PDFName) || subtype !== PDFName.of('Image')) { console.log(`  ${name}: not Image subtype`); continue; }

        const w = dict.get(PDFName.of('Width'));
        const h = dict.get(PDFName.of('Height'));
        const bpc = dict.get(PDFName.of('BitsPerComponent'));
        const filterObj = dict.get(PDFName.of('Filter'));
        const csObj = dict.get(PDFName.of('ColorSpace'));
        const smask = dict.get(PDFName.of('SMask'));
        const mask = dict.get(PDFName.of('Mask'));

        let filter = 'none';
        if (filterObj instanceof PDFName) filter = filterObj.asString();
        else if (filterObj instanceof PDFArray) {
          const parts: string[] = [];
          for (let i = 0; i < filterObj.size(); i++) { const f = context.lookup(filterObj.get(i)); parts.push(f instanceof PDFName ? f.asString() : String(f)); }
          filter = `[${parts.join(', ')}]`;
        }

        let cs = 'unspecified';
        if (csObj instanceof PDFName) cs = csObj.asString();
        else if (csObj instanceof PDFArray) {
          const first = context.lookup(csObj.get(0));
          cs = first instanceof PDFName ? first.asString() : 'array';
          if (cs === '/ICCBased' && csObj.size() >= 2) {
            const profile = context.lookup(csObj.get(1));
            const profDict = profile instanceof PDFDict ? profile : (profile as any)?.dict;
            if (profDict instanceof PDFDict) {
              const nObj = profDict.get(PDFName.of('N'));
              cs += `(N=${nObj instanceof PDFNumber ? nObj.asNumber() : '?'})`;
            }
          }
          if (cs === '/Indexed') {
            cs += ` (palette-based)`;
          }
        }

        const rawBytes = stream.getContents();
        const rawLen = rawBytes?.length ?? 0;

        console.log(`  ${name}: ${w instanceof PDFNumber ? w.asNumber() : '?'}x${h instanceof PDFNumber ? h.asNumber() : '?'}, bpc=${bpc instanceof PDFNumber ? bpc.asNumber() : '?'}, filter=${filter}, cs=${cs}`);
        console.log(`    rawBytes=${rawLen}, first8=0x${rawBytes ? toHex(rawBytes, 0, 8) : 'null'}`);
        console.log(`    SMask=${smask ? 'YES' : 'no'}, Mask=${mask ? 'YES' : 'no'}`);
      } catch (e: any) { console.log(`  ${name}: ERROR: ${e.message}`); }
    }
  }

  // ─── STAGE B: Run pipeline (Phase 1-3: Load → Analyze → Layout) ──
  console.log('\n\n========================================');
  console.log('STAGE B: Pipeline Phase 1-3 (Load → Analyze → Layout)');
  console.log('========================================\n');

  // Phase 1: Load with pdfjs (legacy for Node)
  const pdfJsDoc = await pdfjsLib.getDocument({ data: pdfData.slice() }).promise;
  console.log(`pdfjs loaded: ${pdfJsDoc.numPages} pages`);

  // Phase 2: Analyze pages
  const scenes: PageScene[] = [];
  for (let pageIdx = 0; pageIdx < pdfJsDoc.numPages; pageIdx++) {
    const page = await pdfJsDoc.getPage(pageIdx + 1);
    console.log(`\n--- Analyzing page ${pageIdx + 1} ---`);
    const scene = await analyzePage(page, pdfLibDoc, pageIdx);
    scenes.push(scene);

    // Log all image elements
    const images = scene.elements.filter((e: any) => e.kind === 'image');
    console.log(`  Image elements found: ${images.length}`);
    for (const img of images) {
      const ie = img as ImageElement;
      console.log(`    ${ie.resourceName}: intrinsic=${ie.intrinsicWidth}x${ie.intrinsicHeight}, display=${ie.width.toFixed(1)}x${ie.height.toFixed(1)}, genuine=${ie.isGenuine}, hasData=${!!ie.data}, mime=${ie.mimeType}`);
      if (ie.data) {
        console.log(`      dataLen=${ie.data.length}, first4=0x${toHex(ie.data, 0, 4)}, last4=0x${toHex(ie.data, Math.max(0, ie.data.length - 4), 4)}`);
        // Validate image signatures
        if (ie.mimeType === 'image/jpeg') {
          const validStart = ie.data[0] === 0xFF && ie.data[1] === 0xD8;
          const validEnd = ie.data[ie.data.length - 2] === 0xFF && ie.data[ie.data.length - 1] === 0xD9;
          console.log(`      JPEG: startOK=${validStart}, endOK=${validEnd}`);
        } else if (ie.mimeType === 'image/png') {
          const validSig = ie.data[0] === 0x89 && ie.data[1] === 0x50;
          console.log(`      PNG: sigOK=${validSig}`);
          if (validSig && ie.data.length > 25) {
            const dv = new DataView(ie.data.buffer, ie.data.byteOffset);
            const pw = dv.getUint32(16, false);
            const ph = dv.getUint32(20, false);
            const bd = ie.data[24];
            const ct = ie.data[25];
            console.log(`      PNG IHDR: ${pw}x${ph}, bitDepth=${bd}, colorType=${ct}`);
          }
        }
      } else if (ie.isGenuine) {
        console.log(`      ⚠ GENUINE but data is NULL — this image will be lost!`);
      }
    }

    page.cleanup();
  }

  // Phase 3: Layout
  const layouts: PageLayout[] = [];
  for (const scene of scenes) {
    layouts.push(buildPageLayout(scene));
  }
  console.log(`\nLayouts built: ${layouts.length}`);

  // ─── STAGE C: Phase 4 - Image collection and dedup ───────────
  console.log('\n\n========================================');
  console.log('STAGE C: Pipeline Phase 4 (Image Collection & Dedup)');
  console.log('========================================\n');

  let nextRId = 4;
  let imageCounter = 0;
  const resourceDedup = new Map<string, ImageFile>();
  const contentDedup = new Map<string, ImageFile>();
  const allImages: ImageFile[] = [];
  const uniqueImages: ImageFile[] = [];

  let totalImages = 0, genuineImages = 0, withDataImages = 0;

  for (const layout of layouts) {
    for (const layoutElem of layout.elements) {
      if (layoutElem.type !== 'image') continue;
      totalImages++;
      const imgElem: ImageElement = layoutElem.element;

      if (!imgElem.isGenuine) {
        console.log(`  SKIP non-genuine: ${imgElem.resourceName} (${imgElem.intrinsicWidth}x${imgElem.intrinsicHeight})`);
        continue;
      }
      genuineImages++;

      if (!imgElem.data) {
        console.log(`  ⚠ GENUINE with NULL data: ${imgElem.resourceName} (${imgElem.intrinsicWidth}x${imgElem.intrinsicHeight})`);
        continue;
      }
      withDataImages++;

      const existingByResource = resourceDedup.get(imgElem.resourceName);
      if (existingByResource) {
        console.log(`  DEDUP (same resource): ${imgElem.resourceName} → reuse ${existingByResource.rId}`);
        allImages.push(existingByResource);
        continue;
      }

      const hash = fastHash(imgElem.data);
      const existingByContent = contentDedup.get(hash);
      if (existingByContent) {
        console.log(`  DEDUP (same content hash ${hash}): ${imgElem.resourceName} → reuse ${existingByContent.rId}`);
        resourceDedup.set(imgElem.resourceName, existingByContent);
        allImages.push(existingByContent);
        continue;
      }

      imageCounter++;
      const rId = `rId${nextRId++}`;
      const ext = imgElem.mimeType === 'image/jpeg' ? 'jpeg' : 'png';
      const fileName = `image${imageCounter}.${ext}`;

      let widthEmu = Math.round(imgElem.width * PT_TO_EMU);
      let heightEmu = Math.round(imgElem.height * PT_TO_EMU);
      const maxDim = 6858000;
      if (widthEmu > maxDim) { const r = maxDim / widthEmu; widthEmu = maxDim; heightEmu = Math.round(heightEmu * r); }
      if (heightEmu > maxDim) { const r = maxDim / heightEmu; heightEmu = maxDim; widthEmu = Math.round(widthEmu * r); }

      const imageFile: ImageFile = {
        rId, data: imgElem.data, mimeType: imgElem.mimeType, fileName,
        resourceName: imgElem.resourceName, widthEmu, heightEmu,
      };

      resourceDedup.set(imgElem.resourceName, imageFile);
      contentDedup.set(hash, imageFile);
      allImages.push(imageFile);
      uniqueImages.push(imageFile);

      console.log(`  NEW image: ${rId} → ${fileName} (${imgElem.mimeType}), ${imgElem.data.length} bytes, ${widthEmu}x${heightEmu} EMU`);
    }
  }

  console.log(`\nImage summary: ${totalImages} total, ${genuineImages} genuine, ${withDataImages} with data, ${uniqueImages.length} unique in ZIP`);

  // ─── STAGE D: Phase 5 - Generate OOXML and package ───────────
  console.log('\n\n========================================');
  console.log('STAGE D: Pipeline Phase 5 (OOXML Generation & ZIP)');
  console.log('========================================\n');

  const styleCollector = new StyleCollector();
  // Collect styles from text elements
  for (const scene of scenes) {
    for (const el of scene.elements) {
      if (el.kind === 'text') {
        styleCollector.addTextElement(el as any);
      }
    }
  }

  const hasFormFields = scenes.some(s => s.formFields.length > 0);

  const contentTypes = generateContentTypes(allImages);
  const rootRels = generateRootRels();
  const documentRels = generateDocumentRels(uniqueImages);
  const documentXml = generateDocumentXml(layouts, allImages, styleCollector);
  const stylesXml = generateStylesXml(styleCollector);
  const settingsXml = generateSettingsXml(hasFormFields);
  const fontTableXml = generateFontTableXml(styleCollector.getUsedFonts());

  const zip = new ZipBuilder();
  zip.addFileString('[Content_Types].xml', contentTypes);
  zip.addFileString('_rels/.rels', rootRels);
  zip.addFileString('word/_rels/document.xml.rels', documentRels);
  zip.addFileString('word/document.xml', documentXml);
  zip.addFileString('word/styles.xml', stylesXml);
  zip.addFileString('word/settings.xml', settingsXml);
  zip.addFileString('word/fontTable.xml', fontTableXml);

  for (const img of uniqueImages) {
    zip.addFile(`word/media/${img.fileName}`, img.data);
    console.log(`  Added to ZIP: word/media/${img.fileName} (${img.data.length} bytes)`);
  }

  const docxData = zip.build();
  console.log(`\nDOCX built: ${docxData.length} bytes`);

  // Save DOCX
  const docxPath = path.join(scriptDir, 'diagnostic-output.docx');
  fs.writeFileSync(docxPath, docxData);
  console.log(`Saved: ${docxPath}`);

  // ─── STAGE E: Crack open the DOCX and verify ────────────────
  console.log('\n\n========================================');
  console.log('STAGE E: DOCX ZIP verification');
  console.log('========================================\n');

  const zipEntries = parseZip(docxData);
  console.log('Files in DOCX:');
  for (const entry of zipEntries) {
    console.log(`  ${entry.name} (${entry.data.length} bytes)`);
  }

  // Check media files
  const mediaFiles = zipEntries.filter(e => e.name.startsWith('word/media/'));
  console.log(`\nMedia files: ${mediaFiles.length}`);
  if (mediaFiles.length === 0) {
    console.log('  ⚠ NO MEDIA FILES — all images were lost!');
  }

  const extractDir = path.join(scriptDir, 'extracted-media');
  if (!fs.existsSync(extractDir)) fs.mkdirSync(extractDir, { recursive: true });

  for (const media of mediaFiles) {
    console.log(`\n  ${media.name}: ${media.data.length} bytes`);
    console.log(`    first8=0x${toHex(media.data, 0, 8)}`);

    if (media.name.endsWith('.jpeg')) {
      const ok = media.data[0] === 0xFF && media.data[1] === 0xD8;
      const endOk = media.data[media.data.length - 2] === 0xFF && media.data[media.data.length - 1] === 0xD9;
      console.log(`    JPEG signature: ${ok ? 'VALID' : 'INVALID'}, end marker: ${endOk ? 'VALID' : 'INVALID'}`);
    } else if (media.name.endsWith('.png')) {
      const ok = media.data[0] === 0x89 && media.data[1] === 0x50 && media.data[2] === 0x4E && media.data[3] === 0x47;
      console.log(`    PNG signature: ${ok ? 'VALID' : 'INVALID'}`);
      if (ok && media.data.length > 25) {
        const dv = new DataView(media.data.buffer, media.data.byteOffset, media.data.byteLength);
        const pw = dv.getUint32(16, false);
        const ph = dv.getUint32(20, false);
        console.log(`    PNG IHDR: ${pw}x${ph}, bitDepth=${media.data[24]}, colorType=${media.data[25]}`);
      }
    }

    fs.writeFileSync(path.join(extractDir, path.basename(media.name)), media.data);
    console.log(`    Saved to: extracted-media/${path.basename(media.name)}`);
  }

  // ─── STAGE F: Check OOXML references ─────────────────────────
  console.log('\n\n========================================');
  console.log('STAGE F: OOXML reference chain');
  console.log('========================================\n');

  // document.xml.rels
  const relsEntry = zipEntries.find(e => e.name === 'word/_rels/document.xml.rels');
  if (relsEntry) {
    const relsXml = new TextDecoder().decode(relsEntry.data);
    const imageRels: { id: string; target: string }[] = [];
    for (const m of relsXml.matchAll(/Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
      if (m[2].startsWith('media/')) imageRels.push({ id: m[1], target: m[2] });
    }
    console.log(`Relationships (images): ${imageRels.length}`);
    for (const rel of imageRels) {
      const exists = zipEntries.some(e => e.name === `word/${rel.target}`);
      console.log(`  ${rel.id} → ${rel.target} : ${exists ? 'EXISTS' : '⚠ MISSING'}`);
    }
  }

  // document.xml blip references
  const docEntry = zipEntries.find(e => e.name === 'word/document.xml');
  if (docEntry) {
    const docXml = new TextDecoder().decode(docEntry.data);
    const blipRefs: string[] = [];
    for (const m of docXml.matchAll(/<a:blip r:embed="([^"]+)"\/>/g)) blipRefs.push(m[1]);

    console.log(`\nBlip references in document.xml: ${blipRefs.length}`);
    for (const ref of blipRefs) {
      const relsXml = relsEntry ? new TextDecoder().decode(relsEntry.data) : '';
      const hasRel = relsXml.includes(`Id="${ref}"`);
      console.log(`  ${ref} : relationship ${hasRel ? 'EXISTS' : '⚠ MISSING'}`);
    }

    // Extract extent dimensions
    const extents = [...docXml.matchAll(/<wp:extent cx="(\d+)" cy="(\d+)"\/>/g)];
    console.log(`\nImage dimensions:`);
    let i = 0;
    for (const ext of extents) {
      console.log(`  Image ${i}: ${ext[1]}x${ext[2]} EMU (${(parseInt(ext[1]) / 914400).toFixed(2)}"x${(parseInt(ext[2]) / 914400).toFixed(2)}")`);
      i++;
    }
  }

  // Content types
  const ctEntry = zipEntries.find(e => e.name === '[Content_Types].xml');
  if (ctEntry) {
    const ct = new TextDecoder().decode(ctEntry.data);
    const hasJpeg = ct.includes('Extension="jpeg"');
    const hasPng = ct.includes('Extension="png"');
    console.log(`\nContent types: JPEG=${hasJpeg}, PNG=${hasPng}`);
    const jpegFiles = mediaFiles.some(f => f.name.endsWith('.jpeg'));
    const pngFiles = mediaFiles.some(f => f.name.endsWith('.png'));
    if (jpegFiles && !hasJpeg) console.log('  ⚠ JPEG files exist but no content type!');
    if (pngFiles && !hasPng) console.log('  ⚠ PNG files exist but no content type!');
  }

  // ─── SUMMARY ─────────────────────────────────────────────────
  console.log('\n\n========================================');
  console.log('DIAGNOSTIC SUMMARY');
  console.log('========================================\n');

  console.log(`PDF pages: ${pdfJsDoc.numPages}`);
  console.log(`Total image ops: ${totalImages}`);
  console.log(`Genuine images: ${genuineImages}`);
  console.log(`With data: ${withDataImages}`);
  console.log(`Unique in ZIP: ${uniqueImages.length}`);
  console.log(`Media files in DOCX: ${mediaFiles.length}`);

  const docXml = docEntry ? new TextDecoder().decode(docEntry.data) : '';
  const blipCount = (docXml.match(/<a:blip/g) || []).length;
  console.log(`Drawing references: ${blipCount}`);

  // Check pipeline integrity
  const issues: string[] = [];
  if (genuineImages > 0 && withDataImages < genuineImages) {
    issues.push(`${genuineImages - withDataImages} genuine image(s) had NULL data — extraction failed`);
  }
  if (uniqueImages.length > 0 && mediaFiles.length < uniqueImages.length) {
    issues.push(`ZIP missing media files: expected ${uniqueImages.length}, found ${mediaFiles.length}`);
  }
  if (blipCount !== allImages.length) {
    issues.push(`Blip count (${blipCount}) != image reference count (${allImages.length})`);
  }

  if (issues.length === 0) {
    console.log('\n✓ No pipeline integrity issues detected with this PDF.');
    console.log('  If black boxes appear in Word, the image DATA may be corrupt (wrong color space, etc.)');
  } else {
    console.log('\n⚠ Issues found:');
    for (const issue of issues) console.log(`  - ${issue}`);
  }

  console.log(`\nDOCX: ${docxPath}`);
  console.log(`Extracted media: ${extractDir}/`);
  console.log('\nOpen the DOCX in Word and the extracted media files in an image viewer to verify.\n');

  await pdfJsDoc.destroy();
}

main().catch(e => { console.error('Diagnostic failed:', e); process.exit(1); });
