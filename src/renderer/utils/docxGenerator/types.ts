/**
 * DOCX Generator Type Definitions
 *
 * Unified type system for the scene-graph-based PDF-to-DOCX pipeline:
 *   PageAnalyzer (scene graph) -> LayoutAnalyzer (structural) -> OoxmlParts (XML)
 */

// ─── Unit Conversion Constants ─────────────────────────────────

/** 1 PDF point = 20 twips */
export const PT_TO_TWIPS = 20;
/** 1 PDF point = 12700 EMU */
export const PT_TO_EMU = 12700;
/** 1 inch = 72 PDF points */
export const INCH_TO_PT = 72;
/** 1 inch = 1440 twips */
export const INCH_TO_TWIPS = 1440;
/** 1 inch = 914400 EMU */
export const INCH_TO_EMU = 914400;

// ─── Scene Graph Types (from PageAnalyzer) ─────────────────────

/** RGB color with 0-1 range components */
export interface RGB { r: number; g: number; b: number }

/** Union of all visual elements on a page */
export type SceneElement = TextElement | RectElement | PathElement | ImageElement;

/** A text span with resolved font and positioning */
export interface TextElement {
  kind: 'text';
  text: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  /** Hex color without '#' prefix, e.g. "000000" */
  color: string;
}

/** A filled/stroked rectangle */
export interface RectElement {
  kind: 'rect';
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor: RGB | null;
  strokeColor: RGB | null;
  lineWidth: number;
}

/** A general vector path */
export interface PathElement {
  kind: 'path';
  points: Array<{ x: number; y: number }>;
  strokeColor: RGB | null;
  fillColor: RGB | null;
  lineWidth: number;
  isClosed: boolean;
}

/** An image placed on the page */
export interface ImageElement {
  kind: 'image';
  x: number;
  y: number;
  /** Display width in PDF points */
  width: number;
  /** Display height in PDF points */
  height: number;
  /** PDF resource name (e.g., "Im0") */
  resourceName: string;
  intrinsicWidth: number;
  intrinsicHeight: number;
  /** true = real photo/diagram, false = UI chrome */
  isGenuine: boolean;
  /** Original bytes (JPEG or PNG), null if extraction failed */
  data: Uint8Array | null;
  mimeType: 'image/jpeg' | 'image/png';
}

/** A form field extracted from PDF Widget annotations */
export interface FormField {
  /** PDF field type: Tx = text, Btn = button/checkbox/radio, Ch = choice/dropdown */
  fieldType: 'Tx' | 'Btn' | 'Ch';
  /** Full field name path from the PDF AcroForm */
  fieldName: string;
  /** Current field value (string for text/dropdown, "Off" for unchecked checkbox) */
  fieldValue: string;
  /** True if this is a checkbox widget */
  isCheckBox: boolean;
  /** True if this is a radio button widget */
  isRadioButton: boolean;
  /** True if the checkbox/radio is in checked state */
  isChecked: boolean;
  /** Options for dropdown/listbox fields */
  options: Array<{ exportValue: string; displayValue: string }>;
  /** Whether the field is read-only */
  readOnly: boolean;
  /** Original PDF rect [x1, y1, x2, y2] in bottom-left origin */
  rect: [number, number, number, number];
  /** X position in top-left origin coordinate system */
  x: number;
  /** Y position in top-left origin coordinate system */
  y: number;
  /** Width in PDF points */
  width: number;
  /** Height in PDF points */
  height: number;
  /** Max length for text fields (0 = unlimited) */
  maxLength: number;
}

/** Alias for backward compatibility with OoxmlParts form field generation */
export type DocxFormField = FormField;

/** Complete scene graph for a single page */
export interface PageScene {
  elements: SceneElement[];
  formFields: FormField[];
  width: number;
  height: number;
}

// ─── Layout Types (from LayoutAnalyzer) ────────────────────────

/** Classification of a rectangle's structural role */
export type RectRole = 'table-border' | 'cell-fill' | 'page-background' | 'separator' | 'decorative';

/** A single cell within a DetectedTable */
export interface DetectedCell {
  row: number;
  col: number;
  rowSpan: number;
  colSpan: number;
  x: number;
  y: number;
  width: number;
  height: number;
  fillColor: RGB | null;
  texts: TextElement[];
  formFields: FormField[];
}

/** A table detected from vector borders */
export interface DetectedTable {
  cells: DetectedCell[];
  rows: number;
  cols: number;
  /** Column widths in PDF points */
  columnWidths: number[];
  /** Row heights in PDF points */
  rowHeights: number[];
  x: number;
  y: number;
  width: number;
  height: number;
}

/** A group of text elements forming a paragraph */
export interface ParagraphGroup {
  texts: TextElement[];
  formFields: FormField[];
  y: number;
  x: number;
  /** Background color from overlapping cell-fill rect (RGB 0-1 range) */
  backgroundColor?: RGB | null;
  /** Bottom border from overlapping separator rect */
  bottomBorder?: { color: RGB; widthPt: number } | null;
}

/** A single element within a PageLayout, tagged by type */
export type LayoutElement =
  | { type: 'table'; element: DetectedTable }
  | { type: 'paragraph'; element: ParagraphGroup }
  | { type: 'image'; element: ImageElement };

/** A page layout produced by the LayoutAnalyzer */
export interface PageLayout {
  elements: LayoutElement[];
  /** Page width in PDF points */
  width: number;
  /** Page height in PDF points */
  height: number;
}

// ─── DOCX Run / Paragraph Types (used by OoxmlParts) ──────────

/** A run of text with uniform formatting within a paragraph */
export interface DocxRun {
  text: string;
  fontName: string;
  /** Font size in half-points (e.g., 24 = 12pt) */
  fontSize: number;
  bold: boolean;
  italic: boolean;
  /** Hex color without '#' prefix, e.g. "000000" */
  color: string;
  underline?: boolean;
  strikethrough?: boolean;
}

/** A paragraph containing one or more runs */
export interface DocxParagraph {
  runs: DocxRun[];
  alignment: 'left' | 'center' | 'right' | 'justify';
  /** Indent in twips */
  indent: number;
  /** First line indent in twips */
  firstLineIndent: number;
  /** Spacing before in twips */
  spacingBefore: number;
  /** Spacing after in twips */
  spacingAfter: number;
  /** Line spacing in twips (0 = auto) */
  lineSpacing: number;
  styleId?: string;
  pageBreakBefore?: boolean;
  /** Y position in PDF points (top-left origin) for element interleaving */
  yPosition?: number;
  /** X position of leftmost text item in PDF points */
  minX?: number;
  /** Form fields to emit inline within this paragraph */
  inlineFormFields?: Array<{ field: FormField; position: 'before' | 'after' }>;
}

/** A tracked style definition */
export interface DocxStyle {
  id: string;
  name: string;
  fontName: string;
  /** Font size in half-points */
  fontSize: number;
  bold: boolean;
  italic: boolean;
  /** Hex color without '#' */
  color: string;
  /** How many runs use this style */
  usageCount: number;
}

// ─── DOCX Packaging Types ──────────────────────────────────────

/** Image file ready for DOCX embedding */
export interface ImageFile {
  rId: string;
  data: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
  fileName: string;
  /** Matches ImageElement.resourceName */
  resourceName: string;
  widthEmu: number;
  heightEmu: number;
}

/** Options for the conversion process */
export interface ConvertOptions {
  /** Insert page breaks between pages (default: true) */
  preservePageBreaks?: boolean;
  /** Scale factor for image dimensions (default: 1.0) */
  imageScale?: number;
  /** Maximum image dimension in EMU before downscaling */
  maxImageDimEmu?: number;
}
