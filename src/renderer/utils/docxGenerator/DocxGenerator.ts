/**
 * DOCX Generator — Main Orchestrator
 *
 * Thin orchestration layer for the dual-mode PDF-to-DOCX pipeline:
 *
 * SHARED (both modes):
 *   Phase 1: Load PDF with pdfjs-dist + pdf-lib
 *   Phase 2: Analyze each page into a scene graph (PageAnalyzer)
 *
 * POSITIONED mode ("Retain Page Layout"):
 *   Skip Phase 3 — uses scene graph directly
 *   Phase 4: Collect images from scenes
 *   Phase 5a: Generate positioned OOXML (absolute text boxes)
 *
 * FLOW mode ("Retain Flowing Text"):
 *   Phase 3: Build structural layouts from scene graphs (LayoutAnalyzer)
 *   Phase 4: Collect images from layouts
 *   Phase 5b: Generate flow OOXML (paragraphs, tables)
 *
 * All heavy logic lives in PageAnalyzer, LayoutAnalyzer, OoxmlParts,
 * and PositionedOoxmlParts. This file only wires the phases together.
 */

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument } from 'pdf-lib';
import type { PageScene, PageLayout, ImageElement, ImageFile, ConvertOptions } from './types';
import { PT_TO_EMU } from './types';
import { ZipBuilder } from './ZipBuilder';
import { StyleCollector } from './StyleCollector';
import { analyzePage } from './PageAnalyzer';
import { buildPageLayout } from './LayoutAnalyzer';
import {
  generateContentTypes,
  generateRootRels,
  generateDocumentRels,
  generateDocumentXml,
  generateStylesXml,
  generateSettingsXml,
  generateFontTableXml,
} from './OoxmlParts';
import { generatePositionedDocumentXml } from './PositionedOoxmlParts';

// Ensure pdfjs worker is configured
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/**
 * Fast non-crypto hash for image deduplication.
 * Uses FNV-1a (32-bit) with length suffix to minimize collision risk.
 */
function fastHash(data: Uint8Array): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  return `${(hash >>> 0).toString(16)}-${data.length}`;
}

/**
 * Collect and deduplicate images from an array of ImageElement sources.
 * Shared between positioned and flow modes.
 */
function collectImages(
  imageElements: ImageElement[],
  imageScale: number,
  maxImageDimEmu: number,
): { allImages: ImageFile[]; uniqueImages: ImageFile[] } {
  // rIds 1-3 are reserved: styles, settings, fontTable
  let nextRId = 4;
  let imageCounter = 0;

  const resourceDedup = new Map<string, ImageFile>();
  const contentDedup = new Map<string, ImageFile>();
  const allImages: ImageFile[] = [];
  const uniqueImages: ImageFile[] = [];

  let totalImages = 0;
  let genuineImages = 0;
  let withDataImages = 0;

  for (const imgElem of imageElements) {
    totalImages++;

    if (!imgElem.isGenuine) {
      console.log(`[DocxGenerator] Skipping non-genuine image: ${imgElem.resourceName} (${imgElem.intrinsicWidth}x${imgElem.intrinsicHeight})`);
      continue;
    }
    genuineImages++;
    if (!imgElem.data) {
      console.warn(`[DocxGenerator] Genuine image has NULL data: ${imgElem.resourceName} (${imgElem.intrinsicWidth}x${imgElem.intrinsicHeight})`);
      continue;
    }
    withDataImages++;

    const existingByResource = resourceDedup.get(imgElem.resourceName);
    if (existingByResource) {
      allImages.push(existingByResource);
      continue;
    }

    const hash = fastHash(imgElem.data);
    const existingByContent = contentDedup.get(hash);
    if (existingByContent) {
      resourceDedup.set(imgElem.resourceName, existingByContent);
      allImages.push(existingByContent);
      continue;
    }

    imageCounter++;
    const rId = `rId${nextRId++}`;
    const ext = imgElem.mimeType === 'image/jpeg' ? 'jpeg' : 'png';
    const fileName = `image${imageCounter}.${ext}`;

    let widthEmu = Math.round(imgElem.width * PT_TO_EMU * imageScale);
    let heightEmu = Math.round(imgElem.height * PT_TO_EMU * imageScale);

    if (widthEmu > maxImageDimEmu) {
      const ratio = maxImageDimEmu / widthEmu;
      widthEmu = maxImageDimEmu;
      heightEmu = Math.round(heightEmu * ratio);
    }
    if (heightEmu > maxImageDimEmu) {
      const ratio = maxImageDimEmu / heightEmu;
      heightEmu = maxImageDimEmu;
      widthEmu = Math.round(widthEmu * ratio);
    }

    const imageFile: ImageFile = {
      rId,
      data: imgElem.data,
      mimeType: imgElem.mimeType,
      fileName,
      resourceName: imgElem.resourceName,
      widthEmu,
      heightEmu,
    };

    resourceDedup.set(imgElem.resourceName, imageFile);
    contentDedup.set(hash, imageFile);
    allImages.push(imageFile);
    uniqueImages.push(imageFile);
  }

  console.log(`[DocxGenerator] Image summary: ${totalImages} total, ${genuineImages} genuine, ${withDataImages} with data, ${uniqueImages.length} unique in ZIP`);

  return { allImages, uniqueImages };
}

/**
 * Extract all ImageElements from PageScene[] (for positioned mode).
 */
function extractImagesFromScenes(scenes: PageScene[]): ImageElement[] {
  const images: ImageElement[] = [];
  for (const scene of scenes) {
    for (const elem of scene.elements) {
      if (elem.kind === 'image') {
        images.push(elem);
      }
    }
  }
  return images;
}

/**
 * Extract all ImageElements from PageLayout[] (for flow mode).
 */
function extractImagesFromLayouts(layouts: PageLayout[]): ImageElement[] {
  const images: ImageElement[] = [];
  for (const layout of layouts) {
    for (const layoutElem of layout.elements) {
      if (layoutElem.type === 'image') {
        images.push(layoutElem.element);
      }
    }
  }
  return images;
}

/**
 * Main DOCX generation function.
 *
 * Converts raw PDF bytes into a valid DOCX file. Supports two modes:
 *   - 'positioned': 1:1 visual match using absolute text box positioning
 *   - 'flow': editable flowing text with paragraphs and tables (default)
 *
 * @param pdfData - Raw PDF bytes
 * @param options - Conversion options including mode
 * @returns DOCX file as Uint8Array and the page count
 */
export async function generateDocx(
  pdfData: Uint8Array,
  options: ConvertOptions = {}
): Promise<{ data: Uint8Array; pageCount: number }> {
  const {
    conversionMode = 'flow',
    imageScale = 1.0,
    maxImageDimEmu = 6858000, // ~7.5 inches max width
  } = options;

  // ─── Phase 1: Load documents (SHARED) ─────────────────────

  const pdfJsDoc = await pdfjsLib.getDocument({ data: pdfData.slice() }).promise;

  let pdfLibDoc: PDFDocument | null = null;
  try {
    pdfLibDoc = await PDFDocument.load(pdfData, { ignoreEncryption: true });
  } catch {
    // pdf-lib loading failed — image extraction from streams won't be available
  }

  const numPages = pdfJsDoc.numPages;
  const styleCollector = new StyleCollector();

  // ─── Phase 2: Analyze all pages into scene graphs (SHARED) ─

  const scenes: PageScene[] = [];

  for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
    const page = await pdfJsDoc.getPage(pageIdx + 1);

    const scene = await analyzePage(page, pdfLibDoc, pageIdx);
    scenes.push(scene);

    page.cleanup();
  }

  console.log(`[DocxGenerator] Mode: ${conversionMode}, ${numPages} pages`);

  // Detect whether any page has form fields (for document protection settings)
  const hasFormFields = scenes.some(scene => scene.formFields.length > 0);

  let documentXml: string;
  let allImages: ImageFile[];
  let uniqueImages: ImageFile[];

  if (conversionMode === 'positioned') {
    // ─── POSITIONED MODE: Skip LayoutAnalyzer, use scenes directly ─

    // Phase 4: Collect images directly from scenes
    const imageElements = extractImagesFromScenes(scenes);
    const collected = collectImages(imageElements, imageScale, maxImageDimEmu);
    allImages = collected.allImages;
    uniqueImages = collected.uniqueImages;

    // Phase 5a: Generate positioned document XML
    documentXml = generatePositionedDocumentXml(scenes, allImages, styleCollector);

  } else {
    // ─── FLOW MODE: Full pipeline with LayoutAnalyzer ─────────

    // Phase 3: Build structural layouts
    const layouts: PageLayout[] = [];
    for (const scene of scenes) {
      const layout = await buildPageLayout(scene);
      layouts.push(layout);
    }

    // Phase 4: Collect images from layouts
    const imageElements = extractImagesFromLayouts(layouts);
    const collected = collectImages(imageElements, imageScale, maxImageDimEmu);
    allImages = collected.allImages;
    uniqueImages = collected.uniqueImages;

    // Phase 5b: Generate flow document XML
    documentXml = generateDocumentXml(layouts, allImages, styleCollector);
  }

  // ─── Generate remaining OOXML parts and package (SHARED) ─

  const contentTypes = generateContentTypes(allImages);
  const rootRels = generateRootRels();
  const documentRels = generateDocumentRels(uniqueImages);
  const stylesXml = generateStylesXml(styleCollector);
  const settingsXml = generateSettingsXml(hasFormFields);
  const fontTableXml = generateFontTableXml(styleCollector.getUsedFonts());

  // Package into ZIP
  const zip = new ZipBuilder();
  zip.addFileString('[Content_Types].xml', contentTypes);
  zip.addFileString('_rels/.rels', rootRels);
  zip.addFileString('word/_rels/document.xml.rels', documentRels);
  zip.addFileString('word/document.xml', documentXml);
  zip.addFileString('word/styles.xml', stylesXml);
  zip.addFileString('word/settings.xml', settingsXml);
  zip.addFileString('word/fontTable.xml', fontTableXml);

  // Add image media files (only unique images -- deduped by content hash)
  for (const img of uniqueImages) {
    zip.addFile(`word/media/${img.fileName}`, img.data);
  }

  const docxData = zip.build();

  // Cleanup pdfjs document to free memory
  await pdfJsDoc.destroy();

  return { data: docxData, pageCount: numPages };
}
