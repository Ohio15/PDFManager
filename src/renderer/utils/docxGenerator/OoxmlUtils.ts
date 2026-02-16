/**
 * OOXML Shared Utilities
 *
 * Common functions and constants shared between flow-mode (OoxmlParts)
 * and positioned-mode (PositionedOoxmlParts) DOCX generators.
 */

import type {
  TextElement,
  FormField,
  ImageFile,
  DocxStyle,
  RGB,
} from './types';
import { PT_TO_EMU } from './types';
import { StyleCollector } from './StyleCollector';

// ────────────────────────────────────────────────────────────
// XML Utilities
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

// ────────────────────────────────────────────────────────────
// OOXML Namespace Declarations
// ────────────────────────────────────────────────────────────

/** OOXML namespace declarations used in document.xml */
export const DOC_NS = [
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

// ────────────────────────────────────────────────────────────
// Font Mapping
// ────────────────────────────────────────────────────────────

/** Common PDF font name to DOCX font name mappings */
export const FONT_MAP: Record<string, string> = {
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

/**
 * Clean up a PDF font name:
 * - Strip subset prefix (e.g., "ABCDEF+" becomes the base name)
 * - Map to standard DOCX font name via FONT_MAP
 * - Strip style suffixes (Bold, Italic, Regular, etc.)
 * - Default to Calibri if nothing resolves
 */
export function mapFontName(pdfFontName: string): string {
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

// ────────────────────────────────────────────────────────────
// Color Utilities
// ────────────────────────────────────────────────────────────

/**
 * Convert an RGB object (0-1 range) to a 6-char hex string (no '#').
 */
export function rgbToHex(color: RGB): string {
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

// ────────────────────────────────────────────────────────────
// Text Grouping
// ────────────────────────────────────────────────────────────

/** Baseline grouping tolerance in PDF points */
export const BASELINE_TOL = 3;

/** Word spacing detection: gap > fontSize * WORD_GAP_FACTOR implies a space */
export const WORD_GAP_FACTOR = 0.3;

/**
 * Group TextElement[] by Y baseline into lines.
 * Elements within BASELINE_TOL of each other are considered same line.
 * Each resulting line is sorted by X position (left to right).
 */
export function groupTextsByBaseline(texts: TextElement[]): TextElement[][] {
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

// ────────────────────────────────────────────────────────────
// Text Run Rendering
// ────────────────────────────────────────────────────────────

/**
 * Render a line of TextElement[] as <w:r> runs.
 *
 * Detects word gaps (inserts spaces), merges adjacent runs with identical
 * formatting, maps font names via FONT_MAP, and registers styles with
 * the StyleCollector. Only emits run properties that differ from Normal.
 */
export function renderTextRunsFromElements(
  texts: TextElement[],
  normalStyle: DocxStyle,
  styleCollector: StyleCollector,
  hyperlinkCollector?: HyperlinkCollector,
): string {
  if (texts.length === 0) return '';

  interface RunAccum {
    text: string;
    fontName: string;
    fontSize: number; // half-points
    bold: boolean;
    italic: boolean;
    color: string;
    underline: boolean;
    strikethrough: boolean;
    textRise: number;
    rotation: number; // degrees (0 = normal)
    lang?: string; // language tag from structure tree
    linkUri?: string; // hyperlink URI
  }

  const runs: RunAccum[] = [];

  for (let i = 0; i < texts.length; i++) {
    const elem = texts[i];
    const mappedFont = mapFontName(elem.fontName);
    const halfPts = Math.round(elem.fontSize * 2);
    const color = elem.color || '000000';
    const underline = elem.underline || false;
    const strikethrough = elem.strikethrough || false;
    const textRise = elem.textRise || 0;
    const rotation = elem.rotation || 0;
    const lang = elem.lang;
    const linkUri = elem.linkUri;

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

    // Try to merge with previous run if same formatting (and same link target)
    if (runs.length > 0) {
      const prev = runs[runs.length - 1];
      if (
        prev.fontName === mappedFont &&
        prev.fontSize === halfPts &&
        prev.bold === elem.bold &&
        prev.italic === elem.italic &&
        prev.color === color &&
        prev.underline === underline &&
        prev.strikethrough === strikethrough &&
        prev.textRise === textRise &&
        prev.rotation === rotation &&
        prev.lang === lang &&
        prev.linkUri === linkUri
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
      underline,
      strikethrough,
      textRise,
      rotation,
      lang,
      linkUri,
    });
  }

  // Convert accumulated runs to XML
  let xml = '';
  for (const run of runs) {
    // Significantly rotated text → DrawingML inline text box with rotation
    if (Math.abs(run.rotation) > 5) {
      xml += buildRotatedTextBox(run, normalStyle);
      continue;
    }

    // Determine if this run is a hyperlink
    const isHyperlink = !!run.linkUri && !!hyperlinkCollector;
    let hyperlinkRId = '';
    if (isHyperlink) {
      hyperlinkRId = hyperlinkCollector!.addHyperlink(run.linkUri!);
      xml += `  <w:hyperlink r:id="${hyperlinkRId}">\n`;
    }

    xml += '  <w:r>\n';

    // For hyperlinks, force blue color and underline via Hyperlink style
    const effectiveColor = isHyperlink ? '0563C1' : run.color;
    const effectiveUnderline = isHyperlink ? true : run.underline;

    // Run properties — only emit what differs from Normal
    const needsRPr =
      run.fontName !== normalStyle.fontName ||
      run.fontSize !== normalStyle.fontSize ||
      run.bold !== normalStyle.bold ||
      run.italic !== normalStyle.italic ||
      effectiveColor !== normalStyle.color ||
      effectiveUnderline ||
      run.strikethrough ||
      run.textRise !== 0 ||
      !!run.lang ||
      isHyperlink;

    if (needsRPr) {
      xml += '    <w:rPr>\n';

      if (isHyperlink) {
        xml += '      <w:rStyle w:val="Hyperlink"/>\n';
      }

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

      if (effectiveUnderline) {
        xml += '      <w:u w:val="single"/>\n';
      }

      if (run.strikethrough) {
        xml += '      <w:strike/>\n';
      }

      if (effectiveColor !== normalStyle.color) {
        xml += `      <w:color w:val="${escXml(effectiveColor)}"/>\n`;
      }

      if (run.fontSize !== normalStyle.fontSize) {
        xml += `      <w:sz w:val="${run.fontSize}"/>\n`;
        xml += `      <w:szCs w:val="${run.fontSize}"/>\n`;
      }

      // Superscript / subscript from text rise
      if (run.textRise > 0.5) {
        xml += '      <w:vertAlign w:val="superscript"/>\n';
      } else if (run.textRise < -0.5) {
        xml += '      <w:vertAlign w:val="subscript"/>\n';
      }

      // Language tag from structure tree
      if (run.lang) {
        xml += `      <w:lang w:val="${escXml(run.lang)}"/>\n`;
      }

      xml += '    </w:rPr>\n';
    }

    xml += `    <w:t xml:space="preserve">${escXml(run.text)}</w:t>\n`;
    xml += '  </w:r>\n';

    if (isHyperlink) {
      xml += '  </w:hyperlink>\n';
    }
  }

  return xml;
}

/** Unique counter for rotated text box IDs */
let rotatedTextBoxIdCounter = 1000;

/**
 * Build a DrawingML inline text box with rotation for significantly rotated text.
 * Uses <wps:wsp> (WordprocessingShape) with <a:xfrm rot="..."> for rotation.
 */
function buildRotatedTextBox(
  run: { text: string; fontName: string; fontSize: number; bold: boolean; italic: boolean; color: string; rotation: number },
  normalStyle: DocxStyle,
): string {
  const id = rotatedTextBoxIdCounter++;

  // Estimate text box dimensions from text length and font size
  const fontSizePt = run.fontSize / 2; // half-points to points
  const estWidthPt = run.text.length * fontSizePt * 0.6;
  const estHeightPt = fontSizePt * 1.4;
  const widthEmu = Math.round(estWidthPt * PT_TO_EMU);
  const heightEmu = Math.round(estHeightPt * PT_TO_EMU);

  // OOXML rotation is in 60000ths of a degree
  const rotEmu = Math.round(run.rotation * 60000);

  // Build inner run properties
  let rPr = '';
  if (run.fontName !== normalStyle.fontName) {
    rPr += `<w:rFonts w:ascii="${escXml(run.fontName)}" w:hAnsi="${escXml(run.fontName)}" w:cs="${escXml(run.fontName)}"/>`;
  }
  if (run.bold) rPr += '<w:b/>';
  if (run.italic) rPr += '<w:i/>';
  if (run.color !== normalStyle.color) {
    rPr += `<w:color w:val="${escXml(run.color)}"/>`;
  }
  if (run.fontSize !== normalStyle.fontSize) {
    rPr += `<w:sz w:val="${run.fontSize}"/><w:szCs w:val="${run.fontSize}"/>`;
  }
  const rPrXml = rPr ? `<w:rPr>${rPr}</w:rPr>` : '';

  let xml = '  <w:r>\n';
  xml += '    <w:drawing>\n';
  xml += `      <wp:inline distT="0" distB="0" distL="0" distR="0">\n`;
  xml += `        <wp:extent cx="${widthEmu}" cy="${heightEmu}"/>\n`;
  xml += `        <wp:docPr id="${id}" name="RotatedText${id}"/>\n`;
  xml += '        <a:graphic>\n';
  xml += '          <a:graphicData uri="http://schemas.microsoft.com/office/word/2010/wordprocessingShape">\n';
  xml += '            <wps:wsp>\n';
  xml += '              <wps:cNvSpPr txBox="1"/>\n';
  xml += '              <wps:spPr>\n';
  xml += `                <a:xfrm rot="${rotEmu}">\n`;
  xml += '                  <a:off x="0" y="0"/>\n';
  xml += `                  <a:ext cx="${widthEmu}" cy="${heightEmu}"/>\n`;
  xml += '                </a:xfrm>\n';
  xml += '                <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>\n';
  xml += '                <a:noFill/>\n';
  xml += '                <a:ln><a:noFill/></a:ln>\n';
  xml += '              </wps:spPr>\n';
  xml += '              <wps:txbx>\n';
  xml += '                <w:txbxContent>\n';
  xml += '                  <w:p>\n';
  xml += `                    <w:r>${rPrXml}<w:t xml:space="preserve">${escXml(run.text)}</w:t></w:r>\n`;
  xml += '                  </w:p>\n';
  xml += '                </w:txbxContent>\n';
  xml += '              </wps:txbx>\n';
  xml += '              <wps:bodyPr wrap="none" lIns="0" tIns="0" rIns="0" bIns="0" anchor="t"/>\n';
  xml += '            </wps:wsp>\n';
  xml += '          </a:graphicData>\n';
  xml += '        </a:graphic>\n';
  xml += '      </wp:inline>\n';
  xml += '    </w:drawing>\n';
  xml += '  </w:r>\n';
  return xml;
}

// ────────────────────────────────────────────────────────────
// Form Field Generators
// ────────────────────────────────────────────────────────────

/**
 * Sanitize a PDF field name for OOXML w:name.
 * Takes the last segment of the dotted path and strips array indices.
 * Word has a 20-character limit on form field names.
 */
export function sanitizeFieldName(fullName: string): string {
  const last = fullName.split('.').pop() || fullName;
  return last.replace(/\[\d+\]/g, '').substring(0, 20);
}

/**
 * Generate OOXML runs for a text input form field (FORMTEXT).
 * Adds gray underline and light gray shading to the value run for visual clarity.
 * Pads empty/whitespace values to at least 15 spaces for minimum field width.
 */
export function generateTextFieldRuns(field: FormField): string {
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
 *   Checkbox: checked / unchecked
 *   Radio:    filled / empty
 */
export function generateCheckBoxRuns(field: FormField): string {
  const name = sanitizeFieldName(field.fieldName);
  const checked = field.isChecked ? '1' : '0';

  // Visible Unicode indicator run (Segoe UI Symbol, gray)
  let symbol: string;
  if (field.isRadioButton) {
    symbol = field.isChecked ? '\u25CF' : '\u25CB'; // filled / empty circle
  } else {
    symbol = field.isChecked ? '\u2611' : '\u2610'; // checked / unchecked box
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
export function generateDropdownRuns(field: FormField): string {
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
 * These produce functional Word legacy form fields (FORMTEXT, FORMCHECKBOX, FORMDROPDOWN).
 */
export function generateFormFieldRuns(field: FormField): string {
  if (field.fieldType === 'Tx') return generateTextFieldRuns(field);
  if (field.fieldType === 'Btn') return generateCheckBoxRuns(field);
  if (field.fieldType === 'Ch') return generateDropdownRuns(field);
  return '';
}

/**
 * Generate VISUAL-ONLY form field runs for positioned mode (1:1 visual fidelity).
 *
 * Instead of Word legacy form fields (which add their own chrome and look different
 * from the PDF), this renders the field's current value as styled text that matches
 * the PDF's visual appearance:
 *   - Text fields: value with bottom border (underline) to indicate fillable area
 *   - Checkboxes: Unicode checkbox symbol matching checked/unchecked state
 *   - Radio buttons: Unicode radio symbol matching selected/unselected state
 *   - Dropdowns: selected option displayed as plain text
 */
export function generateVisualFormFieldRuns(field: FormField, heightPt: number): string {
  // Estimate font size from field height (typically field height ≈ 1.3× font size)
  const fontSizeHp = Math.max(12, Math.round((heightPt / 1.3) * 2)); // half-points

  if (field.fieldType === 'Tx') {
    // Text field: show value (or empty underlined space)
    let value = field.fieldValue || '';
    if (value.trim().length === 0) {
      value = '               '; // 15 spaces for visible empty field
    }
    return [
      '<w:r>',
      '<w:rPr>',
      `<w:sz w:val="${fontSizeHp}"/>`,
      `<w:szCs w:val="${fontSizeHp}"/>`,
      '<w:u w:val="single" w:color="808080"/>',
      '</w:rPr>',
      `<w:t xml:space="preserve">${escXml(value)}</w:t>`,
      '</w:r>',
    ].join('\n');
  }

  if (field.fieldType === 'Btn') {
    // Checkbox / radio button: Unicode symbol
    let symbol: string;
    if (field.isRadioButton) {
      symbol = field.isChecked ? '\u25CF' : '\u25CB'; // filled / empty circle
    } else {
      symbol = field.isChecked ? '\u2611' : '\u2610'; // checked / unchecked box
    }
    return [
      '<w:r>',
      '<w:rPr>',
      '<w:rFonts w:ascii="Segoe UI Symbol" w:hAnsi="Segoe UI Symbol" w:cs="Segoe UI Symbol"/>',
      `<w:sz w:val="${fontSizeHp}"/>`,
      `<w:szCs w:val="${fontSizeHp}"/>`,
      '</w:rPr>',
      `<w:t>${symbol}</w:t>`,
      '</w:r>',
    ].join('\n');
  }

  if (field.fieldType === 'Ch') {
    // Dropdown: show selected value text
    const selectedOpt = field.options.find(o => o.exportValue === field.fieldValue);
    const displayText = selectedOpt?.displayValue || selectedOpt?.exportValue || field.fieldValue || '';
    return [
      '<w:r>',
      '<w:rPr>',
      `<w:sz w:val="${fontSizeHp}"/>`,
      `<w:szCs w:val="${fontSizeHp}"/>`,
      '</w:rPr>',
      `<w:t xml:space="preserve">${escXml(displayText)}</w:t>`,
      '</w:r>',
    ].join('\n');
  }

  return '';
}

// ────────────────────────────────────────────────────────────
// Hyperlink Collection
// ────────────────────────────────────────────────────────────

export interface HyperlinkCollector {
  addHyperlink(uri: string): string;  // returns rId, deduplicates same URI
  getHyperlinks(): Array<{ rId: string; uri: string }>;
}

export function createHyperlinkCollector(startRId: number): HyperlinkCollector {
  const map = new Map<string, string>(); // uri -> rId
  let nextRId = startRId;
  return {
    addHyperlink(uri: string): string {
      const existing = map.get(uri);
      if (existing) return existing;
      const rId = `rId${nextRId++}`;
      map.set(uri, rId);
      return rId;
    },
    getHyperlinks(): Array<{ rId: string; uri: string }> {
      return Array.from(map.entries()).map(([uri, rId]) => ({ rId, uri }));
    },
  };
}
