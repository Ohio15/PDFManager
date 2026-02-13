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

/** Rasterized page background for positioned mode */
interface PageBackground {
  data: Uint8Array;
  widthEmu: number;
  heightEmu: number;
  /** Indices into scene.elements that are editable text (not part of images) */
  editableTextIndices: Set<number>;
}

/**
 * Determine the background color at a given position from filled rects.
 * Checks largest containing filled rect (most likely to be the background).
 */
function findBgColor(
  x: number, y: number, w: number, h: number,
  filledRects: Array<import('./types').RectElement>,
): string {
  let bestArea = 0;
  let bgColor = '#ffffff';
  for (const rect of filledRects) {
    // Check if the rect contains the target area (with tolerance)
    if (
      x >= rect.x - 2 &&
      y >= rect.y - 2 &&
      x + w <= rect.x + rect.width + 2 &&
      y + h <= rect.y + rect.height + 2
    ) {
      const area = rect.width * rect.height;
      if (area > bestArea) {
        bestArea = area;
        const c = rect.fillColor!;
        bgColor = `rgb(${Math.round(c.r * 255)},${Math.round(c.g * 255)},${Math.round(c.b * 255)})`;
      }
    }
  }
  return bgColor;
}

/**
 * Check if a text element is inside a graphical region (logo, diagram, etc.)
 * by counting how many path elements overlap with it.
 * Text inside dense path clusters is likely part of an image and should NOT
 * be made editable — it stays as part of the background image.
 */
function isTextInGraphicRegion(
  textX: number, textY: number, textW: number, textH: number,
  pathElements: Array<import('./types').PathElement>,
): boolean {
  // Expand the search area slightly beyond the text bounds
  const margin = 5; // 5pt search radius
  const searchX = textX - margin;
  const searchY = textY - margin;
  const searchR = textX + textW + margin;
  const searchB = textY + textH + margin;

  let overlappingPaths = 0;
  for (const path of pathElements) {
    if (path.points.length === 0) continue;

    // Compute path bounding box
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const pt of path.points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }

    // Check overlap between search area and path bounding box
    if (maxX >= searchX && minX <= searchR && maxY >= searchY && minY <= searchB) {
      overlappingPaths++;
    }

    // If many paths overlap this text, it's inside a graphic region
    if (overlappingPaths >= 4) return true;
  }

  return false;
}

/**
 * Render a pdfjs page to PNG bytes using canvas, with text areas erased.
 *
 * Creates a "text-free" background image for positioned mode:
 *   1. Render the full PDF page to canvas (including text)
 *   2. Identify which text elements are "editable" vs "in images"
 *   3. Erase only editable text areas (paint background color over them)
 *   4. Leave text that's part of graphical regions (logos, diagrams) intact
 *   5. Export the modified canvas as PNG
 *
 * Returns the PNG data and a set of text element indices that were erased
 * (so the caller knows which text elements to create overlays for).
 */
async function renderPageToPng(
  page: any,
  scene: PageScene,
  scale: number = 2.0,
): Promise<{ pngData: Uint8Array; editableTextIndices: Set<number> }> {
  const viewport = page.getViewport({ scale });

  const canvas = document.createElement('canvas');
  canvas.width = viewport.width;
  canvas.height = viewport.height;
  const ctx = canvas.getContext('2d')!;

  // White background
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  // Render the full PDF page (including text)
  await page.render({ canvasContext: ctx, viewport }).promise;

  // Collect filled rects and path elements from the scene graph
  const filledRects = scene.elements.filter(
    (e): e is import('./types').RectElement => e.kind === 'rect' && e.fillColor !== null
  );
  const pathElements = scene.elements.filter(
    (e): e is import('./types').PathElement => e.kind === 'path'
  );

  // Classify text elements: editable (normal body text) vs graphic (part of logo/diagram)
  const editableTextIndices = new Set<number>();
  const textElements = scene.elements.filter(e => e.kind === 'text');

  for (let ti = 0; ti < scene.elements.length; ti++) {
    const elem = scene.elements[ti];
    if (elem.kind !== 'text') continue;

    // Check if this text is inside a dense graphical region
    if (isTextInGraphicRegion(elem.x, elem.y, elem.width, elem.height, pathElements)) {
      // Text is part of an image/logo — leave it in the background, don't make editable
      continue;
    }

    // This text is normal body text — mark for erasure and overlay
    editableTextIndices.add(ti);

    // Erase from canvas: paint background color over the text area
    const bgColor = findBgColor(elem.x, elem.y, elem.width, elem.height, filledRects);
    // Generous padding (3pt) ensures complete text coverage by the overlay text box
    const pad = 3;
    ctx.fillStyle = bgColor;
    ctx.fillRect(
      (elem.x - pad) * scale,
      (elem.y - pad) * scale,
      (elem.width + pad * 2) * scale,
      (elem.height + pad * 2) * scale,
    );
  }

  console.log(`[DocxGenerator] Text classification: ${editableTextIndices.size} editable, ${textElements.length - editableTextIndices.size} in graphics (preserved in background)`);

  // Erase form field areas (they'll be overlaid as editable form fields)
  for (const field of scene.formFields) {
    const bgColor = findBgColor(field.x, field.y, field.width, field.height, filledRects);
    const pad = 3;
    ctx.fillStyle = bgColor;
    ctx.fillRect(
      (field.x - pad) * scale,
      (field.y - pad) * scale,
      (field.width + pad * 2) * scale,
      (field.height + pad * 2) * scale,
    );
  }

  const blob = await new Promise<Blob>((resolve) => {
    canvas.toBlob((b) => resolve(b!), 'image/png');
  });

  return {
    pngData: new Uint8Array(await blob.arrayBuffer()),
    editableTextIndices,
  };
}

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
 *
 * @param includeAll - When true (positioned mode), include ALL images with data,
 *   not just genuine ones. This ensures 1:1 visual fidelity.
 * @param skipDimConstraint - When true (positioned mode), don't constrain image
 *   dimensions since exact sizing is needed for absolute positioning.
 */
function collectImages(
  imageElements: ImageElement[],
  imageScale: number,
  maxImageDimEmu: number,
  includeAll: boolean = false,
  skipDimConstraint: boolean = false,
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

    if (!includeAll && !imgElem.isGenuine) {
      console.log(`[DocxGenerator] Skipping non-genuine image: ${imgElem.resourceName} (${imgElem.intrinsicWidth}x${imgElem.intrinsicHeight})`);
      continue;
    }
    genuineImages++;
    if (!imgElem.data) {
      console.warn(`[DocxGenerator] Image has NULL data: ${imgElem.resourceName} (${imgElem.intrinsicWidth}x${imgElem.intrinsicHeight})`);
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

    // In positioned mode, skip dimension constraints to preserve exact sizing
    if (!skipDimConstraint) {
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
  const pageBackgrounds: PageBackground[] = [];

  const extractAllImages = conversionMode === 'positioned';
  // In positioned mode, image bytes are redundant — the page background PNG captures everything.
  // Images still appear in the scene graph (needed for isTextInGraphicRegion classification)
  // but skip the expensive extractImageData/handleFlateImage decompression.
  const extractImageBytes = conversionMode !== 'positioned';

  for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
    const page = await pdfJsDoc.getPage(pageIdx + 1);

    const scene = await analyzePage(page, pdfLibDoc, pageIdx, extractAllImages, extractImageBytes);
    scenes.push(scene);

    // In positioned mode, render each page to a PNG background image.
    // This captures ALL visual elements (vector paths, borders, logos, etc.)
    // that can't be individually converted to OOXML shapes.
    if (conversionMode === 'positioned') {
      try {
        const result = await renderPageToPng(page, scene, 3.0); // 3× = 216 DPI
        pageBackgrounds.push({
          data: result.pngData,
          widthEmu: Math.round(scene.width * PT_TO_EMU),
          heightEmu: Math.round(scene.height * PT_TO_EMU),
          editableTextIndices: result.editableTextIndices,
        });
        console.log(`[DocxGenerator] Page ${pageIdx} background: ${result.pngData.length} bytes PNG`);
      } catch (e) {
        console.warn(`[DocxGenerator] Page ${pageIdx} background render failed:`, e);
        pageBackgrounds.push({ data: new Uint8Array(0), widthEmu: 0, heightEmu: 0, editableTextIndices: new Set() });
      }
    }

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

    // Phase 4: Collect images directly from scenes (include ALL images for 1:1 fidelity)
    const imageElements = extractImagesFromScenes(scenes);
    console.log(`[DocxGenerator] Positioned mode: ${imageElements.length} image elements from scenes, ${imageElements.filter(e => e.data !== null).length} with data, ${imageElements.filter(e => e.isGenuine).length} genuine`);
    const collected = collectImages(imageElements, imageScale, maxImageDimEmu, true, true);
    allImages = collected.allImages;
    uniqueImages = collected.uniqueImages;

    // Create ImageFile entries for page background images (rIds continue from last image)
    const bgNextRId = 4 + uniqueImages.length;
    const bgImages: ImageFile[] = [];
    for (let pi = 0; pi < pageBackgrounds.length; pi++) {
      const bg = pageBackgrounds[pi];
      if (bg.data.length === 0) continue;
      const bgFile: ImageFile = {
        rId: `rId${bgNextRId + pi}`,
        data: bg.data,
        mimeType: 'image/png',
        fileName: `page_bg_${pi + 1}.png`,
        resourceName: `__page_bg_${pi}`,
        widthEmu: bg.widthEmu,
        heightEmu: bg.heightEmu,
      };
      bgImages.push(bgFile);
      uniqueImages.push(bgFile);
    }
    console.log(`[DocxGenerator] Positioned mode: ${allImages.length} allImages, ${uniqueImages.length} uniqueImages (${bgImages.length} page backgrounds)`);

    // Build per-page editable text index sets for the OOXML generator
    const editableTextSets = pageBackgrounds.map(bg => bg.editableTextIndices);

    // Phase 5a: Generate positioned document XML
    documentXml = generatePositionedDocumentXml(scenes, allImages, styleCollector, bgImages, editableTextSets);

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
