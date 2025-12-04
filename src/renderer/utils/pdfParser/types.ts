/**
 * PDF Parser Types
 * Low-level types for PDF content stream parsing and manipulation
 */

// PDF Operator Types
export type PDFOperatorType =
  // Text State Operators
  | 'Tc'  // Character spacing
  | 'Tw'  // Word spacing
  | 'Tz'  // Horizontal scaling
  | 'TL'  // Leading
  | 'Tf'  // Font and size
  | 'Tr'  // Rendering mode
  | 'Ts'  // Rise
  // Text Object Operators
  | 'BT'  // Begin text object
  | 'ET'  // End text object
  // Text Positioning Operators
  | 'Td'  // Move text position
  | 'TD'  // Move text position and set leading
  | 'Tm'  // Set text matrix
  | 'T*'  // Move to start of next line
  // Text Showing Operators
  | 'Tj'  // Show text string
  | 'TJ'  // Show text with positioning
  | "'"   // Move to next line and show text
  | '"'   // Set spacing, move to next line, show text
  // Graphics State Operators
  | 'q'   // Save graphics state
  | 'Q'   // Restore graphics state
  | 'cm'  // Concat matrix
  | 'w'   // Line width
  | 'J'   // Line cap
  | 'j'   // Line join
  | 'M'   // Miter limit
  | 'd'   // Dash pattern
  | 'ri'  // Rendering intent
  | 'i'   // Flatness
  | 'gs'  // Extended graphics state
  // Path Construction Operators
  | 'm'   // Move to
  | 'l'   // Line to
  | 'c'   // Curve to (cubic bezier)
  | 'v'   // Curve to (initial point replicated)
  | 'y'   // Curve to (final point replicated)
  | 'h'   // Close subpath
  | 're'  // Rectangle
  // Path Painting Operators
  | 'S'   // Stroke
  | 's'   // Close and stroke
  | 'f'   // Fill (nonzero winding)
  | 'F'   // Fill (nonzero winding - obsolete)
  | 'f*'  // Fill (even-odd rule)
  | 'B'   // Fill and stroke (nonzero)
  | 'B*'  // Fill and stroke (even-odd)
  | 'b'   // Close, fill, stroke (nonzero)
  | 'b*'  // Close, fill, stroke (even-odd)
  | 'n'   // End path without filling or stroking
  // Clipping Path Operators
  | 'W'   // Clip (nonzero)
  | 'W*'  // Clip (even-odd)
  // Color Operators
  | 'CS'  // Set color space (stroke)
  | 'cs'  // Set color space (fill)
  | 'SC'  // Set color (stroke)
  | 'SCN' // Set color (stroke, pattern/separation)
  | 'sc'  // Set color (fill)
  | 'scn' // Set color (fill, pattern/separation)
  | 'G'   // Set gray (stroke)
  | 'g'   // Set gray (fill)
  | 'RG'  // Set RGB (stroke)
  | 'rg'  // Set RGB (fill)
  | 'K'   // Set CMYK (stroke)
  | 'k'   // Set CMYK (fill)
  // XObject Operators
  | 'Do'  // Invoke XObject
  // Inline Image Operators
  | 'BI'  // Begin inline image
  | 'ID'  // Begin inline image data
  | 'EI'  // End inline image
  // Marked Content Operators
  | 'MP'  // Marked content point
  | 'DP'  // Marked content point with property list
  | 'BMC' // Begin marked content
  | 'BDC' // Begin marked content with property list
  | 'EMC' // End marked content
  // Compatibility Operators
  | 'BX'  // Begin compatibility section
  | 'EX'  // End compatibility section
  // Other
  | string; // Unknown operator

// PDF Value Types
export type PDFValue =
  | PDFNumber
  | PDFString
  | PDFName
  | PDFArray
  | PDFDict
  | PDFBoolean
  | PDFNull;

export interface PDFNumber {
  type: 'number';
  value: number;
}

export interface PDFString {
  type: 'string';
  value: string;
  encoding: 'literal' | 'hex';
  raw: string; // Original bytes
}

export interface PDFName {
  type: 'name';
  value: string;
}

export interface PDFArray {
  type: 'array';
  value: PDFValue[];
}

export interface PDFDict {
  type: 'dict';
  value: Map<string, PDFValue>;
}

export interface PDFBoolean {
  type: 'boolean';
  value: boolean;
}

export interface PDFNull {
  type: 'null';
}

// Parsed PDF Operator with operands
export interface PDFOperator {
  operator: PDFOperatorType;
  operands: PDFValue[];
  // Position in original stream for modification
  startOffset: number;
  endOffset: number;
  // Raw bytes for reconstruction
  raw: Uint8Array;
}

// Text State
export interface TextState {
  charSpacing: number;      // Tc
  wordSpacing: number;      // Tw
  horizontalScale: number;  // Tz (percentage)
  leading: number;          // TL
  fontName: string;         // Tf font name
  fontSize: number;         // Tf size
  renderMode: number;       // Tr (0-7)
  rise: number;             // Ts
}

// Text Matrix and Position
export interface TextMatrix {
  a: number;  // scale x
  b: number;  // skew y
  c: number;  // skew x
  d: number;  // scale y
  e: number;  // translate x
  f: number;  // translate y
}

// Graphics State
export interface GraphicsState {
  ctm: TextMatrix;           // Current transformation matrix
  lineWidth: number;
  lineCap: number;
  lineJoin: number;
  miterLimit: number;
  dashArray: number[];
  dashPhase: number;
  strokeColor: Color;
  fillColor: Color;
  colorSpace: {
    stroke: string;
    fill: string;
  };
  textState: TextState;
}

export interface Color {
  space: 'DeviceGray' | 'DeviceRGB' | 'DeviceCMYK' | 'Pattern' | string;
  values: number[];
}

// Glyph Information
export interface Glyph {
  charCode: number;
  unicode: string;
  width: number;
  x: number;
  y: number;
  fontName: string;
  fontSize: number;
  transform: TextMatrix;
}

// Text Run (sequence of glyphs with same properties)
export interface TextRun {
  id: string;
  glyphs: Glyph[];
  text: string;
  boundingBox: BoundingBox;
  fontName: string;
  fontSize: number;
  color: Color;
  transform: TextMatrix;
  // For modification tracking
  operators: PDFOperator[];
  modified: boolean;
}

// Bounding Box
export interface BoundingBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

// Word (one or more text runs forming a word)
export interface Word {
  id: string;
  runs: TextRun[];
  text: string;
  boundingBox: BoundingBox;
}

// Line (sequence of words)
export interface TextLine {
  id: string;
  words: Word[];
  text: string;
  boundingBox: BoundingBox;
  baseline: number;
  leading: number;
}

// Paragraph (sequence of lines)
export interface Paragraph {
  id: string;
  lines: TextLine[];
  text: string;
  boundingBox: BoundingBox;
  alignment: 'left' | 'center' | 'right' | 'justify';
  firstLineIndent: number;
}

// Column (sequence of paragraphs)
export interface Column {
  id: string;
  paragraphs: Paragraph[];
  boundingBox: BoundingBox;
}

// Table Cell
export interface TableCell {
  id: string;
  content: (Paragraph | ImageElement)[];
  boundingBox: BoundingBox;
  rowSpan: number;
  colSpan: number;
}

// Table Row
export interface TableRow {
  id: string;
  cells: TableCell[];
  boundingBox: BoundingBox;
}

// Table
export interface Table {
  id: string;
  rows: TableRow[];
  boundingBox: BoundingBox;
  columnWidths: number[];
}

// Image Element
export interface ImageElement {
  id: string;
  xObjectName: string;
  boundingBox: BoundingBox;
  transform: TextMatrix;
  data?: Uint8Array;
  width: number;
  height: number;
  colorSpace: string;
  bitsPerComponent: number;
}

// Path Element
export interface PathElement {
  id: string;
  commands: PathCommand[];
  boundingBox: BoundingBox;
  strokeColor?: Color;
  fillColor?: Color;
  lineWidth: number;
}

export interface PathCommand {
  type: 'm' | 'l' | 'c' | 'v' | 'y' | 'h' | 're';
  points: number[];
}

// Form XObject
export interface FormXObject {
  name: string;
  boundingBox: BoundingBox;
  matrix: TextMatrix;
  resources: PDFResources;
  content: ContentElement[];
}

// Font Information
export interface FontDescriptor {
  fontName: string;
  fontFamily: string;
  flags: number;
  fontBBox: BoundingBox;
  italicAngle: number;
  ascent: number;
  descent: number;
  capHeight: number;
  xHeight: number;
  stemV: number;
  stemH: number;
  avgWidth: number;
  maxWidth: number;
  missingWidth: number;
}

export interface FontInfo {
  name: string;
  subtype: 'Type1' | 'TrueType' | 'Type0' | 'Type3' | 'CIDFontType0' | 'CIDFontType2' | 'MMType1';
  baseFont: string;
  encoding: string | Map<number, string>;
  toUnicode: Map<number, string> | null;
  widths: Map<number, number>;
  descriptor: FontDescriptor | null;
  isEmbedded: boolean;
  isSubset: boolean;
  isCIDFont: boolean;
  descendantFonts?: FontInfo[];
}

// PDF Resources
export interface PDFResources {
  fonts: Map<string, FontInfo>;
  xObjects: Map<string, FormXObject | ImageElement>;
  extGState: Map<string, GraphicsState>;
  colorSpaces: Map<string, any>;
  patterns: Map<string, any>;
  shadings: Map<string, any>;
}

// Content Element (union of all renderable elements)
export type ContentElement =
  | { type: 'text'; element: TextRun }
  | { type: 'image'; element: ImageElement }
  | { type: 'path'; element: PathElement }
  | { type: 'formXObject'; element: FormXObject };

// Page Structure
export interface PageStructure {
  pageIndex: number;
  mediaBox: BoundingBox;
  cropBox: BoundingBox;
  rotation: number;
  resources: PDFResources;

  // Raw content
  operators: PDFOperator[];

  // Structured content
  textRuns: TextRun[];
  words: Word[];
  lines: TextLine[];
  paragraphs: Paragraph[];
  columns: Column[];
  tables: Table[];
  images: ImageElement[];
  paths: PathElement[];
  formXObjects: FormXObject[];

  // Reading order
  readingOrder: ContentElement[];
}

// Document Structure
export interface DocumentStructure {
  pages: PageStructure[];
  fonts: Map<string, FontInfo>;
  metadata: DocumentMetadata;
  outline: OutlineItem[];
  forms: FormField[];
}

export interface DocumentMetadata {
  title?: string;
  author?: string;
  subject?: string;
  keywords?: string;
  creator?: string;
  producer?: string;
  creationDate?: Date;
  modificationDate?: Date;
}

export interface OutlineItem {
  title: string;
  destination: any;
  children: OutlineItem[];
}

export interface FormField {
  id: string;
  type: 'text' | 'checkbox' | 'radio' | 'button' | 'choice' | 'signature';
  name: string;
  value: any;
  boundingBox: BoundingBox;
  pageIndex: number;
  flags: number;
  options?: string[];
}

// Edit Operations
export interface EditOperation {
  id: string;
  type: 'insert' | 'delete' | 'replace' | 'move' | 'style';
  target: {
    pageIndex: number;
    elementId: string;
    elementType: 'text' | 'image' | 'path' | 'annotation';
  };
  before: any;
  after: any;
  timestamp: number;
}

// Content Stream Builder Types
export interface ContentStreamBuilder {
  beginText(): void;
  endText(): void;
  setFont(fontName: string, size: number): void;
  setTextMatrix(matrix: TextMatrix): void;
  moveText(tx: number, ty: number): void;
  showText(text: string): void;
  showTextWithPositioning(items: (string | number)[]): void;
  setCharacterSpacing(spacing: number): void;
  setWordSpacing(spacing: number): void;
  setTextRise(rise: number): void;
  setLeading(leading: number): void;
  nextLine(): void;

  // Graphics
  saveState(): void;
  restoreState(): void;
  setMatrix(matrix: TextMatrix): void;
  setFillColor(color: Color): void;
  setStrokeColor(color: Color): void;
  setLineWidth(width: number): void;

  // Path
  moveTo(x: number, y: number): void;
  lineTo(x: number, y: number): void;
  curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void;
  rectangle(x: number, y: number, width: number, height: number): void;
  closePath(): void;
  stroke(): void;
  fill(): void;
  fillStroke(): void;
  clip(): void;

  // XObjects
  drawXObject(name: string): void;

  // Build
  build(): Uint8Array;
}
