/**
 * Page scanner over pdf.js's operator list.
 *
 * pdf.js decodes fonts (encodings, CMaps, widths, Type3) independently of our
 * fontModel, so walking its operator list gives an independent view of where
 * every glyph, path segment and image actually lands on the page. It is used:
 *   - as the verification oracle after redaction (redactionVerifier.ts), and
 *   - to locate search terms precisely for search-and-redact (textSearch.ts).
 *
 * Geometry mirrors pdf.js's CanvasGraphics (src/display/canvas.js) so the
 * positions match what pdf.js renders.
 *
 * Fail closed: whatever the scan cannot place exactly (text in a font pdf.js
 * could not load, fonts set through an ExtGState, Type3 glyph procedures,
 * zero-size text, unbounded shadings) is reported in `unexamined` with a
 * named reason. An empty glyph list never means "nothing there" by itself.
 */
import type { PDFPageProxy } from 'pdfjs-dist';
import {
  IDENTITY,
  Matrix,
  Point,
  Rect,
  applyToPoint,
  boundsOfPoints,
  flattenCubic,
  intersectsAny,
  multiply,
  pointInAny,
  unionRect,
} from './geometry';
import { getPdfjsObject, PdfjsImageData, readOperatorListStrict } from './pdfjsEnv';

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
  /**
   * One polyline per subpath, in user space: straight segments as given,
   * Bezier curves flattened, rectangles and closed subpaths closed. A path is
   * under a mark when any SEGMENT enters it, not only when a vertex does.
   */
  subpaths: Point[][];
  /**
   * False only when the path is provably not painted (it ends in `n`, possibly
   * after a clip): such a path puts no ink anywhere, so only its coordinates
   * count. Anything else is treated as painted.
   */
  painted: boolean;
}

/**
 * Why the scan could not examine something. Every value is a named FAIL
 * reason for the verifier; none of them may ever read as "nothing found".
 */
export type UnexaminedReason =
  | 'font-unloadable'
  | 'extgstate-font'
  | 'type3-font-under-mark'
  | 'zero-size-text'
  | 'shading-unbounded';

export interface UnexaminedEntry {
  reason: UnexaminedReason;
  detail: string;
}

export interface PageScan {
  glyphs: ScannedGlyph[];
  images: ScannedImage[];
  paths: ScannedPath[];
  /**
   * Content the scan could NOT examine. Fail closed: a verifier must treat any
   * entry as a failure, never as "nothing found".
   */
  unexamined: UnexaminedEntry[];
}

interface TextState {
  ctm: Matrix;
  textMatrix: Matrix;
  x: number;
  y: number;
  lineX: number;
  lineY: number;
  font: PdfjsFont | null;
  /** Where the current font came from: a Tf operator or an ExtGState /Font entry. */
  fontSource: 'Tf' | 'ExtGState' | null;
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
  isType3Font?: boolean;
  /** FontBBox in glyph space. */
  bbox?: number[];
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

function hasGlyphs(items: Array<PdfjsGlyph | number | null | undefined>): boolean {
  return items.some((g) => g !== null && g !== undefined && typeof g !== 'number');
}

export interface ScanOptions {
  /**
   * Redaction marks (user space). Zero-size text has no glyph box to test, so
   * when marks are given a zero-size run whose glyph ORIGIN lies under a mark
   * is reported as unexamined (the verifier then fails closed); without marks
   * every zero-size run is reported. Type3 text is reported only when it
   * intersects a mark, so it is never reported without marks.
   */
  marks?: Rect[];
  /**
   * Verification mode: read the operator list so that a pdf.js evaluator
   * error REJECTS (see readOperatorListStrict) instead of yielding a
   * truncated list that reads as clean. Use with a document opened strict.
   */
  strict?: boolean;
}

export async function scanPdfjsPage(page: PDFPageProxy, OPS: Record<string, number>, options: ScanOptions = {}): Promise<PageScan> {
  // DISABLE (0): annotation appearances are checked separately via getAnnotations.
  const opList = options.strict ? await readOperatorListStrict(page, 0) : await page.getOperatorList({ annotationMode: 0 } as never);
  const fontCache = new Map<string, PdfjsFont | null>();

  const glyphs: ScannedGlyph[] = [];
  const images: ScannedImage[] = [];
  const paths: ScannedPath[] = [];
  const unexamined: UnexaminedEntry[] = [];
  const flag = (reason: UnexaminedReason, detail: string) => unexamined.push({ reason, detail });
  const marks = options.marks;

  // Union of the glyph boxes of the current text object (BT..ET) and whether
  // it showed any Type3 glyph: Type3 ink is drawn by glyph procedures this
  // scan does not model, so the whole text object must stay clear of marks.
  let textObjectBox: Rect | null = null;
  let textObjectType3 = false;
  let textObjectType3Flagged = false;

  let st: TextState = {
    ctm: [...IDENTITY] as Matrix,
    textMatrix: [...IDENTITY] as Matrix,
    x: 0, y: 0, lineX: 0, lineY: 0,
    font: null, fontSource: null, fontSize: 0, fontDirection: 1,
    charSpacing: 0, wordSpacing: 0, textHScale: 1, leading: 0, textRise: 0,
  };
  const stack: TextState[] = [];
  // Path cursor in the coordinates pdf.js passes, before the CTM (it persists
  // across constructPath operations, as in pdf.js's canvas).
  let pathX = 0;
  let pathY = 0;

  const op = (name: string) => OPS[name];

  const getFont = async (name: string): Promise<PdfjsFont | null> => {
    if (fontCache.has(name)) return fontCache.get(name)!;
    let font: PdfjsFont | null = null;
    try {
      // Fonts always live in commonObjs. A font pdf.js failed to load (its
      // worker-side ErrorFont) resolves to the error STRING, not an object,
      // and shows no glyphs at all; it must read as unloadable, not as empty.
      const data = await getPdfjsObject<unknown>(page as never, name, true);
      font = data !== null && typeof data === 'object' ? (data as PdfjsFont) : null;
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

  const flagType3 = () => {
    if (textObjectType3Flagged) return;
    textObjectType3Flagged = true;
    flag('type3-font-under-mark', 'Type3 font text (glyph procedures are not modelled) intersects a mark');
  };

  const showGlyphs = (raw: Array<PdfjsGlyph | number | null> | null | undefined) => {
    const font = st.font;
    const fontSize = st.fontSize;
    if (!font) {
      // An unloadable font (pdf.js ErrorFont) yields NO glyph entries at all,
      // so the run's content and position are unknowable: any show operator
      // in such a font is unexamined, whatever its argument looks like.
      flag('font-unloadable', 'Text drawn with a font that could not be loaded');
      return;
    }
    const items = Array.isArray(raw) ? raw : [];
    if (st.fontSource === 'ExtGState' && hasGlyphs(items)) {
      // A font selected by an ExtGState /Font entry bypasses Tf; the redactor
      // and this oracle would share any modelling gap there, so it is not an
      // independent check. Located (for search) but never passed as clean.
      flag('extgstate-font', 'Text drawn with a font set by an ExtGState /Font entry');
    }
    if (fontSize === 0) {
      zeroSizeRun(items);
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
      textObjectBox = unionRect(textObjectBox, box);
      if (font.isType3Font) {
        textObjectType3 = true;
        // The advance box says nothing about where a glyph procedure paints;
        // widen it by the declared FontBBox. A FontBBox with no area bounds
        // nothing, so on a marked page such a glyph counts as under a mark.
        const reach = type3Reach(font, baseStart, fontSize, hScale, toUser);
        if (reach) textObjectBox = unionRect(textObjectBox, reach);
        if (marks && marks.length && (!reach || intersectsAny(unionRect(box, reach), marks))) flagType3();
      }
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
    if (!hasGlyphs(items)) return;
    if (!options.marks) {
      flag('zero-size-text', 'Zero-size (invisible but extractable) text');
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
    if (underMark) flag('zero-size-text', 'Zero-size (invisible but extractable) text under a mark');
  };

  const addImage = (kind: ScannedImage['kind'], ctm: Matrix, load: ScannedImage['load']) => {
    const corners = [
      applyToPoint(ctm, 0, 0), applyToPoint(ctm, 1, 0), applyToPoint(ctm, 0, 1), applyToPoint(ctm, 1, 1),
    ];
    images.push({ kind, ctm, bounds: boundsOfPoints(corners)!, load });
  };

  const constructPath = (ops: number[], coords: number[], painted: boolean) => {
    const at = (x: number, y: number) => applyToPoint(st.ctm, x, y);
    const subpaths: Point[][] = [];
    let current: Point[] | null = null;
    let j = 0;
    const lastPoint = (): Point => (current && current.length ? current[current.length - 1] : at(pathX, pathY));
    const extend = (pts: Point[]) => {
      if (!current) {
        // A segment with no open subpath starts at the path cursor.
        current = [at(pathX, pathY)];
        subpaths.push(current);
      }
      current.push(...pts);
    };
    for (const o of ops) {
      if (o === op('rectangle')) {
        const x = coords[j++], y = coords[j++], w = coords[j++], h = coords[j++];
        const first = at(x, y);
        subpaths.push([first, at(x + w, y), at(x + w, y + h), at(x, y + h), first]);
        current = null;
        pathX = x;
        pathY = y;
      } else if (o === op('moveTo')) {
        pathX = coords[j++];
        pathY = coords[j++];
        current = [at(pathX, pathY)];
        subpaths.push(current);
      } else if (o === op('lineTo')) {
        const x = coords[j++], y = coords[j++];
        extend([at(x, y)]);
        pathX = x;
        pathY = y;
      } else if (o === op('curveTo')) {
        const p0 = lastPoint();
        extend(flattenCubic(p0, at(coords[j], coords[j + 1]), at(coords[j + 2], coords[j + 3]), at(coords[j + 4], coords[j + 5])));
        pathX = coords[j + 4];
        pathY = coords[j + 5];
        j += 6;
      } else if (o === op('curveTo2')) {
        // `v`: the first control point is the current point.
        const p0 = lastPoint();
        extend(flattenCubic(p0, p0, at(coords[j], coords[j + 1]), at(coords[j + 2], coords[j + 3])));
        pathX = coords[j + 2];
        pathY = coords[j + 3];
        j += 4;
      } else if (o === op('curveTo3')) {
        // `y`: the second control point is the end point.
        const p0 = lastPoint();
        const end = at(coords[j + 2], coords[j + 3]);
        extend(flattenCubic(p0, at(coords[j], coords[j + 1]), end, end));
        pathX = coords[j + 2];
        pathY = coords[j + 3];
        j += 4;
      } else if (o === op('closePath')) {
        const open = current as Point[] | null;
        if (open && open.length) open.push(open[0]);
      }
    }
    if (subpaths.length) paths.push({ subpaths, painted });
  };

  const { fnArray, argsArray } = opList;
  for (let i = 0; i < fnArray.length; i++) {
    const fn = fnArray[i];
    const args = (argsArray[i] ?? []) as unknown[];
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
        textObjectBox = null;
        textObjectType3 = false;
        textObjectType3Flagged = false;
        break;
      case op('endText'):
        if (textObjectType3 && textObjectBox && marks && intersectsAny(textObjectBox, marks)) flagType3();
        textObjectBox = null;
        textObjectType3 = false;
        break;
      case op('setFont'): {
        const name = args[0] as string;
        let size = args[1] as number;
        st.font = await getFont(name);
        st.fontSource = 'Tf';
        if (size < 0) {
          size = -size;
          st.fontDirection = -1;
        } else {
          st.fontDirection = 1;
        }
        st.fontSize = size;
        break;
      }
      case op('setGState'): {
        // pdf.js resolves an ExtGState /Font entry to ["Font", [loadedName, size]].
        for (const entry of (args[0] ?? []) as unknown[]) {
          if (!Array.isArray(entry) || entry[0] !== 'Font') continue;
          const value = entry[1] as unknown;
          const loadedName = Array.isArray(value) && typeof value[0] === 'string' ? value[0] : null;
          let size = Array.isArray(value) && typeof value[1] === 'number' ? value[1] : 0;
          st.font = loadedName ? await getFont(loadedName) : null;
          st.fontSource = 'ExtGState';
          st.fontDirection = size < 0 ? -1 : 1;
          if (size < 0) size = -size;
          st.fontSize = size;
        }
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
        // Painted unless the next non-clip operator is endPath (`n`).
        let k = i + 1;
        while (k < fnArray.length && (fnArray[k] === op('clip') || fnArray[k] === op('eoClip'))) k++;
        constructPath((args[0] ?? []) as number[], (args[1] ?? []) as number[], !(k < fnArray.length && fnArray[k] === op('endPath')));
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
        flag('shading-unbounded', 'Shading fill whose painted area cannot be bounded');
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

/**
 * User-space box a Type3 glyph's FontBBox covers when the glyph is drawn at
 * text-space origin `origin`, or null when the FontBBox bounds nothing (absent
 * or zero area — allowed by the spec, and then it says nothing about the ink).
 */
function type3Reach(font: PdfjsFont, origin: Point, fontSize: number, hScale: number, toUser: Matrix): Rect | null {
  const bbox = font.bbox;
  if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every((n) => Number.isFinite(n))) return null;
  const x0 = Math.min(bbox[0], bbox[2]), x1 = Math.max(bbox[0], bbox[2]);
  const y0 = Math.min(bbox[1], bbox[3]), y1 = Math.max(bbox[1], bbox[3]);
  if (!(x1 > x0 && y1 > y0)) return null;
  const fm = font.fontMatrix && font.fontMatrix.length === 6 ? (font.fontMatrix as Matrix) : ([0.001, 0, 0, 0.001, 0, 0] as Matrix);
  const corners = [applyToPoint(fm, x0, y0), applyToPoint(fm, x1, y0), applyToPoint(fm, x0, y1), applyToPoint(fm, x1, y1)].map((g) =>
    applyToPoint(toUser, origin.x + g.x * fontSize * hScale, origin.y + g.y * fontSize)
  );
  return boundsOfPoints(corners);
}

export { UNIT_SQUARE };
