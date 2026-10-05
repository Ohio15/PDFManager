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

export async function findOccurrences(
  doc: PDFDocumentProxy,
  env: PdfjsEnv,
  term: string,
  options: SearchOptions = {}
): Promise<SearchOccurrence[]> {
  const needle = options.caseSensitive ? term : term.toLowerCase();
  if (!needle.trim()) return [];
  const results: SearchOccurrence[] = [];

  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { glyphs } = await scanPdfjsPage(page, env.lib.OPS);
    page.cleanup();

    // Build the searchable string with an index map back to glyphs (-1 = virtual space).
    let text = '';
    const map: number[] = [];
    for (let i = 0; i < glyphs.length; i++) {
      const g = glyphs[i];
      if (i > 0) {
        const prev = glyphs[i - 1];
        const gap = g.box.x0 - prev.box.x1;
        const newLine = !sameLine(prev, g);
        if ((newLine || gap > prev.size * 0.15) && !prev.isSpace && !g.isSpace && !/\s$/.test(text)) {
          text += ' ';
          map.push(-1);
        }
      }
      const u = g.unicode || '';
      for (const ch of u) {
        text += ch;
        map.push(i);
      }
    }
    const haystack = options.caseSensitive ? text : text.toLowerCase();

    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at < 0) break;
      from = at + Math.max(needle.length, 1);
      if (options.wholeWord) {
        const before = haystack[at - 1];
        const after = haystack[at + needle.length];
        if ((before && /[\p{L}\p{N}_]/u.test(before)) || (after && /[\p{L}\p{N}_]/u.test(after))) continue;
      }
      const indices = [...new Set(map.slice(at, at + needle.length).filter((i) => i >= 0))];
      if (!indices.length) continue;
      const rects: Rect[] = [];
      let current: Rect | null = null;
      let last: ScannedGlyph | null = null;
      for (const idx of indices) {
        const g = glyphs[idx];
        if (last && !sameLine(last, g)) {
          if (current) rects.push(current);
          current = null;
        }
        current = unionRect(current, g.box);
        last = g;
      }
      if (current) rects.push(current);
      results.push({ pageIndex: p - 1, text: text.slice(at, at + needle.length), rects });
    }
  }
  return results;
}
