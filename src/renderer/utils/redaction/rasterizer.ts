/**
 * Rasterization fallback.
 *
 * Renders a region of the ORIGINAL page with pdf.js (annotations excluded),
 * paints the redaction marks onto the canvas before the pixels are read, and
 * returns plain RGB. A raster carries no vector, text or object data, so a
 * region that is replaced by it cannot leak what was under the mark.
 *
 * Uses the document's own canvas factory: DOM canvas in the renderer, and
 * @napi-rs/canvas under Node (pdfjs-dist's optional dependency).
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Rect, intersection } from './geometry';
import { Rgb } from './imageRedactor';

/** Upper bound on raster size so a huge page cannot exhaust memory. */
const MAX_PIXELS = 24_000_000;

export interface RasterResult {
  width: number;
  height: number;
  rgb: Uint8Array;
  /** The user-space rectangle the raster covers (clipped to the page). */
  rect: Rect;
}

interface CanvasLike {
  width: number;
  height: number;
}
interface Context2DLike {
  fillStyle: string;
  fillRect(x: number, y: number, w: number, h: number): void;
  getImageData(x: number, y: number, w: number, h: number): { data: Uint8ClampedArray };
}
interface CanvasFactoryLike {
  create(width: number, height: number): { canvas: CanvasLike; context: Context2DLike };
  destroy(entry: { canvas: CanvasLike; context: Context2DLike }): void;
}

export async function rasterizeRegion(
  doc: PDFDocumentProxy,
  pageIndex: number,
  region: Rect | 'page',
  marks: Rect[],
  fill: Rgb,
  scale: number
): Promise<RasterResult | null> {
  const page = await doc.getPage(pageIndex + 1);
  const [vx0, vy0, vx1, vy1] = page.view;
  const pageRect: Rect = { x0: Math.min(vx0, vx1), y0: Math.min(vy0, vy1), x1: Math.max(vx0, vx1), y1: Math.max(vy0, vy1) };
  const target = region === 'page' ? pageRect : intersection(region, pageRect);
  if (!target) return null;

  let s = scale;
  const area = (target.x1 - target.x0) * (target.y1 - target.y0);
  if (area * s * s > MAX_PIXELS) s = Math.sqrt(MAX_PIXELS / area);

  const width = Math.max(1, Math.ceil((target.x1 - target.x0) * s));
  const height = Math.max(1, Math.ceil((target.y1 - target.y0) * s));
  // Rotation 0: the pixel grid stays aligned with user space whatever /Rotate says.
  const base = page.getViewport({ scale: s, rotation: 0 });
  const [ox, oy] = base.convertToViewportPoint(target.x0, target.y1);
  const viewport = page.getViewport({ scale: s, rotation: 0, offsetX: -ox, offsetY: -oy });

  const factory = (doc as unknown as { canvasFactory: CanvasFactoryLike }).canvasFactory;
  const entry = factory.create(width, height);
  try {
    entry.context.fillStyle = '#ffffff';
    entry.context.fillRect(0, 0, width, height);
    await page.render({
      canvasContext: entry.context as never,
      viewport,
      annotationMode: 0,
      background: '#ffffff',
    } as never).promise;

    entry.context.fillStyle = `rgb(${Math.round(fill.r * 255)}, ${Math.round(fill.g * 255)}, ${Math.round(fill.b * 255)})`;
    for (const m of marks) {
      const [ax, ay] = viewport.convertToViewportPoint(m.x0, m.y0);
      const [bx, by] = viewport.convertToViewportPoint(m.x1, m.y1);
      // Grow by a pixel so anti-aliased edges of covered content are inside the box.
      const left = Math.floor(Math.min(ax, bx)) - 1;
      const top = Math.floor(Math.min(ay, by)) - 1;
      const right = Math.ceil(Math.max(ax, bx)) + 1;
      const bottom = Math.ceil(Math.max(ay, by)) + 1;
      entry.context.fillRect(left, top, right - left, bottom - top);
    }

    const rgba = entry.context.getImageData(0, 0, width, height).data;
    const rgb = new Uint8Array(width * height * 3);
    for (let i = 0, j = 0; i < rgba.length; i += 4, j += 3) {
      rgb[j] = rgba[i];
      rgb[j + 1] = rgba[i + 1];
      rgb[j + 2] = rgba[i + 2];
    }
    return {
      width,
      height,
      rgb,
      rect: { x0: target.x0, y0: target.y1 - height / s, x1: target.x0 + width / s, y1: target.y1 },
    };
  } finally {
    factory.destroy(entry);
    page.cleanup();
  }
}
