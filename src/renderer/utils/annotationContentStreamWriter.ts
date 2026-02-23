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
  // Try rgba() format first
  const rgbaMatch = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\s*\)/i.exec(color);
  if (rgbaMatch) {
    return {
      r: parseInt(rgbaMatch[1]) / 255,
      g: parseInt(rgbaMatch[2]) / 255,
      b: parseInt(rgbaMatch[3]) / 255,
      a: rgbaMatch[4] !== undefined ? parseFloat(rgbaMatch[4]) : 1,
    };
  }

  // Fall back to hex
  const hex = parseHexColor(color);
  return { ...hex, a: 1 };
}

/**
 * Write a highlight annotation as transparent filled rectangles.
 *
 * Requires ExtGState for fill opacity (`ca` operator).
 */
function writeHighlight(
  annotation: HighlightAnnotation,
  pageHeight: number
): AnnotationWriteResult {
  const builder = new ContentStreamBuilder();
  const color = parseColor(annotation.color);
  const opacity = color.a < 1 ? color.a : 0.35; // Default highlight transparency

  const resources: ResourceRequirements = {
    extGStates: [{ fillOpacity: opacity }],
    xObjects: [],
    fonts: [],
  };

  builder.saveState();

  // ExtGState will be set by caller-assigned name via placeholder index 0
  // The name gets patched in by writeAnnotationsToContentStream()
  builder.setExtGState('__GS_0__');

  builder.setFillColor({ space: 'DeviceRGB', values: [color.r, color.g, color.b] });

  for (const rect of annotation.rects) {
    // Convert from page coords (top-left origin) to PDF coords (bottom-left origin)
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
  builder.setLineCap(1); // Round cap for smooth freehand appearance

  for (const path of annotation.paths) {
    if (path.points.length < 2) continue;

    const color = parseHexColor(path.color);
    builder.setStrokeColor({ space: 'DeviceRGB', values: [color.r, color.g, color.b] });
    builder.setLineWidth(path.width);

    // First point - moveTo
    const first = path.points[0];
    builder.moveTo(first.x, pageHeight - first.y);

    // Subsequent points - lineTo
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
 */
function writeShape(
  annotation: ShapeAnnotation,
  pageHeight: number
): AnnotationWriteResult {
  const builder = new ContentStreamBuilder();
  const resources: ResourceRequirements = { extGStates: [], xObjects: [], fonts: [] };

  const strokeColor = parseHexColor(annotation.strokeColor);
  const fillColor = parseHexColor(annotation.fillColor);
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
  builder.setFillColor({ space: 'DeviceRGB', values: [fillColor.r, fillColor.g, fillColor.b] });
  builder.setLineWidth(annotation.strokeWidth);

  // Convert position from page coords to PDF coords
  const x = annotation.position.x;
  const y = pageHeight - annotation.position.y - annotation.size.height;
  const w = annotation.size.width;
  const h = annotation.size.height;

  switch (annotation.shapeType) {
    case 'rectangle':
      builder.rectangle(x, y, w, h);
      if (fillColor.r !== 1 || fillColor.g !== 1 || fillColor.b !== 1) {
        builder.fillStroke(); // Fill + stroke
      } else {
        builder.stroke(); // Stroke only for transparent/white fill
      }
      break;

    case 'ellipse':
      drawEllipse(builder, x, y, w, h);
      if (fillColor.r !== 1 || fillColor.g !== 1 || fillColor.b !== 1) {
        builder.fillStroke();
      } else {
        builder.stroke();
      }
      break;

    case 'line':
      // Line from top-left to bottom-right of the bounding box
      builder.moveTo(x, y + h); // Top-left in PDF coords
      builder.lineTo(x + w, y); // Bottom-right in PDF coords
      builder.stroke();
      break;

    case 'arrow':
      drawArrow(builder, x, y, w, h);
      break;
  }

  builder.restoreState();

  return { contentBytes: builder.build(), resources };
}

/**
 * Draw an ellipse using 4 cubic bezier curves (kappa approximation).
 * k = 0.5523 is the standard approximation for a quarter-circle.
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

  // Start at top of ellipse
  builder.moveTo(cx, cy + ry);

  // Top to right
  builder.curveTo(cx + kx, cy + ry, cx + rx, cy + ky, cx + rx, cy);

  // Right to bottom
  builder.curveTo(cx + rx, cy - ky, cx + kx, cy - ry, cx, cy - ry);

  // Bottom to left
  builder.curveTo(cx - kx, cy - ry, cx - rx, cy - ky, cx - rx, cy);

  // Left to top
  builder.curveTo(cx - rx, cy + ky, cx - kx, cy + ry, cx, cy + ry);

  builder.closePath();
}

/**
 * Draw an arrow: line from start to end with a filled triangle arrowhead.
 */
function drawArrow(
  builder: ContentStreamBuilder,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  // Line from top-left to bottom-right of bounding box (in PDF coords)
  const x1 = x;
  const y1 = y + h;
  const x2 = x + w;
  const y2 = y;

  // Draw the main line
  builder.moveTo(x1, y1);
  builder.lineTo(x2, y2);
  builder.stroke();

  // Calculate arrowhead at endpoint (x2, y2)
  const angle = Math.atan2(y2 - y1, x2 - x1);
  const headLen = Math.min(15, Math.sqrt(w * w + h * h) * 0.2);
  const headAngle = Math.PI / 6; // 30 degrees

  const ax1 = x2 - headLen * Math.cos(angle - headAngle);
  const ay1 = y2 - headLen * Math.sin(angle - headAngle);
  const ax2 = x2 - headLen * Math.cos(angle + headAngle);
  const ay2 = y2 - headLen * Math.sin(angle + headAngle);

  // Draw filled arrowhead triangle
  builder.moveTo(x2, y2);
  builder.lineTo(ax1, ay1);
  builder.lineTo(ax2, ay2);
  builder.closePath();
  builder.fill();
}

/**
 * Write a stamp annotation as a bordered rectangle with text.
 * Requires a font resource.
 */
function writeStamp(
  annotation: StampAnnotation,
  pageHeight: number
): AnnotationWriteResult {
  const builder = new ContentStreamBuilder();
  const color = parseHexColor(annotation.color);
  const resources: ResourceRequirements = {
    extGStates: [],
    xObjects: [],
    fonts: [{ ref: null }], // Font ref will be assigned by caller
  };

  const x = annotation.position.x;
  const y = pageHeight - annotation.position.y - annotation.size.height;
  const w = annotation.size.width;
  const h = annotation.size.height;

  builder.saveState();

  // Draw border rectangle
  builder.setStrokeColor({ space: 'DeviceRGB', values: [color.r, color.g, color.b] });
  builder.setLineWidth(2);
  builder.rectangle(x, y, w, h);
  builder.stroke();

  // Draw text centered in the rectangle
  builder.setFillColor({ space: 'DeviceRGB', values: [color.r, color.g, color.b] });
  builder.beginText();

  const fontSize = Math.min(16, h * 0.5);
  builder.setFont('__F_0__', fontSize);

  // Approximate text centering: estimate text width
  const approxTextWidth = annotation.text.length * fontSize * 0.5;
  const textX = x + (w - approxTextWidth) / 2;
  const textY = y + (h - fontSize) / 2 + fontSize * 0.2; // Slight vertical adjust for baseline

  builder.setTextMatrix({ a: 1, b: 0, c: 0, d: 1, e: textX, f: textY });
  builder.showText(annotation.text);
  builder.endText();

  builder.restoreState();

  return { contentBytes: builder.build(), resources };
}

/**
 * Write a sticky note annotation.
 * Renders a small colored square as a visual marker in the content stream.
 * The actual note text is added as a PDF /Text annotation object separately.
 */
function writeStickyNote(
  annotation: StickyNoteAnnotation,
  pageHeight: number
): AnnotationWriteResult {
  const builder = new ContentStreamBuilder();
  const color = parseHexColor(annotation.color);
  const resources: ResourceRequirements = { extGStates: [], xObjects: [], fonts: [] };

  // Draw a small colored square (24x24) as visual marker
  const markerSize = 24;
  const x = annotation.position.x;
  const y = pageHeight - annotation.position.y - markerSize;

  builder.saveState();

  builder.setFillColor({ space: 'DeviceRGB', values: [color.r, color.g, color.b] });
  builder.setStrokeColor({ space: 'DeviceRGB', values: [0.4, 0.4, 0.4] });
  builder.setLineWidth(0.5);
  builder.rectangle(x, y, markerSize, markerSize);
  builder.fillStroke();

  // Draw a small "N" icon inside to indicate it's a note
  builder.setFillColor({ space: 'DeviceRGB', values: [0.2, 0.2, 0.2] });
  builder.beginText();
  builder.setFont('__F_0__', 14);
  builder.setTextMatrix({ a: 1, b: 0, c: 0, d: 1, e: x + 6, f: y + 6 });
  builder.showText('N');
  builder.endText();

  builder.restoreState();

  // Flag that this needs a font
  resources.fonts.push({ ref: null });

  return { contentBytes: builder.build(), resources };
}

/**
 * Write a text annotation using direct text operators.
 * Replaces pdfPage.drawText().
 * Requires a font resource.
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
    fonts: [{ ref: null }], // Font ref will be assigned by caller
  };

  builder.saveState();
  builder.setFillColor({ space: 'DeviceRGB', values: [color.r, color.g, color.b] });
  builder.beginText();

  builder.setFont('__F_0__', annotation.fontSize);

  // Convert from page coords to PDF coords
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
 * The image must already be embedded in the PDF document; we just reference it.
 * Requires an XObject resource.
 */
function writeImageAnnotation(
  annotation: ImageAnnotation,
  pageHeight: number
): AnnotationWriteResult {
  const builder = new ContentStreamBuilder();
  const resources: ResourceRequirements = {
    extGStates: [],
    xObjects: [{ ref: null }], // XObject ref will be assigned by caller
    fonts: [],
  };

  const x = annotation.position.x;
  const y = pageHeight - annotation.position.y - annotation.size.height;
  const w = annotation.size.width;
  const h = annotation.size.height;

  builder.saveState();
  // Image placement: cm matrix scales and positions the XObject
  // [width 0 0 height x y] cm
  builder.setMatrix({ a: w, b: 0, c: 0, d: h, e: x, f: y });
  builder.drawXObject('__Im_0__');
  builder.restoreState();

  return { contentBytes: builder.build(), resources };
}

/**
 * Convert a single annotation to content stream bytes.
 * Returns the raw bytes and resource requirements that must be registered on the page.
 */
export function writeAnnotation(
  annotation: Annotation,
  pageHeight: number
): AnnotationWriteResult | null {
  switch (annotation.type) {
    case 'highlight':
      return writeHighlight(annotation, pageHeight);
    case 'drawing':
      return writeDrawing(annotation, pageHeight);
    case 'shape':
      return writeShape(annotation, pageHeight);
    case 'stamp':
      return writeStamp(annotation, pageHeight);
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
