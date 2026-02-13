/**
 * OOXML Parts Generator
 *
 * Generates all XML parts for a valid DOCX file.
 * Key constraint: DrawingML ONLY — no VML, no mc:AlternateContent, no w:pict.
 *
 * Consumes PageLayout[] from the LayoutAnalyzer (unified scene graph pipeline).
 * Tables come from vector border detection with cell shading, not text-gap heuristics.
 *
 * Generated parts:
 * - [Content_Types].xml
 * - _rels/.rels
 * - word/_rels/document.xml.rels
 * - word/document.xml
 * - word/styles.xml
 * - word/settings.xml
 * - word/fontTable.xml
 */

import type {
  PageLayout,
  DetectedTable,
  DetectedCell,
  ParagraphGroup,
  TwoColumnRegion,
  TextElement,
  ImageElement,
  FormField,
  ImageFile,
  DocxStyle,
  RGB,
} from './types';
import { PT_TO_TWIPS, PT_TO_EMU } from './types';
import { StyleCollector } from './StyleCollector';

// ────────────────────────────────────────────────────────────
// Shared utilities
// ────────────────────────────────────────────────────────────

/** Escape XML special characters */
export function escXml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

// OOXML namespace declarations used in document.xml
const DOC_NS = [
  'xmlns:wpc="http://schemas.microsoft.com/office/word/2010/wordprocessingCanvas"',
  'xmlns:mo="http://schemas.microsoft.com/office/mac/office/2008/main"',
  'xmlns:mv="urn:schemas-microsoft-com:mac:vml"',
  'xmlns:o="urn:schemas-microsoft-com:office:office"',
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"',
  'xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math"',
  'xmlns:wp14="http://schemas.microsoft.com/office/word/2010/wordprocessingDrawing"',
  'xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"',
  'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"',
  'xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml"',
  'xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml"',
  'xmlns:wpg="http://schemas.microsoft.com/office/word/2010/wordprocessingGroup"',
  'xmlns:wpi="http://schemas.microsoft.com/office/word/2010/wordprocessingInk"',
  'xmlns:wps="http://schemas.microsoft.com/office/word/2010/wordprocessingShape"',
  'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"',
  'xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"',
].join(' ');

/** Common PDF font name to DOCX font name mappings */
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

/** Baseline grouping tolerance in PDF points */
const BASELINE_TOL = 3;

/** Word spacing detection: gap > fontSize * WORD_GAP_FACTOR implies a space */
const WORD_GAP_FACTOR = 0.3;

/** Paragraph splitting: gap > avgFontSize * PARA_GAP_FACTOR implies new paragraph */
const PARA_GAP_FACTOR = 1.5;

/**
 * Clean up a PDF font name:
 * - Strip subset prefix (e.g., "ABCDEF+" becomes the base name)
 * - Map to standard DOCX font name via FONT_MAP
 * - Strip style suffixes (Bold, Italic, Regular, etc.)
 * - Default to Calibri if nothing resolves
 */
function mapFontName(pdfFontName: string): string {
  if (!pdfFontName) return 'Calibri';

  // Strip subset prefix like "BCDFGH+"
  let name = pdfFontName.replace(/^[A-Z]{6}\+/, '');

  // Check mapped names first
  if (FONT_MAP[name]) return FONT_MAP[name];

  // Strip common suffixes
  name = name.replace(
    /[-,](Bold|Italic|BoldItalic|Regular|Medium|Light|Semibold|Condensed|Narrow|Black|Heavy|Thin|ExtraBold|ExtraLight)$/i,
    ''
  );
  name = name.replace(/MT$/, '');
  name = name.replace(/PS$/, '');

  // Handle hyphenated compound names
  if (name.includes('-')) {
    const parts = name.split('-');
    if (
      /^(Bold|Italic|Regular|Medium|Light|Semi|Extra|Condensed)$/i.test(
        parts[parts.length - 1]
      )
    ) {
      name = parts.slice(0, -1).join('-');
    }
  }

  return name || 'Calibri';
}

/**
 * Convert an RGB object (0-1 range) to a 6-char hex string (no '#').
 */
function rgbToHex(color: RGB): string {
  const r = Math.round(Math.min(1, Math.max(0, color.r)) * 255)
    .toString(16)
    .padStart(2, '0');
  const g = Math.round(Math.min(1, Math.max(0, color.g)) * 255)
    .toString(16)
    .padStart(2, '0');
  const b = Math.round(Math.min(1, Math.max(0, color.b)) * 255)
    .toString(16)
    .padStart(2, '0');
  return `${r}${g}${b}`;
}

/**
 * Compute statistical variance of a number array.
 */
function variance(nums: number[]): number {
  if (nums.length <= 1) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / nums.length;
}

// ────────────────────────────────────────────────────────────
// Content Types, Relationships (unchanged logic, new param types)
// ────────────────────────────────────────────────────────────

/**
 * Generate [Content_Types].xml
 */
export function generateContentTypes(images: ImageFile[]): string {
  const hasJpeg = images.some(img => img.mimeType === 'image/jpeg');
  const hasPng = images.some(img => img.mimeType === 'image/png');

  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">\n';
  xml += '  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>\n';
  xml += '  <Default Extension="xml" ContentType="application/xml"/>\n';
  if (hasJpeg) {
    xml += '  <Default Extension="jpeg" ContentType="image/jpeg"/>\n';
  }
  if (hasPng) {
    xml += '  <Default Extension="png" ContentType="image/png"/>\n';
  }
  xml += '  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>\n';
  xml += '  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>\n';
  xml += '  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>\n';
  xml += '  <Override PartName="/word/fontTable.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.fontTable+xml"/>\n';
  xml += '</Types>';
  return xml;
}

/**
 * Generate _rels/.rels (root relationships)
 */
export function generateRootRels(): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n';
  xml += '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>\n';
  xml += '</Relationships>';
  return xml;
}

/**
 * Generate word/_rels/document.xml.rels
 */
export function generateDocumentRels(images: ImageFile[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n';
  xml += '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n';
  xml += '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>\n';
  xml += '  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>\n';

  for (const img of images) {
    xml += `  <Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.fileName}"/>\n`;
  }

  xml += '</Relationships>';
  return xml;
}

// ────────────────────────────────────────────────────────────
// Document XML — main entry point (REWRITTEN)
// ────────────────────────────────────────────────────────────

/**
 * Generate word/document.xml
 *
 * Consumes PageLayout[] from the LayoutAnalyzer. Each layout contains
 * interleaved tables, paragraphs, and images already sorted by Y position.
 * Pure DrawingML output — no VML, no mc:AlternateContent.
 */
export function generateDocumentXml(
  layouts: PageLayout[],
  images: ImageFile[],
  styleCollector: StyleCollector
): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += `<w:document ${DOC_NS}>\n`;
  xml += '<w:body>\n';

  const normalStyle = styleCollector.getNormalStyle();

  // Compute page left margin for indentation reference
  const boundsForMargin = layouts.filter(l => l.contentBounds);
  const pageLeftMarginPt = boundsForMargin.length > 0
    ? boundsForMargin.reduce((s, l) => s + l.contentBounds!.left, 0) / boundsForMargin.length
    : 72;

  for (let pageIdx = 0; pageIdx < layouts.length; pageIdx++) {
    const layout = layouts[pageIdx];

    // Elements are already sorted by Y position by the LayoutAnalyzer
    for (const elem of layout.elements) {
      if (elem.type === 'table') {
        xml += generateTableFromDetected(elem.element, images, normalStyle, styleCollector);
      } else if (elem.type === 'paragraph') {
        xml += generateParagraphGroupXml(elem.element, normalStyle, styleCollector, pageLeftMarginPt);
      } else if (elem.type === 'image') {
        xml += generateImageXml(elem.element, images);
      } else if (elem.type === 'two-column') {
        xml += generateTwoColumnXml(elem.element, images, normalStyle, styleCollector, pageLeftMarginPt);
      }
    }

    // Page break between pages (except after last page)
    if (pageIdx < layouts.length - 1) {
      xml += '<w:p><w:r><w:br w:type="page"/></w:r></w:p>\n';
    }
  }

  // Section properties (page size from last layout, or default Letter)
  const lastLayout = layouts[layouts.length - 1];
  const pgW = lastLayout ? Math.round(lastLayout.width * PT_TO_TWIPS) : 12240; // 8.5" default
  const pgH = lastLayout ? Math.round(lastLayout.height * PT_TO_TWIPS) : 15840; // 11" default

  // Compute aggregate margins from content bounds across all pages
  let marginTopTwips = 1440; // 1" default
  let marginBottomTwips = 1440;
  let marginLeftTwips = 1440;
  let marginRightTwips = 1440;

  const boundsPages = layouts.filter(l => l.contentBounds);
  if (boundsPages.length > 0) {
    const avgLeft = boundsPages.reduce((s, l) => s + l.contentBounds!.left, 0) / boundsPages.length;
    const avgTop = boundsPages.reduce((s, l) => s + l.contentBounds!.top, 0) / boundsPages.length;
    const avgRight = boundsPages.reduce((s, l) => s + l.contentBounds!.right, 0) / boundsPages.length;
    const avgBottom = boundsPages.reduce((s, l) => s + l.contentBounds!.bottom, 0) / boundsPages.length;

    marginLeftTwips = Math.round(avgLeft * PT_TO_TWIPS);
    marginTopTwips = Math.round(avgTop * PT_TO_TWIPS);
    marginRightTwips = Math.round(avgRight * PT_TO_TWIPS);
    marginBottomTwips = Math.round(avgBottom * PT_TO_TWIPS);
  }

  xml += '<w:sectPr>\n';
  xml += `  <w:pgSz w:w="${pgW}" w:h="${pgH}"/>\n`;
  xml += `  <w:pgMar w:top="${marginTopTwips}" w:right="${marginRightTwips}" w:bottom="${marginBottomTwips}" w:left="${marginLeftTwips}" w:header="720" w:footer="720" w:gutter="0"/>\n`;
  xml += '  <w:cols w:space="720"/>\n';
  xml += '</w:sectPr>\n';

  xml += '</w:body>\n';
  xml += '</w:document>';
  return xml;
}

// ────────────────────────────────────────────────────────────
// Table generation from DetectedTable (vector border detection)
// ────────────────────────────────────────────────────────────

/**
 * Generate <w:tbl> from a DetectedTable produced by vector border detection.
 *
 * Handles:
 * - Merged cells (colSpan/rowSpan) with gridSpan and vMerge
 * - Cell shading from fillColor (w:shd)
 * - Cell content rendered as paragraphs grouped by Y baseline
 * - Inline form fields positioned relative to cell text
 */
function generateTableFromDetected(
  table: DetectedTable,
  _images: ImageFile[],
  normalStyle: DocxStyle,
  styleCollector: StyleCollector
): string {
  let xml = '<w:tbl>\n';

  // Table properties with borders (use actual border data if available)
  const borderSz = table.borderWidthPt
    ? String(Math.max(Math.round(table.borderWidthPt * 8), 2))
    : '4';
  const borderColor = table.borderColor
    ? rgbToHex(table.borderColor)
    : 'auto';

  xml += '  <w:tblPr>\n';
  xml += '    <w:tblStyle w:val="TableGrid"/>\n';
  xml += '    <w:tblW w:w="0" w:type="auto"/>\n';
  xml += '    <w:tblBorders>\n';
  xml += `      <w:top w:val="single" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>\n`;
  xml += `      <w:left w:val="single" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>\n`;
  xml += `      <w:bottom w:val="single" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>\n`;
  xml += `      <w:right w:val="single" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>\n`;
  xml += `      <w:insideH w:val="single" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>\n`;
  xml += `      <w:insideV w:val="single" w:sz="${borderSz}" w:space="0" w:color="${borderColor}"/>\n`;
  xml += '    </w:tblBorders>\n';
  xml += '    <w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>\n';
  xml += '  </w:tblPr>\n';

  // Column grid — convert PDF points to twips
  xml += '  <w:tblGrid>\n';
  for (const colW of table.columnWidths) {
    xml += `    <w:gridCol w:w="${Math.round(colW * PT_TO_TWIPS)}"/>\n`;
  }
  xml += '  </w:tblGrid>\n';

  // Build a lookup map: "row,col" -> DetectedCell for fast access
  const cellMap = new Map<string, DetectedCell>();
  for (const cell of table.cells) {
    cellMap.set(`${cell.row},${cell.col}`, cell);
  }

  // Track which (row, col) positions are continuations of a merged cell.
  // Horizontal continuations are skipped entirely (absorbed by gridSpan).
  // Vertical continuations emit a tc with <w:vMerge/> (continue).
  const mergedContinuations = new Set<string>();
  for (const cell of table.cells) {
    for (let r = cell.row; r < cell.row + cell.rowSpan; r++) {
      for (let c = cell.col; c < cell.col + cell.colSpan; c++) {
        if (r === cell.row && c === cell.col) continue; // origin, not a continuation
        mergedContinuations.add(`${r},${c}`);
      }
    }
  }

  // Rows
  for (let row = 0; row < table.rows; row++) {
    xml += '  <w:tr>\n';

    for (let col = 0; col < table.cols; col++) {
      const key = `${row},${col}`;

      // Check if this position is a continuation of a merged cell
      if (mergedContinuations.has(key)) {
        // Determine if this is a vertical merge continuation that needs a tc element.
        // A vMerge continuation occurs when this row > the origin cell's row,
        // and this col is the origin col of the merge (not a horizontal continuation).
        const originCell = findMergeOrigin(table.cells, row, col);
        if (originCell && originCell.rowSpan > 1 && row > originCell.row && col === originCell.col) {
          // Vertical merge continuation — emit tc with vMerge (no val = continue)
          const cellWidthTwips = computeCellWidthTwips(table.columnWidths, originCell.col, originCell.colSpan);
          xml += '    <w:tc>\n';
          xml += '      <w:tcPr>\n';
          xml += `        <w:tcW w:w="${cellWidthTwips}" w:type="dxa"/>\n`;
          if (originCell.colSpan > 1) {
            xml += `        <w:gridSpan w:val="${originCell.colSpan}"/>\n`;
          }
          xml += '        <w:vMerge/>\n';
          xml += '      </w:tcPr>\n';
          xml += '      <w:p/>\n';
          xml += '    </w:tc>\n';
        }
        // Horizontal continuations are absorbed by gridSpan — skip entirely
        continue;
      }

      const cell = cellMap.get(key);

      if (!cell) {
        // No cell defined at this position — emit an empty cell
        const colWidthTwips = Math.round(
          (col < table.columnWidths.length ? table.columnWidths[col] : 100) * PT_TO_TWIPS
        );
        xml += '    <w:tc>\n';
        xml += '      <w:tcPr>\n';
        xml += `        <w:tcW w:w="${colWidthTwips}" w:type="dxa"/>\n`;
        xml += '      </w:tcPr>\n';
        xml += '      <w:p/>\n';
        xml += '    </w:tc>\n';
        continue;
      }

      // Emit <w:tc> for this cell
      xml += '    <w:tc>\n';
      xml += '      <w:tcPr>\n';

      // Cell width: sum of spanned column widths, converted to twips
      const cellWidthTwips = computeCellWidthTwips(table.columnWidths, cell.col, cell.colSpan);
      xml += `        <w:tcW w:w="${cellWidthTwips}" w:type="dxa"/>\n`;

      if (cell.colSpan > 1) {
        xml += `        <w:gridSpan w:val="${cell.colSpan}"/>\n`;
      }

      if (cell.rowSpan > 1) {
        xml += '        <w:vMerge w:val="restart"/>\n';
      }

      // Cell shading from fill color
      if (cell.fillColor) {
        const hex = rgbToHex(cell.fillColor);
        xml += `        <w:shd w:val="clear" w:color="auto" w:fill="${hex}"/>\n`;
      }

      xml += '      </w:tcPr>\n';

      // Cell content: texts grouped into paragraphs by Y baseline, with form fields inline
      const cellContent = renderCellContent(cell, normalStyle, styleCollector);
      if (cellContent.length === 0) {
        xml += '      <w:p/>\n';
      } else {
        xml += cellContent;
      }

      xml += '    </w:tc>\n';
    }

    xml += '  </w:tr>\n';
  }

  xml += '</w:tbl>\n';
  return xml;
}

/**
 * Find the merge origin cell for a given (row, col) that is part of a merged range.
 */
function findMergeOrigin(cells: DetectedCell[], row: number, col: number): DetectedCell | null {
  for (const cell of cells) {
    if (
      row >= cell.row &&
      row < cell.row + cell.rowSpan &&
      col >= cell.col &&
      col < cell.col + cell.colSpan
    ) {
      return cell;
    }
  }
  return null;
}

/**
 * Compute the total width of a cell spanning multiple columns, in twips.
 */
function computeCellWidthTwips(columnWidths: number[], startCol: number, colSpan: number): number {
  let total = 0;
  for (let c = startCol; c < startCol + colSpan && c < columnWidths.length; c++) {
    total += columnWidths[c];
  }
  return Math.round(total * PT_TO_TWIPS);
}

/**
 * Render the content of a DetectedCell as OOXML paragraph(s).
 *
 * Groups texts by Y baseline into lines, then renders each line as runs
 * within a paragraph. Interleaves form fields inline with text based on
 * spatial position (checkboxes before text, inputs/dropdowns after text).
 */
function renderCellContent(
  cell: DetectedCell,
  normalStyle: DocxStyle,
  styleCollector: StyleCollector
): string {
  if (cell.texts.length === 0 && cell.formFields.length === 0) {
    return '';
  }

  // Group texts by Y baseline
  const lines = groupTextsByBaseline(cell.texts);

  // Associate form fields with their closest lines
  const consumedFields = new Set<number>();
  const lineFormFields = new Map<number, Array<{ field: FormField; position: 'before' | 'after' }>>();

  for (let fi = 0; fi < cell.formFields.length; fi++) {
    const field = cell.formFields[fi];

    // Find the closest line by Y
    let bestLineIdx = -1;
    let bestDist = Infinity;
    for (let li = 0; li < lines.length; li++) {
      const lineY = lines[li][0].y;
      const dist = Math.abs(field.y - lineY);
      if (dist < bestDist) {
        bestDist = dist;
        bestLineIdx = li;
      }
    }

    if (bestLineIdx >= 0 && bestDist <= BASELINE_TOL * 3) {
      const lineTexts = lines[bestLineIdx];
      const lineMinX = Math.min(...lineTexts.map(t => t.x));

      if (!lineFormFields.has(bestLineIdx)) {
        lineFormFields.set(bestLineIdx, []);
      }

      if (field.fieldType === 'Btn' && (field.isCheckBox || field.isRadioButton)) {
        // Checkbox: place before text if its X is less than the text X
        const pos = field.x < lineMinX ? 'before' : 'after';
        lineFormFields.get(bestLineIdx)!.push({ field, position: pos });
      } else {
        // Text input / dropdown: place after the label text
        const pos = field.x >= lineMinX ? 'after' : 'before';
        lineFormFields.get(bestLineIdx)!.push({ field, position: pos });
      }
      consumedFields.add(fi);
    }
  }

  let xml = '';

  // Render each baseline group as a paragraph
  for (let li = 0; li < lines.length; li++) {
    const lineTexts = lines[li];
    const fields = lineFormFields.get(li) || [];

    xml += '      <w:p>\n';

    // Emit "before" form fields
    for (const ff of fields) {
      if (ff.position === 'before') {
        xml += generateFormFieldRuns(ff.field);
      }
    }

    // Build runs from text elements on this line
    xml += renderTextRunsFromElements(lineTexts, normalStyle, styleCollector);

    // Emit "after" form fields
    for (const ff of fields) {
      if (ff.position === 'after') {
        xml += generateFormFieldRuns(ff.field);
      }
    }

    xml += '      </w:p>\n';
  }

  // Unconsumed form fields as standalone paragraphs
  for (let fi = 0; fi < cell.formFields.length; fi++) {
    if (!consumedFields.has(fi)) {
      xml += '      <w:p>\n';
      xml += generateFormFieldRuns(cell.formFields[fi]);
      xml += '      </w:p>\n';
    }
  }

  return xml;
}

// ────────────────────────────────────────────────────────────
// Paragraph group generation (NEW)
// ────────────────────────────────────────────────────────────

/**
 * Convert a ParagraphGroup to one or more <w:p> elements.
 *
 * Groups texts by Y baseline (tolerance ~3pt) into lines, builds runs
 * with word spacing detection, maps font names via FONT_MAP, registers
 * each run's style with styleCollector, detects alignment from line edges,
 * and inserts form fields inline:
 *   - Checkboxes: before text if checkbox X < text X
 *   - Text inputs/dropdowns: after text label
 *   - Unconsumed form fields: standalone paragraphs
 */
function generateParagraphGroupXml(
  group: ParagraphGroup,
  normalStyle: DocxStyle,
  styleCollector: StyleCollector,
  pageLeftMarginPt: number = 72,
): string {
  if (group.texts.length === 0 && group.formFields.length === 0) {
    return '<w:p/>\n';
  }

  // Group texts by baseline
  const lines = groupTextsByBaseline(group.texts);

  // Associate form fields with lines
  const consumedFields = new Set<number>();
  const lineFormFields = new Map<number, Array<{ field: FormField; position: 'before' | 'after' }>>();

  for (let fi = 0; fi < group.formFields.length; fi++) {
    const field = group.formFields[fi];

    // Find closest line by Y
    let bestLineIdx = -1;
    let bestDist = Infinity;
    for (let li = 0; li < lines.length; li++) {
      const lineY = lines[li][0].y;
      const dist = Math.abs(field.y - lineY);
      if (dist < bestDist) {
        bestDist = dist;
        bestLineIdx = li;
      }
    }

    if (bestLineIdx >= 0 && bestDist <= BASELINE_TOL * 3) {
      const lineTexts = lines[bestLineIdx];
      const lineMinX = Math.min(...lineTexts.map(t => t.x));

      if (!lineFormFields.has(bestLineIdx)) {
        lineFormFields.set(bestLineIdx, []);
      }

      if (field.fieldType === 'Btn' && (field.isCheckBox || field.isRadioButton)) {
        const pos = field.x < lineMinX ? 'before' : 'after';
        lineFormFields.get(bestLineIdx)!.push({ field, position: pos });
      } else {
        const pos = field.x >= lineMinX ? 'after' : 'before';
        lineFormFields.get(bestLineIdx)!.push({ field, position: pos });
      }
      consumedFields.add(fi);
    }
  }

  let xml = '';

  if (lines.length === 0) {
    // No text lines — emit unconsumed form fields as standalone paragraphs
    for (let fi = 0; fi < group.formFields.length; fi++) {
      if (!consumedFields.has(fi)) {
        xml += '<w:p>\n';
        xml += generateFormFieldRuns(group.formFields[fi]);
        xml += '</w:p>\n';
      }
    }
    return xml || '<w:p/>\n';
  }

  // Split lines into visual paragraphs based on Y gaps
  const paraGroups = splitLinesIntoParagraphs(lines);

  for (const paraLines of paraGroups) {
    const alignment = detectAlignmentFromElements(paraLines);

    // Gather form fields for lines in this paragraph
    const fields: Array<{ field: FormField; position: 'before' | 'after' }> = [];
    for (const paraLine of paraLines) {
      const idx = lines.indexOf(paraLine);
      if (idx >= 0 && lineFormFields.has(idx)) {
        fields.push(...lineFormFields.get(idx)!);
      }
    }

    xml += '<w:p>\n';

    // Compute paragraph indentation from X offset vs page left margin
    const leftIndentPt = group.x - pageLeftMarginPt;
    const hasIndent = leftIndentPt > 5; // ignore tiny rounding offsets

    // First-line indent detection: compare first line X to subsequent lines
    let firstLineIndentTwips = 0;
    let hangingTwips = 0;
    if (paraLines.length >= 2) {
      const firstLineMinX = Math.min(...paraLines[0].map(t => t.x));
      const restMinXs = paraLines.slice(1).map(line => Math.min(...line.map(t => t.x)));
      const avgRestX = restMinXs.reduce((s, v) => s + v, 0) / restMinXs.length;
      const diff = firstLineMinX - avgRestX;
      if (diff > 10) {
        firstLineIndentTwips = Math.round(diff * PT_TO_TWIPS);
      } else if (diff < -10) {
        hangingTwips = Math.round(Math.abs(diff) * PT_TO_TWIPS);
      }
    }

    // Line spacing from paragraph group
    let lineSpacingTwips = 0;
    if (group.lineSpacingPt && group.lineSpacingPt > 0) {
      lineSpacingTwips = Math.round(group.lineSpacingPt * PT_TO_TWIPS);
    }

    // Paragraph properties (heading style, alignment, indentation, spacing, background, borders)
    const needsPPr = group.headingLevel || alignment !== 'left' || hasIndent
      || firstLineIndentTwips > 0 || hangingTwips > 0
      || lineSpacingTwips > 0
      || group.backgroundColor || group.bottomBorder;
    if (needsPPr) {
      xml += '  <w:pPr>\n';
      if (group.headingLevel) {
        xml += `    <w:pStyle w:val="Heading${group.headingLevel}"/>\n`;
      }
      if (alignment !== 'left') {
        const jcVal = alignment === 'justify' ? 'both' : alignment;
        xml += `    <w:jc w:val="${jcVal}"/>\n`;
      }
      if (hasIndent || firstLineIndentTwips > 0 || hangingTwips > 0) {
        const leftTwips = hasIndent ? Math.round(leftIndentPt * PT_TO_TWIPS) : 0;
        let indAttr = `w:left="${leftTwips}"`;
        if (firstLineIndentTwips > 0) {
          indAttr += ` w:firstLine="${firstLineIndentTwips}"`;
        } else if (hangingTwips > 0) {
          indAttr += ` w:hanging="${hangingTwips}"`;
        }
        xml += `    <w:ind ${indAttr}/>\n`;
      }
      if (lineSpacingTwips > 0) {
        xml += `    <w:spacing w:line="${lineSpacingTwips}" w:lineRule="exact"/>\n`;
      }
      if (group.backgroundColor) {
        const bgHex = rgbToHex(group.backgroundColor);
        xml += `    <w:shd w:val="clear" w:color="auto" w:fill="${bgHex}"/>\n`;
      }
      if (group.bottomBorder) {
        const borderHex = rgbToHex(group.bottomBorder.color);
        const borderSz = Math.round(group.bottomBorder.widthPt * 8); // half-points to eighths
        xml += '    <w:pBdr>\n';
        xml += `      <w:bottom w:val="single" w:sz="${Math.max(borderSz, 4)}" w:space="1" w:color="${borderHex}"/>\n`;
        xml += '    </w:pBdr>\n';
      }
      xml += '  </w:pPr>\n';
    }

    // Emit "before" form fields
    for (const ff of fields) {
      if (ff.position === 'before') {
        xml += generateFormFieldRuns(ff.field);
      }
    }

    // Build runs across all lines in this paragraph
    for (let li = 0; li < paraLines.length; li++) {
      // Add a space between lines within the same paragraph
      if (li > 0) {
        xml += '  <w:r><w:t xml:space="preserve"> </w:t></w:r>\n';
      }
      xml += renderTextRunsFromElements(paraLines[li], normalStyle, styleCollector);
    }

    // Emit "after" form fields
    for (const ff of fields) {
      if (ff.position === 'after') {
        xml += generateFormFieldRuns(ff.field);
      }
    }

    xml += '</w:p>\n';
  }

  // Unconsumed form fields as standalone paragraphs
  for (let fi = 0; fi < group.formFields.length; fi++) {
    if (!consumedFields.has(fi)) {
      xml += '<w:p>\n';
      xml += generateFormFieldRuns(group.formFields[fi]);
      xml += '</w:p>\n';
    }
  }

  return xml;
}

// ────────────────────────────────────────────────────────────
// Text element grouping and run rendering
// ────────────────────────────────────────────────────────────

/**
 * Group TextElement[] by Y baseline into lines.
 * Elements within BASELINE_TOL of each other are considered same line.
 * Each resulting line is sorted by X position (left to right).
 */
function groupTextsByBaseline(texts: TextElement[]): TextElement[][] {
  if (texts.length === 0) return [];

  // Sort by Y first, then X
  const sorted = [...texts].sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) > BASELINE_TOL) return yDiff;
    return a.x - b.x;
  });

  const lines: TextElement[][] = [];
  let currentLine: TextElement[] = [sorted[0]];
  let currentY = sorted[0].y;

  for (let i = 1; i < sorted.length; i++) {
    const elem = sorted[i];
    if (Math.abs(elem.y - currentY) <= BASELINE_TOL) {
      currentLine.push(elem);
    } else {
      currentLine.sort((a, b) => a.x - b.x);
      lines.push(currentLine);
      currentLine = [elem];
      currentY = elem.y;
    }
  }
  if (currentLine.length > 0) {
    currentLine.sort((a, b) => a.x - b.x);
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Split lines into paragraph groups based on large Y gaps.
 * Lines close together form a single paragraph; large gaps split them.
 */
function splitLinesIntoParagraphs(lines: TextElement[][]): TextElement[][][] {
  if (lines.length <= 1) return [lines];

  const groups: TextElement[][][] = [];
  let current: TextElement[][] = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prevLine = lines[i - 1];
    const currLine = lines[i];
    const prevY = prevLine[0].y;
    const currY = currLine[0].y;
    const prevAvgHeight =
      prevLine.reduce((sum, t) => sum + t.height, 0) / prevLine.length;
    const gap = currY - prevY - prevAvgHeight;
    const avgFontSize =
      (prevLine.reduce((s, t) => s + t.fontSize, 0) / prevLine.length +
        currLine.reduce((s, t) => s + t.fontSize, 0) / currLine.length) /
      2;

    if (gap > avgFontSize * PARA_GAP_FACTOR) {
      groups.push(current);
      current = [currLine];
    } else {
      current.push(currLine);
    }
  }
  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}

/**
 * Detect alignment from text element lines by examining edge positions.
 */
function detectAlignmentFromElements(
  lines: TextElement[][]
): 'left' | 'center' | 'right' | 'justify' {
  if (lines.length === 0) return 'left';

  const leftEdges: number[] = [];
  const rightEdges: number[] = [];

  for (const line of lines) {
    if (line.length === 0) continue;
    leftEdges.push(Math.min(...line.map(t => t.x)));
    rightEdges.push(Math.max(...line.map(t => t.x + t.width)));
  }

  if (leftEdges.length === 0) return 'left';

  const leftVar = variance(leftEdges);
  const rightVar = variance(rightEdges);
  const LOW_VAR = 15;

  if (leftVar < LOW_VAR && rightVar < LOW_VAR && lines.length > 1) {
    return 'justify';
  }
  if (leftVar < LOW_VAR) return 'left';
  if (rightVar < LOW_VAR) return 'right';

  const centers = leftEdges.map((l, i) => (l + rightEdges[i]) / 2);
  if (variance(centers) < LOW_VAR) return 'center';

  return 'left';
}

/**
 * Render a line of TextElement[] as <w:r> runs.
 *
 * Detects word gaps (inserts spaces), merges adjacent runs with identical
 * formatting, maps font names via FONT_MAP, and registers styles with
 * the StyleCollector. Only emits run properties that differ from Normal.
 */
function renderTextRunsFromElements(
  texts: TextElement[],
  normalStyle: DocxStyle,
  styleCollector: StyleCollector
): string {
  if (texts.length === 0) return '';

  interface RunAccum {
    text: string;
    fontName: string;
    fontSize: number; // half-points
    bold: boolean;
    italic: boolean;
    color: string;
  }

  const runs: RunAccum[] = [];

  for (let i = 0; i < texts.length; i++) {
    const elem = texts[i];
    const mappedFont = mapFontName(elem.fontName);
    const halfPts = Math.round(elem.fontSize * 2);
    const color = elem.color || '000000';

    // Register with style collector
    styleCollector.registerRun(mappedFont, halfPts, elem.bold, elem.italic, color);

    // Detect word gap — insert space if gap between items is significant
    let prefix = '';
    if (i > 0) {
      const prevElem = texts[i - 1];
      const gap = elem.x - (prevElem.x + prevElem.width);
      if (gap > elem.fontSize * WORD_GAP_FACTOR) {
        prefix = ' ';
      } else if (gap > 0.5) {
        prefix = ' ';
      }
    }

    const text = prefix + elem.text;

    // Try to merge with previous run if same formatting
    if (runs.length > 0) {
      const prev = runs[runs.length - 1];
      if (
        prev.fontName === mappedFont &&
        prev.fontSize === halfPts &&
        prev.bold === elem.bold &&
        prev.italic === elem.italic &&
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
      bold: elem.bold,
      italic: elem.italic,
      color,
    });
  }

  // Convert accumulated runs to XML
  let xml = '';
  for (const run of runs) {
    xml += '  <w:r>\n';

    // Run properties — only emit what differs from Normal
    const needsRPr =
      run.fontName !== normalStyle.fontName ||
      run.fontSize !== normalStyle.fontSize ||
      run.bold !== normalStyle.bold ||
      run.italic !== normalStyle.italic ||
      run.color !== normalStyle.color;

    if (needsRPr) {
      xml += '    <w:rPr>\n';

      if (run.fontName !== normalStyle.fontName) {
        xml += `      <w:rFonts w:ascii="${escXml(run.fontName)}" w:hAnsi="${escXml(run.fontName)}" w:cs="${escXml(run.fontName)}"/>\n`;
      }

      if (run.bold && !normalStyle.bold) {
        xml += '      <w:b/>\n';
      } else if (!run.bold && normalStyle.bold) {
        xml += '      <w:b w:val="0"/>\n';
      }

      if (run.italic && !normalStyle.italic) {
        xml += '      <w:i/>\n';
      } else if (!run.italic && normalStyle.italic) {
        xml += '      <w:i w:val="0"/>\n';
      }

      if (run.color !== normalStyle.color) {
        xml += `      <w:color w:val="${escXml(run.color)}"/>\n`;
      }

      if (run.fontSize !== normalStyle.fontSize) {
        xml += `      <w:sz w:val="${run.fontSize}"/>\n`;
        xml += `      <w:szCs w:val="${run.fontSize}"/>\n`;
      }

      xml += '    </w:rPr>\n';
    }

    xml += `    <w:t xml:space="preserve">${escXml(run.text)}</w:t>\n`;
    xml += '  </w:r>\n';
  }

  return xml;
}

// ────────────────────────────────────────────────────────────
// Image generation — DrawingML inline, NO VML (NEW)
// ────────────────────────────────────────────────────────────

/**
 * Generate a DrawingML inline image paragraph from an ImageElement.
 *
 * Uses <wp:inline> with <pic:pic> — NO VML, NO mc:AlternateContent, NO w:pict.
 * Finds the matching ImageFile by resourceName and uses its rId and EMU dimensions.
 */
function generateImageXml(image: ImageElement, images: ImageFile[]): string {
  // Find matching ImageFile by resourceName
  const imgFile = images.find(img => img.resourceName === image.resourceName);
  if (!imgFile) {
    // No matching image file found — skip silently
    return '';
  }

  const n = parseInt(imgFile.rId.replace('rId', ''), 10) || 1;

  // Use pre-computed EMU from ImageFile, or compute from display dimensions
  const widthEmu = imgFile.widthEmu > 0
    ? imgFile.widthEmu
    : Math.round(image.width * PT_TO_EMU);
  const heightEmu = imgFile.heightEmu > 0
    ? imgFile.heightEmu
    : Math.round(image.height * PT_TO_EMU);

  let xml = '<w:p>\n';
  xml += '  <w:r>\n';
  xml += '    <w:drawing>\n';
  xml += `      <wp:inline distT="0" distB="0" distL="0" distR="0">\n`;
  xml += `        <wp:extent cx="${widthEmu}" cy="${heightEmu}"/>\n`;
  xml += `        <wp:docPr id="${n}" name="Picture ${n}"/>\n`;
  xml += '        <a:graphic>\n';
  xml += '          <a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture">\n';
  xml += '            <pic:pic>\n';
  xml += '              <pic:nvPicPr>\n';
  xml += `                <pic:cNvPr id="${n}" name="${escXml(imgFile.fileName)}"/>\n`;
  xml += '                <pic:cNvPicPr/>\n';
  xml += '              </pic:nvPicPr>\n';
  xml += '              <pic:blipFill>\n';
  xml += `                <a:blip r:embed="${imgFile.rId}"/>\n`;
  xml += '                <a:stretch><a:fillRect/></a:stretch>\n';
  xml += '              </pic:blipFill>\n';
  xml += '              <pic:spPr>\n';
  xml += '                <a:xfrm>\n';
  xml += '                  <a:off x="0" y="0"/>\n';
  xml += `                  <a:ext cx="${widthEmu}" cy="${heightEmu}"/>\n`;
  xml += '                </a:xfrm>\n';
  xml += '                <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>\n';
  xml += '              </pic:spPr>\n';
  xml += '            </pic:pic>\n';
  xml += '          </a:graphicData>\n';
  xml += '        </a:graphic>\n';
  xml += '      </wp:inline>\n';
  xml += '    </w:drawing>\n';
  xml += '  </w:r>\n';
  xml += '</w:p>\n';
  return xml;
}

// ────────────────────────────────────────────────────────────
// Two-column region rendering
// ────────────────────────────────────────────────────────────

/**
 * Render a TwoColumnRegion as a 2-column invisible-border table.
 * Left and right elements are placed in separate cells, preserving
 * side-by-side layout from the original PDF.
 */
function generateTwoColumnXml(
  region: TwoColumnRegion,
  images: ImageFile[],
  normalStyle: DocxStyle,
  styleCollector: StyleCollector,
  pageLeftMarginPt: number = 72,
): string {
  // Compute column widths from gapX and actual page margins
  const marginPt = pageLeftMarginPt;
  const contentWidth = region.pageWidth - marginPt * 2;
  const leftWidthPt = region.gapX - marginPt;
  const rightWidthPt = contentWidth - leftWidthPt;
  const leftWidthTwips = Math.round(Math.max(leftWidthPt, 50) * PT_TO_TWIPS);
  const rightWidthTwips = Math.round(Math.max(rightWidthPt, 50) * PT_TO_TWIPS);

  let xml = '<w:tbl>\n';

  // Table properties with invisible borders
  xml += '  <w:tblPr>\n';
  xml += '    <w:tblW w:w="0" w:type="auto"/>\n';
  xml += '    <w:tblBorders>\n';
  xml += '      <w:top w:val="none" w:sz="0" w:space="0" w:color="auto"/>\n';
  xml += '      <w:left w:val="none" w:sz="0" w:space="0" w:color="auto"/>\n';
  xml += '      <w:bottom w:val="none" w:sz="0" w:space="0" w:color="auto"/>\n';
  xml += '      <w:right w:val="none" w:sz="0" w:space="0" w:color="auto"/>\n';
  xml += '      <w:insideH w:val="none" w:sz="0" w:space="0" w:color="auto"/>\n';
  xml += '      <w:insideV w:val="none" w:sz="0" w:space="0" w:color="auto"/>\n';
  xml += '    </w:tblBorders>\n';
  xml += '    <w:tblLook w:val="04A0" w:firstRow="1" w:lastRow="0" w:firstColumn="1" w:lastColumn="0" w:noHBand="0" w:noVBand="1"/>\n';
  xml += '  </w:tblPr>\n';

  // Column grid
  xml += '  <w:tblGrid>\n';
  xml += `    <w:gridCol w:w="${leftWidthTwips}"/>\n`;
  xml += `    <w:gridCol w:w="${rightWidthTwips}"/>\n`;
  xml += '  </w:tblGrid>\n';

  // Single row with two cells
  xml += '  <w:tr>\n';

  // Left cell
  xml += '    <w:tc>\n';
  xml += '      <w:tcPr>\n';
  xml += `        <w:tcW w:w="${leftWidthTwips}" w:type="dxa"/>\n`;
  xml += '      </w:tcPr>\n';
  const leftContent = renderColumnContent(region.leftElements, images, normalStyle, styleCollector, pageLeftMarginPt);
  xml += leftContent || '      <w:p/>\n';
  xml += '    </w:tc>\n';

  // Right cell
  xml += '    <w:tc>\n';
  xml += '      <w:tcPr>\n';
  xml += `        <w:tcW w:w="${rightWidthTwips}" w:type="dxa"/>\n`;
  xml += '      </w:tcPr>\n';
  const rightContent = renderColumnContent(region.rightElements, images, normalStyle, styleCollector, pageLeftMarginPt);
  xml += rightContent || '      <w:p/>\n';
  xml += '    </w:tc>\n';

  xml += '  </w:tr>\n';
  xml += '</w:tbl>\n';
  return xml;
}

/**
 * Render a list of LayoutElements into OOXML content for a table cell.
 * Handles paragraphs, images, and nested tables within a column of a two-column layout.
 *
 * OOXML requires every w:tc to contain at least one w:p. When the last element
 * in the cell is a nested table, we append an empty paragraph to satisfy this.
 */
function renderColumnContent(
  elements: LayoutElement[],
  images: ImageFile[],
  normalStyle: DocxStyle,
  styleCollector: StyleCollector,
  pageLeftMarginPt: number = 72,
): string {
  let xml = '';
  let lastType: string = '';
  for (const elem of elements) {
    if (elem.type === 'paragraph') {
      xml += generateParagraphGroupXml(elem.element, normalStyle, styleCollector, pageLeftMarginPt);
      lastType = 'paragraph';
    } else if (elem.type === 'image') {
      xml += generateImageXml(elem.element, images);
      lastType = 'image';
    } else if (elem.type === 'table') {
      xml += generateTableFromDetected(elem.element, images, normalStyle, styleCollector);
      lastType = 'table';
    }
  }
  // OOXML: w:tc must end with a w:p — add trailing paragraph after nested table
  if (lastType === 'table') {
    xml += '      <w:p/>\n';
  }
  return xml;
}

// ────────────────────────────────────────────────────────────
// Form field generators (preserved from original)
// ────────────────────────────────────────────────────────────

/**
 * Sanitize a PDF field name for OOXML w:name.
 * Takes the last segment of the dotted path and strips array indices.
 * Word has a 20-character limit on form field names.
 */
function sanitizeFieldName(fullName: string): string {
  const last = fullName.split('.').pop() || fullName;
  return last.replace(/\[\d+\]/g, '').substring(0, 20);
}

/**
 * Generate OOXML runs for a text input form field (FORMTEXT).
 * Adds gray underline and light gray shading to the value run for visual clarity.
 * Pads empty/whitespace values to at least 15 spaces for minimum field width.
 */
function generateTextFieldRuns(field: FormField): string {
  const name = sanitizeFieldName(field.fieldName);
  let value = field.fieldValue || '';
  // Pad to minimum 15 spaces for visible field width
  if (value.trim().length === 0) {
    value = '               '; // 15 spaces
  }
  return [
    '<w:r><w:fldChar w:fldCharType="begin">',
    '<w:ffData>',
    `<w:name w:val="${escXml(name)}"/>`,
    '<w:enabled/>',
    `<w:textInput>${field.maxLength > 0 ? `<w:maxLength w:val="${field.maxLength}"/>` : ''}</w:textInput>`,
    '</w:ffData>',
    '</w:fldChar></w:r>',
    '<w:r><w:instrText xml:space="preserve"> FORMTEXT </w:instrText></w:r>',
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    `<w:r><w:rPr><w:noProof/><w:u w:val="single" w:color="999999"/><w:shd w:val="clear" w:color="auto" w:fill="F0F0F0"/></w:rPr><w:t xml:space="preserve">${escXml(value)}</w:t></w:r>`,
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join('\n');
}

/**
 * Generate OOXML runs for a checkbox form field (FORMCHECKBOX).
 * Also used for radio buttons (Word legacy forms don't have native radio groups).
 * Inserts a visible Unicode character before the legacy field for visual clarity:
 *   Checkbox: ☑ (checked) / ☐ (unchecked)
 *   Radio:    ● (checked) / ○ (unchecked)
 */
function generateCheckBoxRuns(field: FormField): string {
  const name = sanitizeFieldName(field.fieldName);
  const checked = field.isChecked ? '1' : '0';

  // Visible Unicode indicator run (Segoe UI Symbol, gray)
  let symbol: string;
  if (field.isRadioButton) {
    symbol = field.isChecked ? '\u25CF' : '\u25CB'; // ● / ○
  } else {
    symbol = field.isChecked ? '\u2611' : '\u2610'; // ☑ / ☐
  }
  const symbolRun = `<w:r><w:rPr><w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:cs="Segoe UI Symbol"/><w:color w:val="404040"/></w:rPr><w:t>${symbol}</w:t></w:r>`;

  return [
    symbolRun,
    '<w:r><w:fldChar w:fldCharType="begin">',
    '<w:ffData>',
    `<w:name w:val="${escXml(name)}"/>`,
    '<w:enabled/>',
    `<w:checkBox><w:sizeAuto/><w:default w:val="${checked}"/></w:checkBox>`,
    '</w:ffData>',
    '</w:fldChar></w:r>',
    '<w:r><w:instrText xml:space="preserve"> FORMCHECKBOX </w:instrText></w:r>',
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join('\n');
}

/**
 * Generate OOXML runs for a dropdown form field (FORMDROPDOWN).
 */
function generateDropdownRuns(field: FormField): string {
  const name = sanitizeFieldName(field.fieldName);
  const selectedIdx = Math.max(0, field.options.findIndex(
    o => o.exportValue === field.fieldValue
  ));
  const entries = field.options.map(
    o => `<w:listEntry w:val="${escXml(o.displayValue || o.exportValue)}"/>`
  ).join('');
  return [
    '<w:r><w:fldChar w:fldCharType="begin">',
    '<w:ffData>',
    `<w:name w:val="${escXml(name)}"/>`,
    '<w:enabled/>',
    `<w:ddList><w:result w:val="${selectedIdx}"/>${entries}</w:ddList>`,
    '</w:ffData>',
    '</w:fldChar></w:r>',
    '<w:r><w:instrText xml:space="preserve"> FORMDROPDOWN </w:instrText></w:r>',
    '<w:r><w:fldChar w:fldCharType="separate"/></w:r>',
    '<w:r><w:fldChar w:fldCharType="end"/></w:r>',
  ].join('\n');
}

/**
 * Generate form field runs (w:r elements only, no w:p wrapper).
 * Dispatches to the appropriate generator based on field type.
 */
function generateFormFieldRuns(field: FormField): string {
  if (field.fieldType === 'Tx') return generateTextFieldRuns(field);
  if (field.fieldType === 'Btn') return generateCheckBoxRuns(field);
  if (field.fieldType === 'Ch') return generateDropdownRuns(field);
  return '';
}

// ────────────────────────────────────────────────────────────
// Styles, settings, and font table (preserved from original)
// ────────────────────────────────────────────────────────────

/**
 * Generate word/styles.xml
 *
 * Only emits actually-used styles, plus the docDefaults from Normal.
 */
// ─── Test Exports ─────────────────────────────────────────────────
// These are exported for unit testing only. Do not use in production code.
export const _testExports = {
  sanitizeFieldName,
  generateFormFieldRuns,
  generateTextFieldRuns,
  generateCheckBoxRuns,
  generateDropdownRuns,
  renderTextRunsFromElements,
  generateTableFromDetected,
  mapFontName,
  rgbToHex,
};

export function generateStylesXml(styleCollector: StyleCollector): string {
  const normal = styleCollector.getNormalStyle();
  const usedStyles = styleCollector.getUsedStyles();

  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n';

  // Document defaults
  xml += '  <w:docDefaults>\n';
  xml += '    <w:rPrDefault>\n';
  xml += '      <w:rPr>\n';
  xml += `        <w:rFonts w:ascii="${escXml(normal.fontName)}" w:hAnsi="${escXml(normal.fontName)}" w:cs="${escXml(normal.fontName)}" w:eastAsia="${escXml(normal.fontName)}"/>\n`;
  xml += `        <w:sz w:val="${normal.fontSize}"/>\n`;
  xml += `        <w:szCs w:val="${normal.fontSize}"/>\n`;
  if (normal.color !== '000000') {
    xml += `        <w:color w:val="${escXml(normal.color)}"/>\n`;
  }
  if (normal.bold) {
    xml += '        <w:b/>\n';
  }
  if (normal.italic) {
    xml += '        <w:i/>\n';
  }
  xml += '      </w:rPr>\n';
  xml += '    </w:rPrDefault>\n';
  xml += '    <w:pPrDefault>\n';
  xml += '      <w:pPr>\n';
  xml += '        <w:spacing w:after="0" w:line="240" w:lineRule="auto"/>\n';
  xml += '      </w:pPr>\n';
  xml += '    </w:pPrDefault>\n';
  xml += '  </w:docDefaults>\n';

  // Normal style definition
  xml += '  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">\n';
  xml += '    <w:name w:val="Normal"/>\n';
  xml += '    <w:qFormat/>\n';
  xml += '  </w:style>\n';

  // Heading styles (Heading 1-3)
  const headingDefs = [
    { level: 1, name: 'heading 1', sizeFactor: 2.0, spacingBefore: 240 },
    { level: 2, name: 'heading 2', sizeFactor: 1.6, spacingBefore: 200 },
    { level: 3, name: 'heading 3', sizeFactor: 1.3, spacingBefore: 160 },
  ];

  for (const h of headingDefs) {
    const headingSizeHp = Math.round(normal.fontSize * h.sizeFactor);
    xml += `  <w:style w:type="paragraph" w:styleId="Heading${h.level}">\n`;
    xml += `    <w:name w:val="${h.name}"/>\n`;
    xml += '    <w:basedOn w:val="Normal"/>\n';
    xml += '    <w:next w:val="Normal"/>\n';
    xml += '    <w:qFormat/>\n';
    xml += '    <w:pPr>\n';
    xml += '      <w:keepNext/>\n';
    xml += `      <w:spacing w:before="${h.spacingBefore}"/>\n`;
    xml += '    </w:pPr>\n';
    xml += '    <w:rPr>\n';
    xml += '      <w:b/>\n';
    xml += `      <w:sz w:val="${headingSizeHp}"/>\n`;
    xml += `      <w:szCs w:val="${headingSizeHp}"/>\n`;
    xml += '    </w:rPr>\n';
    xml += '  </w:style>\n';
  }

  // Only emit styles that are actually used and differ from Normal
  for (const style of usedStyles) {
    xml += `  <w:style w:type="character" w:customStyle="1" w:styleId="${escXml(style.id)}">\n`;
    xml += `    <w:name w:val="${escXml(style.name)}"/>\n`;
    xml += '    <w:rPr>\n';
    if (style.fontName !== normal.fontName) {
      xml += `      <w:rFonts w:ascii="${escXml(style.fontName)}" w:hAnsi="${escXml(style.fontName)}" w:cs="${escXml(style.fontName)}"/>\n`;
    }
    if (style.bold !== normal.bold) {
      xml += style.bold ? '      <w:b/>\n' : '      <w:b w:val="0"/>\n';
    }
    if (style.italic !== normal.italic) {
      xml += style.italic ? '      <w:i/>\n' : '      <w:i w:val="0"/>\n';
    }
    if (style.fontSize !== normal.fontSize) {
      xml += `      <w:sz w:val="${style.fontSize}"/>\n`;
      xml += `      <w:szCs w:val="${style.fontSize}"/>\n`;
    }
    if (style.color !== normal.color) {
      xml += `      <w:color w:val="${escXml(style.color)}"/>\n`;
    }
    xml += '    </w:rPr>\n';
    xml += '  </w:style>\n';
  }

  xml += '</w:styles>';
  return xml;
}

/**
 * Generate word/settings.xml
 * Compatibility mode 15 = Word 2013+
 * When hasFormFields is true, adds document protection for form editing.
 */
export function generateSettingsXml(hasFormFields: boolean = false): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<w:settings xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:o="urn:schemas-microsoft-com:office:office" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">\n';
  xml += '  <w:zoom w:percent="100"/>\n';
  xml += '  <w:defaultTabStop w:val="720"/>\n';
  xml += '  <w:characterSpacingControl w:val="doNotCompress"/>\n';

  // Enable form protection when document contains form fields
  // This makes checkboxes clickable, text fields editable, dropdowns selectable
  if (hasFormFields) {
    xml += '  <w:documentProtection w:edit="forms" w:enforcement="1"/>\n';
  }

  xml += '  <w:compat>\n';
  xml += '    <w:compatSetting w:name="compatibilityMode" w:uri="http://schemas.microsoft.com/office/word" w:val="15"/>\n';
  xml += '  </w:compat>\n';
  xml += '</w:settings>';
  return xml;
}

/**
 * Generate word/fontTable.xml with only used fonts.
 */
export function generateFontTableXml(fonts: string[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n';

  for (const font of fonts) {
    xml += `  <w:font w:name="${escXml(font)}">\n`;
    xml += `    <w:panose1 w:val="020F0502020204030204"/>\n`;
    xml += '    <w:charset w:val="00"/>\n';
    xml += '    <w:family w:val="swiss"/>\n';
    xml += '    <w:pitch w:val="variable"/>\n';
    xml += '  </w:font>\n';
  }

  xml += '</w:fonts>';
  return xml;
}
