/**
 * Stamping — asserts the OUTPUT bytes, re-read through pdf.js (the same engine
 * the viewer uses) and pdf-lib, on the real fixtures in test-pdfs/.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import { PDFDocument as PDFLib, PDFName, PDFArray, PDFDict, PDFStream } from 'pdf-lib';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';
import {
  applyStamp,
  removeStamps,
  listStampKinds,
  renderStampPreview,
  parsePageRange,
  toRoman,
  formatBates,
  resolveTokens,
  StampValidationError,
  type StampRequest,
  type StampContext,
  type TextStyle,
} from './stamping';
import { setPdfPageRotation } from './pageStructure';
import { applyEditsAndAnnotations } from './pdfSavePipeline';
import type { PDFPage } from '../types';

const FIXTURES = resolve(__dirname, '../../../test-pdfs');
const fixture = (name: string) => new Uint8Array(readFileSync(resolve(FIXTURES, name)));

const CTX: StampContext = { fileName: 'scan-document.pdf', date: new Date(2026, 9, 5, 12, 0, 0) };
const STYLE: TextStyle = { font: 'Helvetica', fontSize: 10, color: '#000000' };
const MARGINS = { top: 24, bottom: 24, left: 36, right: 36 };

interface PageText {
  items: Array<{ str: string; transform: number[] }>;
  joined: string;
  viewport: { width: number; height: number; transform: number[] };
}

async function readText(bytes: Uint8Array, password?: string): Promise<PageText[]> {
  const doc = await pdfjs.getDocument({
    data: bytes.slice(),
    password,
    isEvalSupported: false,
    useSystemFonts: false,
    verbosity: 0,
  }).promise;
  const out: PageText[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const viewport = page.getViewport({ scale: 1 });
    const tc = await page.getTextContent();
    const items = (tc.items as Array<{ str?: string; transform?: number[] }>)
      .filter((it) => typeof it.str === 'string')
      .map((it) => ({ str: it.str as string, transform: it.transform as number[] }));
    out.push({
      items,
      joined: items.map((it) => it.str).join('|'),
      viewport: { width: viewport.width, height: viewport.height, transform: viewport.transform },
    });
  }
  await doc.destroy();
  return out;
}

async function ocgNames(bytes: Uint8Array): Promise<string[]> {
  const doc = await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, verbosity: 0 }).promise;
  const config = await doc.getOptionalContentConfig();
  const groups = config.getGroups() as Record<string, { name: string }> | null;
  const names = groups ? Object.values(groups).map((g) => g.name) : [];
  await doc.destroy();
  return names;
}

function contentsLength(doc: PDFLib, index: number): number {
  const c = doc.context.lookup(doc.getPage(index).node.get(PDFName.of('Contents')));
  return c instanceof PDFArray ? c.size() : 1;
}

function itemWith(page: PageText, needle: string) {
  const item = page.items.find((it) => it.str.includes(needle));
  if (!item) throw new Error(`"${needle}" not found on page; text was: ${page.joined.slice(0, 300)}`);
  return item;
}

// ─────────────────────────── pure helpers ───────────────────────────

describe('page range / numbering helpers', () => {
  it('parses all / odd / even / lists', () => {
    expect(parsePageRange('all', 5)).toEqual([0, 1, 2, 3, 4]);
    expect(parsePageRange('odd', 5)).toEqual([0, 2, 4]);
    expect(parsePageRange('even', 5)).toEqual([1, 3]);
    expect(parsePageRange('1-3, 5', 6)).toEqual([0, 1, 2, 4]);
    expect(parsePageRange('5,1,1-2', 6)).toEqual([0, 1, 4]);
  });

  it('rejects out-of-range and malformed ranges with a validation error', () => {
    expect(() => parsePageRange('0-2', 5)).toThrow(StampValidationError);
    expect(() => parsePageRange('7', 5)).toThrow(StampValidationError);
    expect(() => parsePageRange('3-1', 5)).toThrow(StampValidationError);
    expect(() => parsePageRange('abc', 5)).toThrow(StampValidationError);
  });

  it('formats roman numerals, Bates numbers and tokens', () => {
    expect([1, 4, 9, 14, 40, 1994].map(toRoman)).toEqual(['i', 'iv', 'ix', 'xiv', 'xl', 'mcmxciv']);
    expect(() => toRoman(0)).toThrow(StampValidationError);
    expect(formatBates(42, { prefix: 'ABC', suffix: '-X', digits: 6 })).toBe('ABC000042-X');
    expect(formatBates(1234567, { prefix: '', suffix: '', digits: 3 })).toBe('1234567');
    expect(resolveTokens('{page}/{pages} {filename} {date} {nope}', {
      page: '2', pages: '9', filename: 'a.pdf', date: '2026-10-05',
    })).toBe('2/9 a.pdf 2026-10-05 {nope}');
  });
});

// ─────────────────────────── header / footer ───────────────────────────

describe('header/footer output', () => {
  let src: Uint8Array;
  beforeAll(() => {
    src = fixture('scan-document.pdf'); // 9 pages
  });

  it('writes every slot with resolved tokens on the selected pages only', async () => {
    const req: StampRequest = {
      kind: 'HeaderFooter',
      options: {
        slots: {
          'header-left': 'HDR-L {filename}',
          'header-right': 'HDR-R {date}',
          'footer-center': 'FTR p{page} of {pages}',
        },
        style: STYLE,
        margins: MARGINS,
        pageRange: '2-4,7',
        skipFirstPage: false,
        startNumber: 1,
        numberFormat: 'arabic',
      },
    };
    const { bytes, stampedPages } = await applyStamp(src, req, CTX);
    expect(stampedPages).toEqual([1, 2, 3, 6]);
    const pages = await readText(bytes);
    expect(pages).toHaveLength(9);
    for (let i = 0; i < 9; i++) {
      const expected = [1, 2, 3, 6].includes(i);
      expect(pages[i].joined.includes(`FTR p${i + 1} of 9`), `page ${i + 1}`).toBe(expected);
      expect(pages[i].joined.includes('HDR-L scan-document.pdf'), `page ${i + 1}`).toBe(expected);
      expect(pages[i].joined.includes('HDR-R 2026-10-05'), `page ${i + 1}`).toBe(expected);
    }
    // Slot geometry: header near the top, footer near the bottom, left < right.
    const p2 = pages[1];
    const toView = (t: number[]) => pdfjs.Util.transform(p2.viewport.transform, t);
    const hl = toView(itemWith(p2, 'HDR-L').transform);
    const hr = toView(itemWith(p2, 'HDR-R').transform);
    const fc = toView(itemWith(p2, 'FTR').transform);
    expect(hl[5]).toBeLessThan(60);
    expect(fc[5]).toBeGreaterThan(p2.viewport.height - 60);
    expect(hl[4]).toBeCloseTo(MARGINS.left, 0);
    expect(hr[4]).toBeGreaterThan(p2.viewport.width / 2);
  });

  it('skips the first page when asked', async () => {
    const { bytes } = await applyStamp(src, {
      kind: 'HeaderFooter',
      options: {
        slots: { 'footer-right': 'SKIPTEST {page}' },
        style: STYLE, margins: MARGINS, pageRange: 'all', skipFirstPage: true, startNumber: 1, numberFormat: 'arabic',
      },
    }, CTX);
    const pages = await readText(bytes);
    expect(pages[0].joined).not.toContain('SKIPTEST');
    expect(pages[1].joined).toContain('SKIPTEST 2');
    expect(pages[8].joined).toContain('SKIPTEST 9');
  });

  it('survives the real save pipeline', async () => {
    const { bytes } = await applyStamp(src, {
      kind: 'HeaderFooter',
      options: {
        slots: { 'header-center': 'PIPELINE-SURVIVES' },
        style: STYLE, margins: MARGINS, pageRange: 'all', skipFirstPage: false, startNumber: 1, numberFormat: 'arabic',
      },
    }, CTX);
    const model = Array.from({ length: 9 }, (_, i) => ({
      index: i, width: 606, height: 786, rotation: 0, annotations: [], textItems: [], textEdits: [],
    })) as unknown as PDFPage[];
    const saved = await applyEditsAndAnnotations({ pdfData: bytes, pages: model, annotationStorage: null, formFieldMappings: [] });
    const pages = await readText(saved);
    expect(pages.every((p) => p.joined.includes('PIPELINE-SURVIVES'))).toBe(true);
  });
});

// ─────────────────────────── page numbers ───────────────────────────

describe('page numbers output', () => {
  const src = () => fixture('scan-document.pdf');
  const base = { style: STYLE, margins: MARGINS, pageRange: 'all', skipFirstPage: false } as const;

  it('"Page n of N"', async () => {
    const { bytes } = await applyStamp(src(), {
      kind: 'PageNumbers', options: { ...base, preset: 'page-n-of-total', position: 'footer-center', startNumber: 1 },
    }, CTX);
    const pages = await readText(bytes);
    pages.forEach((p, i) => expect(p.joined).toContain(`Page ${i + 1} of 9`));
  });

  it('plain numbers honour the start number', async () => {
    const { bytes } = await applyStamp(src(), {
      kind: 'PageNumbers', options: { ...base, preset: 'n', position: 'footer-right', startNumber: 5 },
    }, CTX);
    const pages = await readText(bytes);
    pages.forEach((p, i) => expect(p.items.some((it) => it.str === String(5 + i))).toBe(true));
  });

  it('roman numerals', async () => {
    const { bytes } = await applyStamp(src(), {
      kind: 'PageNumbers', options: { ...base, preset: 'roman', position: 'footer-center', startNumber: 1 },
    }, CTX);
    const pages = await readText(bytes);
    const expected = ['i', 'ii', 'iii', 'iv', 'v', 'vi', 'vii', 'viii', 'ix'];
    pages.forEach((p, i) => expect(p.items.some((it) => it.str === expected[i])).toBe(true));
  });

  it('replacing page numbers does not duplicate them', async () => {
    const first = await applyStamp(src(), {
      kind: 'PageNumbers', options: { ...base, preset: 'page-n-of-total', position: 'footer-center', startNumber: 1 },
    }, CTX);
    const second = await applyStamp(first.bytes, {
      kind: 'PageNumbers', options: { ...base, preset: 'page-n-of-total', position: 'footer-center', startNumber: 1 },
    }, CTX);
    const pages = await readText(second.bytes);
    expect(pages[2].items.filter((it) => it.str.includes('Page 3 of 9'))).toHaveLength(1);
  });
});

// ─────────────────────────── Bates ───────────────────────────

describe('Bates output', () => {
  it('numbers consecutively with zero padding, prefix and suffix, on the selected pages only', async () => {
    const { bytes } = await applyStamp(fixture('scan-document.pdf'), {
      kind: 'Bates',
      options: {
        prefix: 'ACME', suffix: '-CONF', startNumber: 98, digits: 6,
        position: 'footer-right', style: STYLE, margins: MARGINS, pageRange: 'odd',
      },
    }, CTX);
    const pages = await readText(bytes);
    // odd pages 1,3,5,7,9 → 98..102
    const expected: Record<number, string> = { 0: 'ACME000098-CONF', 2: 'ACME000099-CONF', 4: 'ACME000100-CONF', 6: 'ACME000101-CONF', 8: 'ACME000102-CONF' };
    for (let i = 0; i < 9; i++) {
      if (expected[i]) {
        expect(pages[i].items.some((it) => it.str === expected[i]), `page ${i + 1}`).toBe(true);
      } else {
        expect(pages[i].joined, `page ${i + 1}`).not.toContain('ACME');
      }
    }
    expect(await listStampKinds(bytes)).toEqual(['Bates']);
  });
});

// ─────────────────────────── watermark ───────────────────────────

describe('watermark output', () => {
  const textReq = (overrides: Partial<Extract<StampRequest, { kind: 'Watermark' }>['options']> = {}): StampRequest => ({
    kind: 'Watermark',
    options: {
      source: { type: 'text', text: 'CONFIDENTIAL', style: { font: 'Helvetica-Bold', fontSize: 60, color: '#cc0000' } },
      opacity: 0.25, rotation: 45, position: 'center', tile: false, behind: false, pageRange: 'all', margin: 36,
      ...overrides,
    },
  });

  it('creates a "Watermark" OCG and a Form XObject bound to it; Remove deletes all of it', async () => {
    const src = fixture('announcement.pdf'); // 3 pages
    const before = await PDFLib.load(src);
    const originalContents = [0, 1, 2].map((i) => contentsLength(before, i));
    const originalTextLen = (await readText(src)).map((p) => p.joined.length);

    const { bytes } = await applyStamp(src, textReq({ pageRange: '1,3' }), CTX);
    expect(await ocgNames(bytes)).toEqual(['Watermark']);
    const stampedText = await readText(bytes);
    expect(stampedText[0].joined).toContain('CONFIDENTIAL');
    expect(stampedText[1].joined).not.toContain('CONFIDENTIAL');
    expect(stampedText[2].joined).toContain('CONFIDENTIAL');

    // The XObject carries /OC → the Watermark OCG and our PieceInfo marker; opacity is in its ExtGState.
    const doc = await PDFLib.load(bytes);
    const ocProps = doc.catalog.lookup(PDFName.of('OCProperties'), PDFDict);
    const ocgRef = ocProps.lookup(PDFName.of('OCGs'), PDFArray).get(0);
    const xobjs = doc.getPage(0).node.Resources()!.lookup(PDFName.of('XObject'), PDFDict);
    const ours = xobjs.entries().filter(([k]) => k.decodeText().startsWith('PMStamp_Watermark_'));
    expect(ours).toHaveLength(1);
    const form = doc.context.lookup(ours[0][1], PDFStream);
    expect(form.dict.get(PDFName.of('OC'))).toBe(ocgRef);
    expect(form.dict.lookup(PDFName.of('Subtype'), PDFName).decodeText()).toBe('Form');
    const gs = form.dict.lookup(PDFName.of('Resources'), PDFDict)
      .lookup(PDFName.of('ExtGState'), PDFDict).lookup(PDFName.of('GS0'), PDFDict);
    expect(gs.get(PDFName.of('ca'))?.toString()).toBe('0.25');

    const removed = await removeStamps(bytes, 'Watermark');
    expect(removed.removed).toBeGreaterThan(0);
    expect(await ocgNames(removed.bytes)).toEqual([]);
    const afterText = await readText(removed.bytes);
    afterText.forEach((p, i) => {
      expect(p.joined).not.toContain('CONFIDENTIAL');
      expect(p.joined.length).toBe(originalTextLen[i]);
    });
    const after = await PDFLib.load(removed.bytes);
    expect([0, 1, 2].map((i) => contentsLength(after, i))).toEqual(originalContents);
    expect(after.catalog.get(PDFName.of('OCProperties'))).toBeUndefined();
    expect(await listStampKinds(removed.bytes)).toEqual([]);
  });

  it('removing the watermark leaves other stamps in place', async () => {
    const src = fixture('announcement.pdf');
    const wm = await applyStamp(src, textReq(), CTX);
    const both = await applyStamp(wm.bytes, {
      kind: 'Bates',
      options: { prefix: 'KEEP', suffix: '', startNumber: 1, digits: 4, position: 'footer-left', style: STYLE, margins: MARGINS, pageRange: 'all' },
    }, CTX);
    expect((await ocgNames(both.bytes)).sort()).toEqual(['Bates Numbers', 'Watermark']);
    const { bytes } = await removeStamps(both.bytes, 'Watermark');
    const pages = await readText(bytes);
    pages.forEach((p, i) => {
      expect(p.joined).not.toContain('CONFIDENTIAL');
      expect(p.joined).toContain(`KEEP000${i + 1}`);
    });
    expect(await ocgNames(bytes)).toEqual(['Bates Numbers']);
  });

  it('behind places the stamp first in /Contents; on top places it last inside a q/Q wrap', async () => {
    const src = fixture('invoice.pdf');
    const behind = await PDFLib.load((await applyStamp(src, textReq({ behind: true }), CTX)).bytes);
    const onTop = await PDFLib.load((await applyStamp(src, textReq({ behind: false }), CTX)).bytes);
    const markOf = (doc: PDFLib, i: number) => {
      const arr = doc.context.lookup(doc.getPage(0).node.get(PDFName.of('Contents')), PDFArray);
      const s = doc.context.lookup(arr.get(i < 0 ? arr.size() + i : i), PDFStream);
      return s.dict.get(PDFName.of('PDFManagerStamp'))?.toString() ?? null;
    };
    expect(markOf(behind, 0)).toBe('/Watermark');
    expect(markOf(onTop, 0)).toBe('/Wrap');
    expect(markOf(onTop, -2)).toBe('/Wrap');
    expect(markOf(onTop, -1)).toBe('/Watermark');
    // The page-level invocation is tagged as a pagination artifact.
    const arr = onTop.context.lookup(onTop.getPage(0).node.get(PDFName.of('Contents')), PDFArray);
    const last = onTop.context.lookup(arr.get(arr.size() - 1), PDFStream) as PDFStream & { getContents(): Uint8Array };
    const { inflate } = await import('pako');
    const ops = new TextDecoder('latin1').decode(inflate(last.getContents()));
    expect(ops).toMatch(/\/Artifact\s*<<\s*\/Type \/Pagination\s*\/Subtype \/Watermark\s*>>\s*BDC\s*\/PMStamp_Watermark_[0-9a-f]+ Do\s*EMC/);
  });

  it('tiles text across the page', async () => {
    const { bytes } = await applyStamp(fixture('invoice.pdf'), textReq({ tile: true, source: { type: 'text', text: 'DRAFT', style: { font: 'Helvetica', fontSize: 24, color: '#888888' } } }), CTX);
    const [page] = await readText(bytes);
    expect(page.items.filter((it) => it.str === 'DRAFT').length).toBeGreaterThan(10);
  });

  it('embeds PNG and JPEG image watermarks', async () => {
    for (const img of ['diag-image2.png', 'diag-image1.jpeg']) {
      const src = fixture('invoice.pdf');
      const countImages = async (b: Uint8Array) => {
        const doc = await pdfjs.getDocument({ data: b.slice(), isEvalSupported: false, verbosity: 0 }).promise;
        const ops = await (await doc.getPage(1)).getOperatorList();
        const n = ops.fnArray.filter((f: number) => f === pdfjs.OPS.paintImageXObject).length;
        await doc.destroy();
        return n;
      };
      const before = await countImages(src);
      const { bytes } = await applyStamp(src, {
        kind: 'Watermark',
        options: { source: { type: 'image', bytes: fixture(img), scale: 0.5 }, opacity: 0.3, rotation: 0, position: 'center', tile: false, behind: true, pageRange: 'all', margin: 36 },
      }, CTX);
      expect(await countImages(bytes), img).toBe(before + 1);
      const { bytes: cleaned } = await removeStamps(bytes, 'Watermark');
      expect(await countImages(cleaned), img).toBe(before);
    }
  });

  it('rejects non-PNG/JPEG images', async () => {
    await expect(applyStamp(fixture('invoice.pdf'), {
      kind: 'Watermark',
      options: { source: { type: 'image', bytes: new Uint8Array([0x42, 0x4d, 0, 0, 0, 0]), scale: 0.5 }, opacity: 0.3, rotation: 0, position: 'center', tile: false, behind: true, pageRange: 'all', margin: 36 },
    }, CTX)).rejects.toThrow(/PNG and JPEG/);
  });
});

// ─────────────────────────── geometry ───────────────────────────

describe('rotation and CropBox', () => {
  for (const angle of [0, 90, 180, 270]) {
    it(`footer is upright and at the visual bottom on a /Rotate ${angle} page`, async () => {
      const rotated = await setPdfPageRotation(fixture('invoice.pdf'), 0, angle);
      const { bytes } = await applyStamp(rotated, {
        kind: 'HeaderFooter',
        options: {
          slots: { 'footer-left': 'ROTFOOT' }, style: { ...STYLE, fontSize: 12 }, margins: MARGINS,
          pageRange: 'all', skipFirstPage: false, startNumber: 1, numberFormat: 'arabic',
        },
      }, CTX);
      const [page] = await readText(bytes);
      const m = pdfjs.Util.transform(page.viewport.transform, itemWith(page, 'ROTFOOT').transform);
      // Upright in the displayed view: x-axis right, y-axis up (viewport is y-down).
      expect(m[0]).toBeGreaterThan(0);
      expect(Math.abs(m[1])).toBeLessThan(1e-6);
      expect(Math.abs(m[2])).toBeLessThan(1e-6);
      expect(m[3]).toBeLessThan(0);
      // Bottom-left of what the reader sees.
      expect(m[4]).toBeCloseTo(MARGINS.left, 0);
      expect(m[5]).toBeGreaterThan(page.viewport.height - MARGINS.bottom - 15);
      expect(m[5]).toBeLessThan(page.viewport.height);
    });
  }

  it('stays inside a CropBox that is smaller than the MediaBox', async () => {
    const doc = await PDFLib.load(fixture('invoice.pdf'));
    doc.getPage(0).setCropBox(100, 150, 300, 400);
    const cropped = new Uint8Array(await doc.save());
    const { bytes } = await applyStamp(cropped, {
      kind: 'HeaderFooter',
      options: {
        slots: { 'header-right': 'CROPHEAD' }, style: STYLE, margins: { top: 10, bottom: 10, left: 10, right: 10 },
        pageRange: 'all', skipFirstPage: false, startNumber: 1, numberFormat: 'arabic',
      },
    }, CTX);
    const [page] = await readText(bytes);
    expect(page.viewport.width).toBe(300);
    expect(page.viewport.height).toBe(400);
    const item = itemWith(page, 'CROPHEAD');
    const m = pdfjs.Util.transform(page.viewport.transform, item.transform);
    expect(m[4]).toBeGreaterThan(150);
    expect(m[4]).toBeLessThan(300 - 10);
    expect(m[5]).toBeGreaterThan(10);
    expect(m[5]).toBeLessThan(30);
  });
});

// ─────────────────────────── validation ───────────────────────────

describe('validation', () => {
  it('rejects text outside WinAnsi with a clear message instead of crashing', async () => {
    const err = await applyStamp(fixture('invoice.pdf'), {
      kind: 'Watermark',
      options: {
        source: { type: 'text', text: 'Привет', style: STYLE },
        opacity: 0.5, rotation: 0, position: 'center', tile: false, behind: false, pageRange: 'all', margin: 36,
      },
    }, CTX).catch((e) => e);
    expect(err).toBeInstanceOf(StampValidationError);
    expect(String(err.message)).toMatch(/U\+041F/);
    expect(String(err.message)).toMatch(/WinAnsi/);
  });

  it('rejects non-WinAnsi characters coming from the {filename} token', async () => {
    await expect(applyStamp(fixture('invoice.pdf'), {
      kind: 'HeaderFooter',
      options: {
        slots: { 'header-left': '{filename}' }, style: STYLE, margins: MARGINS,
        pageRange: 'all', skipFirstPage: false, startNumber: 1, numberFormat: 'arabic',
      },
    }, { ...CTX, fileName: '報告.pdf' })).rejects.toBeInstanceOf(StampValidationError);
  });

  it('accepts WinAnsi extended characters (é, €, —)', async () => {
    const { bytes } = await applyStamp(fixture('invoice.pdf'), {
      kind: 'HeaderFooter',
      options: {
        slots: { 'header-left': 'Café € — ok' }, style: STYLE, margins: MARGINS,
        pageRange: 'all', skipFirstPage: false, startNumber: 1, numberFormat: 'arabic',
      },
    }, CTX);
    const [page] = await readText(bytes);
    expect(page.joined).toContain('Café € — ok');
  });
});

// ─────────────────────────── preview ───────────────────────────

describe('preview', () => {
  it('renders the chosen page alone, numbered against the whole document', async () => {
    const preview = await renderStampPreview(fixture('scan-document.pdf'), {
      kind: 'PageNumbers',
      options: { preset: 'page-n-of-total', position: 'footer-center', style: STYLE, margins: MARGINS, pageRange: 'all', skipFirstPage: false, startNumber: 1 },
    }, CTX, 2);
    const pages = await readText(preview);
    expect(pages).toHaveLength(1);
    expect(pages[0].joined).toContain('Page 3 of 9');
  });
});

// ─────────────────────────── encrypted source ───────────────────────────

describe('encrypted source round trip', () => {
  it('decrypt → stamp → re-encrypt keeps the stamp and the password', async () => {
    const require = createRequire(import.meta.url);
    const wasmPath = require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm');
    const createModule = (await import('@neslinesli93/qpdf-wasm')).default as (o: unknown) => Promise<any>;
    const qpdf = await createModule({ locateFile: () => wasmPath, noInitialRun: true, print: () => {}, printErr: () => {} });
    const PASSWORD = 'testpass123';

    qpdf.FS.writeFile('/enc.pdf', fixture('encrypted-sample.pdf'));
    expect(qpdf.callMain(['--decrypt', `--password=${PASSWORD}`, '/enc.pdf', '/plain.pdf'])).toBe(0);
    const plaintext = new Uint8Array(qpdf.FS.readFile('/plain.pdf'));

    const { bytes } = await applyStamp(plaintext, {
      kind: 'Bates',
      options: { prefix: 'ENC', suffix: '', startNumber: 7, digits: 5, position: 'footer-right', style: STYLE, margins: MARGINS, pageRange: 'all' },
    }, CTX);

    // Same flags pdfEncryption.encryptPdf uses (AES-256).
    qpdf.FS.writeFile('/stamped.pdf', bytes);
    expect(qpdf.callMain(['--encrypt', PASSWORD, PASSWORD, '256', '--', '/stamped.pdf', '/out.pdf'])).toBe(0);
    const encrypted = new Uint8Array(qpdf.FS.readFile('/out.pdf'));
    expect(new TextDecoder('latin1').decode(encrypted)).toMatch(/\/Encrypt\b/);

    await expect(readText(encrypted)).rejects.toMatchObject({ name: 'PasswordException' });
    const pages = await readText(encrypted, PASSWORD);
    expect(pages[0].items.some((it) => it.str === 'ENC00007')).toBe(true);
  });
});
