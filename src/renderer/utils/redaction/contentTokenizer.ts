/**
 * Byte-preserving PDF content-stream tokenizer.
 *
 * Unlike pdfParser/ContentStreamParser (which flattens strings to JS strings,
 * loses operand byte offsets and does not understand inline images), this
 * tokenizer keeps the exact [start, end) byte span of every operation so the
 * redactor can copy untouched operations verbatim and splice replacements in.
 *
 * Inline images (BI … ID <binary> EI) are parsed as a single 'BI' operation
 * whose binary payload span is recorded; their bytes are never interpreted as
 * operators.
 *
 * Any structural error (unterminated string/array/dict/inline image) throws a
 * ContentParseError. The redaction engine treats that as "unparseable" and
 * falls back to rasterizing the page, because it cannot prove what the stream
 * draws.
 */

export class ContentParseError extends Error {
  constructor(message: string, public readonly offset: number) {
    super(`${message} at byte ${offset}`);
    this.name = 'ContentParseError';
  }
}

export type Operand =
  | { type: 'num'; value: number; start: number; end: number }
  | { type: 'str'; bytes: Uint8Array; hex: boolean; start: number; end: number }
  | { type: 'name'; value: string; start: number; end: number }
  | { type: 'arr'; items: Operand[]; start: number; end: number }
  | { type: 'dict'; entries: Map<string, Operand>; start: number; end: number }
  | { type: 'bool'; value: boolean; start: number; end: number }
  | { type: 'null'; start: number; end: number };

export interface ContentOp {
  op: string;
  operands: Operand[];
  /** Start of the first operand (or of the operator if it has none). */
  start: number;
  /** End of the operator keyword (exclusive). For BI: end of the 'EI'. */
  end: number;
  /** BI only: the inline image dictionary (abbreviated keys as written). */
  inlineDict?: Map<string, Operand>;
  /** BI only: [dataStart, dataEnd) of the binary payload. */
  inlineData?: { start: number; end: number };
}

const WS = new Set([0x00, 0x09, 0x0a, 0x0c, 0x0d, 0x20]);
/** Real content streams nest operands a few levels deep at most. */
const MAX_CONTAINER_NESTING = 64;

const DELIM = new Set([0x28, 0x29, 0x3c, 0x3e, 0x5b, 0x5d, 0x7b, 0x7d, 0x2f, 0x25]);

function isWs(c: number): boolean {
  return WS.has(c);
}
function isDelim(c: number): boolean {
  return DELIM.has(c);
}
function isHex(c: number): boolean {
  return (c >= 0x30 && c <= 0x39) || (c >= 0x41 && c <= 0x46) || (c >= 0x61 && c <= 0x66);
}
function hexVal(c: number): number {
  if (c <= 0x39) return c - 0x30;
  if (c <= 0x46) return c - 0x37;
  return c - 0x57;
}

interface Keyword {
  kind: 'kw';
  value: string;
  start: number;
  end: number;
}
type Tok = Operand | Keyword | { kind: 'arrEnd' | 'dictEnd'; start: number; end: number };

export class ContentTokenizer {
  private pos = 0;

  constructor(private readonly data: Uint8Array) {}

  /** Tokenize the whole stream into operations. Throws ContentParseError. */
  parse(): ContentOp[] {
    const ops: ContentOp[] = [];
    let operands: Operand[] = [];
    let opStart = -1;

    for (;;) {
      const tok = this.next();
      if (!tok) break;
      if ('kind' in tok) {
        if (tok.kind !== 'kw') {
          throw new ContentParseError(`Unbalanced '${tok.kind === 'arrEnd' ? ']' : '>>'}'`, tok.start);
        }
        const start = opStart >= 0 ? opStart : tok.start;
        if (tok.value === 'BI') {
          ops.push(this.readInlineImage(start, operands));
        } else {
          ops.push({ op: tok.value, operands, start, end: tok.end });
        }
        operands = [];
        opStart = -1;
        continue;
      }
      if (opStart < 0) opStart = tok.start;
      operands.push(tok);
    }
    // Trailing operands without an operator are ignored by every conforming
    // reader; they draw nothing, so dropping them is safe.
    return ops;
  }

  private skipWsAndComments(): void {
    const d = this.data;
    while (this.pos < d.length) {
      const c = d[this.pos];
      if (isWs(c)) {
        this.pos++;
      } else if (c === 0x25) {
        while (this.pos < d.length && d[this.pos] !== 0x0a && d[this.pos] !== 0x0d) this.pos++;
      } else {
        break;
      }
    }
  }

  private next(): Tok | null {
    this.skipWsAndComments();
    const d = this.data;
    if (this.pos >= d.length) return null;
    const start = this.pos;
    const c = d[this.pos];

    if (c === 0x28) return this.readLiteralString(start);
    if (c === 0x3c) {
      if (d[this.pos + 1] === 0x3c) {
        this.pos += 2;
        return this.readDict(start);
      }
      return this.readHexString(start);
    }
    if (c === 0x3e) {
      if (d[this.pos + 1] === 0x3e) {
        this.pos += 2;
        return { kind: 'dictEnd', start, end: this.pos };
      }
      throw new ContentParseError("Stray '>'", start);
    }
    if (c === 0x5b) {
      this.pos++;
      return this.readArray(start);
    }
    if (c === 0x5d) {
      this.pos++;
      return { kind: 'arrEnd', start, end: this.pos };
    }
    if (c === 0x2f) return this.readName(start);
    if (c === 0x29) throw new ContentParseError("Stray ')'", start);
    if (c === 0x7b || c === 0x7d) {
      // Braces only appear in PostScript calculator functions, never in page
      // content. Treat as unparseable rather than guess.
      throw new ContentParseError('Unexpected brace', start);
    }
    if ((c >= 0x30 && c <= 0x39) || c === 0x2b || c === 0x2d || c === 0x2e) {
      const num = this.tryReadNumber(start);
      if (num) return num;
    }
    // Regular-character keyword
    while (this.pos < d.length && !isWs(d[this.pos]) && !isDelim(d[this.pos])) this.pos++;
    const word = latin1(d, start, this.pos);
    if (word === 'true' || word === 'false') return { type: 'bool', value: word === 'true', start, end: this.pos };
    if (word === 'null') return { type: 'null', start, end: this.pos };
    return { kind: 'kw', value: word, start, end: this.pos };
  }

  private tryReadNumber(start: number): Operand | null {
    const d = this.data;
    let p = this.pos;
    let sign = 1;
    // Tolerate repeated signs ("--5") the way Acrobat/pdf.js do.
    while (d[p] === 0x2b || d[p] === 0x2d) {
      if (d[p] === 0x2d) sign = -sign;
      p++;
    }
    let digits = '';
    let sawDot = false;
    while (p < d.length) {
      const c = d[p];
      if (c >= 0x30 && c <= 0x39) {
        digits += String.fromCharCode(c);
        p++;
      } else if (c === 0x2e && !sawDot) {
        sawDot = true;
        digits += '.';
        p++;
      } else {
        break;
      }
    }
    if (digits === '' || digits === '.') {
      // Not a number (e.g. a keyword starting with '.'): let keyword path handle it.
      return null;
    }
    if (p < d.length && !isWs(d[p]) && !isDelim(d[p])) {
      // Something like "12abc" — not a number token.
      return null;
    }
    this.pos = p;
    const value = sign * parseFloat(digits);
    return { type: 'num', value: Number.isFinite(value) ? value : 0, start, end: p };
  }

  private readLiteralString(start: number): Operand {
    const d = this.data;
    this.pos++; // (
    const out: number[] = [];
    let depth = 1;
    while (this.pos < d.length) {
      const c = d[this.pos];
      if (c === 0x5c) {
        this.pos++;
        if (this.pos >= d.length) break;
        const e = d[this.pos];
        switch (e) {
          case 0x6e: out.push(0x0a); this.pos++; break;
          case 0x72: out.push(0x0d); this.pos++; break;
          case 0x74: out.push(0x09); this.pos++; break;
          case 0x62: out.push(0x08); this.pos++; break;
          case 0x66: out.push(0x0c); this.pos++; break;
          case 0x28: case 0x29: case 0x5c: out.push(e); this.pos++; break;
          case 0x0d:
            this.pos++;
            if (d[this.pos] === 0x0a) this.pos++;
            break;
          case 0x0a:
            this.pos++;
            break;
          default:
            if (e >= 0x30 && e <= 0x37) {
              let v = 0;
              let n = 0;
              while (n < 3 && this.pos < d.length && d[this.pos] >= 0x30 && d[this.pos] <= 0x37) {
                v = v * 8 + (d[this.pos] - 0x30);
                this.pos++;
                n++;
              }
              out.push(v & 0xff);
            } else {
              out.push(e);
              this.pos++;
            }
        }
        continue;
      }
      if (c === 0x28) depth++;
      if (c === 0x29) {
        depth--;
        if (depth === 0) {
          this.pos++;
          return { type: 'str', bytes: Uint8Array.from(out), hex: false, start, end: this.pos };
        }
      }
      out.push(c);
      this.pos++;
    }
    throw new ContentParseError('Unterminated string', start);
  }

  private readHexString(start: number): Operand {
    const d = this.data;
    this.pos++; // <
    const nibbles: number[] = [];
    while (this.pos < d.length) {
      const c = d[this.pos];
      if (c === 0x3e) {
        this.pos++;
        if (nibbles.length % 2 === 1) nibbles.push(0);
        const bytes = new Uint8Array(nibbles.length / 2);
        for (let i = 0; i < bytes.length; i++) bytes[i] = (nibbles[2 * i] << 4) | nibbles[2 * i + 1];
        return { type: 'str', bytes, hex: true, start, end: this.pos };
      }
      if (isHex(c)) nibbles.push(hexVal(c));
      else if (!isWs(c)) throw new ContentParseError('Invalid hex string', this.pos);
      this.pos++;
    }
    throw new ContentParseError('Unterminated hex string', start);
  }

  private readName(start: number): Operand {
    const d = this.data;
    this.pos++; // /
    let name = '';
    while (this.pos < d.length && !isWs(d[this.pos]) && !isDelim(d[this.pos])) {
      const c = d[this.pos];
      if (c === 0x23 && isHex(d[this.pos + 1]) && isHex(d[this.pos + 2])) {
        name += String.fromCharCode((hexVal(d[this.pos + 1]) << 4) | hexVal(d[this.pos + 2]));
        this.pos += 3;
      } else {
        name += String.fromCharCode(c);
        this.pos++;
      }
    }
    return { type: 'name', value: name, start, end: this.pos };
  }

  /** Current array/dictionary nesting; bounded so hostile input cannot overflow the stack. */
  private nesting = 0;

  private enterContainer(start: number): void {
    if (++this.nesting > MAX_CONTAINER_NESTING) {
      throw new ContentParseError('Operand nesting too deep', start);
    }
  }

  private readArray(start: number): Operand {
    this.enterContainer(start);
    try {
      return this.readArrayItems(start);
    } finally {
      this.nesting--;
    }
  }

  private readArrayItems(start: number): Operand {
    const items: Operand[] = [];
    for (;;) {
      const tok = this.next();
      if (!tok) throw new ContentParseError('Unterminated array', start);
      if ('kind' in tok) {
        if (tok.kind === 'arrEnd') return { type: 'arr', items, start, end: tok.end };
        throw new ContentParseError('Unexpected token in array', tok.start);
      }
      items.push(tok);
    }
  }

  private readDict(start: number): Operand {
    this.enterContainer(start);
    try {
      return this.readDictEntries(start);
    } finally {
      this.nesting--;
    }
  }

  private readDictEntries(start: number): Operand {
    const entries = new Map<string, Operand>();
    for (;;) {
      const keyTok = this.next();
      if (!keyTok) throw new ContentParseError('Unterminated dictionary', start);
      if ('kind' in keyTok) {
        if (keyTok.kind === 'dictEnd') return { type: 'dict', entries, start, end: keyTok.end };
        throw new ContentParseError('Unexpected token in dictionary', keyTok.start);
      }
      if (keyTok.type !== 'name') throw new ContentParseError('Dictionary key is not a name', keyTok.start);
      const valTok = this.next();
      if (!valTok || 'kind' in valTok) throw new ContentParseError('Dictionary value missing', keyTok.end);
      entries.set(keyTok.value, valTok);
    }
  }

  /**
   * Parse BI <dict pairs> ID <data> EI. `start` is the BI position (inline
   * images take no operands; stray preceding operands are discarded).
   */
  private readInlineImage(start: number, _strayOperands: Operand[]): ContentOp {
    const d = this.data;
    const dict = new Map<string, Operand>();
    for (;;) {
      const tok = this.next();
      if (!tok) throw new ContentParseError('Unterminated inline image dictionary', start);
      if ('kind' in tok) {
        if (tok.kind === 'kw' && tok.value === 'ID') break;
        throw new ContentParseError('Unexpected token in inline image dictionary', tok.start);
      }
      if (tok.type !== 'name') throw new ContentParseError('Inline image key is not a name', tok.start);
      const val = this.next();
      if (!val || 'kind' in val) throw new ContentParseError('Inline image value missing', tok.end);
      dict.set(tok.value, val);
    }
    // Exactly one whitespace byte separates ID from the data.
    if (isWs(d[this.pos])) this.pos++;
    const dataStart = this.pos;
    const { dataEnd, ei } = this.findInlineImageEnd(dict, dataStart);
    this.pos = ei + 2;
    return {
      op: 'BI',
      operands: [],
      start,
      end: this.pos,
      inlineDict: dict,
      inlineData: { start: dataStart, end: dataEnd },
    };
  }

  /** Returns the payload end and the offset of the 'E' of EI. */
  private findInlineImageEnd(dict: Map<string, Operand>, dataStart: number): { dataEnd: number; ei: number } {
    const d = this.data;
    const lengthOp = dict.get('L') ?? dict.get('Length');
    if (lengthOp && lengthOp.type === 'num' && lengthOp.value >= 0) {
      const endOfData = dataStart + lengthOp.value;
      const ei = this.scanForEI(endOfData);
      if (ei >= 0 && ei - endOfData <= 3) return { dataEnd: endOfData, ei };
    }

    const filter = dict.get('F') ?? dict.get('Filter');
    const hasFilter = !!filter && !(filter.type === 'arr' && filter.items.length === 0);
    if (!hasFilter) {
      const exact = this.unfilteredInlineLength(dict);
      if (exact !== null) {
        const ei = this.scanForEI(dataStart + exact);
        if (ei >= 0 && ei - (dataStart + exact) <= 3) return { dataEnd: dataStart + exact, ei };
      }
    }

    // Filtered (or undeterminable) data: find "<ws>EI<ws|EOF>" followed by
    // bytes that look like content-stream text, the same heuristic pdf.js uses.
    let p = dataStart;
    while (p < d.length - 1) {
      if (d[p] === 0x45 && d[p + 1] === 0x49 && (p === dataStart || isWs(d[p - 1]))) {
        const after = p + 2;
        if (after >= d.length || isWs(d[after]) || isDelim(d[after])) {
          // The whitespace before EI is a separator, not payload.
          if (this.looksLikeContentAfter(after)) return { dataEnd: p > dataStart ? p - 1 : p, ei: p };
        }
      }
      p++;
    }
    throw new ContentParseError('Inline image end (EI) not found', dataStart);
  }

  /** Locate 'EI' at or just after `from` (allowing one or two whitespace bytes). */
  private scanForEI(from: number): number {
    const d = this.data;
    let p = from;
    let skipped = 0;
    while (p < d.length && isWs(d[p]) && skipped < 3) {
      p++;
      skipped++;
    }
    if (d[p] === 0x45 && d[p + 1] === 0x49) {
      const after = p + 2;
      if (after >= d.length || isWs(d[after]) || isDelim(d[after])) return p;
    }
    return -1;
  }

  private unfilteredInlineLength(dict: Map<string, Operand>): number | null {
    const num = (k1: string, k2: string): number | null => {
      const v = dict.get(k1) ?? dict.get(k2);
      return v && v.type === 'num' ? v.value : null;
    };
    const w = num('W', 'Width');
    const h = num('H', 'Height');
    if (w === null || h === null) return null;
    const im = dict.get('IM') ?? dict.get('ImageMask');
    const isMask = im?.type === 'bool' && im.value;
    const bpc = isMask ? 1 : num('BPC', 'BitsPerComponent') ?? 8;
    let comps = 1;
    if (!isMask) {
      const cs = dict.get('CS') ?? dict.get('ColorSpace');
      if (!cs) return null;
      if (cs.type === 'name') {
        if (cs.value === 'G' || cs.value === 'DeviceGray' || cs.value === 'I' || cs.value === 'Indexed') comps = 1;
        else if (cs.value === 'RGB' || cs.value === 'DeviceRGB') comps = 3;
        else if (cs.value === 'CMYK' || cs.value === 'DeviceCMYK') comps = 4;
        else return null; // named resource: component count unknown here
      } else if (cs.type === 'arr' && cs.items[0]?.type === 'name' && (cs.items[0].value === 'I' || cs.items[0].value === 'Indexed')) {
        comps = 1;
      } else {
        return null;
      }
    }
    return h * Math.ceil((w * bpc * comps) / 8);
  }

  private looksLikeContentAfter(p: number): boolean {
    const d = this.data;
    const limit = Math.min(d.length, p + 32);
    for (let i = p; i < limit; i++) {
      const c = d[i];
      if (c === 0x09 || c === 0x0a || c === 0x0d) continue;
      if (c < 0x20 || c > 0x7e) return false;
    }
    return true;
  }
}

export function latin1(d: Uint8Array, start: number, end: number): string {
  let s = '';
  for (let i = start; i < end; i++) s += String.fromCharCode(d[i]);
  return s;
}

export function parseContent(data: Uint8Array): ContentOp[] {
  return new ContentTokenizer(data).parse();
}

/** Serialize bytes as a PDF hex string. */
export function hexString(bytes: Uint8Array): string {
  let s = '<';
  for (let i = 0; i < bytes.length; i++) s += bytes[i].toString(16).padStart(2, '0');
  return s + '>';
}
