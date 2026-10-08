/**
 * Search-and-redact index arithmetic (audit 2026-10-08, HIGH; register SC-33).
 *
 * Every page here is a REAL PDF scanned by real pdf.js: a Helvetica font whose
 * ToUnicode CMap maps a few WinAnsi codes to astral characters, length-changing
 * case folds, a ligature and a combining mark, so the glyphs reaching
 * textSearch carry exactly the unicode pdf.js produces for such fonts. The
 * expected glyphs are known by construction (one glyph per code), and each
 * occurrence's rect must equal the union of THOSE glyph boxes: a shifted index
 * map points at neighbouring glyphs and fails.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument as PDFLib, PDFName } from 'pdf-lib';
import { findOccurrences, SearchOccurrence, SearchOptions } from '../textSearch';
import { openPdfjs, PdfjsEnv } from '../pdfjsEnv';
import { scanPdfjsPage, ScannedGlyph } from '../pdfjsScan';
import { Rect, unionRect } from '../geometry';

const env: PdfjsEnv = { lib: pdfjs as unknown as PdfjsEnv['lib'] };

/** Non-ASCII characters and the single-byte (WinAnsi-defined, so it has a width) code each is shown with. */
const SPECIAL: Record<string, { code: number; utf16be: string }> = {
  '\u{20000}': { code: 0x80, utf16be: 'D840DC00' }, // CJK Ext-B letter: surrogate pair, NFKD-stable
  '\u{20001}': { code: 0x88, utf16be: 'D840DC01' }, // same high surrogate as U+20000
  '\u{10400}': { code: 0x8e, utf16be: 'D801DC00' }, // Deseret capital: astral, lowercases to U+10428
  '\u{10428}': { code: 0x92, utf16be: 'D801DC28' }, // Deseret small
  '\u{1D400}': { code: 0x91, utf16be: 'D835DC00' }, // math bold A: astral, NFKD shrinks it to "A"
  'İ': { code: 0x84, utf16be: '0130' }, // İ, lowercases to "i̇" (2 units)
  'ﬁ': { code: 0x85, utf16be: 'FB01' }, // ﬁ ligature, NFKD "fi" (2 units)
  '\u{1F600}': { code: 0x86, utf16be: 'D83DDE00' }, // emoji, surrogate pair
  'ß': { code: 0x87, utf16be: '00DF' }, // ß
  'ẞ': { code: 0x89, utf16be: '1E9E' }, // ẞ capital sharp s, lowercases to ß
  '́': { code: 0x8a, utf16be: '0301' }, // combining acute shown as its own glyph
};

const A = '\u{20000}';
const B = '\u{20001}';
const DESERET_UPPER = '\u{10400}';
const DESERET_LOWER = '\u{10428}';
const MATH_A = '\u{1D400}';
const DOTTED_I = 'İ';
const FI = 'ﬁ';
const EMOJI = '\u{1F600}';
const SHARP_S = 'ß';
const CAP_SHARP_S = 'ẞ';
const ACUTE = '́';

const CMAP = [
  '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
  '/CMapName /SearchTest def /CMapType 2 def',
  '1 begincodespacerange <00> <FF> endcodespacerange',
  '1 beginbfrange <20> <7E> <0020> endbfrange',
  `${Object.keys(SPECIAL).length} beginbfchar`,
  ...Object.values(SPECIAL).map((s) => `<${s.code.toString(16).toUpperCase()}> <${s.utf16be}>`),
  'endbfchar endcmap CMapName currentdict /CMap defineresource pop end end',
].join('\n');

/** The per-glyph units pdf.js will report for a line (code points). */
const units = (line: string) => [...line];

function hexFor(line: string): string {
  return units(line)
    .map((ch) => {
      const special = SPECIAL[ch];
      const code = special ? special.code : ch.charCodeAt(0);
      if (!special && (code < 0x20 || code > 0x7e)) throw new Error(`no code for ${JSON.stringify(ch)}`);
      return code.toString(16).padStart(2, '0');
    })
    .join('');
}

/** One-page PDF; each line is shown by one Tj on its own baseline. */
async function pagePdf(lines: string[]): Promise<Uint8Array> {
  const doc = await PDFLib.create();
  const page = doc.addPage([612, 792]);
  const toUnicode = doc.context.register(doc.context.stream(CMAP));
  const font = doc.context.register(
    doc.context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica', Encoding: 'WinAnsiEncoding', ToUnicode: toUnicode })
  );
  page.node.set(PDFName.of('Resources'), doc.context.obj({ Font: { F1: font } }));
  const content = lines.map((l, i) => `BT /F1 12 Tf 72 ${700 - i * 30} Td <${hexFor(l)}> Tj ET`).join('\n');
  page.node.set(PDFName.of('Contents'), doc.context.register(doc.context.stream(content)));
  return doc.save({ useObjectStreams: false });
}

interface Page {
  glyphs: ScannedGlyph[];
  /** Glyph index of code point `col` on line `row` (one glyph per code point by construction). */
  at: (row: number, col: number) => number;
  search: (term: string, opts?: SearchOptions) => Promise<SearchOccurrence[]>;
}

async function loadPage(lines: string[]): Promise<Page> {
  const bytes = await pagePdf(lines);
  const doc = await openPdfjs(env, bytes);
  const { glyphs } = await scanPdfjsPage(await doc.getPage(1), env.lib.OPS);
  await doc.destroy();
  // Fixture sanity: exactly one glyph per code point, in order, carrying the mapped unicode.
  expect(glyphs.map((g) => g.unicode)).toEqual(lines.flatMap(units));
  const offsets = lines.map((_, i) => lines.slice(0, i).reduce((n, l) => n + units(l).length, 0));
  return {
    glyphs,
    at: (row, col) => offsets[row] + col,
    search: async (term, opts) => {
      const d = await openPdfjs(env, bytes);
      try {
        return await findOccurrences(d, env, term, opts);
      } finally {
        await d.destroy();
      }
    },
  };
}

function boxOf(page: Page, indices: number[]): Rect {
  let r: Rect | null = null;
  for (const i of indices) r = unionRect(r, page.glyphs[i].box);
  return r!;
}

/** Glyph indices for code points [col, col + len) of line `row`. */
const span = (page: Page, row: number, col: number, len: number) => Array.from({ length: len }, (_, k) => page.at(row, col + k));

/** `occ` must cover exactly the expected glyphs, and those glyphs must spell `text`. */
function expectOn(page: Page, occ: SearchOccurrence, expected: number[], text: string) {
  expect(expected.map((i) => page.glyphs[i].unicode).join('')).toBe(text);
  expect(occ.text).toBe(text);
  expect(occ.rects).toHaveLength(1);
  expect(occ.rects[0]).toEqual(boxOf(page, expected));
}

describe('textSearch: one UTF-16 index space end to end', () => {
  let astral: Page;
  beforeAll(async () => {
    astral = await loadPage([`${A}${A}${A} ref SECRET and SECRET`, `${EMOJI} x SECRET`]);
  });

  it('occurrences AFTER astral characters land on the right glyphs (same line and later line)', async () => {
    const occ = await astral.search('secret');
    expect(occ).toHaveLength(3);
    expectOn(astral, occ[0], span(astral, 0, 8, 6), 'SECRET');
    expectOn(astral, occ[1], span(astral, 0, 19, 6), 'SECRET');
    expectOn(astral, occ[2], span(astral, 1, 4, 6), 'SECRET');
  });

  it('occurrences AFTER an İ (length-changing lowercase fold) land on the right glyphs', async () => {
    const page = await loadPage([`${DOTTED_I.repeat(4)} SECRET`, 'ok SECRET']);
    const occ = await page.search('SECRET');
    expect(occ).toHaveLength(2);
    expectOn(page, occ[0], span(page, 0, 5, 6), 'SECRET');
    expectOn(page, occ[1], span(page, 1, 3, 6), 'SECRET');
  });

  it('occurrences AFTER a ligature that NFKD expands land on the right glyphs', async () => {
    const page = await loadPage([`${FI.repeat(3)} SECRET`]);
    const occ = await page.search('secret');
    expect(occ).toHaveLength(1);
    expectOn(page, occ[0], span(page, 0, 4, 6), 'SECRET');
  });

  it('needle containing astral characters (including pairs sharing a high surrogate)', async () => {
    const page = await loadPage([`${EMOJI} x ${A}${B}KEY${A} then ${B}${A}KEY`]);
    const occ = await page.search(`${A}${B}key`);
    expect(occ).toHaveLength(1);
    expectOn(page, occ[0], span(page, 0, 4, 5), `${A}${B}KEY`);

    const emoji = await page.search(EMOJI);
    expect(emoji).toHaveLength(1);
    expectOn(page, emoji[0], [page.at(0, 0)], EMOJI);

    const reversed = await page.search(`${B}${A}key`);
    expect(reversed).toHaveLength(1);
    expectOn(page, reversed[0], span(page, 0, 16, 5), `${B}${A}KEY`);
  });

  it('never matches starting or ending mid-surrogate', async () => {
    const page = await loadPage([`${A}${B} ${A}`]);
    // Low half of A + high half of B: a contiguous unit run on the page, but it splits both pairs.
    expect(await page.search('\uDC00\uD840')).toHaveLength(0);
    // Lone high surrogate: the prefix of every A/B.
    expect(await page.search('\uD840')).toHaveLength(0);
    // Lone low surrogate of B.
    expect(await page.search('\uDC01')).toHaveLength(0);
  });

  it('length-changing folds in page AND needle: İ, ẞ/ß, ﬁ', async () => {
    const page = await loadPage([`${DOTTED_I}STANBUL istanbul`, `STRA${CAP_SHARP_S}E stra${SHARP_S}e`, `pro${FI}le profile`]);

    const dotted = await page.search(`${DOTTED_I}stanbul`);
    expect(dotted).toHaveLength(1);
    expectOn(page, dotted[0], span(page, 0, 0, 8), `${DOTTED_I}STANBUL`);

    // "i" must not match the base letter of İ (that would split İ from its dot).
    const plain = await page.search('istanbul');
    expect(plain).toHaveLength(1);
    expectOn(page, plain[0], span(page, 0, 9, 8), 'istanbul');

    const strasse = await page.search(`STRA${SHARP_S}E`);
    expect(strasse).toHaveLength(2);
    expectOn(page, strasse[0], span(page, 1, 0, 6), `STRA${CAP_SHARP_S}E`);
    expectOn(page, strasse[1], span(page, 1, 7, 6), `stra${SHARP_S}e`);

    // The ligature glyph is a single glyph covering "fi".
    const profile = await page.search('profile');
    expect(profile).toHaveLength(2);
    expectOn(page, profile[0], span(page, 2, 0, 6), `pro${FI}le`);
    expectOn(page, profile[1], span(page, 2, 7, 7), 'profile');
  });

  it('adjacent occurrences are both found; overlapping candidates do not double-mark', async () => {
    const page = await loadPage([`${A}SECRETSECRET`, 'aaaa']);
    const adj = await page.search('secret');
    expect(adj).toHaveLength(2);
    expectOn(page, adj[0], span(page, 0, 1, 6), 'SECRET');
    expectOn(page, adj[1], span(page, 0, 7, 6), 'SECRET');

    const aa = await page.search('aa');
    expect(aa).toHaveLength(2);
    expectOn(page, aa[0], span(page, 1, 0, 2), 'aa');
    expectOn(page, aa[1], span(page, 1, 2, 2), 'aa');
  });

  it('a rejected whole-word candidate does not skip an overlapping valid occurrence', async () => {
    const page = await loadPage([`${A} xa a a`]);
    const occ = await page.search('a a', { wholeWord: true });
    expect(occ).toHaveLength(1);
    expectOn(page, occ[0], span(page, 0, 5, 3), 'a a');
  });

  it('whole-word boundaries see full astral letters and combining marks', async () => {
    const page = await loadPage([`${A}SECRET SECRET`, `cafe${ACUTE} cafe`]);
    // U+20000 is a letter (one code point, two units), so "<it>SECRET" is not a whole-word hit.
    const ww = await page.search('secret', { wholeWord: true });
    expect(ww).toHaveLength(1);
    expectOn(page, ww[0], span(page, 0, 8, 6), 'SECRET');

    // Must not stop between "e" and its combining accent.
    const cafe = await page.search('cafe');
    expect(cafe).toHaveLength(1);
    expectOn(page, cafe[0], span(page, 1, 6, 4), 'cafe');

    // Precomposed needle finds the decomposed page form.
    const accented = await page.search('café');
    expect(accented).toHaveLength(1);
    expectOn(page, accented[0], span(page, 1, 0, 5), `cafe${ACUTE}`);
  });

  it('astral characters whose case fold is itself astral (Deseret)', async () => {
    const page = await loadPage([`${DESERET_UPPER}${DESERET_UPPER} SECRET ${DESERET_UPPER}X`]);
    const secret = await page.search('secret');
    expect(secret).toHaveLength(1);
    expectOn(page, secret[0], span(page, 0, 3, 6), 'SECRET');
    const folded = await page.search(`${DESERET_LOWER}x`);
    expect(folded).toHaveLength(1);
    expectOn(page, folded[0], span(page, 0, 10, 2), `${DESERET_UPPER}X`);
  });

  it('astral characters that NFKD SHRINKS (2 units -> 1) keep later occurrences aligned', async () => {
    const page = await loadPage([`${MATH_A}${MATH_A} SECRET ${MATH_A}BC`]);
    const secret = await page.search('secret');
    expect(secret).toHaveLength(1);
    expectOn(page, secret[0], span(page, 0, 3, 6), 'SECRET');
    // A styled letter is found by its plain form, and the hit covers the styled glyph.
    const abc = await page.search('abc');
    expect(abc).toHaveLength(1);
    expectOn(page, abc[0], span(page, 0, 10, 3), `${MATH_A}BC`);
  });

  it('case-sensitive search uses the same index space', async () => {
    const occ = await astral.search('SECRET', { caseSensitive: true });
    expect(occ).toHaveLength(3);
    expectOn(astral, occ[1], span(astral, 0, 19, 6), 'SECRET');
    expectOn(astral, occ[2], span(astral, 1, 4, 6), 'SECRET');
    expect(await astral.search('secret', { caseSensitive: true })).toHaveLength(0);
  });
});
