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
  isEdited: boolean;
  backgroundColor?: { r: number; g: number; b: number };
  textColor?: { r: number; g: number; b: number };
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
  | HighlightAnnotation;

export interface PDFPage {
  index: number;
  width: number;
  height: number;
  rotation: number;
  annotations: Annotation[];
  textItems?: PDFTextItem[];
  textEdits?: TextEdit[];
}

export interface PDFDocument {
  filePath: string | null;
  fileName: string;
  pageCount: number;
  pages: PDFPage[];
  pdfData: Uint8Array;
}

export interface HistoryEntry {
  action: string;
  data: unknown;
  previousState: unknown;
}
