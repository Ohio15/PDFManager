/**
 * Font model for glyph geometry during redaction.
 *
 * Answers, for a font resource, the three questions glyph-level removal needs:
 *   1. How are the bytes of a shown string split into character codes?
 *   2. What is each code's horizontal advance (text space, per unit font size)?
 *   3. What vertical extent (ascent/descent) does a glyph occupy?
 *
 * A model is `reliable` only when all three come from data the PDF spec defines
 * (Widths/W arrays, standard-14 AFM metrics, Identity or embedded CMaps). Type3
 * fonts (glyph procedures can paint anywhere), vertical writing, and CMaps we
 * cannot resolve are marked unreliable; the redactor then removes the whole
 * text operation and rasterizes the affected region instead of guessing.
 */
import { PDFContext, PDFDict, PDFName, PDFObject } from 'pdf-lib';
import { Encodings, Font, FontNames } from '@pdf-lib/standard-fonts';
import {
  decodeStreamStrict,
  dictGet,
  getArray,
  getDict,
  getName,
  getNumber,
  getStream,
  numberArray,
  resolve,
} from './pdfObjects';

export interface GlyphCode {
  code: number;
  /** Byte offset of this code inside the shown string. */
  start: number;
  /** Byte length of the code (1 for simple fonts, 1–4 for composite). */
  len: number;
  /** Horizontal advance in text space for a font size of 1 (w0 / 1000 for non-Type3). */
  width: number;
  /** False when the width had to be guessed. */
  widthKnown: boolean;
  /** Single-byte code 32 — the only code word spacing (Tw) applies to. */
  isWordSpace: boolean;
}

export interface FontModel {
  kind: 'simple' | 'composite' | 'type3' | 'missing';
  reliable: boolean;
  reason?: string;
  /** Glyph box top, in text space per unit font size (positive). */
  ascent: number;
  /** Glyph box bottom, in text space per unit font size (negative). */
  descent: number;
  decode(bytes: Uint8Array): GlyphCode[];
}

const DEFAULT_ASCENT = 0.8;
const DEFAULT_DESCENT = -0.2;

const STANDARD_14: Record<string, FontNames> = {
  Helvetica: FontNames.Helvetica,
  'Helvetica-Bold': FontNames.HelveticaBold,
  'Helvetica-Oblique': FontNames.HelveticaOblique,
  'Helvetica-BoldOblique': FontNames.HelveticaBoldOblique,
  Arial: FontNames.Helvetica,
  'Arial,Bold': FontNames.HelveticaBold,
  'Arial,Italic': FontNames.HelveticaOblique,
  'Arial,BoldItalic': FontNames.HelveticaBoldOblique,
  'Times-Roman': FontNames.TimesRoman,
  'Times-Bold': FontNames.TimesRomanBold,
  'Times-Italic': FontNames.TimesRomanItalic,
  'Times-BoldItalic': FontNames.TimesRomanBoldItalic,
  TimesNewRoman: FontNames.TimesRoman,
  'TimesNewRoman,Bold': FontNames.TimesRomanBold,
  'TimesNewRoman,Italic': FontNames.TimesRomanItalic,
  'TimesNewRoman,BoldItalic': FontNames.TimesRomanBoldItalic,
  Courier: FontNames.Courier,
  'Courier-Bold': FontNames.CourierBold,
  'Courier-Oblique': FontNames.CourierOblique,
  'Courier-BoldOblique': FontNames.CourierBoldOblique,
  CourierNew: FontNames.Courier,
  Symbol: FontNames.Symbol,
  ZapfDingbats: FontNames.ZapfDingbats,
};

/** StandardEncoding differences from WinAnsi in 32..126, plus its upper half (PDF 32000 Annex D). */
const STANDARD_ENCODING_OVERRIDES: Record<number, string> = {
  39: 'quoteright', 96: 'quoteleft',
  161: 'exclamdown', 162: 'cent', 163: 'sterling', 164: 'fraction', 165: 'yen', 166: 'florin',
  167: 'section', 168: 'currency', 169: 'quotesingle', 170: 'quotedblleft', 171: 'guillemotleft',
  172: 'guilsinglleft', 173: 'guilsinglright', 174: 'fi', 175: 'fl', 177: 'endash', 178: 'dagger',
  179: 'daggerdbl', 180: 'periodcentered', 182: 'paragraph', 183: 'bullet', 184: 'quotesinglbase',
  185: 'quotedblbase', 186: 'quotedblright', 187: 'guillemotright', 188: 'ellipsis', 189: 'perthousand',
  191: 'questiondown', 193: 'grave', 194: 'acute', 195: 'circumflex', 196: 'tilde', 197: 'macron',
  198: 'breve', 199: 'dotaccent', 200: 'dieresis', 202: 'ring', 203: 'cedilla', 205: 'hungarumlaut',
  206: 'ogonek', 207: 'caron', 208: 'emdash', 225: 'AE', 227: 'ordfeminine', 232: 'Lslash',
  233: 'Oslash', 234: 'OE', 235: 'ordmasculine', 241: 'ae', 245: 'dotlessi', 248: 'lslash',
  249: 'oslash', 250: 'oe', 251: 'germandbls',
};

type CodeToName = Map<number, string>;

function encodingTable(encoding: { unicodeMappings?: Record<string, [number, string]> }): CodeToName {
  const map: CodeToName = new Map();
  const mappings = (encoding as unknown as { unicodeMappings: Record<string, [number, string]> }).unicodeMappings;
  for (const key of Object.keys(mappings)) {
    const [code, name] = mappings[key];
    if (!map.has(code)) map.set(code, name);
  }
  return map;
}

let winAnsiCache: CodeToName | null = null;
function winAnsiTable(): CodeToName {
  if (!winAnsiCache) winAnsiCache = encodingTable(Encodings.WinAnsi as never);
  return winAnsiCache;
}

function standardTable(): CodeToName {
  const map: CodeToName = new Map();
  for (const [code, name] of winAnsiTable()) if (code >= 32 && code <= 126) map.set(code, name);
  for (const [code, name] of Object.entries(STANDARD_ENCODING_OVERRIDES)) map.set(Number(code), name);
  return map;
}

function stripSubset(name: string): string {
  return name.replace(/^[A-Z]{6}\+/, '');
}

function descriptorMetrics(context: PDFContext, descriptor: PDFDict | undefined): { ascent: number; descent: number; missingWidth: number } {
  let ascent = getNumber(context, dictGet(descriptor, 'Ascent'));
  let descent = getNumber(context, dictGet(descriptor, 'Descent'));
  const bbox = numberArray(context, dictGet(descriptor, 'FontBBox'));
  if ((ascent === undefined || ascent <= 0) && bbox && bbox.length === 4 && bbox[3] > 0) ascent = bbox[3];
  if ((descent === undefined || descent >= 0) && bbox && bbox.length === 4 && bbox[1] < 0) descent = bbox[1];
  return {
    ascent: ascent !== undefined && ascent > 0 ? ascent / 1000 : DEFAULT_ASCENT,
    descent: descent !== undefined && descent < 0 ? descent / 1000 : DEFAULT_DESCENT,
    missingWidth: getNumber(context, dictGet(descriptor, 'MissingWidth')) ?? 0,
  };
}

function simpleFont(context: PDFContext, font: PDFDict, subtype: string): FontModel {
  const baseFont = stripSubset(getName(context, dictGet(font, 'BaseFont')) ?? '');
  const descriptor = getDict(context, dictGet(font, 'FontDescriptor'));
  const metrics = descriptorMetrics(context, descriptor);
  const firstChar = getNumber(context, dictGet(font, 'FirstChar'));
  const widths = numberArray(context, dictGet(font, 'Widths'));

  let ascent = metrics.ascent;
  let descent = metrics.descent;
  let widthOf: (code: number) => { w: number; known: boolean };

  if (widths && firstChar !== undefined) {
    widthOf = (code) => {
      const idx = code - firstChar;
      if (idx >= 0 && idx < widths.length) return { w: widths[idx] / 1000, known: true };
      // Spec: codes outside FirstChar..LastChar use MissingWidth (default 0).
      return { w: metrics.missingWidth / 1000, known: true };
    };
  } else {
    const std = STANDARD_14[baseFont];
    if (!std) {
      return {
        kind: 'simple',
        reliable: false,
        reason: `Font ${baseFont || '(unnamed)'} has no /Widths and is not a standard-14 font`,
        ascent,
        descent,
        decode: (bytes) => Array.from(bytes, (code, i) => ({ code, start: i, len: 1, width: 0.5, widthKnown: false, isWordSpace: code === 32 })),
      };
    }
    const afm = Font.load(std);
    if (!descriptor) {
      if (typeof afm.Ascender === 'number' && afm.Ascender > 0) ascent = afm.Ascender / 1000;
      else if (afm.FontBBox) ascent = afm.FontBBox[3] / 1000;
      if (typeof afm.Descender === 'number' && afm.Descender < 0) descent = afm.Descender / 1000;
      else if (afm.FontBBox) descent = Math.min(afm.FontBBox[1] / 1000, DEFAULT_DESCENT);
    }
    const table = buildCodeToName(context, font, std);
    widthOf = (code) => {
      const glyph = table.get(code);
      const w = glyph ? afm.getWidthOfGlyph(glyph) : undefined;
      if (typeof w === 'number') return { w: w / 1000, known: true };
      return { w: 0.5, known: false };
    };
  }

  return {
    kind: 'simple',
    reliable: subtype !== 'Type3',
    ascent,
    descent,
    decode: (bytes) => {
      const out: GlyphCode[] = [];
      for (let i = 0; i < bytes.length; i++) {
        const { w, known } = widthOf(bytes[i]);
        out.push({ code: bytes[i], start: i, len: 1, width: w, widthKnown: known, isWordSpace: bytes[i] === 32 });
      }
      return out;
    },
  };
}

function buildCodeToName(context: PDFContext, font: PDFDict, std: FontNames): CodeToName {
  let base: CodeToName;
  if (std === FontNames.Symbol) base = encodingTable(Encodings.Symbol as never);
  else if (std === FontNames.ZapfDingbats) base = encodingTable(Encodings.ZapfDingbats as never);
  else base = standardTable();

  const enc = resolve(context, dictGet(font, 'Encoding'));
  const encName = enc instanceof PDFName ? enc.decodeText() : undefined;
  const encDict = getDict(context, enc as PDFObject | undefined);
  const baseName = encName ?? getName(context, dictGet(encDict, 'BaseEncoding'));
  if (baseName === 'WinAnsiEncoding') base = new Map(winAnsiTable());
  else if (baseName === 'StandardEncoding') base = standardTable();
  else base = new Map(base);

  const diffs = getArray(context, dictGet(encDict, 'Differences'));
  if (diffs) {
    let code = 0;
    for (let i = 0; i < diffs.size(); i++) {
      const item = resolve(context, diffs.get(i));
      const n = getNumber(context, item);
      if (n !== undefined) {
        code = n;
      } else if (item instanceof PDFName) {
        base.set(code, item.decodeText());
        code++;
      }
    }
  }
  return base;
}

interface CodespaceRange {
  len: number;
  lo: number[];
  hi: number[];
}

interface CMapModel {
  vertical: boolean;
  ranges: CodespaceRange[];
  toCid: (code: number, len: number) => number;
  reliable: boolean;
  reason?: string;
}

function parseHexBytes(hex: string): number[] {
  const clean = hex.replace(/[^0-9a-fA-F]/g, '');
  const out: number[] = [];
  for (let i = 0; i + 1 < clean.length; i += 2) out.push(parseInt(clean.substr(i, 2), 16));
  return out;
}

function bytesToInt(b: number[]): number {
  let v = 0;
  for (const x of b) v = v * 256 + x;
  return v;
}

function parseEmbeddedCMap(text: string): CMapModel {
  const ranges: CodespaceRange[] = [];
  const csBlock = /begincodespacerange([\s\S]*?)endcodespacerange/g;
  let m: RegExpExecArray | null;
  while ((m = csBlock.exec(text))) {
    const pair = /<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>/g;
    let p: RegExpExecArray | null;
    while ((p = pair.exec(m[1]))) {
      const lo = parseHexBytes(p[1]);
      const hi = parseHexBytes(p[2]);
      if (lo.length === hi.length && lo.length > 0) ranges.push({ len: lo.length, lo, hi });
    }
  }

  const singles = new Map<string, number>();
  const rangeMaps: Array<{ len: number; lo: number; hi: number; cid: number }> = [];
  const cidRange = /begincidrange([\s\S]*?)endcidrange/g;
  while ((m = cidRange.exec(text))) {
    const entry = /<([0-9a-fA-F\s]+)>\s*<([0-9a-fA-F\s]+)>\s*(\d+)/g;
    let e: RegExpExecArray | null;
    while ((e = entry.exec(m[1]))) {
      const lo = parseHexBytes(e[1]);
      rangeMaps.push({ len: lo.length, lo: bytesToInt(lo), hi: bytesToInt(parseHexBytes(e[2])), cid: parseInt(e[3], 10) });
    }
  }
  const cidChar = /begincidchar([\s\S]*?)endcidchar/g;
  while ((m = cidChar.exec(text))) {
    const entry = /<([0-9a-fA-F\s]+)>\s*(\d+)/g;
    let e: RegExpExecArray | null;
    while ((e = entry.exec(m[1]))) {
      const b = parseHexBytes(e[1]);
      singles.set(`${b.length}:${bytesToInt(b)}`, parseInt(e[2], 10));
    }
  }

  const usesOther = /\/[^\s/]+\s+usecmap/.test(text);
  const vertical = /\/WMode\s+1/.test(text);
  return {
    vertical,
    ranges,
    reliable: ranges.length > 0 && !usesOther && !vertical,
    reason: usesOther ? 'Embedded CMap uses usecmap' : vertical ? 'Vertical writing mode' : ranges.length === 0 ? 'CMap has no codespace ranges' : undefined,
    toCid: (code, len) => {
      const s = singles.get(`${len}:${code}`);
      if (s !== undefined) return s;
      for (const r of rangeMaps) if (r.len === len && code >= r.lo && code <= r.hi) return r.cid + (code - r.lo);
      return 0;
    },
  };
}

function compositeFont(context: PDFContext, font: PDFDict): FontModel {
  const encoding = resolve(context, dictGet(font, 'Encoding'));
  let cmap: CMapModel;
  if (encoding instanceof PDFName) {
    const name = encoding.decodeText();
    if (name === 'Identity-H') {
      cmap = { vertical: false, ranges: [{ len: 2, lo: [0, 0], hi: [255, 255] }], toCid: (c) => c, reliable: true };
    } else if (name === 'Identity-V') {
      cmap = { vertical: true, ranges: [{ len: 2, lo: [0, 0], hi: [255, 255] }], toCid: (c) => c, reliable: false, reason: 'Vertical writing mode (Identity-V)' };
    } else {
      // Predefined CJK CMaps: 2-byte codes in practice, but the code→CID map
      // (needed for /W widths) is not available offline here.
      const vertical = name.endsWith('-V');
      cmap = { vertical, ranges: [{ len: 2, lo: [0, 0], hi: [255, 255] }], toCid: (c) => c, reliable: false, reason: `Predefined CMap ${name}` };
    }
  } else {
    const stream = getStream(context, encoding as PDFObject | undefined);
    if (!stream) {
      cmap = { vertical: false, ranges: [{ len: 2, lo: [0, 0], hi: [255, 255] }], toCid: (c) => c, reliable: false, reason: 'Missing CMap' };
    } else {
      try {
        const text = new TextDecoder('latin1').decode(decodeStreamStrict(stream));
        cmap = parseEmbeddedCMap(text);
      } catch {
        cmap = { vertical: false, ranges: [{ len: 2, lo: [0, 0], hi: [255, 255] }], toCid: (c) => c, reliable: false, reason: 'Undecodable CMap' };
      }
    }
  }

  const descendants = getArray(context, dictGet(font, 'DescendantFonts'));
  const cidFont = descendants && descendants.size() > 0 ? getDict(context, descendants.get(0)) : undefined;
  const descriptor = getDict(context, dictGet(cidFont, 'FontDescriptor'));
  const metrics = descriptorMetrics(context, descriptor);
  const dw = getNumber(context, dictGet(cidFont, 'DW')) ?? 1000;
  const widths = new Map<number, number>();
  const ranges: Array<{ lo: number; hi: number; w: number }> = [];
  const W = getArray(context, dictGet(cidFont, 'W'));
  if (W) {
    let i = 0;
    while (i < W.size()) {
      const first = getNumber(context, W.get(i));
      const next = resolve(context, W.get(i + 1));
      if (first === undefined) break;
      const list = getArray(context, next);
      if (list) {
        for (let j = 0; j < list.size(); j++) {
          const w = getNumber(context, list.get(j));
          if (w !== undefined) widths.set(first + j, w);
        }
        i += 2;
      } else {
        const last = getNumber(context, next);
        const w = getNumber(context, W.get(i + 2));
        if (last === undefined || w === undefined) break;
        ranges.push({ lo: first, hi: last, w });
        i += 3;
      }
    }
  }
  const widthOfCid = (cid: number): number => {
    const w = widths.get(cid);
    if (w !== undefined) return w;
    for (const r of ranges) if (cid >= r.lo && cid <= r.hi) return r.w;
    return dw;
  };

  const sortedRanges = [...cmap.ranges].sort((a, b) => a.len - b.len);
  return {
    kind: 'composite',
    reliable: cmap.reliable && !!cidFont,
    reason: cmap.reason ?? (!cidFont ? 'Missing descendant CIDFont' : undefined),
    ascent: metrics.ascent,
    descent: metrics.descent,
    decode: (bytes) => {
      const out: GlyphCode[] = [];
      let i = 0;
      while (i < bytes.length) {
        let matchedLen = 0;
        for (const r of sortedRanges) {
          if (i + r.len > bytes.length) continue;
          let inRange = true;
          for (let k = 0; k < r.len; k++) {
            const b = bytes[i + k];
            if (b < r.lo[k] || b > r.hi[k]) {
              inRange = false;
              break;
            }
          }
          if (inRange) {
            matchedLen = r.len;
            break;
          }
        }
        // Spec 9.7.6.3: an unmatched code consumes the shortest codespace length.
        const len = matchedLen || Math.min(sortedRanges[0]?.len ?? 1, bytes.length - i);
        let code = 0;
        for (let k = 0; k < len; k++) code = code * 256 + bytes[i + k];
        const cid = cmap.toCid(code, len);
        out.push({
          code,
          start: i,
          len,
          width: widthOfCid(cid) / 1000,
          widthKnown: matchedLen > 0,
          isWordSpace: len === 1 && code === 32,
        });
        i += len;
      }
      return out;
    },
  };
}

function type3Font(context: PDFContext, font: PDFDict): FontModel {
  const fm = numberArray(context, dictGet(font, 'FontMatrix')) ?? [0.001, 0, 0, 0.001, 0, 0];
  const firstChar = getNumber(context, dictGet(font, 'FirstChar')) ?? 0;
  const widths = numberArray(context, dictGet(font, 'Widths')) ?? [];
  const bbox = numberArray(context, dictGet(font, 'FontBBox'));
  let ascent = DEFAULT_ASCENT;
  let descent = DEFAULT_DESCENT;
  if (bbox && bbox.length === 4) {
    const top = Math.max(bbox[1], bbox[3]) * fm[3];
    const bottom = Math.min(bbox[1], bbox[3]) * fm[3];
    if (top > 0) ascent = top;
    if (bottom < 0) descent = bottom;
  }
  return {
    kind: 'type3',
    reliable: false,
    reason: 'Type3 font (glyph procedures may paint outside their advance box)',
    ascent,
    descent,
    decode: (bytes) =>
      Array.from(bytes, (code, i) => {
        const idx = code - firstChar;
        const w = idx >= 0 && idx < widths.length ? widths[idx] * fm[0] : 0;
        return { code, start: i, len: 1, width: w, widthKnown: idx >= 0 && idx < widths.length, isWordSpace: code === 32 };
      }),
  };
}

const MISSING_FONT: FontModel = {
  kind: 'missing',
  reliable: false,
  reason: 'Font resource not found',
  ascent: DEFAULT_ASCENT,
  descent: DEFAULT_DESCENT,
  decode: (bytes) => Array.from(bytes, (code, i) => ({ code, start: i, len: 1, width: 0.5, widthKnown: false, isWordSpace: code === 32 })),
};

/** Build (and cache per font object) the geometry model for a font resource. */
export function buildFontModel(context: PDFContext, fontObj: PDFObject | undefined, cache: Map<PDFObject, FontModel>): FontModel {
  if (!fontObj) return MISSING_FONT;
  const cached = cache.get(fontObj);
  if (cached) return cached;
  const font = getDict(context, fontObj);
  let model: FontModel;
  if (!font) {
    model = MISSING_FONT;
  } else {
    const subtype = getName(context, dictGet(font, 'Subtype')) ?? '';
    if (subtype === 'Type0') model = compositeFont(context, font);
    else if (subtype === 'Type3') model = type3Font(context, font);
    else model = simpleFont(context, font, subtype);
  }
  cache.set(fontObj, model);
  return model;
}
