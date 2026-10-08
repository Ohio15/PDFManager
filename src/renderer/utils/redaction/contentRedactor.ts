/**
 * Content-stream redactor.
 *
 * Interprets a content stream with full graphics/text state (CTM, text matrix,
 * font metrics, Tc/Tw/Tz/Ts) and rewrites ONLY the operations that put data
 * under a redaction mark:
 *
 *  - Text: each shown glyph gets a box (advance × ascent/descent through the
 *    text rendering matrix). Glyphs whose box (shrunk 10% horizontally, 20%
 *    vertically, so a mark on one line does not eat its neighbours) overlaps a
 *    mark are removed. The show operator is rewritten as a TJ array in which
 *    every removed glyph is replaced by the equivalent numeric displacement,
 *    so kept glyphs — on both sides, in TJ arrays per glyph — stay exactly where
 *    they were.
 *  - Vector paths: a subpath with ALL its points inside marks is removed. A
 *    subpath that crosses a mark boundary (some control points inside, some
 *    outside — e.g. text drawn as outlines, partially covered) cannot be cut
 *    exactly, so the whole painting operation is removed and its area is
 *    queued for rasterization from the original page.
 *  - Images (XObject and inline): pixels under the mark are painted and the
 *    image is replaced by a new object (see imageRedactor.ts).
 *  - Form XObjects: interpreted recursively with their own resources; a
 *    changed form is written as a new object under a new name, so other
 *    placements/pages keep the original. The new form's resources are pruned
 *    to what its rewritten content draws, and the engine prunes the page's
 *    resources the same way, so a replaced original is no longer bound
 *    anywhere on the redacted page.
 *  - Marked content: /ActualText, /Alt and /E properties around removed text
 *    are dropped (they would otherwise repeat the redacted string).
 *
 * Anything it cannot reason about (Type3 or undecodable fonts, unparseable
 * streams, clipping paths that cross a mark, pattern fills over a mark) is
 * reported as an uncertain region or a whole-page fallback; the engine then
 * rasterizes instead of guessing.
 */
import { PDFDocument as PDFLib, PDFContext, PDFDict, PDFName, PDFObject, PDFRef } from 'pdf-lib';
import { ContentOp, Operand, hexString, parseContent } from './contentTokenizer';
import { FontModel, buildFontModel } from './fontModel';
import {
  IDENTITY,
  Matrix,
  Point,
  Rect,
  applyToPoint,
  boundsOfPoints,
  expandRect,
  fmt,
  intersectsAny,
  multiply,
  pointInAny,
  rectArea,
  transformRect,
  unionRect,
} from './geometry';
import { ImageEncoder, ImageRedactionUnsupported, Rgb, redactImageXObject, redactInlineImage } from './imageRedactor';
import { PdfjsEnv } from './pdfjsEnv';
import { decodeStreamStrict, dictGet, getArray, getDict, getName, getNumber, getStream, numberArray, resolve } from './pdfObjects';
import { ResourceScope } from './resourceScope';
import { ResourceUsageUnknown, collectResourceUse } from './resourceUsage';

const MAX_FORM_DEPTH = 12;

export interface RedactionStats {
  glyphsRemoved: number;
  textOpsRewritten: number;
  pathsRemoved: number;
  imagesRedacted: number;
  inlineImagesRedacted: number;
  formsRewritten: number;
  markedContentScrubbed: number;
}

export function emptyStats(): RedactionStats {
  return {
    glyphsRemoved: 0,
    textOpsRewritten: 0,
    pathsRemoved: 0,
    imagesRedacted: 0,
    inlineImagesRedacted: 0,
    formsRewritten: 0,
    markedContentScrubbed: 0,
  };
}

export interface UncertainRegion {
  rect: Rect;
  reason: string;
}

export class WholePageFallback extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'WholePageFallback';
  }
}

export interface RedactorContext {
  pdfDoc: PDFLib;
  context: PDFContext;
  marks: Rect[];
  fill: Rgb;
  env: PdfjsEnv;
  encoder?: ImageEncoder;
  fontCache: Map<PDFObject, FontModel>;
  stats: RedactionStats;
  uncertain: UncertainRegion[];
  /** When true, nothing is modified: only counts what WOULD be removed (verification rescan). */
  dryRun: boolean;
  /** Dry-run findings (glyphs/paths that would be removed). */
  findings: string[];
}

interface GState {
  ctm: Matrix;
  font: FontModel | null;
  fontSize: number;
  Tc: number;
  Tw: number;
  Th: number;
  TL: number;
  Ts: number;
  lineWidth: number;
  fillIsPattern: boolean;
  strokeIsPattern: boolean;
}

interface Subpath {
  opIndices: number[];
  points: Point[];
}

interface MarkedContentEntry {
  opIndex: number;
  tag: string;
  inlineProps?: Map<string, Operand>;
  namedProps?: string;
  scrub: boolean;
}

const PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*', 'n']);
const STROKE_OPS = new Set(['S', 's', 'B', 'B*', 'b', 'b*']);
const FILL_OPS = new Set(['f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);

function num(o: Operand | undefined): number {
  return o && o.type === 'num' ? o.value : 0;
}

function nameOf(o: Operand | undefined): string | undefined {
  return o && o.type === 'name' ? o.value : undefined;
}

function encodeName(name: string): string {
  let out = '/';
  for (const ch of name) {
    const c = ch.charCodeAt(0);
    if (c < 0x21 || c > 0x7e || '()<>[]{}/%#'.includes(ch)) out += '#' + c.toString(16).padStart(2, '0');
    else out += ch;
  }
  return out;
}

function sliceOp(data: Uint8Array, op: ContentOp): Uint8Array {
  return data.subarray(op.start, op.end);
}

function latin1Bytes(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

export interface ContentResult {
  /** Rewritten bytes, or null when nothing in this stream changed. */
  bytes: Uint8Array | null;
}

/**
 * Redact one content stream (page content or form XObject content).
 * Throws WholePageFallback when the page must be rasterized entirely.
 */
export async function redactContent(
  rc: RedactorContext,
  data: Uint8Array,
  scope: ResourceScope,
  baseCtm: Matrix,
  formStack: PDFObject[]
): Promise<ContentResult> {
  let ops: ContentOp[];
  try {
    ops = parseContent(data);
  } catch (e) {
    throw new WholePageFallback(`Unparseable content stream: ${(e as Error).message}`);
  }

  const edits = new Map<number, Uint8Array>();
  const marks = rc.marks;

  let gs: GState = {
    ctm: [...baseCtm] as Matrix,
    font: null,
    fontSize: 0,
    Tc: 0,
    Tw: 0,
    Th: 1,
    TL: 0,
    Ts: 0,
    lineWidth: 1,
    fillIsPattern: false,
    strokeIsPattern: false,
  };
  const gsStack: GState[] = [];
  let Tm: Matrix = [...IDENTITY] as Matrix;
  let Tlm: Matrix = [...IDENTITY] as Matrix;

  let subpaths: Subpath[] = [];
  let pathOpIndices: number[] = [];
  let clipOpIndex = -1;
  const mcStack: MarkedContentEntry[] = [];

  const setFont = (fontName: string | undefined, size: number) => {
    const fontObj = fontName ? scope.lookup('Font', fontName) : undefined;
    gs.font = buildFontModel(rc.context, fontObj, rc.fontCache);
    gs.fontSize = size;
  };

  const isPatternSpace = (csName: string | undefined): boolean => {
    if (!csName) return false;
    if (csName === 'Pattern') return true;
    const cs = resolve(rc.context, scope.lookup('ColorSpace', csName));
    const arr = getArray(rc.context, cs);
    return !!arr && getName(rc.context, arr.get(0)) === 'Pattern';
  };

  const markScrubForRemovedText = () => {
    for (const entry of mcStack) {
      if (entry.namedProps) {
        entry.scrub = true;
      } else if (entry.inlineProps && (entry.inlineProps.has('ActualText') || entry.inlineProps.has('Alt') || entry.inlineProps.has('E'))) {
        entry.scrub = true;
      }
    }
  };

  const textOp = (opIndex: number, op: ContentOp) => {
    const font = gs.font;
    const fs = gs.fontSize;
    // Normalise all four show operators into a list of elements.
    let elements: Operand[];
    let prefix = '';
    if (op.op === 'Tj') {
      elements = op.operands.slice(0, 1);
    } else if (op.op === "'") {
      Tlm = multiply([1, 0, 0, 1, 0, -gs.TL], Tlm);
      Tm = [...Tlm] as Matrix;
      elements = op.operands.slice(0, 1);
      prefix = 'T*\n';
    } else if (op.op === '"') {
      gs.Tw = num(op.operands[0]);
      gs.Tc = num(op.operands[1]);
      Tlm = multiply([1, 0, 0, 1, 0, -gs.TL], Tlm);
      Tm = [...Tlm] as Matrix;
      elements = op.operands.slice(2, 3);
      prefix = `${fmt(gs.Tw)} Tw ${fmt(gs.Tc)} Tc T*\n`;
    } else {
      const arr = op.operands[0];
      elements = arr && arr.type === 'arr' ? arr.items : [];
    }
    if (!font) return;

    interface Piece {
      kind: 'glyph' | 'adjust';
      bytes?: Uint8Array;
      remove?: boolean;
      /** TJ-unit displacement equivalent to this glyph's advance (for removal). */
      tjAdvance?: number;
      value?: number;
    }
    const pieces: Piece[] = [];
    let anyRemoved = false;
    let opBounds: Rect | null = null;
    let unknownWidths = false;

    const asc = font.ascent;
    const desc = font.descent;
    const height = asc - desc;

    for (const el of elements) {
      if (el.type === 'num') {
        Tm = multiply([1, 0, 0, 1, (-el.value / 1000) * fs * gs.Th, 0], Tm);
        pieces.push({ kind: 'adjust', value: el.value });
        continue;
      }
      if (el.type !== 'str') continue;
      for (const g of font.decode(el.bytes)) {
        if (!g.widthKnown) unknownWidths = true;
        const trm = multiply(multiply([fs * gs.Th, 0, 0, fs, 0, gs.Ts], Tm), gs.ctm);
        const w = g.width;
        const testW = Math.max(w, 0.2);
        const full = transformRect(trm, { x0: 0, y0: desc, x1: Math.max(w, 0.0001), y1: asc });
        opBounds = unionRect(opBounds, full);
        const test = transformRect(trm, {
          x0: testW * 0.1,
          y0: desc + height * 0.2,
          x1: testW * 0.9,
          y1: asc - height * 0.2,
        });
        // A degenerate box (zero font size, zero horizontal scale, singular
        // CTM) has no area, so no overlap test can ever be true; the glyph is
        // still extractable, so test its origin instead.
        const degenerate = fs === 0 || rectArea(test) === 0;
        const remove = degenerate ? pointInAny(applyToPoint(trm, 0, 0), marks) : intersectsAny(test, marks);
        if (remove) anyRemoved = true;
        const tx = (w * fs + gs.Tc + (g.isWordSpace ? gs.Tw : 0)) * gs.Th;
        const tjAdvance = fs !== 0 ? -((w * fs + gs.Tc + (g.isWordSpace ? gs.Tw : 0)) * 1000) / fs : 0;
        pieces.push({ kind: 'glyph', bytes: el.bytes.subarray(g.start, g.start + g.len), remove, tjAdvance });
        Tm = multiply([1, 0, 0, 1, tx, 0], Tm);
      }
    }

    if (!opBounds) return;

    if (!font.reliable || unknownWidths) {
      // Positions are not trustworthy enough for per-glyph surgery. If the op
      // could reach a mark (generously expanded by one em), drop it entirely.
      const em = Math.max(Math.abs(fs) * Math.hypot(gs.ctm[2], gs.ctm[3]), 1);
      const reach = expandRect(opBounds, em);
      if (!intersectsAny(reach, marks)) return;
      if (font.kind === 'type3' && !unknownWidths) {
        if (rc.dryRun) {
          rc.findings.push(`Type3 text near a mark (${font.reason ?? ''})`);
          return;
        }
        // Type3 advances are exact (Widths × FontMatrix); only the ink is not.
        // Remove the whole operation, keep the pen position, rasterize its area.
        const total = pieces.reduce((s, p) => s + (p.kind === 'glyph' ? p.tjAdvance ?? 0 : p.value ?? 0), 0);
        edits.set(opIndex, latin1Bytes(`${prefix}[${fmt(total)}] TJ`));
        rc.uncertain.push({ rect: expandRect(opBounds, em * 0.25), reason: 'Type3 font text' });
        rc.stats.glyphsRemoved += pieces.filter((p) => p.kind === 'glyph').length;
        rc.stats.textOpsRewritten++;
        markScrubForRemovedText();
        return;
      }
      if (rc.dryRun) {
        rc.findings.push(`Text in an unreliable font near a mark (${font.reason ?? 'unknown widths'})`);
        return;
      }
      throw new WholePageFallback(`Text in font that cannot be measured exactly (${font.reason ?? 'unknown glyph widths'})`);
    }

    if (!anyRemoved) return;
    const removedCount = pieces.filter((p) => p.kind === 'glyph' && p.remove).length;
    if (rc.dryRun) {
      rc.findings.push(`${removedCount} glyph(s) under a mark`);
      return;
    }
    if (fs === 0) {
      // Zero-size text is invisible but extractable; remove it outright.
      edits.set(opIndex, latin1Bytes(prefix.trim()));
      rc.stats.glyphsRemoved += removedCount;
      rc.stats.textOpsRewritten++;
      markScrubForRemovedText();
      return;
    }

    // Build the replacement TJ array: runs of kept glyph bytes as hex strings,
    // removed glyphs folded into numeric displacements.
    const parts: string[] = [];
    let run: number[] = [];
    let pendingAdjust = 0;
    const flushRun = () => {
      if (run.length) {
        parts.push(hexString(Uint8Array.from(run)));
        run = [];
      }
    };
    const flushAdjust = () => {
      if (pendingAdjust !== 0) {
        parts.push(fmt(pendingAdjust));
        pendingAdjust = 0;
      }
    };
    for (const p of pieces) {
      if (p.kind === 'adjust') {
        flushRun();
        pendingAdjust += p.value ?? 0;
      } else if (p.remove) {
        flushRun();
        pendingAdjust += p.tjAdvance ?? 0;
      } else {
        flushAdjust();
        for (const b of p.bytes!) run.push(b);
      }
    }
    flushRun();
    flushAdjust();
    edits.set(opIndex, latin1Bytes(`${prefix}[${parts.join(' ')}] TJ`));
    rc.stats.glyphsRemoved += removedCount;
    rc.stats.textOpsRewritten++;
    markScrubForRemovedText();
  };

  const finishPath = (paintIndex: number, paintOp: string) => {
    const allPoints = subpaths.flatMap((s) => s.points);
    const resetPath = () => {
      subpaths = [];
      pathOpIndices = [];
      clipOpIndex = -1;
    };
    if (allPoints.length === 0) {
      resetPath();
      return;
    }

    const usesPattern = (FILL_OPS.has(paintOp) && gs.fillIsPattern) || (STROKE_OPS.has(paintOp) && gs.strokeIsPattern);
    const pathBounds = boundsOfPoints(allPoints)!;
    const strokeScale = Math.hypot(gs.ctm[0], gs.ctm[1]) || 1;
    const paintedBounds = STROKE_OPS.has(paintOp) ? expandRect(pathBounds, (gs.lineWidth * strokeScale) / 2 + 0.5) : pathBounds;

    const classes = subpaths.map((s) => {
      let inside = 0;
      for (const p of s.points) if (pointInAny(p, marks, 0.001)) inside++;
      return { inside, outside: s.points.length - inside };
    });
    const anyInside = classes.some((c) => c.inside > 0);
    const straddles = classes.some((c) => c.inside > 0 && c.outside > 0);

    if (!anyInside) {
      // No coordinate of this path is hidden by a mark; only a pattern fill
      // could still carry content into the marked area.
      if (usesPattern && paintOp !== 'n' && intersectsAny(paintedBounds, marks)) {
        if (rc.dryRun) {
          rc.findings.push('Pattern-filled path over a mark');
        } else {
          for (const i of pathOpIndices) edits.set(i, new Uint8Array(0));
          if (clipOpIndex >= 0) throw new WholePageFallback('Pattern-filled clipping path crosses a redaction area');
          edits.set(paintIndex, new Uint8Array(0));
          rc.uncertain.push({ rect: paintedBounds, reason: 'Pattern fill over a redaction area' });
          rc.stats.pathsRemoved++;
        }
      }
      resetPath();
      return;
    }

    if (rc.dryRun) {
      rc.findings.push('Vector path with points under a mark');
      resetPath();
      return;
    }

    if (!straddles) {
      // Every affected subpath lies entirely under marks: drop just those.
      const keep = subpaths.filter((_, i) => classes[i].inside === 0);
      for (const i of pathOpIndices) edits.set(i, new Uint8Array(0));
      const rebuilt: Uint8Array[] = [];
      for (const s of keep) for (const i of s.opIndices) rebuilt.push(sliceOp(data, ops[i]));
      const clip = clipOpIndex >= 0 ? ops[clipOpIndex].op : '';
      if (keep.length === 0) {
        // A clip made only of hidden subpaths only ever exposed marked area:
        // clipping to nothing is visually identical once the box is painted.
        edits.set(paintIndex, clip ? latin1Bytes(`0 0 0 0 re ${clip} n`) : new Uint8Array(0));
      } else {
        const tail = latin1Bytes(`${clip ? clip + ' ' : ''}${paintOp}`);
        edits.set(paintIndex, concat([...rebuilt, tail], 0x0a));
      }
      if (clipOpIndex >= 0) edits.set(clipOpIndex, new Uint8Array(0));
      rc.stats.pathsRemoved += subpaths.length - keep.length;
      resetPath();
      return;
    }

    if (clipOpIndex >= 0) {
      throw new WholePageFallback('A clipping path crosses a redaction area');
    }
    // A painted path crosses a mark boundary: remove it and repaint its
    // visible area from a raster of the original page.
    for (const i of pathOpIndices) edits.set(i, new Uint8Array(0));
    edits.set(paintIndex, new Uint8Array(0));
    rc.uncertain.push({ rect: paintedBounds, reason: 'Vector graphics crossing a redaction area (e.g. outlined text)' });
    rc.stats.pathsRemoved++;
    resetPath();
  };

  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const o = op.operands;
    switch (op.op) {
      case 'q':
        gsStack.push({ ...gs, ctm: [...gs.ctm] as Matrix });
        break;
      case 'Q':
        if (gsStack.length) gs = gsStack.pop()!;
        break;
      case 'cm':
        gs.ctm = multiply([num(o[0]), num(o[1]), num(o[2]), num(o[3]), num(o[4]), num(o[5])], gs.ctm);
        break;
      case 'w':
        gs.lineWidth = num(o[0]);
        break;
      case 'gs': {
        const egs = getDict(rc.context, scope.lookup('ExtGState', nameOf(o[0]) ?? ''));
        const lw = getNumber(rc.context, dictGet(egs, 'LW'));
        if (lw !== undefined) gs.lineWidth = lw;
        const fontArr = getArray(rc.context, dictGet(egs, 'Font'));
        if (fontArr && fontArr.size() >= 2) {
          gs.font = buildFontModel(rc.context, fontArr.get(0), rc.fontCache);
          gs.fontSize = getNumber(rc.context, fontArr.get(1)) ?? gs.fontSize;
        }
        break;
      }
      case 'cs':
        gs.fillIsPattern = isPatternSpace(nameOf(o[0]));
        break;
      case 'CS':
        gs.strokeIsPattern = isPatternSpace(nameOf(o[0]));
        break;
      case 'g': case 'rg': case 'k': case 'sc':
        gs.fillIsPattern = false;
        break;
      case 'G': case 'RG': case 'K': case 'SC':
        gs.strokeIsPattern = false;
        break;
      case 'BT':
        Tm = [...IDENTITY] as Matrix;
        Tlm = [...IDENTITY] as Matrix;
        break;
      case 'ET':
        break;
      case 'Tf':
        setFont(nameOf(o[0]), num(o[1]));
        break;
      case 'Tc': gs.Tc = num(o[0]); break;
      case 'Tw': gs.Tw = num(o[0]); break;
      case 'Tz': gs.Th = num(o[0]) / 100; break;
      case 'TL': gs.TL = num(o[0]); break;
      case 'Ts': gs.Ts = num(o[0]); break;
      case 'Td':
        Tlm = multiply([1, 0, 0, 1, num(o[0]), num(o[1])], Tlm);
        Tm = [...Tlm] as Matrix;
        break;
      case 'TD':
        gs.TL = -num(o[1]);
        Tlm = multiply([1, 0, 0, 1, num(o[0]), num(o[1])], Tlm);
        Tm = [...Tlm] as Matrix;
        break;
      case 'Tm':
        Tlm = [num(o[0]), num(o[1]), num(o[2]), num(o[3]), num(o[4]), num(o[5])];
        Tm = [...Tlm] as Matrix;
        break;
      case 'T*':
        Tlm = multiply([1, 0, 0, 1, 0, -gs.TL], Tlm);
        Tm = [...Tlm] as Matrix;
        break;
      case 'Tj': case 'TJ': case "'": case '"':
        textOp(i, op);
        break;

      // Path construction
      case 'm':
        subpaths.push({ opIndices: [i], points: [applyToPoint(gs.ctm, num(o[0]), num(o[1]))] });
        pathOpIndices.push(i);
        break;
      case 'l': case 'c': case 'v': case 'y': case 'h': {
        if (subpaths.length === 0) subpaths.push({ opIndices: [], points: [] });
        const sp = subpaths[subpaths.length - 1];
        sp.opIndices.push(i);
        for (let k = 0; k + 1 < o.length; k += 2) sp.points.push(applyToPoint(gs.ctm, num(o[k]), num(o[k + 1])));
        pathOpIndices.push(i);
        break;
      }
      case 're': {
        const x = num(o[0]), y = num(o[1]), w = num(o[2]), h = num(o[3]);
        subpaths.push({
          opIndices: [i],
          points: [
            applyToPoint(gs.ctm, x, y), applyToPoint(gs.ctm, x + w, y),
            applyToPoint(gs.ctm, x + w, y + h), applyToPoint(gs.ctm, x, y + h),
          ],
        });
        pathOpIndices.push(i);
        break;
      }
      case 'W': case 'W*':
        clipOpIndex = i;
        break;

      case 'BDC': case 'BMC': {
        const entry: MarkedContentEntry = { opIndex: i, tag: nameOf(o[0]) ?? 'Span', scrub: false };
        if (op.op === 'BDC') {
          if (o[1]?.type === 'dict') entry.inlineProps = o[1].entries;
          else if (o[1]?.type === 'name') entry.namedProps = o[1].value;
        }
        mcStack.push(entry);
        break;
      }
      case 'EMC': {
        const entry = mcStack.pop();
        if (entry?.scrub && !rc.dryRun) {
          const mcid = entry.inlineProps?.get('MCID');
          const replacement =
            mcid && mcid.type === 'num'
              ? `${encodeName(entry.tag)} <</MCID ${fmt(mcid.value)}>> BDC`
              : `${encodeName(entry.tag)} BMC`;
          edits.set(entry.opIndex, latin1Bytes(replacement));
          rc.stats.markedContentScrubbed++;
        }
        break;
      }

      case 'Do':
        await doXObject(i, nameOf(o[0]));
        break;
      case 'BI':
        await inlineImage(i, op);
        break;
      case 'sh':
        // A shading fill paints the whole current clipping region, which this
        // redactor does not bound, and mesh shadings (types 4-7) can encode an
        // arbitrary picture. It cannot be shown to stay clear of the marks, so
        // the page falls back to a full raster (content-removing).
        if (rc.dryRun) rc.findings.push('Shading fill on a page with redaction marks');
        else throw new WholePageFallback('Shading fill (sh) on a page with redaction marks');
        break;

      default:
        if (PAINT_OPS.has(op.op)) finishPath(i, op.op);
        break;
    }
  }

  async function doXObject(opIndex: number, name: string | undefined): Promise<void> {
    if (!name) return;
    const xobjRefOrObj = scope.lookup('XObject', name);
    const stream = getStream(rc.context, xobjRefOrObj);
    if (!stream) return;
    const subtype = getName(rc.context, dictGet(stream.dict, 'Subtype'));

    if (subtype === 'Image') {
      const bounds = transformRect(gs.ctm, { x0: 0, y0: 0, x1: 1, y1: 1 });
      if (!intersectsAny(bounds, marks)) return;
      if (rc.dryRun) return; // images are verified by the pdf.js pixel check
      try {
        const result = await redactImageXObject(rc.pdfDoc, stream, gs.ctm, marks, rc.fill, rc.env, rc.encoder);
        const newName = scope.addXObject('RdxIm', result.ref);
        edits.set(opIndex, latin1Bytes(`${encodeName(newName)} Do`));
        rc.stats.imagesRedacted++;
      } catch (e) {
        edits.set(opIndex, new Uint8Array(0));
        rc.uncertain.push({ rect: bounds, reason: `Image could not be decoded for redaction (${(e as Error).message})` });
      }
      return;
    }

    if (subtype === 'Form') {
      const formMatrix = (numberArray(rc.context, dictGet(stream.dict, 'Matrix')) ?? [1, 0, 0, 1, 0, 0]) as Matrix;
      const bbox = numberArray(rc.context, dictGet(stream.dict, 'BBox'));
      const formCtm = multiply(formMatrix, gs.ctm);
      const formBounds = bbox && bbox.length === 4
        ? transformRect(formCtm, { x0: Math.min(bbox[0], bbox[2]), y0: Math.min(bbox[1], bbox[3]), x1: Math.max(bbox[0], bbox[2]), y1: Math.max(bbox[1], bbox[3]) })
        : null;
      if (formBounds && !intersectsAny(formBounds, marks)) return;

      const identity = xobjRefOrObj instanceof PDFRef ? xobjRefOrObj : stream;
      if (formStack.includes(identity) || formStack.length >= MAX_FORM_DEPTH) {
        if (rc.dryRun) {
          rc.findings.push('Form XObject nesting too deep to inspect');
          return;
        }
        throw new WholePageFallback('Form XObject nesting is cyclic or too deep');
      }

      let formData: Uint8Array;
      try {
        formData = decodeStreamStrict(stream);
      } catch (e) {
        if (rc.dryRun) {
          rc.findings.push('Undecodable form XObject over a mark');
          return;
        }
        edits.set(opIndex, new Uint8Array(0));
        rc.uncertain.push({ rect: formBounds ?? { x0: -1e6, y0: -1e6, x1: 1e6, y1: 1e6 }, reason: `Form XObject could not be decoded (${(e as Error).message})` });
        return;
      }
      const ownResources = getDict(rc.context, dictGet(stream.dict, 'Resources'));
      // Forms without /Resources inherit the enclosing scope's resources.
      const formScope = new ResourceScope(rc.context, ownResources ?? scope.finalDict());
      const result = await redactContent(rc, formData, formScope, formCtm, [...formStack, identity]);
      if (rc.dryRun || (!result.bytes && !formScope.modified)) return;

      const newDict = stream.dict.clone(rc.context);
      newDict.delete(PDFName.of('Filter'));
      newDict.delete(PDFName.of('DecodeParms'));
      newDict.delete(PDFName.of('Length'));
      // Drop the bindings the rewrite replaced (the original image/form the
      // form drew before), so they are not reachable through the new form.
      try {
        formScope.pruneTo(collectResourceUse(rc.context, result.bytes ?? formData, formScope.finalDict()));
      } catch (e) {
        if (e instanceof ResourceUsageUnknown) throw new WholePageFallback(`Form XObject resources could not be pruned (${e.message})`);
        throw e;
      }
      const finalResources = formScope.finalDict();
      if (finalResources) newDict.set(PDFName.of('Resources'), finalResources);
      const newStream = rc.context.flateStream(result.bytes ?? formData, {});
      for (const [k, v] of newDict.entries()) newStream.dict.set(k, v);
      const ref = rc.context.register(newStream);
      const newName = scope.addXObject('RdxFm', ref);
      edits.set(opIndex, latin1Bytes(`${encodeName(newName)} Do`));
      rc.stats.formsRewritten++;
    }
  }

  async function inlineImage(opIndex: number, op: ContentOp): Promise<void> {
    const bounds = transformRect(gs.ctm, { x0: 0, y0: 0, x1: 1, y1: 1 });
    if (!intersectsAny(bounds, marks)) return;
    if (rc.dryRun) return;
    const dict = op.inlineDict ?? new Map<string, Operand>();
    const im = dict.get('IM') ?? dict.get('ImageMask');
    const isMask = im?.type === 'bool' && im.value;
    const csOperand = dict.get('CS') ?? dict.get('ColorSpace');
    let colorSpaces: PDFDict | undefined;
    if (csOperand?.type === 'name' && !['G', 'RGB', 'CMYK', 'I', 'DeviceGray', 'DeviceRGB', 'DeviceCMYK', 'Indexed'].includes(csOperand.value)) {
      const res = scope.finalDict();
      colorSpaces = getDict(rc.context, res?.get(PDFName.of('ColorSpace')));
    }
    try {
      const result = await redactInlineImage(rc.pdfDoc, sliceOp(data, op), isMask, colorSpaces, gs.ctm, marks, rc.fill, rc.env);
      const newName = scope.addXObject('RdxIm', result.ref);
      edits.set(opIndex, latin1Bytes(`${encodeName(newName)} Do`));
      rc.stats.inlineImagesRedacted++;
    } catch (e) {
      edits.set(opIndex, new Uint8Array(0));
      const reason = e instanceof ImageRedactionUnsupported ? e.message : `Inline image could not be decoded (${(e as Error).message})`;
      rc.uncertain.push({ rect: bounds, reason });
    }
  }

  if (edits.size === 0) return { bytes: null };

  const chunks: Uint8Array[] = [];
  for (let i = 0; i < ops.length; i++) {
    const replacement = edits.get(i);
    if (replacement !== undefined) {
      if (replacement.length) chunks.push(replacement);
    } else {
      chunks.push(sliceOp(data, ops[i]));
    }
  }
  return { bytes: concat(chunks, 0x0a) };
}

export function concat(chunks: Uint8Array[], separator?: number): Uint8Array {
  const sepLen = separator === undefined ? 0 : 1;
  const total = chunks.reduce((s, c) => s + c.length + sepLen, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
    if (separator !== undefined) out[off++] = separator;
  }
  return out;
}

export { latin1Bytes };
