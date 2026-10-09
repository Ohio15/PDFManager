/**
 * Post-redaction verification. A redaction is only reported successful when
 * every check below RAN and found nothing. The verdict distinguishes three
 * outcomes: `clean` (examined, nothing found), `violations` (something under
 * a mark or a must-be-absent term was found) and `not-examined` (some check
 * could not run; never read as clean). Only `clean` is `ok`.
 *
 *  0. Marks: every mark must be at least MIN_MARK_SIZE in both directions; a
 *     smaller mark has no interior to test and would pass every check.
 *  1. pdf.js oracle (independent font decoding, opened with stopAtErrors so a
 *     pdf.js error rejects instead of silently dropping content): no glyph
 *     centre and no painted path SEGMENT inside a mark; every image touching
 *     a mark is decoded and its pixels under the mark are the fill colour; no
 *     annotation overlaps a mark. Text in an unloadable font, in a font set by
 *     an ExtGState, Type3 text intersecting a mark, zero-size text under a
 *     mark and unbounded shadings are NOT EXAMINED (named reasons).
 *  2. Own-engine rescan (dry run): the redactor itself finds nothing left to
 *     remove, and no marked content over a mark still carries /ActualText,
 *     /Alt or /E — catches rewrite bugs the oracle could miss.
 *  3. Must-be-absent terms (search-and-redact): the term (folded exactly as
 *     the search folded it) is absent from pdf.js text extraction of every
 *     page, from every decoded stream (latin1 and UTF-16), from every string
 *     operand of every content stream, and from every string value anywhere
 *     in the file (metadata, bookmarks, structure tree, form values, ...).
 *     A hit ANYWHERE fails the verdict; there is no "residual" category.
 *  4. Presence, not just drawing (checks 1-3 only see what is DRAWN or
 *     LISTED; the file can still CONTAIN the original):
 *     - every prunable binding (/XObject, /Pattern, /Font, /ExtGState,
 *       /Properties) reachable from a marked page's resources is used by some
 *       remaining content op;
 *     - no object the engine removed is still present in the output;
 *     - no annotation anywhere in the file that belongs to a marked page
 *       (/P) overlaps a mark, whether or not the page /Annots lists it;
 *     - no AcroForm /XFA remains;
 *     - no structure element of a marked page carries /ActualText, /Alt or
 *       /E for marked content that is under a mark or no longer exists.
 */
import { PDFArray, PDFDict, PDFDocument as PDFLib, PDFHexString, PDFName, PDFRef, PDFStream, PDFString } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { IDENTITY, MIN_MARK_SIZE, Rect, applyToPoint, fmt, intersects, markTooSmall, pointInAny, polylineIntersectsAny, verificationCore } from './geometry';
import { emptyStats, redactContent, RedactorContext, WholePageFallback } from './contentRedactor';
import { parseContent, Operand } from './contentTokenizer';
import { Rgb } from './imageRedactor';
import { PdfjsEnv, imageDataToRgba, openPdfjs } from './pdfjsEnv';
import { scanPdfjsPage, UnexaminedReason } from './pdfjsScan';
import { decodeStreamStrict, dictGet, getDict, getName, getNumber, numberArray, getStream } from './pdfObjects';
import { auditResourceUse } from './resourceUsage';
import { structTextForMcids, type RemovedObject, type StructNotExaminedReason } from './documentScrub';
import { ResourceScope } from './resourceScope';
import { concat } from './contentRedactor';
import { foldForSearch } from './textSearch';

/** Why a check could not run. Each is a FAIL, never "nothing found". */
export type NotExaminedReason =
  | UnexaminedReason
  | 'mark-below-minimum'
  | 'pdfjs-error'
  | 'image-unverifiable'
  | 'rescan-not-examined'
  | 'resource-usage-unknown'
  | 'stream-undecodable'
  | 'content-unparseable'
  | StructNotExaminedReason
  | 'depth-cap:string-scan'
  | 'depth-cap:content-strings';

/** Codes for things FOUND. Messages may describe content; codes never do. */
export type ViolationCode =
  | 'page-missing'
  | 'glyph-under-mark'
  | 'path-under-mark'
  | 'image-under-mark'
  | 'annotation-under-mark'
  | 'term-extractable'
  | 'rescan-finding'
  | 'struct-text-under-mark'
  | 'unused-binding'
  | 'removed-object-present'
  | 'xfa-present'
  | 'term-in-document';

export interface NotExaminedItem {
  /** 0-based page, or null for a document-level check. */
  pageIndex: number | null;
  reason: NotExaminedReason;
  detail: string;
}

export type VerificationVerdict = 'clean' | 'violations' | 'not-examined';

export interface VerificationResult {
  /** True only for `verdict === 'clean'`: every check ran and found nothing. */
  ok: boolean;
  verdict: VerificationVerdict;
  /** Every failing message per page (found AND not examined); drives the raster escalation. */
  pageViolations: Map<number, string[]>;
  /** The same failures as CODES (no content), in order; safe for reports and the UI. */
  pageReasons: Map<number, string[]>;
  /** Document-level failures (found AND not examined). */
  globalViolations: string[];
  /** The checks that could not run, with named reasons. */
  notExamined: NotExaminedItem[];
  checks: { glyphs: number; paths: number; images: number; annotations: number; pages: number };
}

const PIXEL_TOLERANCE = 24;
const LATIN1 = new TextDecoder('latin1');
const MAX_MESSAGES_PER_PAGE = 20;

/**
 * The fold every must-be-absent comparison uses: textSearch's foldForSearch
 * (NFKD, case-folded) — the SAME fold that located the occurrences — with
 * whitespace removed. A different fold here (NFKC) could miss a term the
 * search matched, or match one it did not.
 */
export function normalizeForSearch(s: string): string {
  return foldForSearch(s, false).replace(/\s+/g, '');
}

/** Decode a PDF string's bytes as a text string (UTF-16BE with BOM, else PDFDocEncoding ~ latin1). */
function pdfTextFromBytes(bytes: Uint8Array): string {
  if (bytes.length >= 2 && bytes[0] === 0xfe && bytes[1] === 0xff) {
    let out = '';
    for (let i = 2; i + 1 < bytes.length; i += 2) out += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
    return out;
  }
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    return new TextDecoder('utf-8').decode(bytes.subarray(3));
  }
  return LATIN1.decode(bytes);
}

/** Nesting limit for direct values in the term scans (deeper input is NOT EXAMINED). */
const MAX_VALUE_DEPTH = 64;

class DepthCapExceeded extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DepthCapExceeded';
  }
}

/**
 * Every string operand (also inside arrays and dictionaries) of a parsed
 * content stream. Throws DepthCapExceeded rather than skip deeper operands.
 */
function contentStrings(data: Uint8Array): string[] {
  const out: string[] = [];
  const visit = (o: Operand | undefined, depth: number) => {
    if (!o) return;
    if (depth > MAX_VALUE_DEPTH) throw new DepthCapExceeded(`an operand nests deeper than ${MAX_VALUE_DEPTH} levels`);
    if (o.type === 'str') out.push(pdfTextFromBytes(o.bytes));
    else if (o.type === 'arr') for (const it of o.items) visit(it, depth + 1);
    else if (o.type === 'dict') for (const v of o.entries.values()) visit(v, depth + 1);
  };
  for (const op of parseContent(data)) {
    for (const o of op.operands) visit(o, 0);
    if (op.inlineDict) for (const v of op.inlineDict.values()) visit(v, 0);
  }
  return out;
}

/** latin1 views of `term` encoded as UTF-16BE and UTF-16LE (to find it in raw stream bytes). */
function utf16Views(term: string): string[] {
  let be = '';
  let le = '';
  for (let i = 0; i < term.length; i++) {
    const c = term.charCodeAt(i);
    be += String.fromCharCode(c >> 8, c & 0xff);
    le += String.fromCharCode(c & 0xff, c >> 8);
  }
  return [be, le];
}

export async function verifyRedaction(
  bytes: Uint8Array,
  marksByPage: Map<number, Rect[]>,
  fill: Rgb,
  env: PdfjsEnv,
  mustBeAbsent: string[] = [],
  /** Objects the engine removed; each must be absent from the output. */
  removedObjects: RemovedObject[] = []
): Promise<VerificationResult> {
  const pageViolations = new Map<number, string[]>();
  const pageReasons = new Map<number, string[]>();
  const globalViolations: string[] = [];
  const notExamined: NotExaminedItem[] = [];
  let found = 0;
  const checks = { glyphs: 0, paths: 0, images: 0, annotations: 0, pages: 0 };
  const addPage = (p: number, msg: string, code: string) => {
    const list = pageViolations.get(p) ?? [];
    if (list.length < MAX_MESSAGES_PER_PAGE) list.push(msg);
    pageViolations.set(p, list);
    const codes = pageReasons.get(p) ?? [];
    if (!codes.includes(code)) codes.push(code);
    pageReasons.set(p, codes);
  };
  /** Something was FOUND that must not be there. */
  const violation = (p: number | null, code: ViolationCode, msg: string) => {
    found++;
    if (p === null) globalViolations.push(msg);
    else addPage(p, msg, code);
  };
  /** A check could not run. */
  const unexamined = (p: number | null, reason: NotExaminedReason, detail: string) => {
    notExamined.push({ pageIndex: p, reason, detail });
    const msg = `Could not be verified [${reason}]: ${detail}`;
    if (p === null) globalViolations.push(msg);
    else addPage(p, msg, reason);
  };
  const fr = Math.round(fill.r * 255), fg = Math.round(fill.g * 255), fb = Math.round(fill.b * 255);

  // Marks too small to have an interior make every geometric check vacuous.
  const coreMarks = new Map<number, Rect[]>();
  for (const [pageIndex, rawMarks] of marksByPage) {
    const small = rawMarks.find(markTooSmall);
    if (small) {
      unexamined(
        pageIndex,
        'mark-below-minimum',
        `A ${fmt(small.x1 - small.x0)} x ${fmt(small.y1 - small.y0)} pt mark is below the ${MIN_MARK_SIZE} pt minimum; nothing under it can be tested`
      );
    }
    coreMarks.set(pageIndex, rawMarks.map((m) => verificationCore(m)));
  }

  let doc: PDFDocumentProxy | null = null;
  try {
    doc = await openPdfjs(env, bytes, { strict: true });
  } catch (e) {
    unexamined(null, 'pdfjs-error', `pdf.js could not open the output (${(e as Error).message})`);
  }
  if (doc) {
    try {
      for (const [pageIndex] of marksByPage) {
        if (pageIndex >= doc.numPages) {
          violation(pageIndex, 'page-missing', 'Page missing from output');
          continue;
        }
        const marks = coreMarks.get(pageIndex)!;
        try {
          await verifyPageWithPdfjs(doc, pageIndex, marks);
        } catch (e) {
          unexamined(pageIndex, 'pdfjs-error', `pdf.js could not process the page (${(e as Error).message})`);
        }
      }

      if (mustBeAbsent.length) {
        const terms = mustBeAbsent.map(normalizeForSearch).filter((t) => t.length > 0);
        for (let i = 1; i <= doc.numPages; i++) {
          try {
            const page = await doc.getPage(i);
            const tc = await page.getTextContent();
            const text = normalizeForSearch(tc.items.map((it) => ('str' in it ? it.str : '')).join(''));
            for (const t of terms) if (text.includes(t)) violation(i - 1, 'term-extractable', `Search term still extractable from page ${i}`);
          } catch (e) {
            unexamined(i - 1, 'pdfjs-error', `pdf.js could not extract the text of page ${i} (${(e as Error).message})`);
          }
        }
      }
    } finally {
      await doc.destroy();
    }
  }

  async function verifyPageWithPdfjs(pdf: PDFDocumentProxy, pageIndex: number, marks: Rect[]): Promise<void> {
    const page = await pdf.getPage(pageIndex + 1);
    const scan = await scanPdfjsPage(page, env.lib.OPS, { marks, strict: true });
    checks.pages++;

    // Fail closed: content the oracle could not examine is never "clean".
    const seen = new Set<string>();
    for (const u of scan.unexamined) {
      const key = `${u.reason}:${u.detail}`;
      if (seen.has(key)) continue;
      seen.add(key);
      unexamined(pageIndex, u.reason, u.detail);
    }

    for (const g of scan.glyphs) {
      checks.glyphs++;
      // The message never names the glyph: it describes content under a mark.
      if (pointInAny(g.center, marks)) violation(pageIndex, 'glyph-under-mark', 'A text glyph remains under a mark');
    }
    for (const path of scan.paths) {
      checks.paths++;
      // Painted paths: any segment entering a mark (a stroke or curve can
      // cross it with every vertex outside). Unpainted (clip-only) paths put
      // no ink anywhere; only their coordinates count.
      const under = path.painted
        ? path.subpaths.some((sp) => polylineIntersectsAny(sp, marks))
        : path.subpaths.some((sp) => sp.some((p) => pointInAny(p, marks)));
      if (under) violation(pageIndex, 'path-under-mark', path.painted ? 'Vector path segments remain under a mark' : 'Vector path coordinates remain under a mark');
    }
    for (const img of scan.images) {
      if (!marks.some((m) => intersects(img.bounds, m))) continue;
      checks.images++;
      const data = img.kind === 'mask' || img.kind === 'group' ? null : await img.load();
      if (!data || !data.data) {
        unexamined(pageIndex, 'image-unverifiable', `Image (${img.kind}) under a mark could not be decoded`);
        continue;
      }
      const rgba = imageDataToRgba(data);
      const { width, height } = data;
      let bad = 0;
      for (let y = 0; y < height && bad === 0; y++) {
        for (let x = 0; x < width; x++) {
          const p = applyToPoint(img.ctm, (x + 0.5) / width, 1 - (y + 0.5) / height);
          if (!pointInAny(p, marks, 0.5)) continue;
          const o = (y * width + x) * 4;
          if (
            Math.abs(rgba[o] - fr) > PIXEL_TOLERANCE ||
            Math.abs(rgba[o + 1] - fg) > PIXEL_TOLERANCE ||
            Math.abs(rgba[o + 2] - fb) > PIXEL_TOLERANCE ||
            rgba[o + 3] !== 255
          ) {
            bad++;
            break;
          }
        }
      }
      if (bad) violation(pageIndex, 'image-under-mark', 'Image pixels under a mark are not redacted');
    }
    const annots = (await page.getAnnotations()) as Array<{ rect?: number[]; subtype?: string }>;
    for (const a of annots) {
      if (!a.rect || a.rect.length !== 4) continue;
      checks.annotations++;
      const r: Rect = { x0: Math.min(a.rect[0], a.rect[2]), y0: Math.min(a.rect[1], a.rect[3]), x1: Math.max(a.rect[0], a.rect[2]), y1: Math.max(a.rect[1], a.rect[3]) };
      if (marks.some((m) => intersects(r, m))) violation(pageIndex, 'annotation-under-mark', `Annotation (${a.subtype ?? 'unknown'}) overlaps a mark`);
    }
    page.cleanup();
  }

  // Own-engine rescan.
  const lib = await PDFLib.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  for (const [pageIndex, marks] of marksByPage) {
    if (pageIndex >= lib.getPageCount()) continue;
    const rc: RedactorContext = {
      pdfDoc: lib, context: lib.context, marks, fill, env, fontCache: new Map(),
      stats: emptyStats(), uncertain: [], dryRun: true, findings: [],
      mcids: { touched: new Set(), present: new Set() },
    };
    let rescanned = false;
    try {
      const data = pageContentBytes(lib, pageIndex);
      await redactContent(rc, data, new ResourceScope(lib.context, lib.getPage(pageIndex).node.Resources()), IDENTITY, []);
      for (const f of rc.findings) violation(pageIndex, 'rescan-finding', `Rescan: ${f}`);
      rescanned = true;
    } catch (e) {
      const why = e instanceof WholePageFallback ? e.reason : (e as Error).message;
      unexamined(pageIndex, 'rescan-not-examined', `Own-engine rescan could not examine the page (${why})`);
    }
    // Structure elements of this page must not repeat content under a mark,
    // nor content that no longer exists (it was removed or rasterized).
    if (rescanned) {
      const { touched, present } = rc.mcids!;
      const struct = structTextForMcids(lib, lib.getPage(pageIndex).ref, (mcid) => touched.has(mcid) || !present.has(mcid), { apply: false });
      for (const hit of struct.hits) violation(pageIndex, 'struct-text-under-mark', hit);
      for (const n of struct.notExamined) unexamined(pageIndex, n.reason, n.detail);
    }
    // Bound but not used: the redacted-away original of a replaced image or
    // form, or a font / graphics state / property list only removed content used.
    try {
      const resources = lib.getPage(pageIndex).node.Resources();
      for (const f of auditResourceUse(lib.context, pageContentBytes(lib, pageIndex), resources, 'Page resources')) {
        if (f.kind === 'not-examined') unexamined(pageIndex, 'resource-usage-unknown', f.message);
        else violation(pageIndex, 'unused-binding', f.message);
      }
    } catch (e) {
      unexamined(pageIndex, 'resource-usage-unknown', `Resource check failed: ${(e as Error).message}`);
    }
  }

  // Removed objects must be gone from the file, not merely unlisted.
  for (const r of removedObjects) {
    if (lib.context.lookup(r.ref) !== undefined) violation(null, 'removed-object-present', `Removed ${r.kind} ${r.ref.toString()} is still present in the output`);
  }
  // Annotations of a marked page under a mark, however they are reached.
  const markedPageRefs = new Map<string, Rect[]>();
  for (const [pageIndex] of marksByPage) {
    if (pageIndex < lib.getPageCount()) markedPageRefs.set(lib.getPage(pageIndex).ref.toString(), coreMarks.get(pageIndex)!);
  }
  for (const [ref, obj] of lib.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const p = obj.get(PDFName.of('P'));
    const marks = p instanceof PDFRef ? markedPageRefs.get(p.toString()) : undefined;
    if (!marks || !getName(lib.context, dictGet(obj, 'Subtype'))) continue;
    const r = numberArray(lib.context, dictGet(obj, 'Rect'));
    if (!r || r.length !== 4) continue;
    const rect: Rect = { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) };
    if (marks.some((m) => intersects(rect, m))) violation(null, 'annotation-under-mark', `Annotation ${ref.toString()} of a marked page overlaps a mark`);
  }
  if (getDict(lib.context, lib.catalog.get(PDFName.of('AcroForm')))?.has(PDFName.of('XFA'))) {
    violation(null, 'xfa-present', 'AcroForm /XFA (an unredacted copy of the form and its values) is still present');
  }

  if (mustBeAbsent.length) scanDocumentForTerms(lib, mustBeAbsent, violation, unexamined);

  const verdict: VerificationVerdict = found > 0 ? 'violations' : notExamined.length > 0 ? 'not-examined' : 'clean';
  return { ok: verdict === 'clean', verdict, pageViolations, pageReasons, globalViolations, notExamined, checks };
}

/**
 * Every place outside the rendered page text where a must-be-absent term can
 * survive: every decoded non-image stream (as latin1 and as UTF-16BE/LE), every
 * string operand of every content stream (page contents, forms, tiling
 * patterns, Type3 glyph procedures — /ActualText is usually UTF-16 hex), and
 * every string value of every object (Info, bookmarks, structure-tree
 * /ActualText /Alt /E, form values, annotation contents, embedded-file
 * names...). Any hit is a violation; anything undecodable is not examined.
 */
function scanDocumentForTerms(
  lib: PDFLib,
  mustBeAbsent: string[],
  violation: (p: number | null, code: ViolationCode, msg: string) => void,
  unexamined: (p: number | null, reason: NotExaminedReason, detail: string) => void
): void {
  const context = lib.context;
  const needles = [...new Set(mustBeAbsent.map((t) => foldForSearch(t, false)).filter((t) => t.trim().length > 0))];
  const contains = (text: string) => {
    const folded = foldForSearch(text, false);
    return needles.filter((n) => folded.includes(n));
  };

  // Streams interpreted as content (their string operands are text).
  const contentStreams = new Set<PDFStream>();
  for (const page of lib.getPages()) {
    const contents = context.lookup(page.node.get(PDFName.of('Contents')));
    if (contents instanceof PDFStream) contentStreams.add(contents);
    else if (contents instanceof PDFArray) {
      for (let i = 0; i < contents.size(); i++) {
        const s = getStream(context, contents.get(i));
        if (s) contentStreams.add(s);
      }
    }
  }
  for (const [, obj] of context.enumerateIndirectObjects()) {
    if (obj instanceof PDFStream) {
      const subtype = getName(context, obj.dict.get(PDFName.of('Subtype')));
      if (subtype === 'Form' || getNumber(context, dictGet(obj.dict, 'PatternType')) === 1) contentStreams.add(obj);
    } else if (obj instanceof PDFDict && getName(context, dictGet(obj, 'Subtype')) === 'Type3') {
      const procs = getDict(context, dictGet(obj, 'CharProcs'));
      if (procs) for (const [, v] of procs.entries()) {
        const s = getStream(context, v);
        if (s) contentStreams.add(s);
      }
    }
  }

  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    const where = ref.toString();
    if (obj instanceof PDFStream) {
      const subtype = getName(context, obj.dict.get(PDFName.of('Subtype')));
      if (subtype !== 'Image') {
        let data: Uint8Array | null = null;
        try {
          data = decodeStreamStrict(obj);
        } catch (e) {
          unexamined(null, 'stream-undecodable', `Stream ${where} could not be decoded to check for the term (${(e as Error).message})`);
        }
        if (data) {
          const raw = LATIN1.decode(data);
          const lower = raw.toLowerCase();
          const hits = new Set(contains(raw));
          for (const n of needles) for (const view of utf16Views(n)) if (lower.includes(view)) hits.add(n);
          if (contentStreams.has(obj)) {
            try {
              for (const s of contentStrings(data)) for (const n of contains(s)) hits.add(n);
            } catch (e) {
              if (e instanceof DepthCapExceeded) unexamined(null, 'depth-cap:content-strings', `Content stream ${where}: ${e.message}`);
              else unexamined(null, 'content-unparseable', `Content stream ${where} could not be parsed to check its strings (${(e as Error).message})`);
            }
          }
          for (const n of hits) violation(null, 'term-in-document', `Term "${n}" found in stream ${where}`);
        }
      }
    }
    const strings = scanStrings(obj, needles);
    for (const n of strings.found) violation(null, 'term-in-document', `Term "${n}" in a string value of object ${where}`);
    if (strings.depthCapped) unexamined(null, 'depth-cap:string-scan', `Object ${where} nests direct values deeper than ${MAX_VALUE_DEPTH} levels`);
  }
}

/**
 * Needles found in any string value under `obj` (dictionaries, arrays, stream
 * dictionaries; indirect references are separate objects, scanned on their
 * own). Nesting beyond MAX_VALUE_DEPTH is reported, never treated as clean.
 */
function scanStrings(obj: unknown, needles: string[]): { found: Set<string>; depthCapped: boolean } {
  const found = new Set<string>();
  let depthCapped = false;
  const visit = (o: unknown, depth: number) => {
    if (depth > MAX_VALUE_DEPTH) {
      depthCapped = true;
      return;
    }
    if (o instanceof PDFString || o instanceof PDFHexString) {
      const text = foldForSearch(o.decodeText(), false);
      for (const n of needles) if (text.includes(n)) found.add(n);
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) visit(v, depth + 1);
    } else if (o instanceof PDFStream) {
      visit(o.dict, depth + 1);
    } else if (o instanceof PDFArray) {
      for (let i = 0; i < o.size(); i++) visit(o.get(i), depth + 1);
    }
  };
  visit(obj, 0);
  return { found, depthCapped };
}

/** Concatenate a page's decoded content streams. Throws on undecodable content. */
export function pageContentBytes(lib: PDFLib, pageIndex: number): Uint8Array {
  const node = lib.getPage(pageIndex).node;
  const contents = lib.context.lookup(node.get(PDFName.of('Contents')));
  const streams: PDFStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = lib.context.lookup(contents.get(i));
      if (s instanceof PDFStream) streams.push(s);
    }
  } else if (contents instanceof PDFStream) {
    streams.push(contents);
  }
  return concat(streams.map((s) => decodeStreamStrict(s)), 0x0a);
}
