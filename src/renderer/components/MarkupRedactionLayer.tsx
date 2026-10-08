/**
 * Per-page overlay for text markup and redaction.
 *
 *  - Mounts a real pdf.js TextLayer while a selection tool is active, so text
 *    selection follows the PDF's own glyph runs.
 *  - Converts a DOM selection into per-line quads: Range.getClientRects() for
 *    each selected text node, merged per line in display space, then mapped to
 *    PDF user space through the page's scale-1 pdf.js viewport (handles
 *    /Rotate, CropBox origin and zoom).
 *  - Draws text-markup annotations and pending redaction marks (outlined
 *    boxes that can be selected, moved, resized and deleted).
 */
import React, { useCallback, useEffect, useRef, useState } from 'react';
import { TextLayer } from 'pdfjs-dist';
import type { PDFPageProxy, PageViewport } from 'pdfjs-dist';
import type { Annotation, AnnotationStyle, PdfRect, RedactionMarkAnnotation, TextMarkupAnnotation, TextMarkupType } from '../types';
import type { Tool } from '../App';

interface Props {
  pageNum: number;
  scale: number;
  rotation: number;
  tool: Tool;
  style?: AnnotationStyle;
  annotations: Annotation[];
  /** Changes whenever the underlying pdf.js document is replaced. */
  docKey: number;
  getPdfPage: (pageNum: number) => Promise<PDFPageProxy | null>;
  selectedId: string | null;
  onSelect: (id: string | null) => void;
  onContextMenu: (e: React.MouseEvent, pageNum: number, annotation: Annotation) => void;
  onAddTextMarkup?: (pageNum: number, type: TextMarkupType, quads: number[][], color: string, opacity: number, text: string) => void;
  onAddRedactionMark?: (pageNum: number, rects: PdfRect[], source: 'area' | 'text', text?: string) => void;
  onUpdateAnnotation: (pageNum: number, id: string, updates: Partial<Annotation>) => void;
}

interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

const HIGHLIGHT_DEFAULT = '#FFEB3B';

/** Is the given tool/style combination a text-selection tool? */
export function isSelectionTool(tool: Tool, style?: AnnotationStyle): boolean {
  return tool === 'markup' || (tool === 'highlight' && style?.highlightMode === 'text') || (tool === 'redact' && style?.redactMode === 'text');
}

/** Merge client rects (already in page display coordinates) into one box per line segment. */
export function mergeLineBoxes(rects: Box[]): Box[] {
  const sorted = rects
    .filter((r) => r.right - r.left > 0.5 && r.bottom - r.top > 0.5)
    .sort((a, b) => a.top - b.top || a.left - b.left);
  const lines: Box[][] = [];
  for (const r of sorted) {
    const h = r.bottom - r.top;
    const line = lines.find((l) => {
      const ref = l[0];
      const overlap = Math.min(ref.bottom, r.bottom) - Math.max(ref.top, r.top);
      return overlap > 0.5 * Math.min(h, ref.bottom - ref.top);
    });
    if (line) line.push(r);
    else lines.push([r]);
  }
  const out: Box[] = [];
  for (const line of lines) {
    line.sort((a, b) => a.left - b.left);
    let cur: Box | null = null;
    for (const r of line) {
      const h = r.bottom - r.top;
      if (cur && r.left - cur.right < 0.6 * h) {
        cur = { left: Math.min(cur.left, r.left), top: Math.min(cur.top, r.top), right: Math.max(cur.right, r.right), bottom: Math.max(cur.bottom, r.bottom) };
      } else {
        if (cur) out.push(cur);
        cur = { ...r };
      }
    }
    if (cur) out.push(cur);
  }
  return out;
}

/** Display box (scale-1 viewport coordinates) → quad [UL UR LL LR] in PDF user space. */
export function boxToQuad(viewport: PageViewport, b: Box): number[] {
  const [ulx, uly] = viewport.convertToPdfPoint(b.left, b.top);
  const [urx, ury] = viewport.convertToPdfPoint(b.right, b.top);
  const [llx, lly] = viewport.convertToPdfPoint(b.left, b.bottom);
  const [lrx, lry] = viewport.convertToPdfPoint(b.right, b.bottom);
  return [ulx, uly, urx, ury, llx, lly, lrx, lry];
}

function quadBounds(q: number[]): PdfRect {
  const xs = [q[0], q[2], q[4], q[6]];
  const ys = [q[1], q[3], q[5], q[7]];
  return { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) };
}

function pdfRectToBox(viewport: PageViewport, r: PdfRect, scale: number): Box {
  const [ax, ay] = viewport.convertToViewportPoint(r.x0, r.y0);
  const [bx, by] = viewport.convertToViewportPoint(r.x1, r.y1);
  return { left: Math.min(ax, bx) * scale, top: Math.min(ay, by) * scale, right: Math.max(ax, bx) * scale, bottom: Math.max(ay, by) * scale };
}

function boxToPdfRect(viewport: PageViewport, b: Box): PdfRect {
  const [ax, ay] = viewport.convertToPdfPoint(b.left, b.top);
  const [bx, by] = viewport.convertToPdfPoint(b.right, b.bottom);
  return { x0: Math.min(ax, bx), y0: Math.min(ay, by), x1: Math.max(ax, bx), y1: Math.max(ay, by) };
}

type DragState =
  | { kind: 'draw'; startX: number; startY: number; x: number; y: number }
  | { kind: 'move' | 'nw' | 'ne' | 'sw' | 'se'; id: string; startX: number; startY: number; orig: Box; current: Box };

const MarkupRedactionLayer: React.FC<Props> = ({
  pageNum, scale, rotation, tool, style, annotations, docKey, getPdfPage,
  selectedId, onSelect, onContextMenu, onAddTextMarkup, onAddRedactionMark, onUpdateAnnotation,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const textLayerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState<PageViewport | null>(null);
  const [drag, setDrag] = useState<DragState | null>(null);
  const selecting = isSelectionTool(tool, style);
  const redactArea = tool === 'redact' && (style?.redactMode ?? 'area') === 'area';

  // Scale-1 viewport for coordinate conversion.
  useEffect(() => {
    let cancelled = false;
    getPdfPage(pageNum).then((page) => {
      if (!cancelled && page) setViewport(page.getViewport({ scale: 1, rotation }));
    }).catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [pageNum, rotation, docKey, getPdfPage]);

  // pdf.js text layer, only while a selection tool is active.
  useEffect(() => {
    const div = textLayerRef.current;
    if (!div || !selecting) return;
    let cancelled = false;
    let layer: TextLayer | null = null;
    div.replaceChildren();
    div.style.setProperty('--scale-factor', String(scale));
    getPdfPage(pageNum).then((page) => {
      if (cancelled || !page) return;
      layer = new TextLayer({ textContentSource: page.streamTextContent(), container: div, viewport: page.getViewport({ scale, rotation }) });
      return layer.render();
    }).catch(() => undefined);
    return () => {
      cancelled = true;
      layer?.cancel();
      div.replaceChildren();
    };
  }, [selecting, scale, rotation, pageNum, docKey, getPdfPage]);

  const selectionBoxes = useCallback((): { boxes: Box[]; text: string } => {
    const sel = window.getSelection();
    const div = textLayerRef.current;
    const container = containerRef.current;
    if (!sel || sel.rangeCount === 0 || sel.isCollapsed || !div || !container) return { boxes: [], text: '' };
    const origin = container.getBoundingClientRect();
    const boxes: Box[] = [];
    let text = '';
    for (let i = 0; i < sel.rangeCount; i++) {
      const range = sel.getRangeAt(i);
      const walker = document.createTreeWalker(div, NodeFilter.SHOW_TEXT);
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (!range.intersectsNode(node)) continue;
        const sub = document.createRange();
        const len = (node as Text).length;
        const start = node === range.startContainer ? range.startOffset : 0;
        const end = node === range.endContainer ? range.endOffset : len;
        if (end <= start) continue;
        sub.setStart(node, start);
        sub.setEnd(node, end);
        text += (node as Text).data.slice(start, end);
        for (const r of Array.from(sub.getClientRects())) {
          boxes.push({
            left: (r.left - origin.left) / scale,
            top: (r.top - origin.top) / scale,
            right: (r.right - origin.left) / scale,
            bottom: (r.bottom - origin.top) / scale,
          });
        }
      }
    }
    return { boxes: mergeLineBoxes(boxes), text: text.replace(/\s+/g, ' ').trim() };
  }, [scale]);

  const handleSelectionEnd = useCallback(() => {
    if (!selecting || !viewport) return;
    const { boxes, text } = selectionBoxes();
    if (!boxes.length) return;
    const quads = boxes.map((b) => boxToQuad(viewport, b));
    if (tool === 'redact') {
      onAddRedactionMark?.(pageNum, quads.map(quadBounds), 'text', text);
    } else {
      const type: TextMarkupType = tool === 'highlight' ? 'highlight' : style?.markupType ?? 'underline';
      const color = tool === 'highlight' ? (style?.color && style.color !== '#000000' ? style.color : HIGHLIGHT_DEFAULT) : style?.strokeColor ?? '#FF0000';
      const opacity = type === 'highlight' ? 0.4 : 1;
      onAddTextMarkup?.(pageNum, type, quads, color, opacity, text);
    }
    window.getSelection()?.removeAllRanges();
  }, [selecting, viewport, selectionBoxes, tool, style, pageNum, onAddRedactionMark, onAddTextMarkup]);

  const localPoint = (e: React.MouseEvent | MouseEvent) => {
    const r = containerRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top };
  };

  // Window-level move/up so drags keep working when the pointer leaves the mark.
  useEffect(() => {
    if (!drag) return;
    const onMove = (e: MouseEvent) => {
      const p = localPoint(e);
      setDrag((d) => {
        if (!d) return d;
        if (d.kind === 'draw') return { ...d, x: p.x, y: p.y };
        const dx = p.x - d.startX, dy = p.y - d.startY;
        const o = d.orig;
        let b: Box;
        if (d.kind === 'move') b = { left: o.left + dx, right: o.right + dx, top: o.top + dy, bottom: o.bottom + dy };
        else b = {
          left: d.kind === 'nw' || d.kind === 'sw' ? o.left + dx : o.left,
          right: d.kind === 'ne' || d.kind === 'se' ? o.right + dx : o.right,
          top: d.kind === 'nw' || d.kind === 'ne' ? o.top + dy : o.top,
          bottom: d.kind === 'sw' || d.kind === 'se' ? o.bottom + dy : o.bottom,
        };
        return { ...d, current: b };
      });
    };
    const onUp = () => {
      setDrag((d) => {
        if (d && viewport) {
          if (d.kind === 'draw') {
            const box: Box = { left: Math.min(d.startX, d.x) / scale, top: Math.min(d.startY, d.y) / scale, right: Math.max(d.startX, d.x) / scale, bottom: Math.max(d.startY, d.y) / scale };
            if (box.right - box.left > 3 && box.bottom - box.top > 3) onAddRedactionMark?.(pageNum, [boxToPdfRect(viewport, box)], 'area');
          } else {
            const c = d.current;
            const box: Box = { left: Math.min(c.left, c.right) / scale, right: Math.max(c.left, c.right) / scale, top: Math.min(c.top, c.bottom) / scale, bottom: Math.max(c.top, c.bottom) / scale };
            if (box.right - box.left > 2 && box.bottom - box.top > 2) {
              onUpdateAnnotation(pageNum, d.id, { rects: [boxToPdfRect(viewport, box)], edited: true } as Partial<RedactionMarkAnnotation>);
            }
          }
        }
        return null;
      });
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [drag !== null, viewport, scale, pageNum, onAddRedactionMark, onUpdateAnnotation]); // eslint-disable-line react-hooks/exhaustive-deps

  const markInteractive = tool === 'select' || tool === 'redact';
  const markups = annotations.filter((a): a is TextMarkupAnnotation => a.type === 'textMarkup');
  const marks = annotations.filter((a): a is RedactionMarkAnnotation => a.type === 'redaction');

  return (
    <div
      ref={containerRef}
      className={`markup-redaction-layer ${selecting ? 'selecting' : ''} ${redactArea ? 'redact-area' : ''}`}
      data-testid={`markup-layer-${pageNum}`}
      onMouseDown={(e) => {
        if (!redactArea || e.button !== 0 || e.target !== containerRef.current) return;
        e.stopPropagation();
        const p = localPoint(e);
        setDrag({ kind: 'draw', startX: p.x, startY: p.y, x: p.x, y: p.y });
      }}
      onMouseUp={() => {
        if (selecting) handleSelectionEnd();
      }}
      onClick={(e) => {
        if (selecting || redactArea) e.stopPropagation();
      }}
    >
      {viewport && (
        <svg className="markup-svg" width="100%" height="100%">
          {markups.map((a) => {
            const selected = selectedId === a.id;
            return (
              <g
                key={a.id}
                className={`text-markup ${a.markupType} ${selected ? 'selected' : ''}`}
                data-testid="text-markup"
                data-markup-type={a.markupType}
                style={{ pointerEvents: tool === 'select' || tool === 'erase' ? 'auto' : 'none', cursor: 'pointer' }}
                onMouseDown={(e) => {
                  e.stopPropagation();
                  onSelect(a.id);
                }}
                onClick={(e) => e.stopPropagation()}
                onContextMenu={(e) => onContextMenu(e, pageNum, a)}
              >
                {a.quads.map((q, i) => {
                  const pts = [[q[0], q[1]], [q[2], q[3]], [q[6], q[7]], [q[4], q[5]]].map(([x, y]) => viewport.convertToViewportPoint(x, y).map((v) => v * scale));
                  const [ul, ur, lr, ll] = pts;
                  const hl = (t: number) => [ll[0] + (ul[0] - ll[0]) * t, ll[1] + (ul[1] - ll[1]) * t, lr[0] + (ur[0] - lr[0]) * t, lr[1] + (ur[1] - lr[1]) * t];
                  if (a.markupType === 'highlight') {
                    return <polygon key={i} points={pts.map((p) => p.join(',')).join(' ')} fill={a.color} fillOpacity={a.opacity} style={{ mixBlendMode: 'multiply' }} />;
                  }
                  const t = a.markupType === 'strikeout' ? 0.45 : 0.06;
                  const [x1, y1, x2, y2] = hl(t);
                  const w = Math.max(1, Math.hypot(ul[0] - ll[0], ul[1] - ll[1]) / 14);
                  if (a.markupType === 'squiggly') {
                    const steps = Math.max(2, Math.round(Math.hypot(x2 - x1, y2 - y1) / 4));
                    const d = Array.from({ length: steps + 1 }, (_, k) => {
                      const x = x1 + ((x2 - x1) * k) / steps;
                      const y = y1 + ((y2 - y1) * k) / steps - (k % 2 ? 2 * scale : 0);
                      return `${k ? 'L' : 'M'} ${x} ${y}`;
                    }).join(' ');
                    return <path key={i} d={d} stroke={a.color} strokeWidth={w} fill="none" />;
                  }
                  return <line key={i} x1={x1} y1={y1} x2={x2} y2={y2} stroke={a.color} strokeWidth={w} />;
                })}
              </g>
            );
          })}
        </svg>
      )}

      {viewport && marks.map((m) => {
        const selected = selectedId === m.id;
        const draggingThis = drag && drag.kind !== 'draw' && drag.id === m.id ? drag.current : null;
        const editable = m.rects.length === 1;
        return m.rects.map((r, i) => {
          const b = draggingThis && i === 0 ? draggingThis : pdfRectToBox(viewport, r, scale);
          return (
            <div
              key={`${m.id}-${i}`}
              className={`redaction-mark ${selected ? 'selected' : ''}`}
              data-testid="redaction-mark"
              title={m.text ? `Redaction mark: ${m.text}` : 'Redaction mark (not yet applied)'}
              style={{
                left: Math.min(b.left, b.right), top: Math.min(b.top, b.bottom),
                width: Math.abs(b.right - b.left), height: Math.abs(b.bottom - b.top),
                pointerEvents: markInteractive ? 'auto' : 'none',
                cursor: editable && selected ? 'move' : 'pointer',
              }}
              onMouseDown={(e) => {
                if (e.button !== 0) return;
                e.stopPropagation();
                onSelect(m.id);
                if (editable && selected) {
                  const p = localPoint(e);
                  const orig = pdfRectToBox(viewport, r, scale);
                  setDrag({ kind: 'move', id: m.id, startX: p.x, startY: p.y, orig, current: orig });
                }
              }}
              onClick={(e) => e.stopPropagation()}
              onContextMenu={(e) => onContextMenu(e, pageNum, m)}
            >
              {selected && editable && (['nw', 'ne', 'sw', 'se'] as const).map((h) => (
                <span
                  key={h}
                  className={`redaction-handle ${h}`}
                  onMouseDown={(e) => {
                    e.stopPropagation();
                    const p = localPoint(e);
                    const orig = pdfRectToBox(viewport, r, scale);
                    setDrag({ kind: h, id: m.id, startX: p.x, startY: p.y, orig, current: orig });
                  }}
                />
              ))}
            </div>
          );
        });
      })}

      {drag?.kind === 'draw' && (
        <div
          className="redaction-preview"
          style={{ left: Math.min(drag.startX, drag.x), top: Math.min(drag.startY, drag.y), width: Math.abs(drag.x - drag.startX), height: Math.abs(drag.y - drag.startY) }}
        />
      )}

      <div ref={textLayerRef} className={`textLayer markup-text-layer ${selecting ? 'active' : ''}`} />
    </div>
  );
};

export default MarkupRedactionLayer;
