import React, { useRef, useCallback, useEffect, useState } from 'react';
import { X, Trash2, Check } from 'lucide-react';

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

const PAD_WIDTH = 480;
const PAD_HEIGHT = 200;
const SIGNATURE_COLORS = ['#000000', '#1a237e', '#0d47a1', '#b71c1c'];
const MIN_PEN_WIDTH = 1.5;
const MAX_PEN_WIDTH = 6;

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
  const hasStrokesRef = useRef(false);
  const activePointerIdRef = useRef<number | null>(null);
  const [hasStrokes, setHasStrokes] = useState(false);
  const [activeColor, setActiveColor] = useState(penColor);
  const [isDragging, setIsDragging] = useState(false);
  const dragOffsetRef = useRef({ x: 0, y: 0 });
  const [padPosition, setPadPosition] = useState({ x: 0, y: 0 });

  // Effective pen width for signatures (thicker than regular drawing)
  const effectivePenWidth = Math.max(MIN_PEN_WIDTH, Math.min(MAX_PEN_WIDTH, penWidth * 1.5));

  // Position the pad centered on the click point within the viewport
  useEffect(() => {
    // Convert PDF coordinates to approximate screen position
    const screenX = anchorX * scale;
    const screenY = anchorY * scale;

    // Find the PDF viewer container to get scroll offset
    const viewer = document.querySelector('.pdf-viewer');
    const viewerRect = viewer?.getBoundingClientRect();

    let finalX = screenX - PAD_WIDTH / 2;
    let finalY = screenY;

    if (viewerRect) {
      // Offset by viewer position and scroll
      finalX += viewerRect.left + (viewer?.scrollLeft ?? 0) * 0 ;
      finalY += viewerRect.top;
    }

    // Clamp to viewport
    finalX = Math.max(20, Math.min(window.innerWidth - PAD_WIDTH - 20, finalX));
    finalY = Math.max(60, Math.min(window.innerHeight - PAD_HEIGHT - 100, finalY));

    setPadPosition({ x: finalX, y: finalY });
  }, [anchorX, anchorY, scale]);

  // Initialize canvas with devicePixelRatio scaling
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
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
  }, []);

  // Suppress keyboard shortcuts while pad is open
  useEffect(() => {
    const suppress = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onCancel();
        return;
      }
      if (!e.ctrlKey && !e.metaKey) {
        e.stopPropagation();
      }
    };
    window.addEventListener('keydown', suppress, true);
    return () => window.removeEventListener('keydown', suppress, true);
  }, [onCancel]);

  const getCanvasPoint = useCallback((e: PointerEvent): StrokePoint => {
    const canvas = canvasRef.current!;
    const rect = canvas.getBoundingClientRect();
    return {
      x: e.clientX - rect.left,
      y: e.clientY - rect.top,
      pressure: e.pressure > 0 ? e.pressure : 0.5,
    };
  }, []);

  const drawSegment = useCallback((from: StrokePoint, to: StrokePoint, color: string, baseWidth: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // Smooth pressure via EMA
    smoothedPressureRef.current = smoothedPressureRef.current * 0.7 + to.pressure * 0.3;
    const pressure = smoothedPressureRef.current;

    // Width varies from 40% to 160% of base width based on pressure
    const width = baseWidth * (0.4 + pressure * 1.2);

    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    ctx.beginPath();
    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
    ctx.stroke();
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    // Palm rejection: only accept pen and mouse
    if (e.pointerType === 'touch') return;
    // Only one pointer at a time
    if (activePointerIdRef.current !== null) return;

    e.preventDefault();
    e.stopPropagation();

    const canvas = canvasRef.current;
    if (!canvas) return;

    canvas.setPointerCapture(e.pointerId);
    activePointerIdRef.current = e.pointerId;
    isDrawingRef.current = true;
    smoothedPressureRef.current = e.pressure > 0 ? e.pressure : 0.5;

    const point = getCanvasPoint(e.nativeEvent);
    lastPointRef.current = point;

    // Draw a dot at the start point
    const ctx = canvas.getContext('2d');
    if (ctx) {
      const pressure = smoothedPressureRef.current;
      const radius = (effectivePenWidth * (0.4 + pressure * 1.2)) / 2;
      ctx.fillStyle = activeColor;
      ctx.beginPath();
      ctx.arc(point.x, point.y, Math.max(0.5, radius), 0, Math.PI * 2);
      ctx.fill();
    }

    if (!hasStrokesRef.current) {
      hasStrokesRef.current = true;
      setHasStrokes(true);
    }
  }, [getCanvasPoint, activeColor, effectivePenWidth]);

  const handlePointerMove = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!isDrawingRef.current) return;
    if (e.pointerId !== activePointerIdRef.current) return;
    e.preventDefault();
    e.stopPropagation();

    // Use coalesced events for maximum stylus resolution
    const nativeEvent = e.nativeEvent;
    const events = nativeEvent.getCoalescedEvents?.() ?? [nativeEvent];

    for (const coalescedEvent of events) {
      const point = getCanvasPoint(coalescedEvent);
      if (lastPointRef.current) {
        drawSegment(lastPointRef.current, point, activeColor, effectivePenWidth);
      }
      lastPointRef.current = point;
    }
  }, [getCanvasPoint, drawSegment, activeColor, effectivePenWidth]);

  const handlePointerUp = useCallback((e: React.PointerEvent<HTMLCanvasElement>) => {
    if (e.pointerId !== activePointerIdRef.current) return;
    e.preventDefault();

    isDrawingRef.current = false;
    lastPointRef.current = null;
    activePointerIdRef.current = null;

    const canvas = canvasRef.current;
    if (canvas) {
      canvas.releasePointerCapture(e.pointerId);
    }
  }, []);

  const handleClear = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    ctx.clearRect(0, 0, PAD_WIDTH * dpr, PAD_HEIGHT * dpr);
    hasStrokesRef.current = false;
    setHasStrokes(false);
  }, []);

  const handleApply = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas || !hasStrokesRef.current) return;

    // Find the bounding box of actual content (non-transparent pixels)
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

    // Add padding
    const pad = Math.ceil(6 * dpr);
    minX = Math.max(0, minX - pad);
    minY = Math.max(0, minY - pad);
    maxX = Math.min(canvas.width, maxX + pad);
    maxY = Math.min(canvas.height, maxY + pad);

    const cropWidth = maxX - minX;
    const cropHeight = maxY - minY;

    // Create a cropped canvas
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = cropWidth;
    cropCanvas.height = cropHeight;
    const cropCtx = cropCanvas.getContext('2d')!;
    cropCtx.drawImage(canvas, minX, minY, cropWidth, cropHeight, 0, 0, cropWidth, cropHeight);

    const dataUrl = cropCanvas.toDataURL('image/png');

    // Convert pixel dimensions back to CSS pixels for the annotation
    const cssWidth = cropWidth / dpr;
    const cssHeight = cropHeight / dpr;

    onApply(dataUrl, { width: cssWidth, height: cssHeight });
  }, [onApply]);

  // Title bar drag handlers
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
        style={{
          left: padPosition.x,
          top: padPosition.y,
        }}
        onMouseDown={(e) => e.stopPropagation()}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Title bar */}
        <div
          className="signature-pad-titlebar"
          onMouseDown={handleTitleMouseDown}
        >
          <span className="signature-pad-title">Sign here</span>
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
