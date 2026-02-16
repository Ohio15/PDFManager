/**
 * Text Color Extractor — Operator-list-based text color extraction for the viewer pipeline.
 *
 * Mirrors the approach in PageAnalyzer's parseOperatorList() text color map,
 * but produces a format suitable for usePDFDocument.ts to consume.
 *
 * Scans the pdfjs operator list for setFill*Color ops followed by showText/showSpacedText ops,
 * tracking the graphics state stack (save/restore) to correctly attribute colors.
 */

/** pdfjs-dist OPS constants (subset needed for color extraction) */
const OPS = {
  save: 10,
  restore: 11,
  transform: 12,
  rectangle: 19,
  fill: 22,
  eoFill: 23,
  fillStroke: 24,
  eoFillStroke: 25,
  setFillGray: 57,
  setFillRGBColor: 59,
  setFillCMYKColor: 61,
  showText: 36,
  showSpacedText: 37,
  setTextMatrix: 43,
} as const;

export interface TextColorEntry {
  x: number;
  y: number;
  color: { r: number; g: number; b: number };
}

/** Normalize a color component from pdfjs — values > 1 are 0-255 range */
function normalizeComponent(v: number): number {
  return v > 1 ? v / 255 : v;
}

/** Convert CMYK (0-1 range) to RGB (0-1 range) */
function cmykToRgb(c: number, m: number, y: number, k: number): { r: number; g: number; b: number } {
  return {
    r: (1 - c) * (1 - k),
    g: (1 - m) * (1 - k),
    b: (1 - y) * (1 - k),
  };
}

/**
 * Build a text color map from a pdfjs operator list.
 * Returns an array of position+color entries from showText/showSpacedText ops.
 *
 * @param operatorList  The result of page.getOperatorList()
 * @param pageHeight    The page height for Y coordinate flipping
 */
export function buildTextColorMap(
  operatorList: { fnArray: number[]; argsArray: any[] },
  pageHeight: number,
): TextColorEntry[] {
  const { fnArray, argsArray } = operatorList;
  const colorMap: TextColorEntry[] = [];

  // Graphics state
  let fillColor = { r: 0, g: 0, b: 0 };
  const fillColorStack: Array<{ r: number; g: number; b: number }>[] = [];
  let currentStack: Array<{ r: number; g: number; b: number }> = [];

  // Simple CTM tracking for text position
  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack: number[][] = [];
  let textMatrix = [1, 0, 0, 1, 0, 0];

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];

    switch (op) {
      case OPS.save: {
        ctmStack.push([...ctm]);
        currentStack.push({ ...fillColor });
        fillColorStack.push([...currentStack]);
        currentStack = [];
        break;
      }
      case OPS.restore: {
        const prevCtm = ctmStack.pop();
        if (prevCtm) ctm = prevCtm;
        const prevStack = fillColorStack.pop();
        if (prevStack && prevStack.length > 0) {
          fillColor = prevStack[prevStack.length - 1];
          currentStack = prevStack;
        }
        break;
      }
      case OPS.transform: {
        // Simplified: just track translation for position
        const [a, b, c, d, e, f] = args;
        const newCtm = [
          ctm[0] * a + ctm[1] * c,
          ctm[0] * b + ctm[1] * d,
          ctm[2] * a + ctm[3] * c,
          ctm[2] * b + ctm[3] * d,
          ctm[4] * a + ctm[5] * c + e,
          ctm[4] * b + ctm[5] * d + f,
        ];
        ctm = newCtm;
        break;
      }
      case OPS.setFillRGBColor: {
        fillColor = {
          r: normalizeComponent(args[0]),
          g: normalizeComponent(args[1]),
          b: normalizeComponent(args[2]),
        };
        break;
      }
      case OPS.setFillGray: {
        const g = normalizeComponent(args[0]);
        fillColor = { r: g, g: g, b: g };
        break;
      }
      case OPS.setFillCMYKColor: {
        fillColor = cmykToRgb(args[0], args[1], args[2], args[3]);
        break;
      }
      case OPS.setTextMatrix: {
        textMatrix = [args[0], args[1], args[2], args[3], args[4], args[5]];
        break;
      }
      case OPS.showText:
      case OPS.showSpacedText: {
        // Record the fill color at the current text position
        const tx = textMatrix[4];
        const ty = pageHeight - textMatrix[5];
        colorMap.push({
          x: tx,
          y: ty,
          color: { ...fillColor },
        });
        break;
      }
    }
  }

  return colorMap;
}

/**
 * Match a text item to the closest color entry using Euclidean distance.
 *
 * @param itemX       X position of the text item
 * @param itemY       Y position of the text item (top-left origin)
 * @param fontSize    Font size for distance tolerance
 * @param colorMap    The color map built from buildTextColorMap()
 * @returns The matched RGB color, or default black
 */
export function matchTextColor(
  itemX: number,
  itemY: number,
  fontSize: number,
  colorMap: TextColorEntry[],
): { r: number; g: number; b: number } {
  if (colorMap.length === 0) return { r: 0, g: 0, b: 0 };

  const tolerance = fontSize * 2; // match PageAnalyzer's tolerance
  let bestDist = Infinity;
  let bestColor = { r: 0, g: 0, b: 0 };

  for (const entry of colorMap) {
    const dx = itemX - entry.x;
    const dy = itemY - entry.y;
    const dist = Math.sqrt(dx * dx + dy * dy);
    if (dist < bestDist && dist <= tolerance) {
      bestDist = dist;
      bestColor = entry.color;
    }
  }

  return bestColor;
}

// ─── Background Color Extraction (from filled rectangles in operator list) ────

export interface FilledRect {
  x: number;
  y: number;
  width: number;
  height: number;
  color: { r: number; g: number; b: number };
}

/**
 * Build a map of filled rectangles from a pdfjs operator list.
 * These represent background colors behind text — extracted directly from
 * the content stream instead of rendering to canvas.
 *
 * Tracks the graphics state (save/restore, transform, fill color) and records
 * each filled rectangle with its position and active fill color.
 *
 * @param operatorList  The result of page.getOperatorList()
 * @param pageHeight    The page height for Y coordinate flipping
 */
export function buildFilledRectMap(
  operatorList: { fnArray: number[]; argsArray: any[] },
  pageHeight: number,
): FilledRect[] {
  const { fnArray, argsArray } = operatorList;
  const rects: FilledRect[] = [];

  // Graphics state
  let fillColor = { r: 0, g: 0, b: 0 };
  const fillColorStack: Array<{ r: number; g: number; b: number }>[] = [];
  let currentStack: Array<{ r: number; g: number; b: number }> = [];

  // CTM tracking for coordinate transforms
  let ctm = [1, 0, 0, 1, 0, 0];
  const ctmStack: number[][] = [];

  // Pending rectangle (set by rectangle op, consumed by fill op)
  let pendingRect: { x: number; y: number; w: number; h: number } | null = null;

  for (let i = 0; i < fnArray.length; i++) {
    const op = fnArray[i];
    const args = argsArray[i];

    switch (op) {
      case OPS.save: {
        ctmStack.push([...ctm]);
        currentStack.push({ ...fillColor });
        fillColorStack.push([...currentStack]);
        currentStack = [];
        break;
      }
      case OPS.restore: {
        const prevCtm = ctmStack.pop();
        if (prevCtm) ctm = prevCtm;
        const prevStack = fillColorStack.pop();
        if (prevStack && prevStack.length > 0) {
          fillColor = prevStack[prevStack.length - 1];
          currentStack = prevStack;
        }
        pendingRect = null;
        break;
      }
      case OPS.transform: {
        const [a, b, c, d, e, f] = args;
        ctm = [
          ctm[0] * a + ctm[1] * c,
          ctm[0] * b + ctm[1] * d,
          ctm[2] * a + ctm[3] * c,
          ctm[2] * b + ctm[3] * d,
          ctm[4] * a + ctm[5] * c + e,
          ctm[4] * b + ctm[5] * d + f,
        ];
        break;
      }
      case OPS.setFillRGBColor: {
        fillColor = {
          r: normalizeComponent(args[0]),
          g: normalizeComponent(args[1]),
          b: normalizeComponent(args[2]),
        };
        break;
      }
      case OPS.setFillGray: {
        const g = normalizeComponent(args[0]);
        fillColor = { r: g, g: g, b: g };
        break;
      }
      case OPS.setFillCMYKColor: {
        fillColor = cmykToRgb(args[0], args[1], args[2], args[3]);
        break;
      }
      case OPS.rectangle: {
        // Record pending rectangle in user space
        pendingRect = { x: args[0], y: args[1], w: args[2], h: args[3] };
        break;
      }
      case OPS.fill:
      case OPS.eoFill:
      case OPS.fillStroke:
      case OPS.eoFillStroke: {
        if (pendingRect) {
          // Transform rectangle corners through CTM
          const x0 = pendingRect.x * ctm[0] + pendingRect.y * ctm[2] + ctm[4];
          const y0 = pendingRect.x * ctm[1] + pendingRect.y * ctm[3] + ctm[5];
          const x1 = (pendingRect.x + pendingRect.w) * ctm[0] + (pendingRect.y + pendingRect.h) * ctm[2] + ctm[4];
          const y1 = (pendingRect.x + pendingRect.w) * ctm[1] + (pendingRect.y + pendingRect.h) * ctm[3] + ctm[5];

          const minX = Math.min(x0, x1);
          const maxX = Math.max(x0, x1);
          const minY = Math.min(y0, y1);
          const maxY = Math.max(y0, y1);

          const width = maxX - minX;
          const height = maxY - minY;

          // Only record rects large enough to be a background (> 5pt in both dimensions)
          if (width > 5 && height > 5) {
            rects.push({
              x: minX,
              y: pageHeight - maxY, // flip to top-left origin
              width,
              height,
              color: { ...fillColor },
            });
          }
        }
        pendingRect = null;
        break;
      }
    }
  }

  return rects;
}

/**
 * Find the background color at a given text position from the filled rect map.
 * Returns the fill color of the smallest containing rectangle (most specific background),
 * or default white if no rectangle contains the position.
 *
 * @param itemX     X position of the text item
 * @param itemY     Y position of the text item (top-left origin)
 * @param itemW     Width of the text item
 * @param itemH     Height of the text item
 * @param rectMap   The filled rect map built from buildFilledRectMap()
 * @returns The background RGB color (0-1 range), default white
 */
export function matchBackgroundColor(
  itemX: number,
  itemY: number,
  itemW: number,
  itemH: number,
  rectMap: FilledRect[],
): { r: number; g: number; b: number } {
  if (rectMap.length === 0) return { r: 1, g: 1, b: 1 };

  // Find the smallest containing rect (most specific background)
  let bestArea = Infinity;
  let bestColor = { r: 1, g: 1, b: 1 }; // default white
  const tolerance = 2; // 2pt tolerance for containment

  const centerX = itemX + itemW / 2;
  const centerY = itemY + itemH / 2;

  for (const rect of rectMap) {
    // Check if the text center is inside this filled rect
    if (
      centerX >= rect.x - tolerance &&
      centerX <= rect.x + rect.width + tolerance &&
      centerY >= rect.y - tolerance &&
      centerY <= rect.y + rect.height + tolerance
    ) {
      const area = rect.width * rect.height;
      if (area < bestArea) {
        bestArea = area;
        bestColor = rect.color;
      }
    }
  }

  return bestColor;
}
