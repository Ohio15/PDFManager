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

  const tolerance = fontSize * 3; // generous tolerance
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
