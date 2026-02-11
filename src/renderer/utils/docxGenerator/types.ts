/**
 * DOCX Generator Type Definitions
 * Types for converting PDF content to OOXML DOCX format.
 */

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
}

/** An image to embed in the DOCX */
export interface DocxImage {
  /** Relationship ID (rId) linking to the media file */
  rId: string;
  /** Raw image bytes */
  data: Uint8Array;
  /** MIME type: image/jpeg or image/png */
  mimeType: 'image/jpeg' | 'image/png';
  /** Width in EMU (English Metric Units, 1pt = 12700 EMU) */
  widthEmu: number;
  /** Height in EMU */
  heightEmu: number;
  /** File name in word/media/ */
  fileName: string;
  /** Which page this image belongs to */
  pageIndex: number;
  /** Y position in PDF points for ordering */
  yPosition: number;
}

/** A table cell */
export interface DocxTableCell {
  paragraphs: DocxParagraph[];
  /** Width in twips */
  width: number;
  colSpan: number;
  rowSpan: number;
}

/** A table row */
export interface DocxTableRow {
  cells: DocxTableCell[];
}

/** A table */
export interface DocxTable {
  rows: DocxTableRow[];
  /** Column widths in twips */
  columnWidths: number[];
  /** Y position in PDF points (top-left origin) for element interleaving */
  yPosition?: number;
}

/** A form field extracted from PDF Widget annotations */
export interface DocxFormField {
  /** Field name from the PDF AcroForm */
  fieldName: string;
  /** Field type: text, checkbox, dropdown */
  fieldType: 'text' | 'checkbox' | 'dropdown';
  /** Current value if any */
  value: string;
  /** Options for dropdown fields */
  options: string[];
  /** Whether checkbox is checked */
  checked: boolean;
  /** Y position on the page in PDF points for ordering */
  yPosition: number;
  /** X position on the page in PDF points */
  xPosition: number;
  /** Width in PDF points */
  width: number;
  /** Height in PDF points */
  height: number;
  /** Page index */
  pageIndex: number;
  /** Max length for text fields (0 = unlimited) */
  maxLength: number;
}

/** Content element in page order */
export type DocxPageElement =
  | { type: 'paragraph'; element: DocxParagraph }
  | { type: 'image'; element: DocxImage }
  | { type: 'table'; element: DocxTable }
  | { type: 'formField'; element: DocxFormField };

/** A single page's worth of DOCX content */
export interface DocxPage {
  elements: DocxPageElement[];
  /** Page width in twips (1 inch = 1440 twips) */
  widthTwips: number;
  /** Page height in twips */
  heightTwips: number;
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

/** Options for the conversion process */
export interface ConvertOptions {
  /** Insert page breaks between pages (default: true) */
  preservePageBreaks?: boolean;
  /** Scale factor for image dimensions (default: 1.0) */
  imageScale?: number;
  /** Maximum image dimension in EMU before downscaling */
  maxImageDimEmu?: number;
}

/** Result of extracting an image from a PDF page */
export interface ExtractedImage {
  name: string;
  data: Uint8Array;
  mimeType: 'image/jpeg' | 'image/png';
  /** Width in PDF points */
  width: number;
  /** Height in PDF points */
  height: number;
  /** X position on the page in PDF points */
  x: number;
  /** Y position on the page in PDF points */
  y: number;
}

// Unit conversion constants
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
