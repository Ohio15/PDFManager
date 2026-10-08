/**
 * pageViewport — PDF user space ⇄ rendered page pixels.
 *
 * Mirrors pdf.js PageViewport (src/display/display_utils.js) so a rectangle
 * computed here lands exactly where pdf.js painted the page and its widgets,
 * including rotated pages and view boxes that do not start at 0,0.
 */

import type { FieldRect } from './formBuilder';

export interface ViewportTransform {
  width: number;
  height: number;
  toViewport(x: number, y: number): [number, number];
  toPdf(vx: number, vy: number): [number, number];
}

export function createViewportTransform(
  view: [number, number, number, number],
  rotation: number,
  scale: number
): ViewportTransform {
  const [x0, y0, x1, y1] = view;
  const centerX = (x1 + x0) / 2;
  const centerY = (y1 + y0) / 2;
  let rotateA: number;
  let rotateB: number;
  let rotateC: number;
  let rotateD: number;
  const r = ((rotation % 360) + 360) % 360;
  switch (r) {
    case 180: rotateA = -1; rotateB = 0; rotateC = 0; rotateD = 1; break;
    case 90: rotateA = 0; rotateB = 1; rotateC = 1; rotateD = 0; break;
    case 270: rotateA = 0; rotateB = -1; rotateC = -1; rotateD = 0; break;
    default: rotateA = 1; rotateB = 0; rotateC = 0; rotateD = -1; break;
  }
  let offsetCanvasX: number;
  let offsetCanvasY: number;
  let width: number;
  let height: number;
  if (rotateA === 0) {
    offsetCanvasX = Math.abs(centerY - y0) * scale;
    offsetCanvasY = Math.abs(centerX - x0) * scale;
    width = (y1 - y0) * scale;
    height = (x1 - x0) * scale;
  } else {
    offsetCanvasX = Math.abs(centerX - x0) * scale;
    offsetCanvasY = Math.abs(centerY - y0) * scale;
    width = (x1 - x0) * scale;
    height = (y1 - y0) * scale;
  }
  const m = [
    rotateA * scale,
    rotateB * scale,
    rotateC * scale,
    rotateD * scale,
    offsetCanvasX - rotateA * scale * centerX - rotateC * scale * centerY,
    offsetCanvasY - rotateB * scale * centerX - rotateD * scale * centerY,
  ];
  const det = m[0] * m[3] - m[1] * m[2];
  return {
    width,
    height,
    toViewport: (x, y) => [x * m[0] + y * m[2] + m[4], x * m[1] + y * m[3] + m[5]],
    toPdf: (vx, vy) => {
      const dx = vx - m[4];
      const dy = vy - m[5];
      return [(dx * m[3] - dy * m[2]) / det, (dy * m[0] - dx * m[1]) / det];
    },
  };
}

export interface ScreenRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export function pdfRectToScreen(t: ViewportTransform, rect: FieldRect): ScreenRect {
  const [ax, ay] = t.toViewport(rect.x, rect.y);
  const [bx, by] = t.toViewport(rect.x + rect.width, rect.y + rect.height);
  return {
    left: Math.min(ax, bx),
    top: Math.min(ay, by),
    width: Math.abs(bx - ax),
    height: Math.abs(by - ay),
  };
}

export function screenRectToPdf(t: ViewportTransform, rect: ScreenRect): FieldRect {
  const [ax, ay] = t.toPdf(rect.left, rect.top);
  const [bx, by] = t.toPdf(rect.left + rect.width, rect.top + rect.height);
  const round = (n: number) => Math.round(n * 100) / 100;
  return {
    x: round(Math.min(ax, bx)),
    y: round(Math.min(ay, by)),
    width: round(Math.abs(bx - ax)),
    height: round(Math.abs(by - ay)),
  };
}
