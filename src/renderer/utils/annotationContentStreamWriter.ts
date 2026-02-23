/**
 * Annotation Content Stream Writer
 *
 * Converts each annotation type to PDF content stream bytes using ContentStreamBuilder.
 * All coordinate transforms (top-left origin -> bottom-left origin) are handled here.
 *
 * Annotations use page coordinates (origin top-left, Y increases downward).
 * PDF content streams use PDF coordinates (origin bottom-left, Y increases upward).
 * Conversion: pdfY = pageHeight - pageY - elementHeight
 */

import { ContentStreamBuilder } from './pdfParser/ContentStreamBuilder';
import {
  Annotation,
  TextAnnotation,
  ImageAnnotation,
  DrawingAnnotation,
  HighlightAnnotation,
  ShapeAnnotation,
  StickyNoteAnnotation,
  StampAnnotation,
} from '../types';

/**
 * Resource requirements returned alongside content stream bytes.
 * The caller must register these resources on the page before injecting the stream.
 */
export interface ResourceRequirements {
  extGStates: Array<{ fillOpacity?: number; strokeOpacity?: number; name?: string }>;
  xObjects: Array<{ ref: any; name?: string }>;
  fonts: Array<{ ref: any; name?: string }>;
}

export interface AnnotationWriteResult {
  contentBytes: Uint8Array;
  resources: ResourceRequirements;
  /** If true, the caller should add a PDF /Text annotation dict for popup note content. */
  needsPdfAnnotation?: boolean;
  /** Content for the PDF /Text annotation (sticky notes). */
  pdfAnnotationContent?: string;
  /** Position in PDF coordinates for the annotation rect. */
  pdfAnnotationRect?: { x: number; y: number; width: number; height: number };
  /** Color for the PDF annotation. */
  pdfAnnotationColor?: { r: number; g: number; b: number };
}

/**
 * Options that the pipeline can pass to customize annotation rendering.
 */
export interface WriteAnnotationOptions {
  /** Actual text width in points, calculated by pipeline from font metrics. Used for stamp centering. */
  measuredTextWidth?: number;
}

/**
 * Parse a hex color string (#RRGGBB) to RGB values (0-1 scale).
 */
function parseHexColor(hex: string): { r: number; g: number; b: number } {
  const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (match) {
    return {
      r: parseInt(match[1], 16) / 255,
      g: parseInt(match[2], 16) / 255,
      b: parseInt(match[3], 16) / 255,
    };
  }
  return { r: 0, g: 0, b: 0 };
}

/**
 * Parse an rgba() color string to RGB + alpha.
 * Handles both rgba(R, G, B, A) and hex formats.
 */
function parseColor(color: string): { r: number; g: number; b: number; a: number } {
  const rgbaMatch = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i.exec(color);
  if (rgbaMatch) {
    return {
      r: parseInt(rgbaMatch[1]) / 255,
      g: parseInt(rgbaMatch[2]) / 255,
      b: parseInt(rgbaMatch[3]) / 255,
      a: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1,
    };
  }

  const hex = parseHexColor(color);
  return { ...hex, a: 1 };
}

/**
 * Detect whether a fill color represents "no fill" / transparent.
 * Checks for empty string, 'transparent', 'none', or pure white (#ffffff/#fff).
 */
function isTransparentFill(fillColor: string): boolean {
  if (!fillColor) return true;
  const lower = fillColor.toLowerCase().trim();
  if (lower === 'transparent' || lower === 'none' || lower === '') return true;
  if (lower === '#ffffff' || lower === '#fff') return true;
  if (lower === 'rgba(255, 255, 255, 0)' || lower === 'rgba(0, 0, 0, 0)') return true;
  return false;
}

/**
 * Write a highlight annotation as transparent filled rectangles.
 * Requires ExtGState for fill opacity (`ca` operator).
 */
function writeHighlight(
  annotation: HighlightAnnotation,
  pageHeight: number
): AnnotationWriteResult {
  const builder = new ContentStreamBuilder();
  const color = parseColor(annotation.color);
  const opacity = color.a < 1 ? color.a : 0.35;

  const resources: ResourceRequirements = {
    extGStates: [{ fillOpacity: opacity }],
    xObjects: [],
    fonts: [],
  };

  builder.saveState();
  builder.setExtGState('__GS_0__');
  builder.setFillColor({ space: 'DeviceRGB', values: [color.r, color.g, color.b] });

  for (const rect of annotation.rects) {
    const pdfX = rect.x;
    const pdfY = pageHeight - rect.y - rect.height;
    builder.rectangle(pdfX, pdfY, rect.width, rect.height);
    builder.fill();
  }

  builder.restoreState();
  return { contentBytes: builder.build(), resources };
}

/**
 * Write a freehand drawing annotation as stroked paths.
 */
function writeDrawing(
  annotation: DrawingAnnotation,
  pageHeight: number
): AnnotationWriteResult {
  const builder = new ContentStreamBuilder();
  const resources: ResourceRequirements = { extGStates: [], xObjects: [], fonts: [] };

  builder.saveState();
  builder.setLineCap(1); // Round cap

  for (const path of annotation.paths) {
    if (path.points.length < 2) continue;

    const color = parseHexColor(path.color);
    builder.setStrokeColor({ space: 'DeviceRGB', values: [color.r, color.g, color.b] });
    builder.setLineWidth(path.width);

    const first = path.points[0];
    builder.moveTo(first.x, pageHeight - first.y);

    for (let i = 1; i < path.points.length; i++) {
      const pt = path.points[i];
      builder.lineTo(pt.x, pageHeight - pt.y);
    }

    builder.stroke();
  }

  builder.restoreState();
  return { contentBytes: builder.build(), resources };
}

/**
 * Write a shape annotation (rectangle, ellipse, line, arrow).
 * Fix #8: Uses isTransparentFill() instead of white-color check.
 * Fix #9: Arrows respect startCorner for direction.
 */
function writeShape(
  annotation: ShapeAnnotation,
  pageHeight: number
): AnnotationWriteResult {
  const builder = new ContentStreamBuilder();
  const resources: ResourceRequirements = { extGStates: [], xObjects: [], fonts: [] };

  const strokeColor = parseHexColor(annotation.strokeColor);
  const fillColor = parseHexColor(annotation.fillColor);
  const noFill = isTransparentFill(annotation.fillColor);
  const needsOpacity = annotation.opacity < 1;

  if (needsOpacity) {
    resources.extGStates.push({
      fillOpacity: annotation.opacity,
      strokeOpacity: annotation.opacity,
    });
  }

  builder.saveState();

  if (needsOpacity) {
    builder.setExtGState('__GS_0__');
  }

  builder.setStrokeColor({ space: 'DeviceRGB', values: [strokeColor.r, strokeColor.g, strokeColor.b] });
  builder.setLineWidth(annotation.strokeWidth);

  // Convert position from page coords to PDF coords
  const x = annotation.position.x;
  const y = pageHeight - annotation.position.y - annotation.size.height;
  const w = annotation.size.width;
  const h = annotation.size.height;

  switch (annotation.shapeType) {
    case 'rectangle':
      if (!noFill) {
        builder.setFillColor({ space: 'DeviceRGB', values: [fillColor.r, fillColor.g, fillColor.b] });
      }
      builder.rectangle(x, y, w, h);
      if (noFill) {
        builder.stroke();
      } else {
        builder.fillStroke();
      }
      break;

    case 'ellipse':
      if (!noFill) {
        builder.setFillColor({ space: 'DeviceRGB', values: [fillColor.r, fillColor.g, fillColor.b] });
      }
      drawEllipse(builder, x, y, w, h);
      if (noFill) {
        builder.stroke();
      } else {
        builder.fillStroke();
      }
      break;

    case 'line':
      builder.moveTo(x, y + h);
      builder.lineTo(x + w, y);
      builder.stroke();
      break;

    case 'arrow': {
      const corner = annotation.startCorner || 'topLeft';
      drawArrow(builder, x, y, w, h, corner, strokeColor);
      break;
    }
  }

  builder.restoreState();
  return { contentBytes: builder.build(), resources };
}

/**
 * Draw an ellipse using 4 cubic bezier curves (kappa approximation).
 */
function drawEllipse(
  builder: ContentStreamBuilder,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  const k = 0.5523;
  const cx = x + w / 2;
  const cy = y + h / 2;
  const rx = w / 2;
  const ry = h / 2;
  const kx = rx * k;
  const ky = ry * k;

  builder.moveTo(cx, cy + ry);
  builder.curveTo(cx + kx, cy + ry, cx + rx, cy + ky, cx + rx, cy);
  builder.curveTo(cx + rx, cy - ky, cx + kx, cy - ry, cx, cy - ry);
  builder.curveTo(cx - kx, cy - ry, cx - rx, cy - ky, cx - rx, cy);
  builder.curveTo(cx - rx, cy + ky, cx - kx, cy + ry, cx, cy + ry);
  builder.closePath();
}

/**
 * Draw an arrow with direction determined by startCorner.
 * Fix #9: Supports all 4 corner-to-corner directions.
 */
function drawArrow(
  builder: ContentStreamBuilder,
  x: number,
  y: number,
  w: number,
  h: number,
  startCorner: 'topLeft' | 'topRight' | 'bottomLeft' | 'bottomRight',
  strokeColor: { r: number; g: number; b: number }
): void {
  // Map corners to PDF coordinates (y already converted to bottom-left origin)
  // In PDF coords: bottom-left = (x, y), top-right = (x+w, y+h)
  let x1: number, y1: number, x2: number, y2: number;

  switch (startCorner) {
    case 'topLeft':
      // Page top-left → PDF top-left = (x, y+h) → bottom-right = (x+w, y)
      x1 = x; y1 = y + h;
      x2 = x + w; y2 = y;
      break;
    case 'topRight':
      // Page top-right → PDF top-right = (x+w, y+h) → bottom-left = (x, y)
      x1 = x + w; y1 = y + h;
      x2 = x; y2 = y;
      break;
    case 'bottomLeft':
      // Page bottom-left → PDF bottom-left = (x, y) → top-right = (x+w, y+h)
      x1 = x; y1 = y;
      x2 = x + w; y2 = y + h;
      break;
    case 'bottomRight':
      // Page bottom-right → PDF bottom-right = (x+w, y) → top-left = (x, y+h)
      x1 = x + w; y1 = y;
      x2 = x; y2 = y + h;
      break;
  }

  // Draw the main line
  builder.moveTo(x1, y1);
  builder.lineTo(x2, y2);
  builder.stroke();

  // Calculate arrowhead at endpoint
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.min(15, Math.sqrt(w * w + h * h) * 0.2);
  const headAngle = Math.PI / 6;

  const ax1 = x2 - headLen * Math.cos(angle - headAngle);
  const ay1 = y2 - headLen * Math.sin(angle - headAngle);
  const ax2 = x2 - headLen * Math.cos(angle + headAngle);
  const ay2 = y2 - headLen * Math.sin(angle + headAngle);

  // Filled arrowhead triangle using stroke color as fill
  builder.setFillColor({ space: 'DeviceRGB', values: [strokeColor.r, strokeColor.g, strokeColor.b] });
  builder.moveTo(x2, y2);
  builder.lineTo(ax1, ay1);
  builder.lineTo(ax2, ay2);
  builder.closePath();
  builder.fill();
}

/**
 * Write a stamp annotation as a bordered rectangle with text.
 * Fix #4: Accepts measuredTextWidth from pipeline for accurate centering.
 */
function writeStamp(
  annotation: StampAnnotation,
  pageHeight: number,
  options?: WriteAnnotationOptions
): AnnotationWriteResult {
  const builder = new ContentStreamBuilder();
  const color = parseHexColor(annotation.color);
  const resources: ResourceRequirements = {
    extGStates: [],
    xObjects: [],
    fonts: [{ ref: null }],
  };

  const x = annotation.position.x;
  const y = pageHeight - annotation.position.y - annotation.size.height;
  const w = annotation.size.width;
  const h = annotation.size.height;

  builder.saveState();

  // Border rectangle
  builder.setStrokeColor({ space: 'DeviceRGB', values: [color.r, color.g, color.b] });
  builder.setLineWidth(2);
  builder.rectangle(x, y, w, h);
  builder.stroke();

  // Centered text
  builder.setFillColor({ space: 'DeviceRGB', values: [color.r, color.g, color.b] });
  builder.beginText();

  const fontSize = Math.min(16, h * 0.5);
  builder.setFont('__F_0__', fontSize);

  // Use measured width from font metrics if available, otherwise estimate
  const textWidth = options?.measuredTextWidth ?? (annotation.text.length * fontSize * 0.5);
  const textX = x + (w - textWidth) / 2;
  const textY = y + (h - fontSize) / 2 + fontSize * 0.2;

  builder.setTextMatrix({ a: 1, b: 0, c: 0, d: 1, e: textX, f: textY });
  builder.showText(annotation.text);
  builder.endText();

  builder.restoreState();
  return { contentBytes: builder.build(), resources };
}

/**
 * Write a sticky note annotation.
 * Fix #2: Returns metadata for the caller to create a proper PDF /Text annotation
 * with the note content, so the text is stored in the PDF (not just the visual marker).
 */
function writeStickyNote(
  annotation: StickyNoteAnnotation,
  pageHeight: number
): AnnotationWriteResult {
  const builder = new ContentStreamBuilder();
  const color = parseHexColor(annotation.color);
  const resources: ResourceRequirements = { extGStates: [], xObjects: [], fonts: [] };

  const markerSize = 24;
  const x = annotation.position.x;
  const pdfY = pageHeight - annotation.position.y - markerSize;

  builder.saveState();

  builder.setFillColor({ space: 'DeviceRGB', values: [color.r, color.g, color.b] });
  builder.setStrokeColor({ space: 'DeviceRGB', values: [0.4, 0.4, 0.4] });
  builder.setLineWidth(0.5);
  builder.rectangle(x, pdfY, markerSize, markerSize);
  builder.fillStroke();

  // "N" icon inside the marker
  builder.setFillColor({ space: 'DeviceRGB', values: [0.2, 0.2, 0.2] });
  builder.beginText();
  builder.setFont('__F_0__', 14);
  builder.setTextMatrix({ a: 1, b: 0, c: 0, d: 1, e: x + 6, f: pdfY + 6 });
  builder.showText('N');
  builder.endText();

  builder.restoreState();

  resources.fonts.push({ ref: null });

  return {
    contentBytes: builder.build(),
    resources,
    // Signal to pipeline that a PDF /Text annotation object is needed
    needsPdfAnnotation: annotation.content ? true : false,
    pdfAnnotationContent: annotation.content || '',
    pdfAnnotationRect: { x, y: pdfY, width: markerSize, height: markerSize },
    pdfAnnotationColor: color,
  };
}

/**
 * Write a text annotation using direct text operators.
 */
function writeTextAnnotation(
  annotation: TextAnnotation,
  pageHeight: number
): AnnotationWriteResult {
  const builder = new ContentStreamBuilder();
  const color = parseHexColor(annotation.color);
  const resources: ResourceRequirements = {
    extGStates: [],
    xObjects: [],
    fonts: [{ ref: null }],
  };

  builder.saveState();
  builder.setFillColor({ space: 'DeviceRGB', values: [color.r, color.g, color.b] });
  builder.beginText();

  builder.setFont('__F_0__', annotation.fontSize);

  const pdfX = annotation.position.x;
  const pdfY = pageHeight - annotation.position.y - annotation.fontSize;

  builder.setTextMatrix({ a: 1, b: 0, c: 0, d: 1, e: pdfX, f: pdfY });
  builder.showText(annotation.content);
  builder.endText();
  builder.restoreState();

  return { contentBytes: builder.build(), resources };
}

/**
 * Write an image annotation using XObject placement.
 */
function writeImageAnnotation(
  annotation: ImageAnnotation,
  pageHeight: number
): AnnotationWriteResult {
  const builder = new ContentStreamBuilder();
  const resources: ResourceRequirements = {
    extGStates: [],
    xObjects: [{ ref: null }],
    fonts: [],
  };

  const x = annotation.position.x;
  const y = pageHeight - annotation.position.y - annotation.size.height;
  const w = annotation.size.width;
  const h = annotation.size.height;

  builder.saveState();
  builder.setMatrix({ a: w, b: 0, c: 0, d: h, e: x, f: y });
  builder.drawXObject('__Im_0__');
  builder.restoreState();

  return { contentBytes: builder.build(), resources };
}

/**
 * Convert a single annotation to content stream bytes.
 * Returns the raw bytes, resource requirements, and optional PDF annotation metadata.
 */
export function writeAnnotation(
  annotation: Annotation,
  pageHeight: number,
  options?: WriteAnnotationOptions
): AnnotationWriteResult | null {
  switch (annotation.type) {
    case 'highlight':
      return writeHighlight(annotation, pageHeight);
    case 'drawing':
      return writeDrawing(annotation, pageHeight);
    case 'shape':
      return writeShape(annotation, pageHeight);
    case 'stamp':
      return writeStamp(annotation, pageHeight, options);
    case 'note':
      return writeStickyNote(annotation, pageHeight);
    case 'text':
      return writeTextAnnotation(annotation, pageHeight);
    case 'image':
      return writeImageAnnotation(annotation, pageHeight);
    default:
      return null;
  }
}
