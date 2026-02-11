/**
 * DOCX Generator — Main Orchestrator
 *
 * Converts PDF bytes to DOCX bytes by:
 * 1. Extracting text via pdfjs-dist (getTextContent)
 * 2. Extracting images via pdf-lib (XObject streams)
 * 3. Grouping text into paragraphs via layout analysis
 * 4. Registering only used styles
 * 5. Generating clean OOXML (DrawingML only, no VML)
 * 6. Packaging into ZIP → DOCX
 */

import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { PDFDocument as PDFLibDoc } from 'pdf-lib';

import type {
  DocxPage,
  DocxPageElement,
  DocxParagraph,
  DocxRun,
  DocxImage,
  ConvertOptions,
  ExtractedImage,
} from './types';
import { PT_TO_TWIPS, PT_TO_EMU } from './types';
import { ZipBuilder } from './ZipBuilder';
import { extractPageImages } from './ImageExtractor';
import { StyleCollector } from './StyleCollector';
import {
  generateContentTypes,
  generateRootRels,
  generateDocumentRels,
  generateDocumentXml,
  generateStylesXml,
  generateSettingsXml,
  generateFontTableXml,
} from './OoxmlParts';

// Ensure worker is configured
pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

/** Common PDF font name → DOCX font name mappings */
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

/**
 * Clean up a PDF font name:
 * - Strip subset prefix (e.g., "ABCDEF+" → "")
 * - Map to standard DOCX font name
 * - Strip style suffixes
 */
function mapFontName(pdfFontName: string): string {
  if (!pdfFontName) return 'Calibri';

  // Strip subset prefix like "BCDFGH+"
  let name = pdfFontName.replace(/^[A-Z]{6}\+/, '');

  // Check mapped names first
  if (FONT_MAP[name]) return FONT_MAP[name];

  // Strip common suffixes
  name = name.replace(/[-,](Bold|Italic|BoldItalic|Regular|Medium|Light|Semibold|Condensed|Narrow|Black|Heavy|Thin|ExtraBold|ExtraLight)$/i, '');
  name = name.replace(/MT$/, '');
  name = name.replace(/PS$/, '');

  // Handle hyphenated compound names
  if (name.includes('-')) {
    const parts = name.split('-');
    // If the second part looks like a style, keep only the first part
    if (/^(Bold|Italic|Regular|Medium|Light|Semi|Extra|Condensed)$/i.test(parts[parts.length - 1])) {
      name = parts.slice(0, -1).join('-');
    }
  }

  return name || 'Calibri';
}

/**
 * Convert PDF color components to a hex string (without '#').
 * pdfjs-dist textContent items don't expose color directly, so we default to black.
 */
function colorToHex(r: number, g: number, b: number): string {
  const toHex = (v: number) => Math.round(v * 255).toString(16).padStart(2, '0');
  return `${toHex(r)}${toHex(g)}${toHex(b)}`;
}

interface TextItem {
  str: string;
  fontName: string;
  fontSize: number;
  x: number;
  y: number;
  width: number;
  height: number;
  bold: boolean;
  italic: boolean;
}

/**
 * Main DOCX generation function.
 *
 * @param pdfData - Raw PDF bytes
 * @param options - Conversion options
 * @returns DOCX file as Uint8Array
 */
export async function generateDocx(
  pdfData: Uint8Array,
  options: ConvertOptions = {}
): Promise<{ data: Uint8Array; pageCount: number }> {
  const {
    preservePageBreaks = true,
    imageScale = 1.0,
    maxImageDimEmu = 6858000, // ~7.5 inches max width
  } = options;

  // Load PDF with both libraries in parallel
  const [pdfJsDoc, pdfLibDoc] = await Promise.all([
    pdfjsLib.getDocument({ data: pdfData.slice() }).promise,
    PDFLibDoc.load(pdfData, { ignoreEncryption: true }),
  ]);

  const styleCollector = new StyleCollector();
  const allPages: DocxPage[] = [];
  const allImages: DocxImage[] = [];
  let imageCounter = 0;
  // rIds 1-3 reserved for styles, settings, fontTable
  let nextRId = 4;

  const numPages = pdfJsDoc.numPages;

  for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
    const page = await pdfJsDoc.getPage(pageIdx + 1);
    const viewport = page.getViewport({ scale: 1 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    // -- Extract text --
    const textContent = await page.getTextContent();
    const textItems: TextItem[] = [];

    for (const item of textContent.items) {
      const ti = item as any;
      if (!ti.str || !ti.str.trim()) continue;

      const transform = ti.transform;
      const fontSize = Math.sqrt(transform[0] * transform[0] + transform[1] * transform[1]);
      const x = transform[4];
      const height = ti.height || fontSize * 1.2;
      // pdfjs uses bottom-left origin; convert to top-left for layout
      const y = pageHeight - transform[5] - height;
      const width = ti.width || (ti.str.length * fontSize * 0.5);
      const fontName = ti.fontName || 'default';

      textItems.push({
        str: ti.str,
        fontName,
        fontSize,
        x,
        y,
        width,
        height,
        bold: isBoldFont(fontName),
        italic: isItalicFont(fontName),
      });
    }

    // -- Group into lines and paragraphs --
    const paragraphs = groupTextIntoParagraphs(textItems, pageWidth, styleCollector);

    // -- Extract images --
    let pageImages: ExtractedImage[] = [];
    try {
      pageImages = await extractPageImages(pdfLibDoc, pageIdx);
    } catch {
      // Image extraction failure is non-fatal
    }

    // Convert extracted images to DocxImage format
    const docxPageImages: DocxImage[] = [];
    for (const img of pageImages) {
      imageCounter++;
      const rId = `rId${nextRId++}`;
      const ext = img.mimeType === 'image/jpeg' ? 'jpeg' : 'png';
      const fileName = `image${imageCounter}.${ext}`;

      // Convert PDF points to EMU, respecting scale and max dimension
      let widthEmu = Math.round(img.width * PT_TO_EMU * imageScale);
      let heightEmu = Math.round(img.height * PT_TO_EMU * imageScale);

      // Constrain to max dimension while preserving aspect ratio
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

      const docxImg: DocxImage = {
        rId,
        data: img.data,
        mimeType: img.mimeType,
        widthEmu,
        heightEmu,
        fileName,
        pageIndex: pageIdx,
        yPosition: img.y,
      };

      docxPageImages.push(docxImg);
      allImages.push(docxImg);
    }

    // -- Build page elements in reading order --
    const elements: DocxPageElement[] = [];

    // Add images at the top of the page (before text)
    for (const img of docxPageImages) {
      elements.push({ type: 'image', element: img });
    }

    // Add text paragraphs
    for (const para of paragraphs) {
      elements.push({ type: 'paragraph', element: para });
    }

    allPages.push({
      elements,
      widthTwips: Math.round(pageWidth * PT_TO_TWIPS),
      heightTwips: Math.round(pageHeight * PT_TO_TWIPS),
    });

    // Clean up pdfjs page to free memory
    page.cleanup();
  }

  // -- Generate all OOXML parts --
  const contentTypes = generateContentTypes(allImages);
  const rootRels = generateRootRels();
  const documentRels = generateDocumentRels(allImages);
  const documentXml = generateDocumentXml(allPages, allImages, styleCollector);
  const stylesXml = generateStylesXml(styleCollector);
  const settingsXml = generateSettingsXml();
  const fontTableXml = generateFontTableXml(styleCollector.getUsedFonts());

  // -- Package into ZIP --
  const zip = new ZipBuilder();
  zip.addFileString('[Content_Types].xml', contentTypes);
  zip.addFileString('_rels/.rels', rootRels);
  zip.addFileString('word/_rels/document.xml.rels', documentRels);
  zip.addFileString('word/document.xml', documentXml);
  zip.addFileString('word/styles.xml', stylesXml);
  zip.addFileString('word/settings.xml', settingsXml);
  zip.addFileString('word/fontTable.xml', fontTableXml);

  // Add image media files
  for (const img of allImages) {
    zip.addFile(`word/media/${img.fileName}`, img.data);
  }

  const docxData = zip.build();

  // Cleanup pdfjs document
  await pdfJsDoc.destroy();

  return { data: docxData, pageCount: numPages };
}

// ────────────────────────────────────────────────────────────
// Layout analysis: group text items into paragraphs with runs
// ────────────────────────────────────────────────────────────

const BASELINE_TOLERANCE = 3; // pts
const WORD_GAP_FACTOR = 0.3; // fraction of font size
const PARA_GAP_FACTOR = 1.5; // fraction of average font size

interface TextLine {
  items: TextItem[];
  y: number;
  minX: number;
  maxX: number;
  avgFontSize: number;
}

function groupTextIntoParagraphs(
  items: TextItem[],
  pageWidth: number,
  styleCollector: StyleCollector
): DocxParagraph[] {
  if (items.length === 0) return [];

  // Sort by Y (top to bottom), then X (left to right)
  const sorted = [...items].sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) > BASELINE_TOLERANCE) return yDiff;
    return a.x - b.x;
  });

  // Group into lines by baseline proximity
  const lines: TextLine[] = [];
  let currentLine: TextItem[] = [sorted[0]];
  let currentY = sorted[0].y;

  for (let i = 1; i < sorted.length; i++) {
    const item = sorted[i];
    if (Math.abs(item.y - currentY) <= BASELINE_TOLERANCE) {
      currentLine.push(item);
    } else {
      lines.push(finalizeLine(currentLine, currentY));
      currentLine = [item];
      currentY = item.y;
    }
  }
  if (currentLine.length > 0) {
    lines.push(finalizeLine(currentLine, currentY));
  }

  // Sort lines within each by X
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
  }

  // Group lines into paragraphs based on vertical spacing
  const paragraphs: DocxParagraph[] = [];
  let paraLines: TextLine[] = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prevLine = lines[i - 1];
    const currLine = lines[i];
    const gap = currLine.y - (prevLine.y + prevLine.avgFontSize * 1.2);
    const avgFont = (prevLine.avgFontSize + currLine.avgFontSize) / 2;

    if (gap > avgFont * PARA_GAP_FACTOR) {
      // New paragraph
      paragraphs.push(buildParagraph(paraLines, pageWidth, styleCollector));
      paraLines = [currLine];
    } else {
      paraLines.push(currLine);
    }
  }
  if (paraLines.length > 0) {
    paragraphs.push(buildParagraph(paraLines, pageWidth, styleCollector));
  }

  return paragraphs;
}

function finalizeLine(items: TextItem[], y: number): TextLine {
  const minX = Math.min(...items.map(i => i.x));
  const maxX = Math.max(...items.map(i => i.x + i.width));
  const avgFontSize = items.reduce((sum, i) => sum + i.fontSize, 0) / items.length;
  return { items, y, minX, maxX, avgFontSize };
}

function buildParagraph(
  lines: TextLine[],
  pageWidth: number,
  styleCollector: StyleCollector
): DocxParagraph {
  // Merge all items from all lines into runs with word spacing
  const runs: DocxRun[] = [];

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];

    // Add line break between lines (except first)
    if (lineIdx > 0 && runs.length > 0) {
      // Append a space or newline to the last run's text
      const lastRun = runs[runs.length - 1];
      runs[runs.length - 1] = { ...lastRun, text: lastRun.text + ' ' };
    }

    for (let i = 0; i < line.items.length; i++) {
      const item = line.items[i];
      const mappedFont = mapFontName(item.fontName);
      const halfPts = Math.round(item.fontSize * 2);
      const color = '000000'; // Default black (pdfjs doesn't expose color in textContent)

      // Register style
      styleCollector.registerRun(mappedFont, halfPts, item.bold, item.italic, color);

      // Check if we need to insert a space before this item
      let prefix = '';
      if (i > 0) {
        const prevItem = line.items[i - 1];
        const gap = item.x - (prevItem.x + prevItem.width);
        if (gap > item.fontSize * WORD_GAP_FACTOR) {
          prefix = ' ';
        } else if (gap > 0.5) {
          // Small gap but still a space
          prefix = ' ';
        }
      }

      const text = prefix + item.str;

      // Try to merge with previous run if same formatting
      if (runs.length > 0) {
        const prev = runs[runs.length - 1];
        if (
          prev.fontName === mappedFont &&
          prev.fontSize === halfPts &&
          prev.bold === item.bold &&
          prev.italic === item.italic &&
          prev.color === color
        ) {
          runs[runs.length - 1] = { ...prev, text: prev.text + text };
          continue;
        }
      }

      runs.push({
        text,
        fontName: mappedFont,
        fontSize: halfPts,
        bold: item.bold,
        italic: item.italic,
        color,
      });
    }
  }

  // Detect alignment
  const alignment = detectAlignment(lines, pageWidth);

  // Calculate spacing
  const avgFontSize = lines.reduce((s, l) => s + l.avgFontSize, 0) / lines.length;
  const lineSpacing = Math.round(avgFontSize * 1.15 * PT_TO_TWIPS); // 115% line spacing

  return {
    runs,
    alignment,
    indent: 0,
    firstLineIndent: 0,
    spacingBefore: 0,
    spacingAfter: Math.round(avgFontSize * 0.3 * PT_TO_TWIPS), // Small spacing after
    lineSpacing,
  };
}

function detectAlignment(lines: TextLine[], pageWidth: number): 'left' | 'center' | 'right' | 'justify' {
  if (lines.length === 0) return 'left';

  const MARGIN = 72; // Approximate 1-inch margins in points
  const contentWidth = pageWidth - 2 * MARGIN;

  const leftEdges = lines.map(l => l.minX);
  const rightEdges = lines.map(l => l.maxX);

  const leftVar = variance(leftEdges);
  const rightVar = variance(rightEdges);

  const LOW_VAR = 15;

  if (leftVar < LOW_VAR && rightVar < LOW_VAR && lines.length > 1) {
    return 'justify';
  }
  if (leftVar < LOW_VAR) return 'left';
  if (rightVar < LOW_VAR) return 'right';

  const centers = lines.map(l => (l.minX + l.maxX) / 2);
  if (variance(centers) < LOW_VAR) return 'center';

  return 'left';
}

function variance(nums: number[]): number {
  if (nums.length <= 1) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / nums.length;
}
