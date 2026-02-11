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
  DocxTable,
  DocxTableRow,
  DocxTableCell,
  DocxFormField,
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

/**
 * Fast non-crypto hash for image deduplication.
 * Uses FNV-1a (32-bit) — fast, good distribution, no collisions for our use case.
 */
function fastHash(data: Uint8Array): string {
  let hash = 0x811c9dc5; // FNV offset basis
  for (let i = 0; i < data.length; i++) {
    hash ^= data[i];
    hash = Math.imul(hash, 0x01000193); // FNV prime
  }
  // Include length to further reduce collision risk
  return `${(hash >>> 0).toString(16)}-${data.length}`;
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

  // Image dedup: hash → { rId, fileName } so identical images share one media entry
  const imageHashMap = new Map<string, { rId: string; fileName: string }>();
  // Track unique images for ZIP packaging (only one copy per hash)
  const uniqueImages: DocxImage[] = [];

  const numPages = pdfJsDoc.numPages;

  for (let pageIdx = 0; pageIdx < numPages; pageIdx++) {
    const page = await pdfJsDoc.getPage(pageIdx + 1);
    const viewport = page.getViewport({ scale: 1 });
    const pageWidth = viewport.width;
    const pageHeight = viewport.height;

    // -- Extract text --
    const textContent = await page.getTextContent();
    const textItems: TextItem[] = [];

    // Build font name resolution map from pdfjs styles metadata
    // textContent.styles maps internal font IDs (e.g., "g_d6_f1") to objects with fontFamily
    const fontNameMap: Record<string, string> = {};
    const styles = (textContent as any).styles;
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
      const fontSize = Math.sqrt(transform[0] * transform[0] + transform[1] * transform[1]);
      const x = transform[4];
      const height = ti.height || fontSize * 1.2;
      // pdfjs uses bottom-left origin; convert to top-left for layout
      const y = pageHeight - transform[5] - height;
      const width = ti.width || (ti.str.length * fontSize * 0.5);

      // Resolve internal font name to actual font family
      const rawFontName = ti.fontName || 'default';
      const fontName = fontNameMap[rawFontName] || rawFontName;

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

    // -- Detect tables and group remaining text into paragraphs --
    const { paragraphs, tables } = analyzePageLayout(textItems, pageWidth, styleCollector);

    // -- Extract images --
    let pageImages: ExtractedImage[] = [];
    try {
      pageImages = await extractPageImages(pdfLibDoc, pageIdx);
    } catch {
      // Image extraction failure is non-fatal
    }

    // Convert extracted images to DocxImage format with deduplication
    const docxPageImages: DocxImage[] = [];
    for (const img of pageImages) {
      // Compute a fast content hash for dedup
      const hash = fastHash(img.data);
      let rId: string;
      let fileName: string;

      const existing = imageHashMap.get(hash);
      if (existing) {
        // Reuse the same rId and fileName — no new media entry needed
        rId = existing.rId;
        fileName = existing.fileName;
      } else {
        // New unique image
        imageCounter++;
        rId = `rId${nextRId++}`;
        const ext = img.mimeType === 'image/jpeg' ? 'jpeg' : 'png';
        fileName = `image${imageCounter}.${ext}`;
        imageHashMap.set(hash, { rId, fileName });
      }

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

      // Only add to uniqueImages if this is a new hash (for ZIP packaging)
      if (!existing) {
        uniqueImages.push(docxImg);
      }
    }

    // -- Extract form fields from Widget annotations --
    const formFields: DocxFormField[] = [];
    try {
      const annotations = await page.getAnnotations();
      for (const annot of annotations) {
        if (annot.subtype !== 'Widget') continue;

        const rect = annot.rect; // [x1, y1, x2, y2] in PDF coords (bottom-left origin)
        const fieldWidth = Math.abs(rect[2] - rect[0]);
        const fieldHeight = Math.abs(rect[3] - rect[1]);
        const xPos = rect[0];
        // Convert from bottom-left to top-left origin
        const yPos = pageHeight - rect[3];

        let fieldType: DocxFormField['fieldType'] = 'text';
        let checked = false;
        let options: string[] = [];
        let value = '';
        const maxLength = annot.maxLen || 0;

        if (annot.checkBox) {
          fieldType = 'checkbox';
          checked = annot.fieldValue === annot.exportValue ||
                    annot.fieldValue === 'Yes' ||
                    annot.fieldValue === true;
        } else if (annot.radioButton) {
          fieldType = 'checkbox'; // Radio buttons emit as checkboxes in DOCX
          checked = !!annot.fieldValue && annot.fieldValue !== 'Off';
        } else if (annot.combo || annot.listBox) {
          fieldType = 'dropdown';
          options = annot.options?.map((o: any) => o.displayValue || o.exportValue || String(o)) || [];
          value = typeof annot.fieldValue === 'string' ? annot.fieldValue : '';
        } else if (!annot.pushButton) {
          // Text field (default) — skip push buttons
          fieldType = 'text';
          value = typeof annot.fieldValue === 'string' ? annot.fieldValue : '';
        } else {
          continue; // Skip push buttons entirely
        }

        formFields.push({
          fieldName: annot.fieldName || '',
          fieldType,
          value,
          options,
          checked,
          yPosition: yPos,
          xPosition: xPos,
          width: fieldWidth,
          height: fieldHeight,
          pageIndex: pageIdx,
          maxLength,
        });
      }
    } catch {
      // Form field extraction failure is non-fatal
    }

    // -- Build page elements in reading order (interleaved by Y position) --
    const elements: DocxPageElement[] = [];

    // Collect all positioned elements with their Y coordinates
    const positioned: Array<{ y: number; elem: DocxPageElement }> = [];

    for (const img of docxPageImages) {
      positioned.push({ y: img.yPosition, elem: { type: 'image', element: img } });
    }
    for (const para of paragraphs) {
      positioned.push({ y: para.yPosition ?? 0, elem: { type: 'paragraph', element: para } });
    }
    for (const field of formFields) {
      positioned.push({ y: field.yPosition, elem: { type: 'formField', element: field } });
    }
    for (const tbl of tables) {
      positioned.push({ y: tbl.yPosition ?? 0, elem: { type: 'table', element: tbl } });
    }

    // Sort by Y position (top to bottom)
    positioned.sort((a, b) => a.y - b.y);

    for (const item of positioned) {
      elements.push(item.elem);
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
  const documentRels = generateDocumentRels(uniqueImages);
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

  // Add image media files (only unique images — deduped by content hash)
  for (const img of uniqueImages) {
    zip.addFile(`word/media/${img.fileName}`, img.data);
  }

  const docxData = zip.build();

  // Cleanup pdfjs document
  await pdfJsDoc.destroy();

  return { data: docxData, pageCount: numPages };
}

// ────────────────────────────────────────────────────────────
// Layout analysis: detect tables, group text into paragraphs
// ────────────────────────────────────────────────────────────

const BASELINE_TOLERANCE = 3; // pts
const WORD_GAP_FACTOR = 0.3; // fraction of font size
const PARA_GAP_FACTOR = 1.5; // fraction of average font size
const COLUMN_CLUSTER_TOLERANCE = 8; // pts — X positions within this are "same column"
const MIN_TABLE_COLUMNS = 2; // Need at least 2 columns to be a table
const MIN_TABLE_ROWS = 2; // Need at least 2 rows to be a table

interface TextLine {
  items: TextItem[];
  y: number;
  minX: number;
  maxX: number;
  avgFontSize: number;
}

interface LayoutResult {
  paragraphs: DocxParagraph[];
  tables: DocxTable[];
}

/**
 * Analyze a page's text items to detect tables and group remaining text into paragraphs.
 *
 * Algorithm:
 * 1. Group all text items into lines (by Y baseline proximity)
 * 2. For each line, identify column-start X positions
 * 3. Cluster X positions across lines to find column boundaries
 * 4. If consistent columns found across consecutive rows → table
 * 5. Remaining lines → paragraphs
 */
function analyzePageLayout(
  items: TextItem[],
  pageWidth: number,
  styleCollector: StyleCollector
): LayoutResult {
  if (items.length === 0) return { paragraphs: [], tables: [] };

  // Step 1: Sort and group into lines
  const sorted = [...items].sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) > BASELINE_TOLERANCE) return yDiff;
    return a.x - b.x;
  });

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

  // Sort items within each line by X
  for (const line of lines) {
    line.items.sort((a, b) => a.x - b.x);
  }

  // Step 2: Detect column structure per line
  // For each line, find the X-start positions of "cell groups"
  // A cell group is a cluster of text items separated by large gaps
  const lineColumns: Array<{ line: TextLine; cellStarts: number[] }> = [];

  for (const line of lines) {
    const cellStarts: number[] = [line.items[0].x];

    for (let i = 1; i < line.items.length; i++) {
      const prevItem = line.items[i - 1];
      const gap = line.items[i].x - (prevItem.x + prevItem.width);
      const avgFontSize = (prevItem.fontSize + line.items[i].fontSize) / 2;

      // A gap larger than 3x the average font size suggests a column boundary
      if (gap > avgFontSize * 3) {
        cellStarts.push(line.items[i].x);
      }
    }

    lineColumns.push({ line, cellStarts });
  }

  // Step 3: Find runs of consecutive lines with the same column count
  // These are table candidates
  const tables: DocxTable[] = [];
  const tableLineIndices = new Set<number>();

  let runStart = 0;
  while (runStart < lineColumns.length) {
    const colCount = lineColumns[runStart].cellStarts.length;

    if (colCount < MIN_TABLE_COLUMNS) {
      runStart++;
      continue;
    }

    // Find consecutive lines with the same number of columns and similar column positions
    let runEnd = runStart + 1;
    while (runEnd < lineColumns.length) {
      const nextColCount = lineColumns[runEnd].cellStarts.length;
      if (nextColCount !== colCount) break;

      // Check if column positions roughly match
      const starts1 = lineColumns[runStart].cellStarts;
      const starts2 = lineColumns[runEnd].cellStarts;
      let columnsMatch = true;
      for (let c = 0; c < colCount; c++) {
        if (Math.abs(starts1[c] - starts2[c]) > COLUMN_CLUSTER_TOLERANCE) {
          columnsMatch = false;
          break;
        }
      }
      if (!columnsMatch) break;

      runEnd++;
    }

    const rowCount = runEnd - runStart;
    if (rowCount >= MIN_TABLE_ROWS) {
      // Build table from these lines
      const tableLines = lineColumns.slice(runStart, runEnd);
      const table = buildTable(tableLines, pageWidth, styleCollector);
      tables.push(table);

      for (let i = runStart; i < runEnd; i++) {
        tableLineIndices.add(i);
      }
    }

    runStart = runEnd;
  }

  // Step 4: Build paragraphs from non-table lines
  const paragraphs: DocxParagraph[] = [];
  let paraLines: TextLine[] = [];

  for (let i = 0; i < lines.length; i++) {
    if (tableLineIndices.has(i)) {
      // Flush current paragraph group
      if (paraLines.length > 0) {
        paragraphs.push(...groupLinesToParagraphs(paraLines, pageWidth, styleCollector));
        paraLines = [];
      }
      continue;
    }
    paraLines.push(lines[i]);
  }
  if (paraLines.length > 0) {
    paragraphs.push(...groupLinesToParagraphs(paraLines, pageWidth, styleCollector));
  }

  return { paragraphs, tables };
}

/**
 * Build a DocxTable from a run of lines with consistent column structure.
 */
function buildTable(
  tableLines: Array<{ line: TextLine; cellStarts: number[] }>,
  pageWidth: number,
  styleCollector: StyleCollector
): DocxTable {
  const colCount = tableLines[0].cellStarts.length;

  // Compute average column start positions across all rows
  const avgColStarts: number[] = [];
  for (let c = 0; c < colCount; c++) {
    const sum = tableLines.reduce((s, tl) => s + tl.cellStarts[c], 0);
    avgColStarts.push(sum / tableLines.length);
  }

  // Compute column widths in twips
  const columnWidths: number[] = [];
  for (let c = 0; c < colCount; c++) {
    const colStart = avgColStarts[c];
    const colEnd = c < colCount - 1 ? avgColStarts[c + 1] : pageWidth - 72; // 1-inch right margin
    const widthPt = Math.max(colEnd - colStart, 20); // min 20pt
    columnWidths.push(Math.round(widthPt * PT_TO_TWIPS));
  }

  // Build rows
  const rows: DocxTableRow[] = [];
  for (const { line, cellStarts } of tableLines) {
    const cells: DocxTableCell[] = [];

    for (let c = 0; c < colCount; c++) {
      const colStart = cellStarts[c];
      const colEnd = c < colCount - 1 ? cellStarts[c + 1] : Infinity;

      // Collect items belonging to this cell
      const cellItems = line.items.filter(item =>
        item.x >= colStart - COLUMN_CLUSTER_TOLERANCE &&
        item.x < colEnd - COLUMN_CLUSTER_TOLERANCE
      );

      // Build a single paragraph for the cell content
      const cellParagraphs: DocxParagraph[] = [];
      if (cellItems.length > 0) {
        const cellLine = finalizeLine(cellItems, line.y);
        cellParagraphs.push(buildParagraph([cellLine], pageWidth, styleCollector));
      }

      cells.push({
        paragraphs: cellParagraphs,
        width: columnWidths[c],
        colSpan: 1,
        rowSpan: 1,
      });
    }

    rows.push({ cells });
  }

  return {
    rows,
    columnWidths,
    yPosition: tableLines[0].line.y,
  };
}

/**
 * Group consecutive non-table lines into paragraphs.
 */
function groupLinesToParagraphs(
  lines: TextLine[],
  pageWidth: number,
  styleCollector: StyleCollector
): DocxParagraph[] {
  if (lines.length === 0) return [];

  const paragraphs: DocxParagraph[] = [];
  let paraLines: TextLine[] = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prevLine = lines[i - 1];
    const currLine = lines[i];
    const gap = currLine.y - (prevLine.y + prevLine.avgFontSize * 1.2);
    const avgFont = (prevLine.avgFontSize + currLine.avgFontSize) / 2;

    if (gap > avgFont * PARA_GAP_FACTOR) {
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
    yPosition: lines[0].y,
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
