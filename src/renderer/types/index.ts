export interface Position {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface TextAnnotation {
  id: string;
  type: 'text';
  pageIndex: number;
  position: Position;
  content: string;
  fontSize: number;
  fontFamily: string;
  color: string;
  size?: Size;
}

export interface ImageAnnotation {
  id: string;
  type: 'image';
  pageIndex: number;
  position: Position;
  size: Size;
  data: string;
  imageType: string;
}

export interface DrawingAnnotation {
  id: string;
  type: 'drawing';
  pageIndex: number;
  paths: Array<{
    points: Position[];
    color: string;
    width: number;
  }>;
}

export interface ShapeAnnotation {
  id: string;
  type: 'shape';
  pageIndex: number;
  shapeType: 'rectangle' | 'ellipse' | 'arrow' | 'line';
  position: Position;
  size: Size;
  strokeColor: string;
  fillColor: string;
  strokeWidth: number;
  opacity: number;
  /** For arrows: which corner the arrow starts from. Default: 'topLeft' (arrow points to bottomRight). */
  startCorner?: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight';
}

export interface StickyNoteAnnotation {
  id: string;
  type: 'note';
  pageIndex: number;
  position: Position;
  content: string;
  color: string;
}

export interface StampAnnotation {
  id: string;
  type: 'stamp';
  pageIndex: number;
  position: Position;
  stampType: 'approved' | 'rejected' | 'draft' | 'confidential' | 'final' | 'custom';
  text: string;
  color: string;
  size: Size;
}

export interface HighlightAnnotation {
  id: string;
  type: 'highlight';
  pageIndex: number;
  rects: Array<{
    x: number;
    y: number;
    width: number;
    height: number;
  }>;
  color: string;
}

export interface PDFTextItem {
  id: string;
  str: string;
  originalStr: string;
  x: number;
  y: number;
  width: number;
  height: number;
  fontName: string;
  fontSize: number;
  transform: number[];
  parentTransform?: number[];
  isEdited: boolean;
  isDeleted?: boolean;
  backgroundColor?: { r: number; g: number; b: number };
  textColor?: { r: number; g: number; b: number };
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  strikethrough?: boolean;
  colorSpace?: 'DeviceRGB' | 'DeviceGray' | 'DeviceCMYK';
  originalColorValues?: number[];
}

export interface PDFSourceAnnotation {
  id: string;
  subtype: string;
  pageIndex: number;
  rect: { x: number; y: number; width: number; height: number };
  contents?: string;
  author?: string;
  modDate?: string;
  color?: { r: number; g: number; b: number };
  uri?: string;
  destPage?: number;
  richText?: string;
  quadPoints?: number[];
  inReplyTo?: string;
  replyType?: string;
  creationDate?: string;
  opacity?: number;
}

export interface TextEdit {
  itemId: string;
  pageIndex: number;
  originalText: string;
  newText: string;
}

export type Annotation =
  | TextAnnotation
  | ImageAnnotation
  | DrawingAnnotation
  | HighlightAnnotation
  | ShapeAnnotation
  | StickyNoteAnnotation
  | StampAnnotation;

export interface PDFPage {
  index: number;
  width: number;
  height: number;
  rotation: number;
  annotations: Annotation[];
  textItems?: PDFTextItem[];
  textEdits?: TextEdit[];
  sourceAnnotations?: PDFSourceAnnotation[];
}

export interface PDFDocument {
  filePath: string | null;
  fileName: string;
  pageCount: number;
  pages: PDFPage[];
  pdfData: Uint8Array;
}

export interface AnnotationStyle {
  color: string;
  strokeColor: string;
  fillColor: string;
  strokeWidth: number;
  fontSize: number;
  opacity: number;
  shapeType: 'rectangle' | 'ellipse' | 'arrow' | 'line';
  stampType: 'approved' | 'rejected' | 'draft' | 'confidential' | 'final' | 'custom';
  stampText: string;
  noteColor: string;
}

export interface TabInfo {
  id: string;
  fileName: string;
  filePath: string | null;
  modified: boolean;
}

export interface HistoryEntry {
  action: string;
  data: unknown;
  previousState: unknown;
}
