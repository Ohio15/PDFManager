import React, { useRef, useCallback, useEffect, useState } from 'react';
import { X, Trash2, Check, Sparkles } from 'lucide-react';

interface SignaturePadProps {
  anchorX: number;
  anchorY: number;
  scale: number;
  penColor: string;
  penWidth: number;
  onApply: (dataUrl: string, bounds: { width: number; height: number }) => void;
  onCancel: () => void;
}

interface StrokePoint {
  x: number;
  y: number;
  pressure: number;
}

interface Stroke {
  points: StrokePoint[];
  color: string;
  baseWidth: number;
}

// ── Ramer-Douglas-Peucker simplification ──────────────────────────────
function perpendicularDistance(point: StrokePoint, lineStart: StrokePoint, lineEnd: StrokePoint): number {
  const dx = lineEnd.x - lineStart.x;
  const dy = lineEnd.y - lineStart.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq === 0) return Math.hypot(point.x - lineStart.x, point.y - lineStart.y);
  const t = Math.max(0, Math.min(1, ((point.x - lineStart.x) * dx + (point.y - lineStart.y) * dy) / lenSq));
  const projX = lineStart.x + t * dx;
  const projY = lineStart.y + t * dy;
  return Math.hypot(point.x - projX, point.y - projY);
}

function rdpSimplify(points: StrokePoint[], epsilon: number): StrokePoint[] {
  if (points.length <= 2) return points;

  let maxDist = 0;
  let maxIdx = 0;
  const first = points[0];
  const last = points[points.length - 1];

  for (let i = 1; i < points.length - 1; i++) {
    const dist = perpendicularDistance(points[i], first, last);
    if (dist > maxDist) {
      maxDist = dist;
      maxIdx = i;
    }
  }

  if (maxDist > epsilon) {
    const left = rdpSimplify(points.slice(0, maxIdx + 1), epsilon);
    const right = rdpSimplify(points.slice(maxIdx), epsilon);
    return [...left.slice(0, -1), ...right];
  }

  // Interpolate pressure for the simplified segment
  return [first, last];
}

// ── Cubic bezier curve fitting ────────────────────────────────────────
// Attempt least-squares fit of a cubic bezier to a set of points.
// Returns 4 control points [P0, P1, P2, P3].
interface BezierPoint { x: number; y: number }

function fitCubicBezier(points: StrokePoint[]): BezierPoint[] {
  const n = points.length;
  if (n <= 2) return points.map(p => ({ x: p.x, y: p.y }));

  const P0 = points[0];
  const P3 = points[n - 1];

  // Parameterize by chord length
  const chordLengths = [0];
  for (let i = 1; i < n; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    chordLengths.push(chordLengths[i - 1] + Math.hypot(dx, dy));
  }
  const totalLen = chordLengths[n - 1];
  if (totalLen === 0) return [P0, P0, P3, P3];
  const t = chordLengths.map(l => l / totalLen);

  // Compute tangent vectors at endpoints
  const tHat1 = normalize({ x: points[1].x - P0.x, y: points[1].y - P0.y });
  const tHat2 = normalize({ x: points[n - 2].x - P3.x, y: points[n - 2].y - P3.y });

  // Solve for alpha1, alpha2 using least squares
  // P(t) = (1-t)^3 P0 + 3(1-t)^2 t P1 + 3(1-t) t^2 P2 + t^3 P3
  // P1 = P0 + alpha1 * tHat1, P2 = P3 + alpha2 * tHat2
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;

  for (let i = 1; i < n - 1; i++) {
    const ti = t[i];
    const b1 = 3 * ti * (1 - ti) * (1 - ti); // basis for P1
    const b2 = 3 * ti * ti * (1 - ti);        // basis for P2
    const a1x = tHat1.x * b1;
    const a1y = tHat1.y * b1;
    const a2x = tHat2.x * b2;
    const a2y = tHat2.y * b2;

    c00 += a1x * a1x + a1y * a1y;
    c01 += a1x * a2x + a1y * a2y;
    c11 += a2x * a2x + a2y * a2y;

    const b0 = (1 - ti) * (1 - ti) * (1 - ti);
    const b3 = ti * ti * ti;
    const tmpX = points[i].x - (b0 * P0.x + b3 * P3.x);
    const tmpY = points[i].y - (b0 * P0.y + b3 * P3.y);

    x0 += a1x * tmpX + a1y * tmpY;
    x1 += a2x * tmpX + a2y * tmpY;
  }

  const det = c00 * c11 - c01 * c01;
  let alpha1: number, alpha2: number;
  if (Math.abs(det) < 1e-12) {
    const dist = Math.hypot(P3.x - P0.x, P3.y - P0.y) / 3;
    alpha1 = dist;
    alpha2 = dist;
  } else {
    alpha1 = (c11 * x0 - c01 * x1) / det;
    alpha2 = (c00 * x1 - c01 * x0) / det;
  }

  // Guard against negative or crazy alphas
  const segLen = Math.hypot(P3.x - P0.x, P3.y - P0.y);
  if (alpha1 < 1e-6 || alpha1 > segLen * 2) alpha1 = segLen / 3;
  if (alpha2 < 1e-6 || Math.abs(alpha2) > segLen * 2) alpha2 = segLen / 3;

  return [
    { x: P0.x, y: P0.y },
    { x: P0.x + alpha1 * tHat1.x, y: P0.y + alpha1 * tHat1.y },
    { x: P3.x + alpha2 * tHat2.x, y: P3.y + alpha2 * tHat2.y },
    { x: P3.x, y: P3.y },
  ];
}

function normalize(v: BezierPoint): BezierPoint {
  const len = Math.hypot(v.x, v.y);
  return len < 1e-12 ? { x: 1, y: 0 } : { x: v.x / len, y: v.y / len };
}

// Split a stroke into segments at corners (sharp angle changes), fit beziers to each
function smoothStroke(stroke: Stroke, epsilon: number): { beziers: BezierPoint[][]; pressures: number[]; color: string; baseWidth: number } {
  const simplified = rdpSimplify(stroke.points, epsilon);

  // Average pressure per simplified segment for width
  const pressures: number[] = [];
  for (const pt of simplified) {
    pressures.push(pt.pressure);
  }

  // Split into segments at sharp corners (> 90 degree direction change)
  const segments: StrokePoint[][] = [];
  let current: StrokePoint[] = [simplified[0]];

  for (let i = 1; i < simplified.length; i++) {
    current.push(simplified[i]);

    if (i < simplified.length - 1 && current.length >= 2) {
      const prev = simplified[i - 1];
      const curr = simplified[i];
      const next = simplified[i + 1];
      const dx1 = curr.x - prev.x, dy1 = curr.y - prev.y;
      const dx2 = next.x - curr.x, dy2 = next.y - curr.y;
      const dot = dx1 * dx2 + dy1 * dy2;
      const cross = dx1 * dy2 - dy1 * dx2;
      const angle = Math.abs(Math.atan2(cross, dot));
      if (angle > Math.PI * 0.55) { // ~100 degree threshold
        segments.push(current);
        current = [simplified[i]];
      }
    }
  }
  if (current.length >= 2) segments.push(current);

  // Fit cubic bezier to each segment
  const beziers: BezierPoint[][] = [];
  for (const seg of segments) {
    if (seg.length <= 1) continue;
    if (seg.length <= 3) {
      // Too few points for cubic fit — use the points directly
      beziers.push(seg.map(p => ({ x: p.x, y: p.y })));
    } else {
      beziers.push(fitCubicBezier(seg));
    }
  }

  return { beziers, pressures, color: stroke.color, baseWidth: stroke.baseWidth };
}

// ── Rendering helpers ─────────────────────────────────────────────────

function renderRawStroke(ctx: CanvasRenderingContext2D, stroke: Stroke) {
  const { points, color, baseWidth } = stroke;
  if (points.length === 0) return;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let smoothedPressure = points[0].pressure;

  // Dot for single-point strokes
  if (points.length === 1) {
    const radius = (baseWidth * (0.4 + smoothedPressure * 1.2)) / 2;
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(points[0].x, points[0].y, Math.max(0.5, radius), 0, Math.PI * 2);
    ctx.fill();
    return;
  }

  for (let i = 1; i < points.length; i++) {
    smoothedPressure = smoothedPressure * 0.7 + points[i].pressure * 0.3;
    const width = baseWidth * (0.4 + smoothedPressure * 1.2);

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(points[i - 1].x, points[i - 1].y);
    ctx.lineTo(points[i].x, points[i].y);
    ctx.stroke();
  }
}

function renderSmoothedStroke(ctx: CanvasRenderingContext2D, smoothed: ReturnType<typeof smoothStroke>) {
  const { beziers, pressures, color, baseWidth } = smoothed;
  if (beziers.length === 0) return;

  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.strokeStyle = color;

  // Average pressure across entire stroke for consistent width
  const avgPressure = pressures.length > 0
    ? pressures.reduce((a, b) => a + b, 0) / pressures.length
    : 0.5;
  const width = baseWidth * (0.4 + avgPressure * 1.2);
  ctx.lineWidth = width;

  ctx.beginPath();
  for (const bez of beziers) {
    if (bez.length === 4) {
      // Cubic bezier
      ctx.moveTo(bez[0].x, bez[0].y);
      ctx.bezierCurveTo(bez[1].x, bez[1].y, bez[2].x, bez[2].y, bez[3].x, bez[3].y);
    } else if (bez.length === 3) {
      // Quadratic bezier
      ctx.moveTo(bez[0].x, bez[0].y);
      ctx.quadraticCurveTo(bez[1].x, bez[1].y, bez[2].x, bez[2].y);
    } else if (bez.length === 2) {
      ctx.moveTo(bez[0].x, bez[0].y);
      ctx.lineTo(bez[1].x, bez[1].y);
    }
  }
  ctx.stroke();
}

// ── Component ─────────────────────────────────────────────────────────

const PAD_WIDTH = 480;
const PAD_HEIGHT = 200;
const SIGNATURE_COLORS = ['#000000', '#1a237e', '#0d47a1', '#b71c1c'];
const MIN_PEN_WIDTH = 1.5;
const MAX_PEN_WIDTH = 6;
const RDP_EPSILON = 1.8; // Simplification tolerance in CSS pixels

const SignaturePad: React.FC<SignaturePadProps> = ({
  anchorX,
  anchorY,
  scale,
  penColor,
  penWidth,
  onApply,
  onCancel,
}) => {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const isDrawingRef = useRef(false);
  const lastPointRef = useRef<StrokePoint | null>(null);
  const smoothedPressureRef = useRef(0.5);
  const activePointerIdRef = useRef<number | null>(null);
  const strokesRef = useRef<Stroke[]>([]);
  const currentStrokeRef = useRef<StrokePoint[]>([]);

  const [hasStrokes, setHasStrokes] = useState(false);
  const [isCleaned, setIsCleaned] = useState(false);
  const [activeColor, setActiveColor] = useState(penColor);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const [padPosition, setPadPosition] = useState({ x: 0, y: 0 });

  const effectivePenWidth = Math.max(MIN_PEN_WIDTH, Math.min(MAX_PEN_WIDTH, penWidth * 1.5));

  // Position the pad centered on the click point within the viewport
  useEffect(() => {
    const screenX = anchorX * scale;
    const screenY = anchorY * scale;
    const viewer = document.querySelector('.pdf-viewer');
    const viewerRect = viewer?.getBoundingClientRect();

    let finalX = screenX - PAD_WIDTH / 2;
    let finalY = screenY;

    if (viewerRect) {
      finalX += viewerRect.left;
      finalY += viewerRect.top;
    }

    finalX = Math.max(20, Math.min(window.innerWidth - PAD_WIDTH - 20, finalX));
    finalY = Math.max(60, Math.min(window.innerHeight - PAD_HEIGHT - 100, finalY));

    setPadPosition({ x: finalX, y: finalY });
  }, [anchorX, anchorY, scale]);

  // Initialize canvas
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const dpr = window.devicePixelRatio || 1;
    canvas.width = PAD_WIDTH * dpr;
    canvas.height = PAD_HEIGHT * dpr;
    canvas.style.width = `${PAD_WIDTH}px`;
    canvas.style.height = `${PAD_HEIGHT}px`;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.scale(dpr, dpr);
  }, []);

  // Suppress keyboard shortcuts while pad is open
  useEffect(() => {
    const suppress = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { onCancel(); return; }
      if (!e.ctrlKey && !e.metaKey) e.stopPropagation();
    };
    window.addEventListener('keydown', suppress, true);
    return () => window.removeEventListener('keydown', suppress, true);
  }, [onCancel]);

  // ── Redraw all strokes (raw or smoothed) ──
  const redrawCanvas = useCallback((cleaned: boolean) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;

    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.scale(dpr, dpr);
    ctx.restore();

    // But we need to reset transform properly
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    if (cleaned) {
      for (const stroke of strokesRef.current) {
        const smoothed = smoothStroke(stroke, RDP_EPSILON);
        renderSmoothedStroke(ctx, smoothed);
      }
    } else {
      for (const stroke of strokesRef.current) {
        renderRawStroke(ctx, stroke);
      }
    }
  }, []);

  const getCanvasPoint = useCallback((e: PointerEvent): StrokePoint => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure > 0 ? e.pressure : 0.5,
    };
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerType === 'touch') return;
    if (activePointerIdRef.current !== null) return;
    e.preventDefault();
    e.stopPropagation();

    const canvas = canvasRef.current;
    if (!canvas) return;

    // If we were in cleaned state, revert to raw before new input
    if (isCleaned) {
      setIsCleaned(false);
      redrawCanvas(false);
    }

    canvas.setPointerCapture(e.pointerId);
    activePointerIdRef.current = e.pointerId;
    isDrawingRef.current = true;
    smoothedPressureRef.current = e.pressure > 0 ? e.pressure : 0.5;

    const point = getCanvasPoint(e.nativeEvent);
    lastPointRef.current = point;
    currentStrokeRef.current = [point];

    // Draw a dot at the start
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const pressure = smoothedPressureRef.current;
      const radius = (effectivePenWidth * (0.4 + pressure * 1.2)) / 2;
      ctx.fillStyle = activeColor;
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(0.5, radius), 0, Math.PI * 2);
      ctx.fill();
    }

    if (!hasStrokes) setHasStrokes(true);
  }, [getCanvasPoint, activeColor, effectivePenWidth, isCleaned, redrawCanvas, hasStrokes]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    if (e.pointerId !== activePointerIdRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const nativeEvent = e.nativeEvent;
    const events = nativeEvent.getCoalescedEvents?.() ?? [nativeEvent];

    for (const coalescedEvent of events) {
      const point = getCanvasPoint(coalescedEvent);
      currentStrokeRef.current.push(point);

      if (lastPointRef.current) {
        // Live draw segment
        smoothedPressureRef.current = smoothedPressureRef.current * 0.7 + point.pressure * 0.3;
        const width = effectivePenWidth * (0.4 + smoothedPressureRef.current * 1.2);

        ctx.strokeStyle = activeColor;
        ctx.lineWidth = width;
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        ctx.moveTo(lastPointRef.current.x, lastPointRef.current.y);
        ctx.lineTo(point.x, point.y);
        ctx.stroke();
      }
      lastPointRef.current = point;
    }
  }, [getCanvasPoint, activeColor, effectivePenWidth]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId !== activePointerIdRef.current) return;
    e.preventDefault();

    isDrawingRef.current = false;
    lastPointRef.current = null;
    activePointerIdRef.current = null;

    // Commit the current stroke
    if (currentStrokeRef.current.length > 0) {
      strokesRef.current.push({
        points: [...currentStrokeRef.current],
        color: activeColor,
        baseWidth: effectivePenWidth,
      });
      currentStrokeRef.current = [];
    }

    const canvas = canvasRef.current;
    if (canvas) canvas.releasePointerCapture(e.pointerId);
  }, [activeColor, effectivePenWidth]);

  const handleCleanup = useCallback(() => {
    if (strokesRef.current.length === 0) return;
    setIsCleaned(true);
    redrawCanvas(true);
  }, [redrawCanvas]);

  const handleUndoCleanup = useCallback(() => {
    setIsCleaned(false);
    redrawCanvas(false);
  }, [redrawCanvas]);

  const handleClear = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const dpr = window.devicePixelRatio || 1;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    strokesRef.current = [];
    currentStrokeRef.current = [];
    setHasStrokes(false);
    setIsCleaned(false);
  }, []);

  const handleApply = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || strokesRef.current.length === 0) return;

    // If not already cleaned, auto-clean before apply
    if (!isCleaned) {
      redrawCanvas(true);
    }

    const dpr = window.devicePixelRatio || 1;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
    const { data } = imageData;
    let minX = canvas.width, minY = canvas.height, maxX = 0, maxY = 0;

    for (let y = 0; y < canvas.height; y++) {
      for (let x = 0; x < canvas.width; x++) {
        const alpha = data[(y * canvas.width + x) * 4 + 3];
        if (alpha > 0) {
          minX = Math.min(minX, x);
          minY = Math.min(minY, y);
          maxX = Math.max(maxX, x);
          maxY = Math.max(maxY, y);
        }
      }
    }

    if (maxX <= minX || maxY <= minY) return;

    const pad = Math.ceil(6 * dpr);
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(canvas.width, maxX + pad);
    maxY = Math.min(canvas.height, maxY + pad);

    const cropWidth = maxX - minX;
    const cropHeight = maxY - minY;

    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropWidth;
    cropCanvas.height = cropHeight;
    const cropCtx = cropCanvas.getContext('2d')!;
    cropCtx.drawImage(canvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    const dataUrl = cropCanvas.toDataURL('image/png');
    const cssWidth = cropWidth / dpr;
    const cssHeight = cropHeight / dpr;

    onApply(dataUrl, { width: cssWidth, height: cssHeight });
  }, [onApply, isCleaned, redrawCanvas]);

  // Title bar drag
  const handleTitleMouseDown = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    setIsDragging(true);
    dragOffsetRef.current = {
      x: e.clientX - padPosition.x,
      y: e.clientY - padPosition.y,
    };
  }, [padPosition]);

  useEffect(() => {
    if (!isDragging) return;
    const handleMouseMove = (e: MouseEvent) => {
      setPadPosition({
        x: e.clientX - dragOffsetRef.current.x,
        y: e.clientY - dragOffsetRef.current.y,
      });
    };
    const handleMouseUp = () => setIsDragging(false);
    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  return (
    <div className="signature-pad-backdrop" onMouseDown={(e) => { e.stopPropagation(); onCancel(); }}>
      <div
        ref={overlayRef}
        className="signature-pad-overlay"
        style={{ left: padPosition.x, top: padPosition.y }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div className="signature-pad-titlebar" onMouseDown={handleTitleMouseDown}>
          <span className="signature-pad-title">
            Sign here
            {isCleaned && <span className="signature-pad-cleaned-badge">cleaned</span>}
          </span>
          <button className="signature-pad-close" onClick={onCancel} title="Cancel">
            <X size={14} />
          </button>
        </div>

        {/* Canvas */}
        <div className="signature-pad-canvas-wrapper">
          <canvas
            ref={canvasRef}
            className="signature-pad-canvas"
            onPointerDown={handlePointerDown}
            onPointerMove={handlePointerMove}
            onPointerUp={handlePointerUp}
            onPointerLeave={handlePointerUp}
            onContextMenu={(e) => e.preventDefault()}
          />
          {!hasStrokes && (
            <div className="signature-pad-placeholder">
              Draw your signature with stylus or mouse
            </div>
          )}
        </div>

        {/* Controls */}
        <div className="signature-pad-controls">
          <div className="signature-pad-colors">
            {SIGNATURE_COLORS.map((color) => (
              <button
                key={color}
                className={`signature-color-btn ${activeColor === color ? 'active' : ''}`}
                style={{ backgroundColor: color }}
                onClick={() => setActiveColor(color)}
                title={color}
              />
            ))}
          </div>
          <div className="signature-pad-actions">
            {!isCleaned ? (
              <button
                className="signature-pad-btn signature-pad-btn-cleanup"
                onClick={handleCleanup}
                disabled={!hasStrokes}
                title="Clean up signature"
              >
                <Sparkles size={14} />
                <span>Clean up</span>
              </button>
            ) : (
              <button
                className="signature-pad-btn signature-pad-btn-undo-cleanup"
                onClick={handleUndoCleanup}
                title="Undo cleanup"
              >
                <Sparkles size={14} />
                <span>Undo cleanup</span>
              </button>
            )}
            <button
              className="signature-pad-btn signature-pad-btn-clear"
              onClick={handleClear}
              disabled={!hasStrokes}
              title="Clear"
            >
              <Trash2 size={14} />
              <span>Clear</span>
            </button>
            <button
              className="signature-pad-btn signature-pad-btn-cancel"
              onClick={onCancel}
              title="Cancel"
            >
              <X size={14} />
              <span>Cancel</span>
            </button>
            <button
              className="signature-pad-btn signature-pad-btn-apply"
              onClick={handleApply}
              disabled={!hasStrokes}
              title="Apply signature"
            >
              <Check size={14} />
              <span>Apply</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};

export default SignaturePad;
