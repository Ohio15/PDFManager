/**
 * annotationBounds — PDF user-space footprints of pending (unflattened)
 * annotations, used to decide which of them sit under a redaction mark.
 *
 * Security property (fail CLOSED): `isUnderAnyMark` answers "true" whenever a
 * footprint cannot be computed (unknown type, empty geometry, non-finite
 * numbers, a throw). An annotation we cannot place is never kept next to a
 * redaction, because it may carry the redacted text (textMarkup /Contents,
 * note /Contents, typed text) into the saved file.
 *
 * Coordinate spaces
 * - textMarkup quads and redaction rects are already PDF user space
 *   (MarkupRedactionLayer converts with viewport.convertToPdfPoint), so they
 *   are used as-is on every rotation.
 * - Every other type is stored in model space: top-left origin of the VISIBLE
 *   box (CropBox ∩ MediaBox, pageStructure.visiblePageBox). Two placements
 *   are produced for each and BOTH are tested against the marks:
 *     saved     where pdfSavePipeline + annotationContentStreamWriter write
 *               it: x' = box.x + x, y' = box.y + box.height - y - h. The
 *               pipeline does not rotate annotation geometry.
 *     displayed where the user sees it: the pdf.js viewport transform
 *               (pageViewport.createViewportTransform) for the page's
 *               /Rotate, mapping model space back to user space.
 *   On /Rotate 0 the two are identical; on 90/180/270 they differ (the save
 *   pipeline ignores rotation for annotations), so testing both keeps the
 *   decision correct for what is drawn on screen AND what lands in the file.
 */
import { FontNames } from '@pdf-lib/standard-fonts';
import type { Annotation, PdfRect } from '../types';
import type { PdfBox } from './pageStructure';
import { createViewportTransform } from './pageViewport';
import { measureTextWidth } from './standardFontMetrics';
import { intersects } from './redaction/geometry';

export interface AnnotationPageFrame {
  /** Visible box (CropBox ∩ MediaBox) in user space, exactly as pageStructure.visiblePageBox returns it. */
  box: PdfBox;
  /** Page /Rotate in degrees (normalised internally). */
  rotation: number;
}

/** Axis-aligned rectangle in model space (top-left origin of the visible box). */
export interface ModelRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Sticky-note marker edge, annotationContentStreamWriter.writeStickyNote. */
const NOTE_MARKER_SIZE = 24;
/** Sticky-note marker border line width, annotationContentStreamWriter.writeStickyNote. */
const NOTE_BORDER_WIDTH = 0.5;
/** Stamp border line width, annotationContentStreamWriter.writeStamp. */
const STAMP_BORDER_WIDTH = 2;
/** Line advance used for typed text when no explicit size exists. */
const TEXT_LINE_FACTOR = 1.4;
/** Courier advance per em: an upper bound for proportional fonts' average glyph. */
const MONO_ADVANCE = 0.6;

const finite = (...values: number[]) => values.every(Number.isFinite);

function inflate(r: ModelRect, pad: number): ModelRect {
  return { x: r.x - pad, y: r.y - pad, w: r.w + 2 * pad, h: r.h + 2 * pad };
}

function bboxOfPoints(points: Array<[number, number]>): PdfRect {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

/** Width of `text` in the font the save pipeline writes with (Helvetica), never below a mono estimate. */
function textWidth(text: string, fontSize: number): number {
  return Math.max(measureTextWidth(text, FontNames.Helvetica, fontSize), text.length * fontSize * MONO_ADVANCE);
}

/**
 * Model-space rectangles covering what the save pipeline paints for `a`
 * (and what the editor shows). Returns null when the geometry is unusable.
 */
function modelRects(a: Annotation): ModelRect[] | null {
  switch (a.type) {
    case 'text': {
      const { x, y } = a.position;
      const lines = a.content.split(/\r\n|\r|\n/);
      // The writer emits the whole content on one baseline at y + fontSize;
      // the editor may wrap it. Cover both: widest of (single line, any line,
      // explicit size) by tallest of (all lines, explicit size).
      const width = Math.max(a.size?.width ?? 0, textWidth(a.content, a.fontSize), ...lines.map((l) => textWidth(l, a.fontSize)));
      const height = Math.max(a.size?.height ?? 0, lines.length * a.fontSize * TEXT_LINE_FACTOR);
      return [{ x, y, w: width, h: height }];
    }
    case 'image':
      return [{ x: a.position.x, y: a.position.y, w: a.size.width, h: a.size.height }];
    case 'shape': {
      const r = { x: a.position.x, y: a.position.y, w: a.size.width, h: a.size.height };
      // Arrowheads reach up to headLen beyond the shaft (writer: min(15, 0.2·diag)).
      const head = a.shapeType === 'arrow' ? Math.min(15, Math.hypot(r.w, r.h) * 0.2) : 0;
      return [inflate(r, Math.abs(a.strokeWidth) / 2 + head)];
    }
    case 'stamp': {
      const { x, y } = a.position;
      const { width: w, height: h } = a.size;
      // Border box plus the centred text line, which can overflow it
      // horizontally (writer: fontSize = min(16, h/2), x = x + (w - tw)/2).
      const fontSize = Math.min(16, h * 0.5);
      const tw = textWidth(a.text, fontSize);
      return [inflate({ x, y, w, h }, STAMP_BORDER_WIDTH / 2), { x: x + (w - tw) / 2, y, w: tw, h }];
    }
    case 'note':
      return [inflate({ x: a.position.x, y: a.position.y, w: NOTE_MARKER_SIZE, h: NOTE_MARKER_SIZE }, NOTE_BORDER_WIDTH / 2)];
    case 'highlight':
      return a.rects.map((r) => ({ x: r.x, y: r.y, w: r.width, h: r.height }));
    case 'drawing': {
      const out: ModelRect[] = [];
      for (const path of a.paths) {
        if (!path.points.length) continue;
        const xs = path.points.map((p) => p.x);
        const ys = path.points.map((p) => p.y);
        const x = Math.min(...xs);
        const y = Math.min(...ys);
        out.push(inflate({ x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }, Math.abs(path.width) / 2));
      }
      return out;
    }
    default:
      return null;
  }
}

/** Where pdfSavePipeline writes a model rect: visible-box offset, y flipped against the visible height, no rotation. */
export function savedRectToPdf(r: ModelRect, box: PdfBox): PdfRect {
  return bboxOfPoints([
    [box.x + r.x, box.y + box.height - r.y],
    [box.x + r.x + r.w, box.y + box.height - r.y - r.h],
  ]);
}

export interface AnnotationPlacements {
  /** Where the save pipeline writes the annotation (user space). */
  saved: PdfRect[];
  /** Where the editor displays it, mapped back through the pdf.js viewport (user space). */
  displayed: PdfRect[];
}

/**
 * Saved and displayed placements of `a` on a page with `frame`, or null when
 * they cannot be computed. For textMarkup and redaction (already user space)
 * both lists are the same rectangles. Every rectangle is finite and
 * normalised (x0 <= x1, y0 <= y1).
 */
export function annotationPlacements(a: Annotation, frame: AnnotationPageFrame): AnnotationPlacements | null {
  const { box } = frame;
  if (!finite(box.x, box.y, box.width, box.height, frame.rotation) || box.width <= 0 || box.height <= 0) return null;

  let saved: PdfRect[];
  let displayed: PdfRect[];
  if (a.type === 'textMarkup') {
    // Any malformed quad voids the whole annotation: the writer would drop it
    // and still write the remaining quads plus the full /Contents text.
    if (!a.quads.length || a.quads.some((q) => q.length !== 8 || !finite(...q))) return null;
    saved = displayed = a.quads.map((q) => bboxOfPoints([[q[0], q[1]], [q[2], q[3]], [q[4], q[5]], [q[6], q[7]]]));
  } else if (a.type === 'redaction') {
    if (!a.rects.length) return null;
    saved = displayed = a.rects.map((r) => bboxOfPoints([[r.x0, r.y0], [r.x1, r.y1]]));
  } else {
    const model = modelRects(a);
    if (!model || !model.length || model.some((r) => !finite(r.x, r.y, r.w, r.h))) return null;
    const view: [number, number, number, number] = [box.x, box.y, box.x + box.width, box.y + box.height];
    const viewport = createViewportTransform(view, frame.rotation, 1);
    saved = model.map((r) => savedRectToPdf(r, box));
    displayed = model.map((r) =>
      bboxOfPoints([
        viewport.toPdf(r.x, r.y),
        viewport.toPdf(r.x + r.w, r.y),
        viewport.toPdf(r.x, r.y + r.h),
        viewport.toPdf(r.x + r.w, r.y + r.h),
      ])
    );
  }
  const ok = (rs: PdfRect[]) => rs.every((r) => finite(r.x0, r.y0, r.x1, r.y1));
  return ok(saved) && ok(displayed) ? { saved, displayed } : null;
}

/** All user-space footprints of `a` (saved and displayed), or null when they cannot be computed. */
export function annotationFootprints(a: Annotation, frame: AnnotationPageFrame): PdfRect[] | null {
  const p = annotationPlacements(a, frame);
  return p ? [...p.saved, ...p.displayed] : null;
}

/** A zero-width or zero-height footprint (a straight line) still marks the page; give it a hair of area. */
function touches(r: PdfRect, mark: PdfRect): boolean {
  const e = 1e-6;
  return intersects({ x0: r.x0 - e, y0: r.y0 - e, x1: Math.max(r.x1, r.x0) + e, y1: Math.max(r.y1, r.y0) + e }, mark);
}

/**
 * True when `a` overlaps any of `marks`, OR when its footprint cannot be
 * computed (fail closed). With no marks nothing is under a mark.
 */
export function isUnderAnyMark(a: Annotation, frame: AnnotationPageFrame, marks: readonly PdfRect[]): boolean {
  if (!marks.length) return false;
  let rects: PdfRect[] | null;
  try {
    rects = annotationFootprints(a, frame);
  } catch {
    rects = null;
  }
  if (!rects) return true;
  return rects.some((r) => marks.some((m) => touches(r, m)));
}

/** Split a page's pending annotations into those kept and those removed by applying `marks`. */
export function partitionByMarks<T extends Annotation>(
  annotations: readonly T[],
  frame: AnnotationPageFrame,
  marks: readonly PdfRect[]
): { kept: T[]; removed: T[] } {
  const kept: T[] = [];
  const removed: T[] = [];
  for (const a of annotations) (isUnderAnyMark(a, frame, marks) ? removed : kept).push(a);
  return { kept, removed };
}
