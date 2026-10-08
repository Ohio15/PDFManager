/**
 * Page scanner over pdf.js's operator list.
 *
 * pdf.js decodes fonts (encodings, CMaps, widths, Type3) independently of our
 * fontModel, so walking its operator list gives an independent view of where
 * every glyph, path point and image actually lands on the page. It is used:
 *   - as the verification oracle after redaction (redactionVerifier.ts), and
 *   - to locate search terms precisely for search-and-redact (textSearch.ts).
 *
 * Geometry mirrors pdf.js's CanvasGraphics (src/display/canvas.js) so the
 * positions match what pdf.js renders.
 */
import type { PDFPageProxy } from 'pdfjs-dist';
import { IDENTITY, Matrix, Point, Rect, applyToPoint, boundsOfPoints, multiply, pointInAny } from './geometry';
import { getPdfjsObject, PdfjsImageData } from './pdfjsEnv';

export interface ScannedGlyph {
  unicode: string;
  isSpace: boolean;
  /** Axis-aligned bounds of the glyph box in page user space. */
  box: Rect;
  /** Centre of the glyph box in user space. */
  center: Point;
  /** Baseline start/end points (user space) — used to group glyphs into lines. */
  baseline: { start: Point; end: Point };
  /** Effective font size in user space (length of the text-space y axis). */
  size: number;
}

export interface ScannedImage {
  kind: 'xobject' | 'inline' | 'mask' | 'group';
  /** Placement: maps the image unit square to user space. */
  ctm: Matrix;
  bounds: Rect;
  load: () => Promise<PdfjsImageData | null>;
}

export interface ScannedPath {
  points: Point[];
}

export interface PageScan {
  glyphs: ScannedGlyph[];
  images: ScannedImage[];
  paths: ScannedPath[];
  /**
   * Content the scan could NOT examine (e.g. text shown in a font pdf.js failed
   * to load). Fail closed: a verifier must treat any entry as a violation,
   * never as "nothing found".
   */
  unexamined: string[];
}

interface TextState {
  ctm: Matrix;
  textMatrix: Matrix;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  font: PdfjsFont | null;
  fontSize: number;
  fontDirection: number;
  charSpacing: number;
  wordSpacing: number;
  textHScale: number;
  leading: number;
  textRise: number;
}

interface PdfjsFont {
  fontMatrix?: number[];
  ascent?: number;
  descent?: number;
  vertical?: boolean;
}

interface PdfjsGlyph {
  unicode: string;
  width: number;
  isSpace: boolean;
}

const UNIT_SQUARE: Rect = { x0: 0, y0: 0, x1: 1, y1: 1 };

function cloneState(s: TextState): TextState {
  return { ...s, ctm: [...s.ctm] as Matrix, textMatrix: [...s.textMatrix] as Matrix };
}

export interface ScanOptions {
  /**
   * Redaction marks (user space). Zero-size text has no glyph box to test, so
   * when marks are given a zero-size run whose glyph ORIGIN lies under a mark
   * is reported as unexamined (the verifier then fails closed); without marks
   * every zero-size run is reported.
   */
  marks?: Rect[];
}

export async function scanPdfjsPage(page: PDFPageProxy, OPS: Record<string, number>, options: ScanOptions = {}): Promise<PageScan> {
  // DISABLE (0): annotation appearances are checked separately via getAnnotations.
  const opList = await page.getOperatorList({ annotationMode: 0 } as never);
  const fontCache = new Map<string, PdfjsFont | null>();

  const glyphs: ScannedGlyph[] = [];
  const images: ScannedImage[] = [];
  const paths: ScannedPath[] = [];
  const unexamined: string[] = [];

  let st: TextState = {
    ctm: [...IDENTITY] as Matrix,
    textMatrix: [...IDENTITY] as Matrix,
    x: 0, y: 0, lineX: 0, lineY: 0,
    font: null, fontSize: 0, fontDirection: 1,
    charSpacing: 0, wordSpacing: 0, textHScale: 1, leading: 0, textRise: 0,
  };
  const stack: TextState[] = [];

  const op = (name: string) => OPS[name];

  const getFont = async (name: string): Promise<PdfjsFont | null> => {
    if (fontCache.has(name)) return fontCache.get(name)!;
    let font: PdfjsFont | null = null;
    try {
      // Fonts always live in commonObjs.
      font = await getPdfjsObject<PdfjsFont>(page as never, name, true);
    } catch {
      font = null;
    }
    fontCache.set(name, font);
    return font;
  };

  const moveText = (x: number, y: number) => {
    st.lineX += x;
    st.lineY += y;
    st.x = st.lineX;
    st.y = st.lineY;
  };

  const showGlyphs = (items: Array<PdfjsGlyph | number | null>) => {
    const font = st.font;
    const fontSize = st.fontSize;
    if (fontSize === 0) {
      zeroSizeRun(items);
      return;
    }
    if (!font) {
      // Glyph positions are unknowable without the font; the run is unexamined.
      if (items.some((g) => g !== null && g !== undefined && typeof g !== 'number')) {
        unexamined.push('Text drawn with a font that could not be loaded');
      }
      return;
    }
    const fm = font.fontMatrix ?? [0.001, 0, 0, 0.001, 0, 0];
    const widthAdvanceScale = fontSize * fm[0];
    const hScale = st.textHScale * st.fontDirection;
    const vertical = !!font.vertical;
    const ascent = typeof font.ascent === 'number' && font.ascent > 0 ? font.ascent : 0.8;
    const descent = typeof font.descent === 'number' && font.descent < 0 ? font.descent : -0.2;
    const toUser = multiply(st.textMatrix, st.ctm);
    const size = Math.hypot(toUser[2], toUser[3]) * fontSize;

    let x = 0;
    for (const g of items) {
      if (g === null || g === undefined) continue;
      if (typeof g === 'number') {
        x += ((vertical ? 1 : -1) * g * fontSize) / 1000;
        continue;
      }
      const spacing = (g.isSpace ? st.wordSpacing : 0) + st.charSpacing;
      const advance = g.width * widthAdvanceScale;
      let corners: Point[];
      let baseStart: Point;
      let baseEnd: Point;
      if (!vertical) {
        const ox = st.x + x * hScale;
        const oy = st.y + st.textRise;
        const w = advance * hScale;
        const top = st.fontDirection > 0 ? ascent * fontSize : -descent * fontSize;
        const bottom = st.fontDirection > 0 ? descent * fontSize : -ascent * fontSize;
        corners = [
          { x: ox, y: oy + bottom }, { x: ox + w, y: oy + bottom },
          { x: ox, y: oy + top }, { x: ox + w, y: oy + top },
        ];
        baseStart = { x: ox, y: oy };
        baseEnd = { x: ox + w, y: oy };
        x += advance + spacing * st.fontDirection;
      } else {
        const oy = st.y - x;
        const ox = st.x;
        corners = [
          { x: ox - fontSize / 2, y: oy - advance }, { x: ox + fontSize / 2, y: oy - advance },
          { x: ox - fontSize / 2, y: oy }, { x: ox + fontSize / 2, y: oy },
        ];
        baseStart = { x: ox, y: oy };
        baseEnd = { x: ox, y: oy - advance };
        x += advance - spacing * st.fontDirection;
      }
      const userCorners = corners.map((p) => applyToPoint(toUser, p.x, p.y));
      const box = boundsOfPoints(userCorners)!;
      glyphs.push({
        unicode: g.unicode ?? '',
        isSpace: !!g.isSpace,
        box,
        center: { x: (box.x0 + box.x1) / 2, y: (box.y0 + box.y1) / 2 },
        baseline: { start: applyToPoint(toUser, baseStart.x, baseStart.y), end: applyToPoint(toUser, baseEnd.x, baseEnd.y) },
        size,
      });
    }
    if (vertical) st.y -= x;
    else st.x += x * hScale;
  };

  // Zero-size text paints nothing but pdf.js, pdftotext and Acrobat still
  // extract it. Glyph boxes collapse to the origin, so locate each origin
  // (advances are zero; only Tc/Tw spacing moves the pen).
  const zeroSizeRun = (items: Array<PdfjsGlyph | number | null>) => {
    if (!items.some((g) => g !== null && g !== undefined && typeof g !== 'number')) return;
    if (!options.marks) {
      unexamined.push('Zero-size (invisible but extractable) text');
      return;
    }
    const vertical = !!st.font?.vertical;
    const hScale = st.textHScale * st.fontDirection;
    const toUser = multiply(st.textMatrix, st.ctm);
    let x = 0;
    let underMark = false;
    for (const g of items) {
      if (g === null || g === undefined || typeof g === 'number') continue;
      const origin = vertical ? applyToPoint(toUser, st.x, st.y - x) : applyToPoint(toUser, st.x + x * hScale, st.y + st.textRise);
      if (pointInAny(origin, options.marks)) underMark = true;
      x += ((g.isSpace ? st.wordSpacing : 0) + st.charSpacing) * (vertical ? -st.fontDirection : st.fontDirection);
    }
    if (vertical) st.y -= x;
    else st.x += x * hScale;
    if (underMark) unexamined.push('Zero-size (invisible but extractable) text under a mark');
  };

  const addImage = (kind: ScannedImage['kind'], ctm: Matrix, load: ScannedImage['load']) => {
    const corners = [
      applyToPoint(ctm, 0, 0), applyToPoint(ctm, 1, 0), applyToPoint(ctm, 0, 1), applyToPoint(ctm, 1, 1),
    ];
    images.push({ kind, ctm, bounds: boundsOfPoints(corners)!, load });
  };

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = argsArray[i] as unknown[];
    switch (fn) {
      case op('save'):
        stack.push(cloneState(st));
        break;
      case op('restore'):
        if (stack.length) st = stack.pop()!;
        break;
      case op('transform'):
        st.ctm = multiply(args as unknown as Matrix, st.ctm);
        break;
      case op('paintFormXObjectBegin'): {
        stack.push(cloneState(st));
        const m = args[0] as number[] | null;
        if (Array.isArray(m) && m.length === 6) st.ctm = multiply(m as Matrix, st.ctm);
        break;
      }
      case op('paintFormXObjectEnd'):
        if (stack.length) st = stack.pop()!;
        break;
      case op('beginText'):
        st.textMatrix = [...IDENTITY] as Matrix;
        st.x = st.lineX = 0;
        st.y = st.lineY = 0;
        break;
      case op('setFont'): {
        const name = args[0] as string;
        let size = args[1] as number;
        st.font = await getFont(name);
        if (size < 0) {
          size = -size;
          st.fontDirection = -1;
        } else {
          st.fontDirection = 1;
        }
        st.fontSize = size;
        break;
      }
      case op('setTextMatrix'): {
        const m = (Array.isArray(args[0]) ? args[0] : args) as number[];
        st.textMatrix = [m[0], m[1], m[2], m[3], m[4], m[5]];
        st.x = st.lineX = 0;
        st.y = st.lineY = 0;
        break;
      }
      case op('moveText'):
        moveText(args[0] as number, args[1] as number);
        break;
      case op('setLeadingMoveText'):
        st.leading = args[1] as number;
        moveText(args[0] as number, args[1] as number);
        break;
      case op('nextLine'):
        moveText(0, st.leading);
        break;
      case op('setLeading'):
        st.leading = -(args[0] as number);
        break;
      case op('setCharSpacing'):
        st.charSpacing = args[0] as number;
        break;
      case op('setWordSpacing'):
        st.wordSpacing = args[0] as number;
        break;
      case op('setHScale'):
        st.textHScale = (args[0] as number) / 100;
        break;
      case op('setTextRise'):
        st.textRise = args[0] as number;
        break;
      case op('showText'):
      case op('showSpacedText'):
        showGlyphs(args[0] as Array<PdfjsGlyph | number>);
        break;
      case op('nextLineShowText'):
        moveText(0, st.leading);
        showGlyphs(args[0] as Array<PdfjsGlyph | number>);
        break;
      case op('nextLineSetSpacingShowText'):
        moveText(0, st.leading);
        st.wordSpacing = args[0] as number;
        st.charSpacing = args[1] as number;
        showGlyphs(args[2] as Array<PdfjsGlyph | number>);
        break;
      case op('constructPath'): {
        const ops = args[0] as number[];
        const coords = args[1] as number[];
        const pts: Point[] = [];
        let j = 0;
        let cx = 0;
        let cy = 0;
        for (const o of ops) {
          if (o === op('rectangle')) {
            const x = coords[j++], y = coords[j++], w = coords[j++], h = coords[j++];
            pts.push(applyToPoint(st.ctm, x, y), applyToPoint(st.ctm, x + w, y), applyToPoint(st.ctm, x + w, y + h), applyToPoint(st.ctm, x, y + h));
            cx = x; cy = y;
          } else if (o === op('moveTo') || o === op('lineTo')) {
            cx = coords[j++]; cy = coords[j++];
            pts.push(applyToPoint(st.ctm, cx, cy));
          } else if (o === op('curveTo')) {
            for (let k = 0; k < 3; k++) pts.push(applyToPoint(st.ctm, coords[j + 2 * k], coords[j + 2 * k + 1]));
            cx = coords[j + 4]; cy = coords[j + 5];
            j += 6;
          } else if (o === op('curveTo2') || o === op('curveTo3')) {
            pts.push(applyToPoint(st.ctm, coords[j], coords[j + 1]), applyToPoint(st.ctm, coords[j + 2], coords[j + 3]));
            cx = coords[j + 2]; cy = coords[j + 3];
            j += 4;
          }
        }
        void cx; void cy;
        if (pts.length) paths.push({ points: pts });
        break;
      }
      case op('paintImageXObject'): {
        const objId = args[0] as string;
        addImage('xobject', [...st.ctm] as Matrix, () => getPdfjsObject<PdfjsImageData>(page as never, objId).catch(() => null));
        break;
      }
      case op('paintInlineImageXObject'): {
        const img = args[0] as PdfjsImageData;
        addImage('inline', [...st.ctm] as Matrix, async () => img);
        break;
      }
      case op('paintImageMaskXObject'): {
        const img = args[0] as PdfjsImageData;
        addImage('mask', [...st.ctm] as Matrix, async () => img);
        break;
      }
      case op('paintImageXObjectRepeat'): {
        const objId = args[0] as string;
        const scaleX = args[1] as number;
        const scaleY = args[2] as number;
        const positions = args[3] as number[];
        for (let k = 0; k < positions.length; k += 2) {
          const m = multiply([scaleX, 0, 0, scaleY, positions[k], positions[k + 1]], st.ctm);
          addImage('xobject', m, () => getPdfjsObject<PdfjsImageData>(page as never, objId).catch(() => null));
        }
        break;
      }
      // Batched small images. Each member gets its exact placement; pixel data
      // is not inspected (load → null), so the verifier treats any member that
      // touches a mark as unverifiable and escalates the page to rasterization.
      case op('paintImageMaskXObjectGroup'): {
        const group = (args[0] ?? []) as Array<{ transform?: number[] }>;
        for (const member of group) {
          const t = member.transform && member.transform.length === 6 ? (member.transform as Matrix) : IDENTITY;
          addImage('group', multiply(t, st.ctm), async () => null);
        }
        break;
      }
      case op('paintInlineImageXObjectGroup'): {
        const map = (args[1] ?? []) as Array<{ transform?: number[] }>;
        for (const entry of map) {
          const t = entry.transform && entry.transform.length === 6 ? (entry.transform as Matrix) : IDENTITY;
          addImage('group', multiply(t, st.ctm), async () => null);
        }
        break;
      }
      case op('paintImageMaskXObjectRepeat'): {
        const scaleX = args[1] as number, skewX = args[2] as number, skewY = args[3] as number, scaleY = args[4] as number;
        const positions = (args[5] ?? []) as number[];
        for (let k = 0; k < positions.length; k += 2) {
          addImage('group', multiply([scaleX, skewX, skewY, scaleY, positions[k], positions[k + 1]], st.ctm), async () => null);
        }
        break;
      }
      case op('shadingFill'):
        // Painted area is the current clip, which this scan does not model.
        unexamined.push('Shading fill whose painted area cannot be bounded');
        break;
      case op('paintSolidColorImageMask'):
        addImage('group', [...st.ctm] as Matrix, async () => null);
        break;
      default:
        break;
    }
  }

  return { glyphs, images, paths, unexamined };
}

export { UNIT_SQUARE };
