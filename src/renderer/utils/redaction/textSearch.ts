/**
 * Search-and-redact: locate every occurrence of a term with glyph-exact boxes.
 *
 * Uses the pdf.js glyph scan (not getTextContent items) so each occurrence maps
 * to the precise boxes of the glyphs that spell it, split per line. Glyphs
 * separated by a positional gap (TJ kerning used as a word space, or a new
 * line) are joined with a virtual space so "Jane Doe" matches across them.
 */
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { Rect, unionRect } from './geometry';
import { PdfjsEnv } from './pdfjsEnv';
import { scanPdfjsPage, ScannedGlyph } from './pdfjsScan';

export interface SearchOccurrence {
  pageIndex: number;
  text: string;
  /** One rect per line the occurrence spans, PDF user space. */
  rects: Rect[];
}

export interface SearchOptions {
  caseSensitive?: boolean;
  wholeWord?: boolean;
}

function sameLine(a: ScannedGlyph, b: ScannedGlyph): boolean {
  const tol = Math.max(a.size, b.size) * 0.5;
  return Math.abs(a.baseline.start.y - b.baseline.start.y) <= tol && b.box.x0 >= a.box.x0 - tol;
}

/**
 * The single fold applied to BOTH the needle and every page segment.
 *
 * NFKD decomposition is context-free per code point (unlike NFC composition or
 * whole-string lowercasing), so folding each glyph on its own produces the same
 * string as folding the whole page — which is what lets every folded UTF-16
 * unit be attributed to exactly one source glyph. It also expands
 * compatibility forms ('ﬁ' -> "fi", NBSP -> ' ') so a ligature glyph cannot
 * hide a term from search. Case folding is lowercasing with final sigma
 * collapsed to σ, because whether 'Σ' lowercases to σ or ς depends on context
 * that a per-glyph fold cannot see.
 */
export function foldForSearch(s: string, caseSensitive: boolean): string {
  const decomposed = s.normalize('NFKD');
  return caseSensitive ? decomposed : decomposed.toLowerCase().replace(/ς/g, 'σ');
}

export interface GlyphSearchText {
  /** Unfolded page text (glyph unicode + virtual spaces), for display. */
  text: string;
  /** Folded text that is actually searched. */
  haystack: string;
  /** Per UTF-16 unit of `haystack`: source glyph index, or -1 for a virtual space. */
  glyphOf: number[];
  /** Per UTF-16 unit of `haystack`: [start, end) of its source segment in `text`. */
  srcStart: number[];
  srcEnd: number[];
}

/**
 * Build the searchable string and its index maps. Every array is indexed by
 * UTF-16 unit of `haystack`, the same space `indexOf`/`slice` operate in, so
 * astral characters (surrogate pairs) and length-changing folds ('İ' -> "i̇",
 * 'ﬁ' -> "fi") cannot shift later occurrences onto the wrong glyphs.
 */
export function buildGlyphSearchText(glyphs: ScannedGlyph[], caseSensitive: boolean): GlyphSearchText {
  let text = '';
  let haystack = '';
  const glyphOf: number[] = [];
  const srcStart: number[] = [];
  const srcEnd: number[] = [];

  const append = (source: string, glyphIndex: number) => {
    const from = text.length;
    text += source;
    const folded = foldForSearch(source, caseSensitive);
    haystack += folded;
    for (let k = 0; k < folded.length; k++) {
      glyphOf.push(glyphIndex);
      srcStart.push(from);
      srcEnd.push(text.length);
    }
  };

  for (let i = 0; i < glyphs.length; i++) {
    const g = glyphs[i];
    if (i > 0) {
      const prev = glyphs[i - 1];
      const gap = g.box.x0 - prev.box.x1;
      const newLine = !sameLine(prev, g);
      if ((newLine || gap > prev.size * 0.15) && !prev.isSpace && !g.isSpace && !/\s$/.test(text)) {
        append(' ', -1);
      }
    }
    append(g.unicode || '', i);
  }
  return { text, haystack, glyphOf, srcStart, srcEnd };
}

const WORD_CHAR = /[\p{L}\p{N}\p{M}_]/u;

const isHighSurrogate = (unit: number) => unit >= 0xd800 && unit <= 0xdbff;
const isLowSurrogate = (unit: number) => unit >= 0xdc00 && unit <= 0xdfff;

/** The full code point that ends just before UTF-16 offset `at`, or '' at the start. */
function codePointBefore(s: string, at: number): string {
  if (at <= 0) return '';
  const last = s.charCodeAt(at - 1);
  if (at >= 2 && isLowSurrogate(last) && isHighSurrogate(s.charCodeAt(at - 2))) return s.slice(at - 2, at);
  return s[at - 1];
}

/** The full code point starting at UTF-16 offset `at`, or '' at the end. */
function codePointAt(s: string, at: number): string {
  if (at >= s.length) return '';
  const cp = s.codePointAt(at)!;
  return String.fromCodePoint(cp);
}

export interface GlyphMatch {
  /** Source text of the matched glyphs (unfolded). */
  text: string;
  /** Indices into the glyph array, in reading order, virtual spaces excluded. */
  glyphIndices: number[];
  /** One rect per line the occurrence spans. */
  rects: Rect[];
}

/** Locate every occurrence of `term` in one page's scanned glyphs. */
export function searchGlyphs(glyphs: ScannedGlyph[], term: string, options: SearchOptions = {}): GlyphMatch[] {
  const caseSensitive = !!options.caseSensitive;
  const needle = foldForSearch(term, caseSensitive);
  if (!needle.trim()) return [];
  const { text, haystack, glyphOf, srcStart, srcEnd } = buildGlyphSearchText(glyphs, caseSensitive);
  const matches: GlyphMatch[] = [];

  // An accepted occurrence consumes its units (non-overlapping, as before); a
  // REJECTED candidate only advances one unit, so rejecting "aab" for whole-word
  // "ab" cannot skip a valid occurrence that overlaps it.
  for (let from = 0; ; ) {
    const at = haystack.indexOf(needle, from);
    if (at < 0) break;
    from = at + 1;
    const end = at + needle.length;

    // Never start or end inside a surrogate pair (only reachable with a needle
    // carrying lone surrogates), nor split a base letter from its combining
    // mark (NFKD output: "cafe" must not match the 'é' of "café").
    if (isLowSurrogate(haystack.charCodeAt(at)) || isHighSurrogate(haystack.charCodeAt(end - 1))) continue;
    if (/\p{M}/u.test(codePointAt(haystack, end)) || /^\p{M}/u.test(needle)) continue;

    if (options.wholeWord) {
      const before = codePointBefore(haystack, at);
      const after = codePointAt(haystack, end);
      if ((before && WORD_CHAR.test(before)) || (after && WORD_CHAR.test(after))) continue;
    }

    const glyphIndices = [...new Set(glyphOf.slice(at, end).filter((i) => i >= 0))];
    if (!glyphIndices.length) continue;
    const rects: Rect[] = [];
    let current: Rect | null = null;
    let last: ScannedGlyph | null = null;
    for (const idx of glyphIndices) {
      const g = glyphs[idx];
      if (last && !sameLine(last, g)) {
        if (current) rects.push(current);
        current = null;
      }
      current = unionRect(current, g.box);
      last = g;
    }
    if (current) rects.push(current);
    matches.push({ text: text.slice(srcStart[at], srcEnd[end - 1]), glyphIndices, rects });
    from = end;
  }
  return matches;
}

export async function findOccurrences(
  doc: PDFDocumentProxy,
  env: PdfjsEnv,
  term: string,
  options: SearchOptions = {}
): Promise<SearchOccurrence[]> {
  if (!foldForSearch(term, !!options.caseSensitive).trim()) return [];
  const results: SearchOccurrence[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { glyphs } = await scanPdfjsPage(page, env.lib.OPS);
    page.cleanup();
    for (const m of searchGlyphs(glyphs, term, options)) {
      results.push({ pageIndex: p - 1, text: m.text, rects: m.rects });
    }
  }
  return results;
}
