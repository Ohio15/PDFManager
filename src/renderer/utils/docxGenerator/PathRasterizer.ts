/**
 * Path Rasterizer — Vector-to-PNG Converter
 *
 * Groups nearby vector paths into visual clusters and rasterizes each
 * cluster to a PNG image via OffscreenCanvas. Used to preserve company
 * logos, decorative shapes, and colored header bars that can't be
 * represented in OOXML paragraph/table markup.
 */

import type { PathElement, RGB } from './types';

/** Padding around rasterized path groups in PDF points */
const PADDING_PT = 2;

/** Default DPI scale for rasterization (2x for high-DPI clarity) */
const DPI_SCALE = 2;

/**
 * Compute the axis-aligned bounding box of a path from its points array.
 */
function pathBounds(path: PathElement): { minX: number; minY: number; maxX: number; maxY: number } {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const pt of path.points) {
    if (pt.x < minX) minX = pt.x;
    if (pt.y < minY) minY = pt.y;
    if (pt.x > maxX) maxX = pt.x;
    if (pt.y > maxY) maxY = pt.y;
  }
  return { minX, minY, maxX, maxY };
}

/**
 * Check if two bounding boxes overlap or are within tolerance of each other.
 */
function boundsOverlap(
  a: { minX: number; minY: number; maxX: number; maxY: number },
  b: { minX: number; minY: number; maxX: number; maxY: number },
  tolerance: number
): boolean {
  return !(
    a.maxX + tolerance < b.minX ||
    b.maxX + tolerance < a.minX ||
    a.maxY + tolerance < b.minY ||
    b.maxY + tolerance < a.minY
  );
}

/**
 * Group nearby paths whose bounding boxes overlap or are within tolerance pts.
 * Uses union-find for efficient cluster merging.
 */
export function groupNearbyPaths(paths: PathElement[], tolerance: number): PathElement[][] {
  if (paths.length === 0) return [];
  if (paths.length === 1) return [paths];

  const bounds = paths.map(p => pathBounds(p));

  // Union-find
  const parent = paths.map((_, i) => i);
  const rank = new Array(paths.length).fill(0);

  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]]; // path compression
      x = parent[x];
    }
    return x;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) {
      parent[ra] = rb;
    } else if (rank[ra] > rank[rb]) {
      parent[rb] = ra;
    } else {
      parent[rb] = ra;
      rank[ra]++;
    }
  }

  // Compare all pairs — O(n^2) but path count per page is typically small
  for (let i = 0; i < paths.length; i++) {
    for (let j = i + 1; j < paths.length; j++) {
      if (boundsOverlap(bounds[i], bounds[j], tolerance)) {
        union(i, j);
      }
    }
  }

  // Collect groups
  const groups = new Map<number, PathElement[]>();
  for (let i = 0; i < paths.length; i++) {
    const root = find(i);
    if (!groups.has(root)) groups.set(root, []);
    groups.get(root)!.push(paths[i]);
  }

  return Array.from(groups.values());
}

/**
 * Convert an RGB (0-1 range) color to a CSS rgba string.
 */
function rgbToCss(color: RGB, alpha: number = 1): string {
  const r = Math.round(Math.min(1, Math.max(0, color.r)) * 255);
  const g = Math.round(Math.min(1, Math.max(0, color.g)) * 255);
  const b = Math.round(Math.min(1, Math.max(0, color.b)) * 255);
  return alpha < 1 ? `rgba(${r},${g},${b},${alpha})` : `rgb(${r},${g},${b})`;
}

/**
 * Rasterize a group of paths to a PNG Uint8Array via OffscreenCanvas.
 *
 * @param paths - The path elements to rasterize (from the same visual cluster)
 * @param scale - Additional scale factor (multiplied with DPI_SCALE)
 * @returns PNG data, and the display width/height in PDF points
 */
export async function rasterizePathGroup(
  paths: PathElement[],
  scale: number = 1.0
): Promise<{ data: Uint8Array; widthPt: number; heightPt: number }> {
  // Compute bounding box across all paths
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
  for (const path of paths) {
    for (const pt of path.points) {
      if (pt.x < minX) minX = pt.x;
      if (pt.y < minY) minY = pt.y;
      if (pt.x > maxX) maxX = pt.x;
      if (pt.y > maxY) maxY = pt.y;
    }
  }

  const widthPt = maxX - minX + PADDING_PT * 2;
  const heightPt = maxY - minY + PADDING_PT * 2;

  // Canvas pixel dimensions with DPI scale
  const totalScale = scale * DPI_SCALE;
  const canvasWidth = Math.ceil(widthPt * totalScale);
  const canvasHeight = Math.ceil(heightPt * totalScale);

  // Guard against degenerate or oversized canvases
  if (canvasWidth <= 0 || canvasHeight <= 0 || canvasWidth > 4096 || canvasHeight > 4096) {
    // Return a 1x1 transparent PNG for degenerate cases
    return { data: new Uint8Array(0), widthPt: 0, heightPt: 0 };
  }

  const canvas = new OffscreenCanvas(canvasWidth, canvasHeight);
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    return { data: new Uint8Array(0), widthPt: 0, heightPt: 0 };
  }

  // Scale and translate to map PDF coords to canvas coords
  ctx.scale(totalScale, totalScale);
  ctx.translate(-minX + PADDING_PT, -minY + PADDING_PT);

  // Draw each path
  for (const path of paths) {
    ctx.beginPath();

    for (const op of path.operations) {
      switch (op.type) {
        case 'moveTo':
          ctx.moveTo(op.args[0], op.args[1]);
          break;
        case 'lineTo':
          ctx.lineTo(op.args[0], op.args[1]);
          break;
        case 'curveTo':
          ctx.bezierCurveTo(
            op.args[0], op.args[1],
            op.args[2], op.args[3],
            op.args[4], op.args[5]
          );
          break;
        case 'closePath':
          ctx.closePath();
          break;
      }
    }

    // Fill first, then stroke (matching PDF rendering order)
    if (path.fillColor) {
      ctx.fillStyle = rgbToCss(path.fillColor);
      ctx.fill();
    }
    if (path.strokeColor) {
      ctx.strokeStyle = rgbToCss(path.strokeColor);
      ctx.lineWidth = path.lineWidth || 1;
      ctx.stroke();
    }
  }

  // Export canvas to PNG
  const blob = await canvas.convertToBlob({ type: 'image/png' });
  const arrayBuffer = await blob.arrayBuffer();
  const data = new Uint8Array(arrayBuffer);

  return { data, widthPt, heightPt };
}
