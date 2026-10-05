import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormDesigner } from '../hooks/useFormDesigner';
import { createViewportTransform, pdfRectToScreen, screenRectToPdf, ScreenRect } from '../utils/pageViewport';
import '../styles/forms-finalize.css';

interface FormFieldOverlayProps {
  pageIndex: number;
  scale: number;
  designer: FormDesigner;
}

type Corner = 'nw' | 'ne' | 'sw' | 'se';

type Gesture =
  | { kind: 'create'; startX: number; startY: number; rect: ScreenRect }
  | { kind: 'move'; name: string; widgetIndex: number; startX: number; startY: number; origin: ScreenRect; rect: ScreenRect }
  | { kind: 'resize'; name: string; widgetIndex: number; corner: Corner; origin: ScreenRect; rect: ScreenRect };

/** Below this drag distance (CSS px) a create gesture is treated as a click. */
const MIN_DRAG = 6;
const MIN_BOX = 8;

function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/**
 * Authoring layer drawn over one rendered page while the Form tool is active:
 * drag on empty space to create a field, drag a box to move it, drag a corner
 * to resize it, Delete to remove the selected field.
 */
const FormFieldOverlay: React.FC<FormFieldOverlayProps> = ({ pageIndex, scale, designer }) => {
  const layerRef = useRef<HTMLDivElement>(null);
  const [gesture, setGesture] = useState<Gesture | null>(null);
  const gestureRef = useRef<Gesture | null>(null);
  gestureRef.current = gesture;

  const geometry = designer.model?.pages[pageIndex];
  const transform = useMemo(
    () => (geometry ? createViewportTransform(geometry.view, geometry.rotation, scale) : null),
    [geometry, scale]
  );

  const widgets = useMemo(() => {
    if (!designer.model || !transform) return [];
    const out: Array<{ name: string; kind: string; widgetIndex: number; rect: ScreenRect; label: string }> = [];
    for (const field of designer.model.fields) {
      field.widgets.forEach((w, widgetIndex) => {
        if (w.pageIndex !== pageIndex) return;
        out.push({
          name: field.name,
          kind: field.kind,
          widgetIndex,
          rect: pdfRectToScreen(transform, w.rect),
          label: w.option ? `${field.name}: ${w.option}` : field.name,
        });
      });
    }
    return out;
  }, [designer.model, transform, pageIndex]);

  const localPoint = useCallback((e: MouseEvent | React.MouseEvent) => {
    const box = layerRef.current!.getBoundingClientRect();
    return {
      x: clamp(e.clientX - box.left, 0, box.width),
      y: clamp(e.clientY - box.top, 0, box.height),
      w: box.width,
      h: box.height,
    };
  }, []);

  // Window-level move/up so a drag that leaves the page still completes.
  useEffect(() => {
    if (!gesture) return;
    const onMove = (e: MouseEvent) => {
      const g = gestureRef.current;
      if (!g || !layerRef.current) return;
      const p = localPoint(e);
      if (g.kind === 'create') {
        setGesture({
          ...g,
          rect: {
            left: Math.min(g.startX, p.x),
            top: Math.min(g.startY, p.y),
            width: Math.abs(p.x - g.startX),
            height: Math.abs(p.y - g.startY),
          },
        });
      } else if (g.kind === 'move') {
        const left = clamp(g.origin.left + (p.x - g.startX), 0, p.w - g.origin.width);
        const top = clamp(g.origin.top + (p.y - g.startY), 0, p.h - g.origin.height);
        setGesture({ ...g, rect: { ...g.origin, left, top } });
      } else {
        const o = g.origin;
        let x1 = o.left;
        let y1 = o.top;
        let x2 = o.left + o.width;
        let y2 = o.top + o.height;
        if (g.corner.includes('w')) x1 = Math.min(p.x, x2 - MIN_BOX);
        if (g.corner.includes('e')) x2 = Math.max(p.x, x1 + MIN_BOX);
        if (g.corner.includes('n')) y1 = Math.min(p.y, y2 - MIN_BOX);
        if (g.corner.includes('s')) y2 = Math.max(p.y, y1 + MIN_BOX);
        setGesture({ ...g, rect: { left: x1, top: y1, width: x2 - x1, height: y2 - y1 } });
      }
    };
    const onUp = () => {
      const g = gestureRef.current;
      setGesture(null);
      if (!g || !transform) return;
      if (g.kind === 'create') {
        if (g.rect.width < MIN_DRAG || g.rect.height < MIN_DRAG) {
          designer.select(null);
          return;
        }
        void designer.createField(pageIndex, screenRectToPdf(transform, g.rect));
        return;
      }
      const moved =
        Math.abs(g.rect.left - g.origin.left) > 0.5 ||
        Math.abs(g.rect.top - g.origin.top) > 0.5 ||
        Math.abs(g.rect.width - g.origin.width) > 0.5 ||
        Math.abs(g.rect.height - g.origin.height) > 0.5;
      if (moved) void designer.moveWidget(g.name, g.widgetIndex, screenRectToPdf(transform, g.rect));
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    // Only (re)bind when a gesture starts or ends, not on every preview update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gesture !== null, transform, designer, pageIndex, localPoint]);

  const stop = (e: React.SyntheticEvent) => {
    e.stopPropagation();
  };

  const onLayerMouseDown = (e: React.MouseEvent) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0 || designer.busy || !transform) return;
    const p = localPoint(e);
    setGesture({ kind: 'create', startX: p.x, startY: p.y, rect: { left: p.x, top: p.y, width: 0, height: 0 } });
  };

  const onBoxMouseDown = (e: React.MouseEvent, name: string, widgetIndex: number, rect: ScreenRect) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0) return;
    designer.select(name);
    if (designer.busy) return;
    const p = localPoint(e);
    setGesture({ kind: 'move', name, widgetIndex, startX: p.x, startY: p.y, origin: rect, rect });
  };

  const onHandleMouseDown = (e: React.MouseEvent, name: string, widgetIndex: number, corner: Corner, rect: ScreenRect) => {
    e.stopPropagation();
    e.preventDefault();
    if (e.button !== 0 || designer.busy) return;
    designer.select(name);
    setGesture({ kind: 'resize', name, widgetIndex, corner, origin: rect, rect });
  };

  if (!transform) return null;

  return (
    <div
      ref={layerRef}
      className={`form-design-layer ${designer.busy ? 'busy' : ''}`}
      data-testid={`form-design-layer-${pageIndex}`}
      onMouseDown={onLayerMouseDown}
      onClick={stop}
      onDoubleClick={stop}
    >
      {widgets.map((w) => {
        const live =
          gesture && gesture.kind !== 'create' && gesture.name === w.name && gesture.widgetIndex === w.widgetIndex
            ? gesture.rect
            : w.rect;
        const selected = designer.selectedName === w.name;
        return (
          <div
            key={`${w.name}#${w.widgetIndex}`}
            className={`form-design-box kind-${w.kind} ${selected ? 'selected' : ''}`}
            style={{ left: live.left, top: live.top, width: live.width, height: live.height }}
            data-field-name={w.name}
            title={`${w.label} (${w.kind})`}
            onMouseDown={(e) => onBoxMouseDown(e, w.name, w.widgetIndex, w.rect)}
          >
            <span className="form-design-label">{w.label}</span>
            {selected &&
              (['nw', 'ne', 'sw', 'se'] as Corner[]).map((corner) => (
                <span
                  key={corner}
                  className={`form-design-handle handle-${corner}`}
                  onMouseDown={(e) => onHandleMouseDown(e, w.name, w.widgetIndex, corner, w.rect)}
                />
              ))}
          </div>
        );
      })}
      {gesture?.kind === 'create' && gesture.rect.width > 0 && (
        <div
          className="form-design-preview"
          style={{ left: gesture.rect.left, top: gesture.rect.top, width: gesture.rect.width, height: gesture.rect.height }}
        />
      )}
    </div>
  );
};

export default FormFieldOverlay;
