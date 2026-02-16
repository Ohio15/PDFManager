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
  LayoutElement,
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
import {
  escXml,
  DOC_NS,
  mapFontName,
  rgbToHex,
  BASELINE_TOL,
  groupTextsByBaseline,
  renderTextRunsFromElements,
  generateFormFieldRuns,
  sanitizeFieldName,
  generateTextFieldRuns,
  generateCheckBoxRuns,
  generateDropdownRuns,
  type HyperlinkCollector,
} from './OoxmlUtils';

// Re-export escXml for backward compatibility
export { escXml } from './OoxmlUtils';

/** Paragraph splitting: gap > avgFontSize * PARA_GAP_FACTOR implies new paragraph */
const PARA_GAP_FACTOR = 1.5;

/**
 * Compute statistical variance of a number array.
 */
function variance(nums: number[]): number {
  if (nums.length <= 1) return 0;
  const mean = nums.reduce((a, b) => a + b, 0) / nums.length;
  return nums.reduce((sum, n) => sum + (n - mean) ** 2, 0) / nums.length;
}

// ────────────────────────────────────────────────────────────
// Content Types, Relationships
// ────────────────────────────────────────────────────────────

/**
 * Generate [Content_Types].xml
 *
 * @param images       Image files for MIME type detection
 * @param extraParts   Optional flags for additional DOCX parts
 */
export function generateContentTypes(
  images: ImageFile[],
  extraParts?: { hasHeader?: boolean; hasFooter?: boolean; hasNumbering?: boolean },
): string {
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
  if (extraParts?.hasHeader) {
    xml += '  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>\n';
  }
  if (extraParts?.hasFooter) {
    xml += '  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>\n';
  }
  if (extraParts?.hasNumbering) {
    xml += '  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>\n';
  }
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

/** An extra relationship entry for header/footer/hyperlink/numbering parts */
export interface ExtraRel {
  rId: string;
  type: string;
  target: string;
  targetMode?: 'External';
}

/**
 * Generate word/_rels/document.xml.rels
 *
 * @param images     Image files with rId references
 * @param extraRels  Additional relationships (header, footer, hyperlinks, numbering)
 */
export function generateDocumentRels(images: ImageFile[], extraRels?: ExtraRel[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n';
  xml += '  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>\n';
  xml += '  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/settings" Target="settings.xml"/>\n';
  xml += '  <Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/fontTable" Target="fontTable.xml"/>\n';

  for (const img of images) {
    xml += `  <Relationship Id="${img.rId}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="media/${img.fileName}"/>\n`;
  }

  if (extraRels) {
    for (const rel of extraRels) {
      const targetMode = rel.targetMode ? ` TargetMode="${rel.targetMode}"` : '';
      xml += `  <Relationship Id="${rel.rId}" Type="${rel.type}" Target="${escXml(rel.target)}"${targetMode}/>\n`;
    }
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
 *
 * @param sectionRefs  Optional header/footer rId references for section properties
 */
export function generateDocumentXml(
  layouts: PageLayout[],
  images: ImageFile[],
  styleCollector: StyleCollector,
  sectionRefs?: { headerRId?: string; footerRId?: string },
  hyperlinkCollector?: HyperlinkCollector,
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
        xml += generateTableFromDetected(elem.element, images, normalStyle, styleCollector, hyperlinkCollector);
      } else if (elem.type === 'paragraph') {
        xml += generateParagraphGroupXml(elem.element, normalStyle, styleCollector, pageLeftMarginPt, layout.width, hyperlinkCollector);
      } else if (elem.type === 'image') {
        xml += generateImageXml(elem.element, images);
      } else if (elem.type === 'two-column') {
        xml += generateTwoColumnXml(elem.element, images, normalStyle, styleCollector, pageLeftMarginPt, hyperlinkCollector);
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
  if (sectionRefs?.headerRId) {
    xml += `  <w:headerReference w:type="default" r:id="${sectionRefs.headerRId}"/>\n`;
  }
  if (sectionRefs?.footerRId) {
    xml += `  <w:footerReference w:type="default" r:id="${sectionRefs.footerRId}"/>\n`;
  }
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
  styleCollector: StyleCollector,
  hyperlinkCollector?: HyperlinkCollector,
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

      // Per-cell borders (when individual cells have detected border rects)
      if (cell.borderTop || cell.borderBottom || cell.borderLeft || cell.borderRight) {
        xml += '        <w:tcBorders>\n';
        if (cell.borderTop) {
          const sz = Math.max(Math.round(cell.borderTop.widthPt * 8), 2);
          xml += `          <w:top w:val="single" w:sz="${sz}" w:space="0" w:color="${rgbToHex(cell.borderTop.color)}"/>\n`;
        }
        if (cell.borderLeft) {
          const sz = Math.max(Math.round(cell.borderLeft.widthPt * 8), 2);
          xml += `          <w:left w:val="single" w:sz="${sz}" w:space="0" w:color="${rgbToHex(cell.borderLeft.color)}"/>\n`;
        }
        if (cell.borderBottom) {
          const sz = Math.max(Math.round(cell.borderBottom.widthPt * 8), 2);
          xml += `          <w:bottom w:val="single" w:sz="${sz}" w:space="0" w:color="${rgbToHex(cell.borderBottom.color)}"/>\n`;
        }
        if (cell.borderRight) {
          const sz = Math.max(Math.round(cell.borderRight.widthPt * 8), 2);
          xml += `          <w:right w:val="single" w:sz="${sz}" w:space="0" w:color="${rgbToHex(cell.borderRight.color)}"/>\n`;
        }
        xml += '        </w:tcBorders>\n';
      }

      // Cell margins/padding (from text-to-cell-boundary gaps)
      if (cell.paddingTop || cell.paddingBottom || cell.paddingLeft || cell.paddingRight) {
        xml += '        <w:tcMar>\n';
        if (cell.paddingTop) {
          xml += `          <w:top w:w="${Math.round(cell.paddingTop * PT_TO_TWIPS)}" w:type="dxa"/>\n`;
        }
        if (cell.paddingLeft) {
          xml += `          <w:left w:w="${Math.round(cell.paddingLeft * PT_TO_TWIPS)}" w:type="dxa"/>\n`;
        }
        if (cell.paddingBottom) {
          xml += `          <w:bottom w:w="${Math.round(cell.paddingBottom * PT_TO_TWIPS)}" w:type="dxa"/>\n`;
        }
        if (cell.paddingRight) {
          xml += `          <w:right w:w="${Math.round(cell.paddingRight * PT_TO_TWIPS)}" w:type="dxa"/>\n`;
        }
        xml += '        </w:tcMar>\n';
      }

      // Vertical alignment
      if (cell.vAlign) {
        xml += `        <w:vAlign w:val="${cell.vAlign}"/>\n`;
      }

      xml += '      </w:tcPr>\n';

      // Cell content: texts grouped into paragraphs by Y baseline, with form fields inline
      const cellContent = renderCellContent(cell, normalStyle, styleCollector, hyperlinkCollector);
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
  styleCollector: StyleCollector,
  hyperlinkCollector?: HyperlinkCollector,
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
    xml += renderTextRunsFromElements(lineTexts, normalStyle, styleCollector, hyperlinkCollector);

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
  pageWidthPt: number = 612,
  hyperlinkCollector?: HyperlinkCollector,
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

    // Paragraph spacing before/after
    const spacingBeforeTwips = group.spacingBeforePt ? Math.round(group.spacingBeforePt * PT_TO_TWIPS) : 0;
    const spacingAfterTwips = group.spacingAfterPt ? Math.round(group.spacingAfterPt * PT_TO_TWIPS) : 0;

    // Right indent: compute from right edge vs page right margin
    let rightIndentTwips = 0;
    if (group.rightX && pageWidthPt > 0) {
      const pageRightMarginPt = pageLeftMarginPt; // assume symmetric margins
      const contentRightEdgePt = pageWidthPt - pageRightMarginPt;
      const rightInsetPt = contentRightEdgePt - group.rightX;
      if (rightInsetPt > 10) {
        rightIndentTwips = Math.round(rightInsetPt * PT_TO_TWIPS);
      }
    }

    // Paragraph properties (heading style, alignment, indentation, spacing, background, borders)
    const needsPPr = group.headingLevel || alignment !== 'left' || hasIndent
      || firstLineIndentTwips > 0 || hangingTwips > 0
      || rightIndentTwips > 0
      || lineSpacingTwips > 0
      || spacingBeforeTwips > 0 || spacingAfterTwips > 0
      || group.backgroundColor || group.bottomBorder
      || group.listType;
    if (needsPPr) {
      xml += '  <w:pPr>\n';
      if (group.headingLevel) {
        xml += `    <w:pStyle w:val="Heading${group.headingLevel}"/>\n`;
      }
      if (alignment !== 'left') {
        const jcVal = alignment === 'justify' ? 'both' : alignment;
        xml += `    <w:jc w:val="${jcVal}"/>\n`;
      }
      if (group.listType && group.numId !== undefined) {
        xml += '    <w:numPr>\n';
        xml += `      <w:ilvl w:val="${group.listLevel ?? 0}"/>\n`;
        xml += `      <w:numId w:val="${group.numId}"/>\n`;
        xml += '    </w:numPr>\n';
      }
      if (hasIndent || firstLineIndentTwips > 0 || hangingTwips > 0 || rightIndentTwips > 0) {
        const leftTwips = hasIndent ? Math.round(leftIndentPt * PT_TO_TWIPS) : 0;
        let indAttr = `w:left="${leftTwips}"`;
        if (rightIndentTwips > 0) {
          indAttr += ` w:right="${rightIndentTwips}"`;
        }
        if (firstLineIndentTwips > 0) {
          indAttr += ` w:firstLine="${firstLineIndentTwips}"`;
        } else if (hangingTwips > 0) {
          indAttr += ` w:hanging="${hangingTwips}"`;
        }
        xml += `    <w:ind ${indAttr}/>\n`;
      }
      if (lineSpacingTwips > 0 || spacingBeforeTwips > 0 || spacingAfterTwips > 0) {
        let spacingAttr = '';
        if (spacingBeforeTwips > 0) {
          spacingAttr += ` w:before="${spacingBeforeTwips}"`;
        }
        if (spacingAfterTwips > 0) {
          spacingAttr += ` w:after="${spacingAfterTwips}"`;
        }
        if (lineSpacingTwips > 0) {
          spacingAttr += ` w:line="${lineSpacingTwips}" w:lineRule="exact"`;
        }
        xml += `    <w:spacing${spacingAttr}/>\n`;
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
      xml += renderTextRunsFromElements(paraLines[li], normalStyle, styleCollector, hyperlinkCollector);
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

// ────────────────────────────────────────────────────────────
// Image generation — DrawingML inline, NO VML
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
  const altDescr = image.altText ? ` descr="${escXml(image.altText)}"` : '';
  xml += `        <wp:docPr id="${n}" name="Picture ${n}"${altDescr}/>\n`;
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
  hyperlinkCollector?: HyperlinkCollector,
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
  const leftContent = renderColumnContent(region.leftElements, images, normalStyle, styleCollector, pageLeftMarginPt, hyperlinkCollector);
  xml += leftContent || '      <w:p/>\n';
  xml += '    </w:tc>\n';

  // Right cell
  xml += '    <w:tc>\n';
  xml += '      <w:tcPr>\n';
  xml += `        <w:tcW w:w="${rightWidthTwips}" w:type="dxa"/>\n`;
  xml += '      </w:tcPr>\n';
  const rightContent = renderColumnContent(region.rightElements, images, normalStyle, styleCollector, pageLeftMarginPt, hyperlinkCollector);
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
  hyperlinkCollector?: HyperlinkCollector,
): string {
  let xml = '';
  let lastType: string = '';
  for (const elem of elements) {
    if (elem.type === 'paragraph') {
      xml += generateParagraphGroupXml(elem.element, normalStyle, styleCollector, pageLeftMarginPt, undefined, hyperlinkCollector);
      lastType = 'paragraph';
    } else if (elem.type === 'image') {
      xml += generateImageXml(elem.element, images);
      lastType = 'image';
    } else if (elem.type === 'table') {
      xml += generateTableFromDetected(elem.element, images, normalStyle, styleCollector, hyperlinkCollector);
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
// Numbering XML generation (bullet & numbered lists)
// ────────────────────────────────────────────────────────────

/**
 * Generate word/numbering.xml with bullet and numbered list definitions.
 *
 * Defines two abstract numbering schemes:
 *   - abstractNumId 0: bullet list (alternating bullet chars across 9 levels)
 *   - abstractNumId 1: decimal numbered list (cycling decimal/lowerLetter/lowerRoman)
 *
 * Concrete numbering instances:
 *   - numId 1 → bullets (abstractNumId 0)
 *   - numId 2 → numbers (abstractNumId 1)
 */
export function generateNumberingXml(): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">\n';

  // Abstract numbering 0: bullet list (9 levels, alternating bullet chars)
  xml += '  <w:abstractNum w:abstractNumId="0">\n';
  const bulletChars = ['\u2022', '\u25E6', '\u25AA', '\u2022', '\u25E6', '\u25AA', '\u2022', '\u25E6', '\u25AA'];
  for (let lvl = 0; lvl < 9; lvl++) {
    const indent = 720 + lvl * 360; // 720 twips base + 360 per level
    xml += `    <w:lvl w:ilvl="${lvl}">\n`;
    xml += '      <w:start w:val="1"/>\n';
    xml += '      <w:numFmt w:val="bullet"/>\n';
    xml += `      <w:lvlText w:val="${bulletChars[lvl]}"/>\n`;
    xml += '      <w:lvlJc w:val="left"/>\n';
    xml += `      <w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr>\n`;
    xml += '      <w:rPr><w:rFonts w:ascii="Symbol" w:hAnsi="Symbol" w:hint="default"/></w:rPr>\n';
    xml += '    </w:lvl>\n';
  }
  xml += '  </w:abstractNum>\n';

  // Abstract numbering 1: decimal numbered list (cycling decimal/lowerLetter/lowerRoman)
  xml += '  <w:abstractNum w:abstractNumId="1">\n';
  const numFormats = ['decimal', 'lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter', 'lowerRoman', 'decimal', 'lowerLetter', 'lowerRoman'];
  const numTexts = ['%1.', '%2.', '%3.', '%4.', '%5.', '%6.', '%7.', '%8.', '%9.'];
  for (let lvl = 0; lvl < 9; lvl++) {
    const indent = 720 + lvl * 360;
    xml += `    <w:lvl w:ilvl="${lvl}">\n`;
    xml += '      <w:start w:val="1"/>\n';
    xml += `      <w:numFmt w:val="${numFormats[lvl]}"/>\n`;
    xml += `      <w:lvlText w:val="${numTexts[lvl]}"/>\n`;
    xml += '      <w:lvlJc w:val="left"/>\n';
    xml += `      <w:pPr><w:ind w:left="${indent}" w:hanging="360"/></w:pPr>\n`;
    xml += '    </w:lvl>\n';
  }
  xml += '  </w:abstractNum>\n';

  // Concrete numbering instances
  xml += '  <w:num w:numId="1"><w:abstractNumId w:val="0"/></w:num>\n'; // bullets
  xml += '  <w:num w:numId="2"><w:abstractNumId w:val="1"/></w:num>\n'; // numbers

  xml += '</w:numbering>';
  return xml;
}

// ────────────────────────────────────────────────────────────
// Header / Footer XML generation
// ────────────────────────────────────────────────────────────

/**
 * Generate word/header1.xml from header text elements.
 *
 * Renders header texts as simple paragraphs with center alignment.
 * Uses the same text run rendering pipeline as body paragraphs.
 */
export function generateHeaderXml(
  texts: TextElement[],
  styleCollector: StyleCollector,
): string {
  const normalStyle = styleCollector.getNormalStyle();
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += `<w:hdr ${DOC_NS}>\n`;

  if (texts.length === 0) {
    xml += '  <w:p/>\n';
  } else {
    // Group texts by baseline into lines
    const lines = groupTextsByBaseline(texts);
    for (const line of lines) {
      xml += '  <w:p>\n';
      xml += '    <w:pPr>\n';
      xml += '      <w:pStyle w:val="Header"/>\n';
      xml += '    </w:pPr>\n';
      xml += renderTextRunsFromElements(line, normalStyle, styleCollector);
      xml += '  </w:p>\n';
    }
  }

  xml += '</w:hdr>';
  return xml;
}

/**
 * Generate word/footer1.xml from footer text elements.
 *
 * Renders footer texts as simple paragraphs with center alignment.
 * Uses the same text run rendering pipeline as body paragraphs.
 */
export function generateFooterXml(
  texts: TextElement[],
  styleCollector: StyleCollector,
): string {
  const normalStyle = styleCollector.getNormalStyle();
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += `<w:ftr ${DOC_NS}>\n`;

  if (texts.length === 0) {
    xml += '  <w:p/>\n';
  } else {
    // Group texts by baseline into lines
    const lines = groupTextsByBaseline(texts);
    for (const line of lines) {
      xml += '  <w:p>\n';
      xml += '    <w:pPr>\n';
      xml += '      <w:pStyle w:val="Footer"/>\n';
      xml += '    </w:pPr>\n';
      xml += renderTextRunsFromElements(line, normalStyle, styleCollector);
      xml += '  </w:p>\n';
    }
  }

  xml += '</w:ftr>';
  return xml;
}

// ────────────────────────────────────────────────────────────
// Styles, settings, and font table
// ────────────────────────────────────────────────────────────

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

  // Header and Footer paragraph styles
  xml += '  <w:style w:type="paragraph" w:styleId="Header">\n';
  xml += '    <w:name w:val="header"/>\n';
  xml += '    <w:basedOn w:val="Normal"/>\n';
  xml += '    <w:pPr>\n';
  xml += '      <w:tabs><w:tab w:val="center" w:pos="4680"/><w:tab w:val="right" w:pos="9360"/></w:tabs>\n';
  xml += '    </w:pPr>\n';
  xml += '  </w:style>\n';
  xml += '  <w:style w:type="paragraph" w:styleId="Footer">\n';
  xml += '    <w:name w:val="footer"/>\n';
  xml += '    <w:basedOn w:val="Normal"/>\n';
  xml += '    <w:pPr>\n';
  xml += '      <w:tabs><w:tab w:val="center" w:pos="4680"/><w:tab w:val="right" w:pos="9360"/></w:tabs>\n';
  xml += '    </w:pPr>\n';
  xml += '  </w:style>\n';

  // Hyperlink character style
  xml += '  <w:style w:type="character" w:styleId="Hyperlink">\n';
  xml += '    <w:name w:val="Hyperlink"/>\n';
  xml += '    <w:rPr>\n';
  xml += '      <w:color w:val="0563C1"/>\n';
  xml += '      <w:u w:val="single"/>\n';
  xml += '    </w:rPr>\n';
  xml += '  </w:style>\n';

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

/** Font metadata for accurate font table generation */
interface FontMetadata {
  panose: string;
  family: string;
  charset: string;
  pitch: string;
}

/** Known font metadata for common fonts */
const FONT_METADATA: Record<string, FontMetadata> = {
  'Arial':           { panose: '020B0604020202020204', family: 'swiss', charset: '00', pitch: 'variable' },
  'Times New Roman': { panose: '02020603050405020304', family: 'roman', charset: '00', pitch: 'variable' },
  'Courier New':     { panose: '02070309020205020404', family: 'modern', charset: '00', pitch: 'fixed' },
  'Calibri':         { panose: '020F0502020204030204', family: 'swiss', charset: '00', pitch: 'variable' },
  'Cambria':         { panose: '02040503050406030204', family: 'roman', charset: '00', pitch: 'variable' },
  'Verdana':         { panose: '020B0604030504040204', family: 'swiss', charset: '00', pitch: 'variable' },
  'Georgia':         { panose: '02040502050405020303', family: 'roman', charset: '00', pitch: 'variable' },
  'Tahoma':          { panose: '020B0604030504040204', family: 'swiss', charset: '00', pitch: 'variable' },
  'Consolas':        { panose: '020B0609020204030204', family: 'modern', charset: '00', pitch: 'fixed' },
  'Symbol':          { panose: '05050102010706020507', family: 'roman', charset: '02', pitch: 'variable' },
  'Wingdings':       { panose: '05000000000000000000', family: 'auto', charset: '02', pitch: 'variable' },
  'Segoe UI':        { panose: '020B0502040204020203', family: 'swiss', charset: '00', pitch: 'variable' },
  'Segoe UI Symbol': { panose: '020B0502040204020203', family: 'swiss', charset: '00', pitch: 'variable' },
  'Helvetica':       { panose: '020B0604020202020204', family: 'swiss', charset: '00', pitch: 'variable' },
};

/** Infer font family classification from font name heuristics */
function inferFontFamily(fontName: string): FontMetadata {
  const lower = fontName.toLowerCase();
  if (lower.includes('mono') || lower.includes('courier') || lower.includes('consolas') || lower.includes('code')) {
    return { panose: '02070309020205020404', family: 'modern', charset: '00', pitch: 'fixed' };
  }
  if (lower.includes('times') || lower.includes('serif') || lower.includes('georgia') || lower.includes('cambria') || lower.includes('garamond') || lower.includes('palatino')) {
    return { panose: '02020603050405020304', family: 'roman', charset: '00', pitch: 'variable' };
  }
  if (lower.includes('script') || lower.includes('cursive') || lower.includes('handwrit')) {
    return { panose: '03050502040302020204', family: 'script', charset: '00', pitch: 'variable' };
  }
  // Default: sans-serif / swiss
  return { panose: '020F0502020204030204', family: 'swiss', charset: '00', pitch: 'variable' };
}

/**
 * Generate word/fontTable.xml with only used fonts.
 * Uses accurate per-font metadata (panose, family, charset, pitch).
 */
export function generateFontTableXml(fonts: string[]): string {
  let xml = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';
  xml += '<w:fonts xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">\n';

  for (const font of fonts) {
    const meta = FONT_METADATA[font] || inferFontFamily(font);
    xml += `  <w:font w:name="${escXml(font)}">\n`;
    xml += `    <w:panose1 w:val="${meta.panose}"/>\n`;
    xml += `    <w:charset w:val="${meta.charset}"/>\n`;
    xml += `    <w:family w:val="${meta.family}"/>\n`;
    xml += `    <w:pitch w:val="${meta.pitch}"/>\n`;
    xml += '  </w:font>\n';
  }

  xml += '</w:fonts>';
  return xml;
}
