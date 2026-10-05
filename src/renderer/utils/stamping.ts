/**
 * Page stamping: watermark, header/footer, page numbers and Bates numbering.
 *
 * Every stamp is a byte transform over the (always-decrypted) in-memory PDF.
 * The hook commits the result like a structural op (runStructural +
 * commitDocument + history), so the pdf.js viewer renders the real stamped
 * bytes and in-session undo restores the previous bytes exactly.
 *
 * On-disk shape of one stamp on one page:
 *
 *   page /Contents  [... , <stream /PDFManagerStamp /Watermark>]
 *       q /Artifact <</Type /Pagination /Subtype /Watermark>> BDC
 *         /PMStamp_Watermark_<id> Do
 *       EMC Q
 *   page /Resources /XObject /PMStamp_Watermark_<id>  ->  Form XObject
 *       /OC  -> OCG "Watermark" (registered in /Root /OCProperties)
 *       /PieceInfo << /PDFManager << /LastModified (D:..) /Private << /Kind /Watermark >> >> >>
 *       /Matrix maps an upright "visual" space onto the page's user space,
 *               compensating /Rotate and the CropBox origin
 *       /BBox   [0 0 visibleWidth visibleHeight]
 *
 * "On top" stamps first wrap the existing content in a balanced q/Q pair
 * (both streams marked /Wrap) so a page that leaves its CTM or colour state
 * dirty cannot displace or recolour the stamp. "Behind" stamps are prepended;
 * they are self-contained q..Q so the original content still starts in the
 * default graphics state.
 *
 * removeStamps(kind) deletes exactly what this module added for that kind:
 * the marked content streams, the marked XObjects, any stray `Do` of a marked
 * XObject left in a foreign (e.g. coalesced) content stream, the /Wrap pair
 * once no stamp remains on the page, and the kind's OCG.
 */
import {
  PDFDocument as PDFLib,
  PDFPage as PDFLibPage,
  PDFFont,
  PDFImage,
  StandardFonts,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFStream,
  PDFString,
  PDFHexString,
  PDFOperator,
  PDFOperatorNames,
  PDFObject,
  pushGraphicsState,
  popGraphicsState,
  beginText,
  endText,
  setFontAndSize,
  showText,
  moveText,
  setFillingRgbColor,
  concatTransformationMatrix,
  setGraphicsState,
  drawObject,
  endMarkedContent,
} from 'pdf-lib';
import { Encodings } from '@pdf-lib/standard-fonts';
import fontkit from '@pdf-lib/fontkit';
import { getContentStreams, decodeStream, updateStream } from './pdfStreamUtils';

// ───────────────────────────── Public types ─────────────────────────────

export type StampKind = 'Watermark' | 'HeaderFooter' | 'PageNumbers' | 'Bates';

export const STAMP_KIND_LABELS: Record<StampKind, string> = {
  Watermark: 'Watermark',
  HeaderFooter: 'Header/Footer',
  PageNumbers: 'Page Numbers',
  Bates: 'Bates Numbers',
};

/** Standard-14 fonts offered for stamps. All encode text as WinAnsi. */
export const STAMP_FONTS = [
  'Helvetica',
  'Helvetica-Bold',
  'Helvetica-Oblique',
  'Times-Roman',
  'Times-Bold',
  'Times-Italic',
  'Courier',
  'Courier-Bold',
] as const;
export type StampFont = (typeof STAMP_FONTS)[number];

const FONT_MAP: Record<StampFont, StandardFonts> = {
  Helvetica: StandardFonts.Helvetica,
  'Helvetica-Bold': StandardFonts.HelveticaBold,
  'Helvetica-Oblique': StandardFonts.HelveticaOblique,
  'Times-Roman': StandardFonts.TimesRoman,
  'Times-Bold': StandardFonts.TimesRomanBold,
  'Times-Italic': StandardFonts.TimesRomanItalic,
  Courier: StandardFonts.Courier,
  'Courier-Bold': StandardFonts.CourierBold,
};

export type GridPosition =
  | 'top-left' | 'top-center' | 'top-right'
  | 'middle-left' | 'center' | 'middle-right'
  | 'bottom-left' | 'bottom-center' | 'bottom-right';

export const GRID_POSITIONS: GridPosition[] = [
  'top-left', 'top-center', 'top-right',
  'middle-left', 'center', 'middle-right',
  'bottom-left', 'bottom-center', 'bottom-right',
];

/** The six header/footer slots. */
export type SlotPosition =
  | 'header-left' | 'header-center' | 'header-right'
  | 'footer-left' | 'footer-center' | 'footer-right';

export const SLOT_POSITIONS: SlotPosition[] = [
  'header-left', 'header-center', 'header-right',
  'footer-left', 'footer-center', 'footer-right',
];

export interface TextStyle {
  font: StampFont;
  /** Points. */
  fontSize: number;
  /** "#rrggbb". */
  color: string;
}

export interface WatermarkTextSource {
  type: 'text';
  text: string;
  style: TextStyle;
}

export interface WatermarkImageSource {
  type: 'image';
  /** Raw PNG or JPEG bytes. */
  bytes: Uint8Array;
  /** Rendered width as a fraction (0..1] of the visible page width. */
  scale: number;
}

export interface WatermarkOptions {
  source: WatermarkTextSource | WatermarkImageSource;
  /** 0..1 */
  opacity: number;
  /** Degrees, counter-clockwise, in the upright page view. */
  rotation: number;
  position: GridPosition;
  /** Repeat across the whole page instead of drawing once at `position`. */
  tile: boolean;
  /** Draw underneath the page content instead of on top. */
  behind: boolean;
  /** "all" | "odd" | "even" | "1-3,5" */
  pageRange: string;
  /** Points from the page edge for non-centred positions. */
  margin: number;
}

export type NumberFormat = 'arabic' | 'roman-lower' | 'roman-upper';

export interface HeaderFooterOptions {
  /** Template text per slot; tokens {page} {pages} {date} {filename}. */
  slots: Partial<Record<SlotPosition, string>>;
  style: TextStyle;
  margins: { top: number; bottom: number; left: number; right: number };
  pageRange: string;
  /** Leave the first page of the document unstamped. */
  skipFirstPage: boolean;
  /** Number rendered for physical page 1 (default 1). */
  startNumber: number;
  numberFormat: NumberFormat;
}

export type PageNumberPreset = 'n' | 'page-n-of-total' | 'roman';

export interface PageNumberOptions {
  preset: PageNumberPreset;
  position: SlotPosition;
  style: TextStyle;
  margins: { top: number; bottom: number; left: number; right: number };
  pageRange: string;
  skipFirstPage: boolean;
  startNumber: number;
}

export interface BatesOptions {
  prefix: string;
  suffix: string;
  startNumber: number;
  /** Zero-pad the number to this many digits (0 = no padding). */
  digits: number;
  position: SlotPosition;
  style: TextStyle;
  margins: { top: number; bottom: number; left: number; right: number };
  pageRange: string;
}

/** Values substituted into header/footer tokens. */
export interface StampContext {
  fileName: string;
  /** Date used for {date}; injected so callers (and tests) control it. */
  date: Date;
}

export type StampRequest =
  | { kind: 'Watermark'; options: WatermarkOptions }
  | { kind: 'HeaderFooter'; options: HeaderFooterOptions }
  | { kind: 'PageNumbers'; options: PageNumberOptions }
  | { kind: 'Bates'; options: BatesOptions };

export interface ApplyStampOptions {
  /** Remove this app's existing stamps of the same kind first (default true). */
  replaceExisting?: boolean;
  /**
   * Reads a bundled font file by name (e.g. 'LiberationSans-Regular.ttf').
   * Defaults to the app's `standard_fonts/` directory; tests pass a disk reader.
   */
  loadFontFile?: FontFileLoader;
}

export type FontFileLoader = (fileName: string) => Promise<Uint8Array>;

/** User-correctable input problem. The message is safe to show verbatim. */
export class StampValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'StampValidationError';
  }
}

// ───────────────────────────── Constants ─────────────────────────────

/** Marker key on content streams, XObjects and OCGs this module creates. */
const MARK = PDFName.of('PDFManagerStamp');
const WRAP_MARK = 'Wrap';
const PIECE_INFO_APP = PDFName.of('PDFManager');
const XOBJECT_PREFIX = 'PMStamp_';

const OCG_NAMES: Record<StampKind, string> = {
  Watermark: 'Watermark',
  HeaderFooter: 'Header/Footer',
  PageNumbers: 'Page Numbers',
  Bates: 'Bates Numbers',
};

/** Upper bound on tiles per page so a 1-char tiny watermark stays tractable. */
const MAX_TILES_PER_PAGE = 1500;

// ───────────────────────────── Pure helpers ─────────────────────────────

/**
 * Parse a page range into sorted, unique 0-based indices.
 * Accepts "all", "odd", "even", or comma-separated numbers / ranges ("1-3,5").
 */
export function parsePageRange(spec: string, pageCount: number): number[] {
  const trimmed = spec.trim().toLowerCase();
  if (pageCount < 1) throw new StampValidationError('The document has no pages.');
  if (trimmed === '' || trimmed === 'all') {
    return Array.from({ length: pageCount }, (_, i) => i);
  }
  if (trimmed === 'odd') {
    return Array.from({ length: pageCount }, (_, i) => i).filter((i) => i % 2 === 0);
  }
  if (trimmed === 'even') {
    return Array.from({ length: pageCount }, (_, i) => i).filter((i) => i % 2 === 1);
  }
  const result = new Set<number>();
  for (const rawPart of trimmed.split(',')) {
    const part = rawPart.trim();
    if (part === '') continue;
    const rangeMatch = /^(\d+)\s*-\s*(\d+)$/.exec(part);
    const singleMatch = /^(\d+)$/.exec(part);
    if (rangeMatch) {
      const start = parseInt(rangeMatch[1], 10);
      const end = parseInt(rangeMatch[2], 10);
      if (start < 1 || end > pageCount || start > end) {
        throw new StampValidationError(`Page range "${part}" is outside 1-${pageCount}.`);
      }
      for (let p = start; p <= end; p++) result.add(p - 1);
    } else if (singleMatch) {
      const p = parseInt(singleMatch[1], 10);
      if (p < 1 || p > pageCount) {
        throw new StampValidationError(`Page ${p} is outside 1-${pageCount}.`);
      }
      result.add(p - 1);
    } else {
      throw new StampValidationError(
        `"${part}" is not a page range. Use "all", "odd", "even", or numbers like 1-3,5.`
      );
    }
  }
  if (result.size === 0) throw new StampValidationError('The page range selects no pages.');
  return [...result].sort((a, b) => a - b);
}

export function toRoman(n: number): string {
  if (!Number.isInteger(n) || n < 1 || n > 3999) {
    throw new StampValidationError(`Roman numerals cover 1-3999; ${n} is out of range.`);
  }
  const table: Array<[number, string]> = [
    [1000, 'm'], [900, 'cm'], [500, 'd'], [400, 'cd'], [100, 'c'], [90, 'xc'],
    [50, 'l'], [40, 'xl'], [10, 'x'], [9, 'ix'], [5, 'v'], [4, 'iv'], [1, 'i'],
  ];
  let rest = n;
  let out = '';
  for (const [value, glyph] of table) {
    while (rest >= value) {
      out += glyph;
      rest -= value;
    }
  }
  return out;
}

export function formatNumber(n: number, format: NumberFormat): string {
  if (format === 'roman-lower') return toRoman(n);
  if (format === 'roman-upper') return toRoman(n).toUpperCase();
  return String(n);
}

export function formatBates(n: number, opts: Pick<BatesOptions, 'prefix' | 'suffix' | 'digits'>): string {
  const digits = Math.max(0, Math.floor(opts.digits));
  return `${opts.prefix}${String(n).padStart(digits, '0')}${opts.suffix}`;
}

export function formatDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** Substitute {page} {pages} {date} {filename}; unknown tokens are left as typed. */
export function resolveTokens(
  template: string,
  values: { page: string; pages: string; date: string; filename: string }
): string {
  return template.replace(/\{(page|pages|date|filename)\}/g, (_, token: keyof typeof values) => values[token]);
}

export function pageNumberTemplate(preset: PageNumberPreset): { template: string; format: NumberFormat } {
  switch (preset) {
    case 'page-n-of-total':
      return { template: 'Page {page} of {pages}', format: 'arabic' };
    case 'roman':
      return { template: '{page}', format: 'roman-lower' };
    case 'n':
    default:
      return { template: '{page}', format: 'arabic' };
  }
}

/** Expand the page-number preset into the equivalent header/footer options. */
export function pageNumbersToHeaderFooter(opts: PageNumberOptions): HeaderFooterOptions {
  const { template, format } = pageNumberTemplate(opts.preset);
  return {
    slots: { [opts.position]: template },
    style: opts.style,
    margins: opts.margins,
    pageRange: opts.pageRange,
    skipFirstPage: opts.skipFirstPage,
    startNumber: opts.startNumber,
    numberFormat: format,
  };
}

function parseHexColor(hex: string): [number, number, number] {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  if (!m) throw new StampValidationError(`"${hex}" is not a colour like #336699.`);
  const v = parseInt(m[1], 16);
  return [((v >> 16) & 0xff) / 255, ((v >> 8) & 0xff) / 255, (v & 0xff) / 255];
}

function assertFinite(value: number, label: string, min: number, max: number): void {
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new StampValidationError(`${label} must be between ${min} and ${max}.`);
  }
}

function validateStyle(style: TextStyle): void {
  if (!STAMP_FONTS.includes(style.font)) {
    throw new StampValidationError(`Unknown font "${style.font}".`);
  }
  assertFinite(style.fontSize, 'Font size', 4, 400);
  parseHexColor(style.color);
}

function validateMargins(m: HeaderFooterOptions['margins']): void {
  assertFinite(m.top, 'Top margin', 0, 1000);
  assertFinite(m.bottom, 'Bottom margin', 0, 1000);
  assertFinite(m.left, 'Left margin', 0, 1000);
  assertFinite(m.right, 'Right margin', 0, 1000);
}

/**
 * Characters the font cannot encode. For a standard font that is anything
 * outside WinAnsi; StampFontResolver only hands one out for WinAnsi text, so
 * this is a final guard before drawing, never the user-facing fallback.
 */
export function findUnencodableChars(font: PDFFont, text: string): string[] {
  const bad = new Set<string>();
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (cp < 0x20 || cp === 0x7f) {
      bad.add(ch);
      continue;
    }
    try {
      font.encodeText(ch);
    } catch {
      bad.add(ch);
    }
  }
  return [...bad];
}

function describeChars(chars: string[]): string {
  return chars
    .slice(0, 6)
    .map((c) => {
      const cp = (c.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
      const printable = (c.codePointAt(0) ?? 0) >= 0x20 ? `"${c}" ` : '';
      return `${printable}(U+${cp})`;
    })
    .join(', ') + (chars.length > 6 ? ` and ${chars.length - 6} more` : '');
}

/**
 * Bundled Unicode fallback per stamp font. Only Liberation Sans ships with the
 * app (it is pdf.js's standard-font data), so serif and monospace stamps fall
 * back to the sans face of the same weight/style when they need it.
 */
const UNICODE_FALLBACK_FILE: Record<StampFont, string> = {
  Helvetica: 'LiberationSans-Regular.ttf',
  'Helvetica-Bold': 'LiberationSans-Bold.ttf',
  'Helvetica-Oblique': 'LiberationSans-Italic.ttf',
  'Times-Roman': 'LiberationSans-Regular.ttf',
  'Times-Bold': 'LiberationSans-Bold.ttf',
  'Times-Italic': 'LiberationSans-Italic.ttf',
  Courier: 'LiberationSans-Regular.ttf',
  'Courier-Bold': 'LiberationSans-Bold.ttf',
};

const defaultLoadFontFile: FontFileLoader = async (fileName) => {
  const res = await fetch(new URL(`standard_fonts/${fileName}`, document.baseURI));
  if (!res.ok) throw new Error(`Could not load bundled font ${fileName} (${res.status})`);
  return new Uint8Array(await res.arrayBuffer());
};

function isControlChar(ch: string): boolean {
  const cp = ch.codePointAt(0) ?? 0;
  return cp < 0x20 || cp === 0x7f;
}

/** True when every character is representable in the standard fonts' WinAnsi encoding. */
function isWinAnsiText(text: string): boolean {
  for (const ch of text) {
    if (isControlChar(ch)) return false;
    if (!Encodings.WinAnsi.canEncodeUnicodeCodePoint(ch.codePointAt(0) ?? 0)) return false;
  }
  return true;
}

/**
 * Picks the font for one stamp. Western (WinAnsi) text keeps the chosen
 * standard font, so existing output is unchanged; anything else embeds the
 * bundled Unicode font as a subset. Characters that font has no glyph for are
 * rejected by name before anything is mutated.
 */
class StampFontResolver {
  constructor(private readonly pdfDoc: PDFLib, private readonly loadFontFile: FontFileLoader) {}

  async resolve(fontName: StampFont, texts: Array<{ text: string; where: string }>): Promise<PDFFont> {
    if (texts.every((t) => isWinAnsiText(t.text))) {
      return this.pdfDoc.embedFont(FONT_MAP[fontName]);
    }
    // Control characters are never drawable, in any font.
    for (const t of texts) {
      const controls = [...new Set([...t.text].filter(isControlChar))];
      if (controls.length) {
        throw new StampValidationError(`${t.where} contains characters that cannot be drawn: ${describeChars(controls)}.`);
      }
    }
    this.pdfDoc.registerFontkit(fontkit);
    const bytes = await this.loadFontFile(UNICODE_FALLBACK_FILE[fontName]);
    const font = await this.pdfDoc.embedFont(bytes, { subset: true });
    const covered = new Set(font.getCharacterSet());
    for (const t of texts) {
      const missing = [...new Set([...t.text].filter((ch) => !covered.has(ch.codePointAt(0) ?? -1)))];
      if (missing.length) {
        throw new StampValidationError(
          `${t.where} contains characters the bundled fonts cannot show: ${describeChars(missing)}. ` +
            'Latin, Greek and Cyrillic text is supported.'
        );
      }
    }
    return font;
  }
}

function assertEncodable(font: PDFFont, text: string, where: string): void {
  const bad = findUnencodableChars(font, text);
  if (bad.length > 0) {
    throw new StampValidationError(
      `${where} contains characters the standard PDF fonts cannot show: ${describeChars(bad)}. ` +
        'Only Western (WinAnsi) characters are supported.'
    );
  }
}

// ───────────────────────────── Geometry ─────────────────────────────

/**
 * The page's visible area and the matrix that maps upright "visual" space
 * (origin at the bottom-left of what the reader sees, y up) onto user space.
 */
export interface PageFrame {
  /** Visible width as displayed (after /Rotate). */
  width: number;
  /** Visible height as displayed (after /Rotate). */
  height: number;
  rotation: 0 | 90 | 180 | 270;
  matrix: [number, number, number, number, number, number];
}

export function computePageFrame(page: PDFLibPage): PageFrame {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  // The visible region is CropBox clipped to MediaBox (ISO 32000-1 §14.11.2).
  const x0 = Math.max(media.x, crop.x);
  const y0 = Math.max(media.y, crop.y);
  const x1 = Math.min(media.x + media.width, crop.x + crop.width);
  const y1 = Math.min(media.y + media.height, crop.y + crop.height);
  const cx = x1 > x0 ? x0 : media.x;
  const cy = y1 > y0 ? y0 : media.y;
  const cw = x1 > x0 ? x1 - x0 : media.width;
  const ch = y1 > y0 ? y1 - y0 : media.height;

  const raw = page.getRotation().angle;
  const rotation = ((((Math.round(raw / 90) * 90) % 360) + 360) % 360) as 0 | 90 | 180 | 270;

  // /Rotate turns the page clockwise for display. Inverting that turn:
  //   0:   x = cx + u,       y = cy + v
  //   90:  x = cx + cw - v,  y = cy + u
  //   180: x = cx + cw - u,  y = cy + ch - v
  //   270: x = cx + v,       y = cy + ch - u
  switch (rotation) {
    case 90:
      return { width: ch, height: cw, rotation, matrix: [0, 1, -1, 0, cx + cw, cy] };
    case 180:
      return { width: cw, height: ch, rotation, matrix: [-1, 0, 0, -1, cx + cw, cy + ch] };
    case 270:
      return { width: ch, height: cw, rotation, matrix: [0, -1, 1, 0, cx, cy + ch] };
    case 0:
    default:
      return { width: cw, height: ch, rotation: 0, matrix: [1, 0, 0, 1, cx, cy] };
  }
}

function slotAnchor(
  slot: SlotPosition,
  frame: PageFrame,
  textWidth: number,
  ascent: number,
  descent: number,
  margins: HeaderFooterOptions['margins']
): { x: number; y: number } {
  const [band, align] = slot.split('-') as ['header' | 'footer', 'left' | 'center' | 'right'];
  const y = band === 'header' ? frame.height - margins.top - ascent : margins.bottom + descent;
  let x: number;
  if (align === 'left') x = margins.left;
  else if (align === 'right') x = frame.width - margins.right - textWidth;
  else x = (frame.width - textWidth) / 2;
  return { x, y };
}

// ───────────────────────────── PDF object helpers ─────────────────────────────

function pdfDate(date: Date): PDFString {
  const pad = (n: number) => String(n).padStart(2, '0');
  return PDFString.of(
    `D:${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}` +
      `${pad(date.getUTCHours())}${pad(date.getUTCMinutes())}${pad(date.getUTCSeconds())}Z`
  );
}

function pieceInfo(pdfDoc: PDFLib, kind: StampKind, date: Date): PDFDict {
  const ctx = pdfDoc.context;
  const priv = ctx.obj({ Kind: PDFName.of(kind) });
  const app = ctx.obj({ LastModified: pdfDate(date), Private: priv });
  const dict = ctx.obj({});
  dict.set(PIECE_INFO_APP, app);
  return dict;
}

/** The stamp kind recorded on an XObject by this module, or null. */
function stampKindOfXObject(pdfDoc: PDFLib, obj: PDFObject | undefined): StampKind | null {
  const resolved = obj instanceof PDFRef ? pdfDoc.context.lookup(obj) : obj;
  if (!(resolved instanceof PDFStream)) return null;
  const pi = resolved.dict.lookupMaybe(PDFName.of('PieceInfo'), PDFDict);
  const app = pi?.lookupMaybe(PIECE_INFO_APP, PDFDict);
  const priv = app?.lookupMaybe(PDFName.of('Private'), PDFDict);
  const kind = priv?.lookupMaybe(PDFName.of('Kind'), PDFName);
  return kind ? (kind.decodeText() as StampKind) : null;
}

function markOf(dict: PDFDict): string | null {
  const v = dict.lookupMaybe(MARK, PDFName);
  return v ? v.decodeText() : null;
}

/** Fetch (or create) the document-level OCG for a stamp kind. */
function ensureOcg(pdfDoc: PDFLib, kind: StampKind): PDFRef {
  const ctx = pdfDoc.context;
  const catalog = pdfDoc.catalog;
  let ocProps = catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
  if (!ocProps) {
    ocProps = ctx.obj({ OCGs: [], D: { Order: [], ON: [] } });
    catalog.set(PDFName.of('OCProperties'), ocProps);
  }
  let ocgs = ocProps.lookupMaybe(PDFName.of('OCGs'), PDFArray);
  if (!ocgs) {
    ocgs = ctx.obj([]);
    ocProps.set(PDFName.of('OCGs'), ocgs);
  }
  for (let i = 0; i < ocgs.size(); i++) {
    const ref = ocgs.get(i);
    const ocg = ctx.lookupMaybe(ref, PDFDict);
    if (ref instanceof PDFRef && ocg && markOf(ocg) === kind) return ref;
  }
  const ocg = ctx.obj({
    Type: 'OCG',
    Name: PDFHexString.fromText(OCG_NAMES[kind]),
    Usage: {
      View: { ViewState: 'ON' },
      Print: { PrintState: 'ON' },
      Export: { ExportState: 'ON' },
    },
  });
  ocg.set(MARK, PDFName.of(kind));
  const ocgRef = ctx.register(ocg);
  ocgs.push(ocgRef);

  let d = ocProps.lookupMaybe(PDFName.of('D'), PDFDict);
  if (!d) {
    d = ctx.obj({});
    ocProps.set(PDFName.of('D'), d);
  }
  for (const key of ['Order', 'ON']) {
    let arr = d.lookupMaybe(PDFName.of(key), PDFArray);
    if (!arr) {
      arr = ctx.obj([]);
      d.set(PDFName.of(key), arr);
    }
    arr.push(ocgRef);
  }
  return ocgRef;
}

function removeOcg(pdfDoc: PDFLib, kind: StampKind): void {
  const ctx = pdfDoc.context;
  const ocProps = pdfDoc.catalog.lookupMaybe(PDFName.of('OCProperties'), PDFDict);
  if (!ocProps) return;
  const ocgs = ocProps.lookupMaybe(PDFName.of('OCGs'), PDFArray);
  if (!ocgs) return;
  const ours: PDFRef[] = [];
  for (let i = 0; i < ocgs.size(); i++) {
    const ref = ocgs.get(i);
    const ocg = ctx.lookupMaybe(ref, PDFDict);
    if (ref instanceof PDFRef && ocg && markOf(ocg) === kind) ours.push(ref);
  }
  if (ours.length === 0) return;
  const isOurs = (o: PDFObject) => o instanceof PDFRef && ours.some((r) => r === o);

  const filterArray = (arr: PDFArray | undefined) => {
    if (!arr) return;
    for (let i = arr.size() - 1; i >= 0; i--) {
      const item = arr.get(i);
      if (isOurs(item)) arr.remove(i);
      else if (item instanceof PDFArray) filterArray(item);
    }
  };
  filterArray(ocgs);
  const configs: PDFDict[] = [];
  const d = ocProps.lookupMaybe(PDFName.of('D'), PDFDict);
  if (d) configs.push(d);
  const extra = ocProps.lookupMaybe(PDFName.of('Configs'), PDFArray);
  if (extra) {
    for (let i = 0; i < extra.size(); i++) {
      const c = ctx.lookupMaybe(extra.get(i), PDFDict);
      if (c) configs.push(c);
    }
  }
  for (const cfg of configs) {
    for (const key of ['Order', 'ON', 'OFF', 'Locked', 'RBGroups']) {
      filterArray(cfg.lookupMaybe(PDFName.of(key), PDFArray));
    }
  }
  for (const ref of ours) ctx.delete(ref);
  if (ocgs.size() === 0) pdfDoc.catalog.delete(PDFName.of('OCProperties'));
}

function contentsArray(pdfDoc: PDFLib, page: PDFLibPage): PDFArray {
  const ctx = pdfDoc.context;
  const existing = page.node.get(PDFName.of('Contents'));
  const resolved = existing ? ctx.lookup(existing) : undefined;
  if (resolved instanceof PDFArray) return resolved;
  const arr = ctx.obj([]);
  if (existing) arr.push(existing);
  page.node.set(PDFName.of('Contents'), arr);
  return arr;
}

/**
 * Give the page its own Resources and XObject dictionaries (shallow copies of
 * whatever it inherited or shared), so adding an XObject never leaks onto
 * another page that shares the same resource dictionary.
 */
function pageLocalXObjectDict(pdfDoc: PDFLib, page: PDFLibPage): PDFDict {
  const ctx = pdfDoc.context;
  const inherited = page.node.Resources();
  const resources = inherited ? inherited.clone(ctx) : ctx.obj({});
  const xobjInherited = resources.lookupMaybe(PDFName.of('XObject'), PDFDict);
  const xobj = xobjInherited ? xobjInherited.clone(ctx) : ctx.obj({});
  resources.set(PDFName.of('XObject'), xobj);
  page.node.set(PDFName.of('Resources'), resources);
  return xobj;
}

function markedContentStream(pdfDoc: PDFLib, kind: string, ops: PDFOperator[]): PDFRef {
  const stream = pdfDoc.context.contentStream(ops);
  stream.dict.set(MARK, PDFName.of(kind));
  return pdfDoc.context.register(stream);
}

function randomId(): string {
  const bytes = new Uint8Array(6);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

const ARTIFACT_SUBTYPE: Record<StampKind, string> = {
  Watermark: 'Watermark',
  HeaderFooter: 'Header',
  PageNumbers: 'Footer',
  Bates: 'Footer',
};

/** Place a finished Form XObject on a page, behind or on top of its content. */
function placeOnPage(
  pdfDoc: PDFLib,
  page: PDFLibPage,
  kind: StampKind,
  xobjectRef: PDFRef,
  behind: boolean
): void {
  const ctx = pdfDoc.context;
  const name = `${XOBJECT_PREFIX}${kind}_${randomId()}`;
  pageLocalXObjectDict(pdfDoc, page).set(PDFName.of(name), xobjectRef);

  // Tag the stamp as a pagination artifact so tagged-PDF readers skip it.
  // pdf-lib's PDFOperatorArg type omits PDFDict, but PDFOperator serialises any
  // PDFObject operand via copyBytesInto, so an inline property list is valid.
  const artifactProps = ctx.obj({ Type: 'Pagination', Subtype: ARTIFACT_SUBTYPE[kind] });
  const bdcOperands = [PDFName.of('Artifact'), artifactProps] as unknown as Parameters<typeof PDFOperator.of>[1];
  const stampRef = markedContentStream(pdfDoc, kind, [
    pushGraphicsState(),
    PDFOperator.of(PDFOperatorNames.BeginMarkedContentSequence, bdcOperands),
    drawObject(name),
    endMarkedContent(),
    popGraphicsState(),
  ]);

  const contents = contentsArray(pdfDoc, page);
  if (behind) {
    contents.insert(0, stampRef);
    return;
  }
  // Isolate whatever is already on the page so its leftover graphics state
  // cannot reach the stamp. Re-use an existing wrap pair from an earlier stamp.
  const alreadyWrapped =
    contents.size() > 0 && (() => {
      const first = ctx.lookupMaybe(contents.get(0), PDFStream);
      return !!first && markOf(first.dict) === WRAP_MARK;
    })();
  if (!alreadyWrapped && contents.size() > 0) {
    contents.insert(0, markedContentStream(pdfDoc, WRAP_MARK, [pushGraphicsState()]));
    contents.push(markedContentStream(pdfDoc, WRAP_MARK, [popGraphicsState()]));
  }
  contents.push(stampRef);
}

interface FormXObjectSpec {
  ops: PDFOperator[];
  frame: PageFrame;
  fonts?: Record<string, PDFRef>;
  images?: Record<string, PDFRef>;
  opacity?: number;
}

function buildFormXObject(
  pdfDoc: PDFLib,
  kind: StampKind,
  ocgRef: PDFRef,
  spec: FormXObjectSpec,
  date: Date
): PDFRef {
  const ctx = pdfDoc.context;
  const resources = ctx.obj({});
  if (spec.fonts && Object.keys(spec.fonts).length > 0) {
    const fontDict = ctx.obj({});
    for (const [k, ref] of Object.entries(spec.fonts)) fontDict.set(PDFName.of(k), ref);
    resources.set(PDFName.of('Font'), fontDict);
  }
  if (spec.images && Object.keys(spec.images).length > 0) {
    const imgDict = ctx.obj({});
    for (const [k, ref] of Object.entries(spec.images)) imgDict.set(PDFName.of(k), ref);
    resources.set(PDFName.of('XObject'), imgDict);
  }
  if (spec.opacity !== undefined && spec.opacity < 1) {
    const gs = ctx.obj({ Type: 'ExtGState', ca: spec.opacity, CA: spec.opacity });
    const gsDict = ctx.obj({});
    gsDict.set(PDFName.of('GS0'), gs);
    resources.set(PDFName.of('ExtGState'), gsDict);
  }
  const form = ctx.formXObject(spec.ops, {
    BBox: [0, 0, spec.frame.width, spec.frame.height],
    Matrix: spec.frame.matrix,
    Resources: resources,
  });
  form.dict.set(PDFName.of('OC'), ocgRef);
  form.dict.set(PDFName.of('PieceInfo'), pieceInfo(pdfDoc, kind, date));
  return ctx.register(form);
}

function textOps(
  fontKey: string,
  font: PDFFont,
  text: string,
  size: number,
  rgb: [number, number, number],
  x: number,
  y: number
): PDFOperator[] {
  return [
    beginText(),
    setFillingRgbColor(rgb[0], rgb[1], rgb[2]),
    setFontAndSize(fontKey, size),
    moveText(x, y),
    showText(font.encodeText(text)),
    endText(),
  ];
}

// ───────────────────────────── Stamp builders ─────────────────────────────

async function loadForStamping(pdfData: Uint8Array): Promise<PDFLib> {
  // pdfData in memory is decrypted plaintext; ignoreEncryption mirrors
  // pageStructure.ts for robustness against a residual /Encrypt entry.
  return PDFLib.load(pdfData, { ignoreEncryption: true, updateMetadata: false });
}

function sniffImage(bytes: Uint8Array): 'png' | 'jpeg' | null {
  if (bytes.length >= 8 && bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return 'png';
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpeg';
  return null;
}

function validateWatermark(opts: WatermarkOptions): void {
  assertFinite(opts.opacity, 'Opacity', 0.01, 1);
  assertFinite(opts.rotation, 'Rotation', -360, 360);
  assertFinite(opts.margin, 'Margin', 0, 1000);
  if (!GRID_POSITIONS.includes(opts.position)) {
    throw new StampValidationError(`Unknown position "${opts.position}".`);
  }
  if (opts.source.type === 'text') {
    if (opts.source.text.trim() === '') throw new StampValidationError('Enter the watermark text.');
    validateStyle(opts.source.style);
  } else {
    assertFinite(opts.source.scale, 'Image size', 0.01, 1);
    if (!sniffImage(opts.source.bytes)) {
      throw new StampValidationError('Only PNG and JPEG images can be used as a watermark.');
    }
  }
}

async function stampWatermark(
  pdfDoc: PDFLib,
  opts: WatermarkOptions,
  pageIndices: number[],
  date: Date,
  fontResolver: StampFontResolver
): Promise<void> {
  validateWatermark(opts);
  const ocgRef = ensureOcg(pdfDoc, 'Watermark');
  const theta = (opts.rotation * Math.PI) / 180;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);

  // Item dimensions + an op generator that draws the item with its centre at
  // the current origin (the caller has already translated and rotated).
  let itemW: number;
  let itemH: number;
  let drawCentered: () => PDFOperator[];
  let fonts: Record<string, PDFRef> | undefined;
  let images: Record<string, PDFRef> | undefined;
  let imageForScale: PDFImage | null = null;

  if (opts.source.type === 'text') {
    const { text, style } = opts.source;
    const font = await fontResolver.resolve(style.font, [{ text, where: 'The watermark text' }]);
    assertEncodable(font, text, 'The watermark text');
    const rgb = parseHexColor(style.color);
    itemW = font.widthOfTextAtSize(text, style.fontSize);
    const ascent = font.heightAtSize(style.fontSize, { descender: false });
    itemH = ascent;
    fonts = { F0: font.ref };
    drawCentered = () => textOps('F0', font, text, style.fontSize, rgb, -itemW / 2, -ascent / 2);
  } else {
    const kind = sniffImage(opts.source.bytes);
    const image = kind === 'png'
      ? await pdfDoc.embedPng(opts.source.bytes)
      : await pdfDoc.embedJpg(opts.source.bytes);
    imageForScale = image;
    images = { Im0: image.ref };
    // Sized per page below; placeholders keep TS definite-assignment happy.
    itemW = 0;
    itemH = 0;
    drawCentered = () => [
      pushGraphicsState(),
      concatTransformationMatrix(itemW, 0, 0, itemH, -itemW / 2, -itemH / 2),
      drawObject('Im0'),
      popGraphicsState(),
    ];
  }

  for (const index of pageIndices) {
    const page = pdfDoc.getPage(index);
    const frame = computePageFrame(page);
    if (imageForScale && opts.source.type === 'image') {
      itemW = frame.width * opts.source.scale;
      itemH = itemW * (imageForScale.height / imageForScale.width);
    }

    const ops: PDFOperator[] = [pushGraphicsState()];
    if (opts.opacity < 1) ops.push(setGraphicsState('GS0'));

    if (opts.tile) {
      const stepX = itemW * 1.5 + Math.max(itemH, 12);
      const stepY = Math.max(itemH * 4, 24);
      const radius = Math.hypot(frame.width, frame.height) / 2 + Math.max(itemW, itemH);
      let cols = Math.ceil((2 * radius) / stepX) + 1;
      let rows = Math.ceil((2 * radius) / stepY) + 1;
      let sx = stepX;
      let sy = stepY;
      if (cols * rows > MAX_TILES_PER_PAGE) {
        const grow = Math.sqrt((cols * rows) / MAX_TILES_PER_PAGE);
        sx *= grow;
        sy *= grow;
        cols = Math.ceil((2 * radius) / sx) + 1;
        rows = Math.ceil((2 * radius) / sy) + 1;
      }
      ops.push(concatTransformationMatrix(1, 0, 0, 1, frame.width / 2, frame.height / 2));
      ops.push(concatTransformationMatrix(cos, sin, -sin, cos, 0, 0));
      for (let r = 0; r < rows; r++) {
        const y = -radius + r * sy;
        const rowShift = r % 2 === 0 ? 0 : sx / 2;
        for (let c = 0; c < cols; c++) {
          const x = -radius + c * sx + rowShift;
          ops.push(pushGraphicsState(), concatTransformationMatrix(1, 0, 0, 1, x, y), ...drawCentered(), popGraphicsState());
        }
      }
    } else {
      // Half-extents of the rotated item's bounding box keep edge positions
      // fully on the page at any rotation.
      const hx = (Math.abs(cos) * itemW + Math.abs(sin) * itemH) / 2;
      const hy = (Math.abs(sin) * itemW + Math.abs(cos) * itemH) / 2;
      const [vert, horiz] = opts.position === 'center' ? ['middle', 'center'] : opts.position.split('-');
      const m = opts.margin;
      const cx = horiz === 'left' ? m + hx : horiz === 'right' ? frame.width - m - hx : frame.width / 2;
      const cy = vert === 'top' ? frame.height - m - hy : vert === 'bottom' ? m + hy : frame.height / 2;
      ops.push(concatTransformationMatrix(cos, sin, -sin, cos, cx, cy), ...drawCentered());
    }
    ops.push(popGraphicsState());

    const xobjectRef = buildFormXObject(pdfDoc, 'Watermark', ocgRef, { ops, frame, fonts, images, opacity: opts.opacity }, date);
    placeOnPage(pdfDoc, page, 'Watermark', xobjectRef, opts.behind);
  }
}

/** Stamp text slots on each selected page; `textFor` returns slot text per page. */
async function stampSlots(
  pdfDoc: PDFLib,
  kind: StampKind,
  style: TextStyle,
  margins: HeaderFooterOptions['margins'],
  pageIndices: number[],
  textFor: (pageIndex: number, ordinal: number) => Partial<Record<SlotPosition, string>>,
  date: Date,
  fontResolver: StampFontResolver
): Promise<void> {
  validateStyle(style);
  validateMargins(margins);

  // Resolve every page's text first; the font is chosen from ALL of it and
  // validated before mutating anything, so a bad character on page 40 never
  // leaves pages 1-39 half-stamped.
  const plan = pageIndices.map((pageIndex, ordinal) => ({ pageIndex, slots: textFor(pageIndex, ordinal) }));
  const allTexts = plan.flatMap(({ slots }) =>
    Object.entries(slots)
      .filter(([, text]) => !!text)
      .map(([slot, text]) => ({ text: text as string, where: `The ${slot.replace('-', ' ')} text` }))
  );
  const font = await fontResolver.resolve(style.font, allTexts);
  for (const t of allTexts) assertEncodable(font, t.text, t.where);
  const rgb = parseHexColor(style.color);
  const ascent = font.heightAtSize(style.fontSize, { descender: false });
  const descent = font.heightAtSize(style.fontSize) - ascent;

  const ocgRef = ensureOcg(pdfDoc, kind);
  for (const { pageIndex, slots } of plan) {
    const entries = SLOT_POSITIONS.filter((s) => slots[s] && slots[s]!.length > 0);
    if (entries.length === 0) continue;
    const page = pdfDoc.getPage(pageIndex);
    const frame = computePageFrame(page);
    const ops: PDFOperator[] = [pushGraphicsState()];
    for (const slot of entries) {
      const text = slots[slot]!;
      const width = font.widthOfTextAtSize(text, style.fontSize);
      const { x, y } = slotAnchor(slot, frame, width, ascent, descent, margins);
      ops.push(...textOps('F0', font, text, style.fontSize, rgb, x, y));
    }
    ops.push(popGraphicsState());
    const xobjectRef = buildFormXObject(pdfDoc, kind, ocgRef, { ops, frame, fonts: { F0: font.ref } }, date);
    placeOnPage(pdfDoc, page, kind, xobjectRef, false);
  }
}

async function stampHeaderFooter(
  pdfDoc: PDFLib,
  kind: 'HeaderFooter' | 'PageNumbers',
  opts: HeaderFooterOptions,
  ctx: StampContext,
  date: Date,
  fontResolver: StampFontResolver
): Promise<void> {
  const pageCount = pdfDoc.getPageCount();
  assertFinite(opts.startNumber, 'Start number', opts.numberFormat === 'arabic' ? 0 : 1, 1_000_000_000);
  if (!Number.isInteger(opts.startNumber)) throw new StampValidationError('Start number must be a whole number.');
  const hasText = Object.values(opts.slots).some((t) => t && t.trim() !== '');
  if (!hasText) throw new StampValidationError('Enter text for at least one header or footer slot.');

  let indices = parsePageRange(opts.pageRange, pageCount);
  if (opts.skipFirstPage) indices = indices.filter((i) => i !== 0);
  if (indices.length === 0) throw new StampValidationError('The page range selects no pages.');

  // {pages} is the number shown on the last page, so "Page n of N" stays
  // consistent when numbering starts somewhere other than 1.
  const usesPages = Object.values(opts.slots).some((t) => t && t.includes('{pages}'));
  const pagesText = usesPages ? formatNumber(opts.startNumber + pageCount - 1, opts.numberFormat) : '';
  const dateText = formatDate(ctx.date);

  await stampSlots(pdfDoc, kind, opts.style, opts.margins, indices, (pageIndex) => {
    const values = {
      page: formatNumber(opts.startNumber + pageIndex, opts.numberFormat),
      pages: pagesText,
      date: dateText,
      filename: ctx.fileName,
    };
    const out: Partial<Record<SlotPosition, string>> = {};
    for (const slot of SLOT_POSITIONS) {
      const tpl = opts.slots[slot];
      if (tpl && tpl.trim() !== '') out[slot] = resolveTokens(tpl, values);
    }
    return out;
  }, date, fontResolver);
}

async function stampBates(pdfDoc: PDFLib, opts: BatesOptions, date: Date, fontResolver: StampFontResolver): Promise<void> {
  if (!Number.isInteger(opts.startNumber) || opts.startNumber < 0) {
    throw new StampValidationError('Bates start number must be a whole number of 0 or more.');
  }
  if (!Number.isInteger(opts.digits) || opts.digits < 0 || opts.digits > 15) {
    throw new StampValidationError('Bates digits must be between 0 and 15.');
  }
  if (!SLOT_POSITIONS.includes(opts.position)) {
    throw new StampValidationError(`Unknown position "${opts.position}".`);
  }
  const indices = parsePageRange(opts.pageRange, pdfDoc.getPageCount());
  // Bates numbers run consecutively over the stamped pages.
  await stampSlots(
    pdfDoc,
    'Bates',
    opts.style,
    opts.margins,
    indices,
    (_pageIndex, ordinal) => ({ [opts.position]: formatBates(opts.startNumber + ordinal, opts) }),
    date,
    fontResolver
  );
}

// ───────────────────────────── Removal ─────────────────────────────

/**
 * Delete one of our Form XObjects plus the fonts/images it owns. Those were
 * embedded by this module solely for the stamp, so nothing else references
 * them; leaving them would keep orphans in the saved file (pdf-lib writes
 * every registered object). Shared refs are tolerated: deleting twice is a no-op.
 */
function deleteFormAndOwnedResources(pdfDoc: PDFLib, value: PDFObject): void {
  const ctx = pdfDoc.context;
  const form = ctx.lookupMaybe(value, PDFStream);
  const res = form?.dict.lookupMaybe(PDFName.of('Resources'), PDFDict);
  for (const sub of ['Font', 'XObject']) {
    const dict = res?.lookupMaybe(PDFName.of(sub), PDFDict);
    if (!dict) continue;
    for (const [, ref] of dict.entries()) {
      if (ref instanceof PDFRef) ctx.delete(ref);
    }
  }
  if (value instanceof PDFRef) ctx.delete(value);
}

function removeStampsInDoc(pdfDoc: PDFLib, kind: StampKind): number {
  const ctx = pdfDoc.context;
  let removed = 0;
  for (const page of pdfDoc.getPages()) {
    const contentsObj = page.node.get(PDFName.of('Contents'));
    const contents = contentsObj ? ctx.lookup(contentsObj) : undefined;

    // 1. Our marked content streams.
    if (contents instanceof PDFArray) {
      for (let i = contents.size() - 1; i >= 0; i--) {
        const ref = contents.get(i);
        const stream = ctx.lookupMaybe(ref, PDFStream);
        if (stream && markOf(stream.dict) === kind) {
          contents.remove(i);
          if (ref instanceof PDFRef) ctx.delete(ref);
          removed++;
        }
      }
    }

    // 2. Our XObjects of this kind, plus any foreign `Do` that still names one
    //    (a tool that coalesced content streams would have dropped our marker).
    const resources = page.node.Resources();
    const xobjects = resources?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    const ourNames: string[] = [];
    if (xobjects) {
      for (const [key, value] of xobjects.entries()) {
        if (stampKindOfXObject(pdfDoc, value) === kind) {
          ourNames.push(key.decodeText());
          xobjects.delete(key);
          deleteFormAndOwnedResources(pdfDoc, value);
        }
      }
    }
    if (ourNames.length > 0 && contentsObj) {
      const pattern = new RegExp(
        `\\/(?:${ourNames.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\s+Do\\b`,
        'g'
      );
      for (const stream of getContentStreams(ctx, page.node.get(PDFName.of('Contents')))) {
        const bytes = decodeStream(stream);
        if (!bytes) continue;
        const text = new TextDecoder('latin1').decode(bytes);
        if (!pattern.test(text)) continue;
        pattern.lastIndex = 0;
        updateStream(stream, text.replace(pattern, ''), pdfDoc);
        removed++;
      }
    }

    // 3. Drop the q/Q isolation pair once no stamp of any kind remains on top.
    const after = page.node.get(PDFName.of('Contents'));
    const arr = after ? ctx.lookup(after) : undefined;
    if (arr instanceof PDFArray) {
      let anyStampLeft = false;
      const wrapIdx: number[] = [];
      for (let i = 0; i < arr.size(); i++) {
        const s = ctx.lookupMaybe(arr.get(i), PDFStream);
        const mark = s ? markOf(s.dict) : null;
        if (mark === WRAP_MARK) wrapIdx.push(i);
        else if (mark) anyStampLeft = true;
      }
      if (!anyStampLeft && wrapIdx.length > 0 && wrapIdx.length % 2 === 0) {
        for (let k = wrapIdx.length - 1; k >= 0; k--) {
          const ref = arr.get(wrapIdx[k]);
          arr.remove(wrapIdx[k]);
          if (ref instanceof PDFRef) ctx.delete(ref);
        }
      }
    }
  }
  removeOcg(pdfDoc, kind);
  return removed;
}

// ───────────────────────────── Public API ─────────────────────────────

export interface StampResult {
  bytes: Uint8Array;
  /** 0-based indices of the pages that received the stamp. */
  stampedPages: number[];
}

function stampedPagesFor(request: StampRequest, pageCount: number): number[] {
  switch (request.kind) {
    case 'Watermark':
    case 'Bates':
      return parsePageRange(request.options.pageRange, pageCount);
    case 'HeaderFooter':
    case 'PageNumbers': {
      const idx = parsePageRange(request.options.pageRange, pageCount);
      return request.options.skipFirstPage ? idx.filter((i) => i !== 0) : idx;
    }
  }
}

async function applyToDoc(pdfDoc: PDFLib, request: StampRequest, ctx: StampContext, opts: ApplyStampOptions): Promise<number[]> {
  if (opts.replaceExisting !== false) removeStampsInDoc(pdfDoc, request.kind);
  const now = new Date();
  const fonts = new StampFontResolver(pdfDoc, opts.loadFontFile ?? defaultLoadFontFile);
  switch (request.kind) {
    case 'Watermark': {
      const indices = parsePageRange(request.options.pageRange, pdfDoc.getPageCount());
      await stampWatermark(pdfDoc, request.options, indices, now, fonts);
      return indices;
    }
    case 'HeaderFooter':
      await stampHeaderFooter(pdfDoc, 'HeaderFooter', request.options, ctx, now, fonts);
      return stampedPagesFor(request, pdfDoc.getPageCount());
    case 'PageNumbers':
      await stampHeaderFooter(pdfDoc, 'PageNumbers', pageNumbersToHeaderFooter(request.options), ctx, now, fonts);
      return stampedPagesFor(request, pdfDoc.getPageCount());
    case 'Bates':
      await stampBates(pdfDoc, request.options, now, fonts);
      return stampedPagesFor(request, pdfDoc.getPageCount());
  }
}

/** Apply one stamp to the whole document and return the new bytes. */
export async function applyStamp(
  pdfData: Uint8Array,
  request: StampRequest,
  ctx: StampContext,
  opts: ApplyStampOptions = {}
): Promise<StampResult> {
  const pdfDoc = await loadForStamping(pdfData);
  const pageCountBefore = pdfDoc.getPageCount();
  const stampedPages = await applyToDoc(pdfDoc, request, ctx, opts);
  const bytes = new Uint8Array(await pdfDoc.save());
  if (pageCountBefore !== pdfDoc.getPageCount()) {
    throw new Error('Stamping changed the page count; refusing to commit.');
  }
  return { bytes, stampedPages };
}

/** Remove every stamp of `kind` this app added. Returns the new bytes and how much was removed. */
export async function removeStamps(pdfData: Uint8Array, kind: StampKind): Promise<{ bytes: Uint8Array; removed: number }> {
  const pdfDoc = await loadForStamping(pdfData);
  const removed = removeStampsInDoc(pdfDoc, kind);
  return { bytes: new Uint8Array(await pdfDoc.save()), removed };
}

/** Which stamp kinds this app has placed in the document (for enabling "Remove"). */
export async function listStampKinds(pdfData: Uint8Array): Promise<StampKind[]> {
  const pdfDoc = await loadForStamping(pdfData);
  const found = new Set<StampKind>();
  for (const page of pdfDoc.getPages()) {
    const xobjects = page.node.Resources()?.lookupMaybe(PDFName.of('XObject'), PDFDict);
    if (!xobjects) continue;
    for (const [, value] of xobjects.entries()) {
      const kind = stampKindOfXObject(pdfDoc, value);
      if (kind) found.add(kind);
    }
  }
  return [...found];
}

/**
 * Preview: a one-page PDF of `previewPageIndex` stamped exactly as the full
 * document would be (numbering, {pages}, Bates sequence all computed against
 * the full document), without saving the whole document.
 */
export async function renderStampPreview(
  pdfData: Uint8Array,
  request: StampRequest,
  ctx: StampContext,
  previewPageIndex: number,
  opts: ApplyStampOptions = {}
): Promise<Uint8Array> {
  const pdfDoc = await loadForStamping(pdfData);
  const count = pdfDoc.getPageCount();
  if (previewPageIndex < 0 || previewPageIndex >= count) {
    throw new StampValidationError(`Preview page must be between 1 and ${count}.`);
  }
  await applyToDoc(pdfDoc, request, ctx, opts);
  const preview = await PDFLib.create({ updateMetadata: false });
  const [copied] = await preview.copyPages(pdfDoc, [previewPageIndex]);
  preview.addPage(copied);
  return new Uint8Array(await preview.save());
}

/** Default text style used by the dialog. */
export const DEFAULT_TEXT_STYLE: TextStyle = { font: 'Helvetica', fontSize: 10, color: '#000000' };

/** Narrow helper for UI code that needs to tell validation errors apart. */
export function isStampValidationError(e: unknown): e is StampValidationError {
  return e instanceof StampValidationError;
}
