/**
 * Geometry primitives for the redaction engine.
 *
 * Matrices follow the PDF convention [a b c d e f] with row vectors:
 *   x' = a*x + c*y + e
 *   y' = b*x + d*y + f
 * `multiply(m1, m2)` returns the matrix that applies m1 FIRST, then m2 — the
 * same order the PDF spec uses for `CTM' = M × CTM` when `cm` is executed.
 *
 * Rects are axis-aligned boxes in PDF user space (origin bottom-left) stored as
 * normalized corners so intersection math never has to care about sign.
 */

export type Matrix = [number, number, number, number, number, number];

export interface Point {
  x: number;
  y: number;
}

export interface Rect {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
}

export const IDENTITY: Matrix = [1, 0, 0, 1, 0, 0];

export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return [
    m1[0] * m2[0] + m1[1] * m2[2],
    m1[0] * m2[1] + m1[1] * m2[3],
    m1[2] * m2[0] + m1[3] * m2[2],
    m1[2] * m2[1] + m1[3] * m2[3],
    m1[4] * m2[0] + m1[5] * m2[2] + m2[4],
    m1[4] * m2[1] + m1[5] * m2[3] + m2[5],
  ];
}

export function applyToPoint(m: Matrix, x: number, y: number): Point {
  return { x: m[0] * x + m[2] * y + m[4], y: m[1] * x + m[3] * y + m[5] };
}

export function invert(m: Matrix): Matrix | null {
  const det = m[0] * m[3] - m[1] * m[2];
  if (!Number.isFinite(det) || Math.abs(det) < 1e-12) return null;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}

export function normalizeRect(x0: number, y0: number, x1: number, y1: number): Rect {
  return {
    x0: Math.min(x0, x1),
    y0: Math.min(y0, y1),
    x1: Math.max(x0, x1),
    y1: Math.max(y0, y1),
  };
}

export function rectFromXYWH(r: { x: number; y: number; width: number; height: number }): Rect {
  return normalizeRect(r.x, r.y, r.x + r.width, r.y + r.height);
}

export function rectToXYWH(r: Rect): { x: number; y: number; width: number; height: number } {
  return { x: r.x0, y: r.y0, width: r.x1 - r.x0, height: r.y1 - r.y0 };
}

/** Bounding box of a set of points. */
export function boundsOfPoints(points: Point[]): Rect | null {
  if (points.length === 0) return null;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of points) {
    if (p.x < x0) x0 = p.x;
    if (p.y < y0) y0 = p.y;
    if (p.x > x1) x1 = p.x;
    if (p.y > y1) y1 = p.y;
  }
  return { x0, y0, x1, y1 };
}

/** Axis-aligned bounds of a rect after transforming its four corners by `m`. */
export function transformRect(m: Matrix, r: Rect): Rect {
  return boundsOfPoints([
    applyToPoint(m, r.x0, r.y0),
    applyToPoint(m, r.x1, r.y0),
    applyToPoint(m, r.x0, r.y1),
    applyToPoint(m, r.x1, r.y1),
  ])!;
}

export function unionRect(a: Rect | null, b: Rect): Rect {
  if (!a) return { ...b };
  return {
    x0: Math.min(a.x0, b.x0),
    y0: Math.min(a.y0, b.y0),
    x1: Math.max(a.x1, b.x1),
    y1: Math.max(a.y1, b.y1),
  };
}

export function intersection(a: Rect, b: Rect): Rect | null {
  const x0 = Math.max(a.x0, b.x0);
  const y0 = Math.max(a.y0, b.y0);
  const x1 = Math.min(a.x1, b.x1);
  const y1 = Math.min(a.y1, b.y1);
  if (x1 <= x0 || y1 <= y0) return null;
  return { x0, y0, x1, y1 };
}

/** True when the two rects overlap with strictly positive area. */
export function intersects(a: Rect, b: Rect): boolean {
  return Math.min(a.x1, b.x1) > Math.max(a.x0, b.x0) && Math.min(a.y1, b.y1) > Math.max(a.y0, b.y0);
}

export function intersectsAny(r: Rect, marks: Rect[]): boolean {
  for (const m of marks) if (intersects(r, m)) return true;
  return false;
}

/** Strict containment with an inward tolerance `eps` (points on the boundary are outside). */
export function pointInRect(p: Point, r: Rect, eps = 0): boolean {
  return p.x > r.x0 + eps && p.x < r.x1 - eps && p.y > r.y0 + eps && p.y < r.y1 - eps;
}

export function pointInAny(p: Point, marks: Rect[], eps = 0): boolean {
  for (const m of marks) if (pointInRect(p, m, eps)) return true;
  return false;
}

export function insetRect(r: Rect, dx: number, dy: number = dx): Rect {
  return { x0: r.x0 + dx, y0: r.y0 + dy, x1: r.x1 - dx, y1: r.y1 - dy };
}

export function expandRect(r: Rect, d: number): Rect {
  return { x0: r.x0 - d, y0: r.y0 - d, x1: r.x1 + d, y1: r.y1 + d };
}

export function rectArea(r: Rect): number {
  return Math.max(0, r.x1 - r.x0) * Math.max(0, r.y1 - r.y0);
}

/** Format a number for a content stream: finite, no exponent, trimmed. */
export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 10000) / 10000;
  if (Object.is(rounded, -0)) return '0';
  let s = rounded.toFixed(4);
  s = s.replace(/\.?0+$/, '');
  return s === '' || s === '-' ? '0' : s;
}

/**
 * Smallest redaction mark (in points, both width and height) the engine
 * accepts. The verifier insets every mark by a fraction of its own size and
 * tests glyph centres, path segments and pixels against what remains; a mark
 * below this size has (almost) no interior, so every check would pass without
 * testing anything. Marks this small are refused, never silently passed.
 */
export const MIN_MARK_SIZE = 1;

export function markTooSmall(r: Rect): boolean {
  return !(r.x1 - r.x0 >= MIN_MARK_SIZE && r.y1 - r.y0 >= MIN_MARK_SIZE);
}

/** Grow `r` about its centre so each side is at least `min` long (never shrinks). */
export function padToMinSize(r: Rect, min: number = MIN_MARK_SIZE): Rect {
  const w = r.x1 - r.x0;
  const h = r.y1 - r.y0;
  const dx = w < min ? (min - w) / 2 : 0;
  const dy = h < min ? (min - h) / 2 : 0;
  return { x0: r.x0 - dx, y0: r.y0 - dy, x1: r.x1 + dx, y1: r.y1 + dy };
}

/**
 * Tolerance-shrunk copy of a mark for verification: the inset is capped at a
 * quarter of the mark's smaller side, so the result always keeps a non-empty
 * interior (a fixed inset would invert any mark narrower than twice it).
 */
export function verificationCore(r: Rect, inset = 0.5): Rect {
  const d = Math.min(inset, Math.min(r.x1 - r.x0, r.y1 - r.y0) / 4);
  return insetRect(r, Math.max(0, d));
}

/** Number of line segments a cubic Bezier is flattened into for intersection tests. */
export const BEZIER_STEPS = 16;

/**
 * Points of a cubic Bezier p0..p3 (excluding p0), flattened to BEZIER_STEPS
 * segments. Affine maps preserve Beziers, so flattening after the CTM is exact
 * up to the flattening error, which is far below a point for page-sized curves.
 */
export function flattenCubic(p0: Point, p1: Point, p2: Point, p3: Point, steps = BEZIER_STEPS): Point[] {
  const out: Point[] = [];
  for (let i = 1; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
    out.push({ x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y });
  }
  return out;
}

/**
 * True when segment a-b has any point strictly inside `r` (Liang-Barsky
 * clipping against the open rectangle). A segment that only runs along the
 * boundary is outside, matching pointInRect.
 */
export function segmentIntersectsRect(a: Point, b: Point, r: Rect): boolean {
  if (!(r.x1 > r.x0 && r.y1 > r.y0)) return false;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  let t0 = 0;
  let t1 = 1;
  const clip = (p: number, q: number): boolean => {
    if (p === 0) return q > 0;
    const t = q / p;
    if (p < 0) {
      if (t > t1) return false;
      if (t > t0) t0 = t;
    } else {
      if (t < t0) return false;
      if (t < t1) t1 = t;
    }
    return true;
  };
  if (!clip(-dx, a.x - r.x0) || !clip(dx, r.x1 - a.x) || !clip(-dy, a.y - r.y0) || !clip(dy, r.y1 - a.y)) return false;
  if (t0 > t1) return false;
  // The clipped piece may be a single boundary point; test its midpoint strictly.
  const mid = (t0 + t1) / 2;
  return pointInRect({ x: a.x + dx * mid, y: a.y + dy * mid }, r);
}

/** True when the polyline (consecutive points; a single point is tested as a point) enters any rect. */
export function polylineIntersectsAny(points: Point[], rects: Rect[]): boolean {
  if (points.length === 1) return pointInAny(points[0], rects);
  for (let i = 1; i < points.length; i++) {
    for (const r of rects) if (segmentIntersectsRect(points[i - 1], points[i], r)) return true;
  }
  return false;
}
