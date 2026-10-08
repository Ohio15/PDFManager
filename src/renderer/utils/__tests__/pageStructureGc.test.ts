/**
 * Page ops must not ship removed pages. pdf-lib's writer emits every object in
 * the context, reachable or not, so a page dropped by delete/replace (or an
 * orphan already sitting in the input) survives the save unless the op runs the
 * unreachable-object GC first. These tests assert at the OUTPUT boundary: the
 * saved bytes and the re-parsed object table, never the code path.
 */
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import {
  PDFDocument,
  PDFName,
  PDFString,
  PDFRawStream,
  PDFRef,
  PDFArray,
  decodePDFRawStream,
} from 'pdf-lib';
import {
  applyPdfPageOrder,
  deletePdfPage,
  deletePdfPages,
  duplicatePdfPages,
  movePdfPages,
  replacePdfPage,
} from '../pageStructure';
import { collectReachableRefs } from '../pdfObjectGraph';
import { openPdfJs } from './formsFinalizeHelpers';

const enc = new TextEncoder();
const dec = new TextDecoder('latin1');

/**
 * One page whose content stream, image XObject and page dictionary each carry
 * `marker`. Streams are stored unfiltered so a surviving copy is visible as raw
 * bytes in the saved file (pdf-lib never re-encodes existing streams).
 */
function addMarkedPage(doc: PDFDocument, marker: string): void {
  const ctx = doc.context;
  const side = 32;
  const pixels = new Uint8Array(side * side);
  const markerBytes = enc.encode(`IMG-${marker}`);
  for (let i = 0; i < pixels.length; i++) pixels[i] = markerBytes[i % markerBytes.length];
  const image = ctx.stream(pixels, {
    Type: 'XObject',
    Subtype: 'Image',
    Width: side,
    Height: side,
    ColorSpace: 'DeviceGray',
    BitsPerComponent: 8,
  });
  const imageRef = ctx.register(image);

  const page = doc.addPage([300, 300]);
  const content = ctx.stream(
    `BT /F1 12 Tf 20 250 Td (TXT-${marker}) Tj ET\nq 64 0 0 64 20 20 cm /Im0 Do Q\n`
  );
  page.node.set(PDFName.Contents, ctx.register(content));
  page.node.setXObject(PDFName.of('Im0'), imageRef);
  page.node.set(PDFName.of('PieceInfo'), ctx.obj({ Tag: PDFString.of(`DICT-${marker}`) }));
}

async function markedDoc(markers: string[], orphanMarker?: string): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (const m of markers) addMarkedPage(doc, m);
  if (orphanMarker) {
    // An unreachable object as an older, GC-less build would have left behind.
    doc.context.register(doc.context.stream(`ORPHAN-${orphanMarker}`));
    doc.context.register(doc.context.obj({ Leak: PDFString.of(`ORPHAN-DICT-${orphanMarker}`) }));
  }
  return new Uint8Array(await doc.save());
}

function rawContains(bytes: Uint8Array, needle: string): boolean {
  return dec.decode(bytes).includes(needle);
}

/** Readable text of an object: decoded stream data plus its dictionary. */
function objectText(obj: unknown): string {
  if (obj instanceof PDFRawStream) {
    let data: string;
    try {
      data = dec.decode(decodePDFRawStream(obj).decode());
    } catch {
      data = dec.decode(obj.contents);
    }
    return `${obj.dict.toString()}\n${data}`;
  }
  return String(obj);
}

interface Census {
  /** Every indirect object (decoded) whose text contains the marker. */
  carriers: string[];
  /** Objects the trailer cannot reach, ignoring the file's own xref/objstm containers. */
  unreachable: string[];
}

async function census(bytes: Uint8Array, marker: string): Promise<Census> {
  const doc = await PDFDocument.load(bytes);
  const reachable = collectReachableRefs(doc);
  const carriers: string[] = [];
  const unreachable: string[] = [];
  for (const [ref, obj] of doc.context.enumerateIndirectObjects()) {
    if (objectText(obj).includes(marker)) carriers.push(ref.toString());
    if (!reachable.has(ref.toString())) {
      const type = obj instanceof PDFRawStream ? obj.dict.get(PDFName.Type)?.toString() : undefined;
      if (type !== '/XRef' && type !== '/ObjStm') unreachable.push(ref.toString());
    }
  }
  return { carriers, unreachable };
}

/** Text of every page's content streams in order, as the reader sees it. */
async function pageTexts(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  return doc.getPages().map((p) => {
    const contents = p.node.get(PDFName.Contents);
    const refs = contents instanceof PDFArray ? contents.asArray() : [contents];
    return refs.map((r) => objectText(doc.context.lookup(r as PDFRef))).join('');
  });
}

async function reopensWithPdfJs(bytes: Uint8Array): Promise<number> {
  const pdf = await openPdfJs(bytes);
  try {
    for (let i = 1; i <= pdf.numPages; i++) await (await pdf.getPage(i)).getOperatorList();
    return pdf.numPages;
  } finally {
    await pdf.destroy();
  }
}

/** The removed page's marker must be gone from the bytes and the object table. */
async function expectPurged(out: Uint8Array, marker: string): Promise<void> {
  expect(rawContains(out, `TXT-${marker}`)).toBe(false);
  expect(rawContains(out, `IMG-${marker}`)).toBe(false);
  const c = await census(out, marker);
  expect(c.carriers).toEqual([]);
  expect(c.unreachable).toEqual([]);
}

/** A kept page's marker must still be readable: proves the scan can see survivors. */
async function expectKept(out: Uint8Array, marker: string): Promise<void> {
  expect(rawContains(out, `TXT-${marker}`)).toBe(true);
  expect(rawContains(out, `IMG-${marker}`)).toBe(true);
  expect((await census(out, `DICT-${marker}`)).carriers.length).toBe(1);
}

describe('page ops drop removed pages from the saved file', () => {
  it('fixture sanity: every marker is present in the input bytes / object table', async () => {
    const input = await markedDoc(['KEEP-A', 'SECRET-B', 'KEEP-C']);
    for (const m of ['KEEP-A', 'SECRET-B', 'KEEP-C']) {
      expect(rawContains(input, `TXT-${m}`)).toBe(true);
      expect(rawContains(input, `IMG-${m}`)).toBe(true);
      expect((await census(input, `DICT-${m}`)).carriers.length).toBe(1);
    }
  });

  it('deletePdfPage: the deleted page leaves no content, image or page dict behind', async () => {
    const input = await markedDoc(['KEEP-A', 'SECRET-B', 'KEEP-C']);
    const out = await deletePdfPage(input, 1);
    await expectPurged(out, 'SECRET-B');
    await expectKept(out, 'KEEP-A');
    await expectKept(out, 'KEEP-C');
    expect((await pageTexts(out)).map((t) => /TXT-(\S+)\)/.exec(t)?.[1])).toEqual(['KEEP-A', 'KEEP-C']);
    expect(await reopensWithPdfJs(out)).toBe(2);
  });

  it('deletePdfPages (bulk): every deleted page is purged', async () => {
    const input = await markedDoc(['SECRET-A', 'KEEP-B', 'SECRET-C', 'KEEP-D']);
    const out = await deletePdfPages(input, [0, 2]);
    await expectPurged(out, 'SECRET-A');
    await expectPurged(out, 'SECRET-C');
    await expectKept(out, 'KEEP-B');
    await expectKept(out, 'KEEP-D');
    expect(await reopensWithPdfJs(out)).toBe(2);
  });

  it('applyPdfPageOrder with an omission purges the omitted page', async () => {
    const input = await markedDoc(['KEEP-A', 'SECRET-B', 'KEEP-C']);
    const out = await applyPdfPageOrder(input, [2, 0]);
    await expectPurged(out, 'SECRET-B');
    expect((await pageTexts(out)).map((t) => /TXT-(\S+)\)/.exec(t)?.[1])).toEqual(['KEEP-C', 'KEEP-A']);
  });

  it('replacePdfPage: the replaced original is purged, the replacement is present', async () => {
    const input = await markedDoc(['KEEP-A', 'SECRET-B', 'KEEP-C']);
    const source = await markedDoc(['NEW-R']);
    const { bytes: out } = await replacePdfPage(input, 1, source);
    await expectPurged(out, 'SECRET-B');
    await expectKept(out, 'NEW-R');
    await expectKept(out, 'KEEP-A');
    await expectKept(out, 'KEEP-C');
    expect((await pageTexts(out)).map((t) => /TXT-(\S+)\)/.exec(t)?.[1])).toEqual(['KEEP-A', 'NEW-R', 'KEEP-C']);
    expect(await reopensWithPdfJs(out)).toBe(3);
  });

  it('movePdfPages: rebuilds the page tree without carrying any orphan (pre-existing one is purged)', async () => {
    const input = await markedDoc(['KEEP-A', 'KEEP-B', 'KEEP-C'], 'LEFTOVER');
    expect(rawContains(input, 'ORPHAN-LEFTOVER')).toBe(true);
    const out = await movePdfPages(input, [0], 3);
    expect(rawContains(out, 'ORPHAN-LEFTOVER')).toBe(false);
    const c = await census(out, 'ORPHAN-');
    expect(c.carriers).toEqual([]);
    expect(c.unreachable).toEqual([]);
    for (const m of ['KEEP-A', 'KEEP-B', 'KEEP-C']) await expectKept(out, m);
    expect((await pageTexts(out)).map((t) => /TXT-(\S+)\)/.exec(t)?.[1])).toEqual(['KEEP-B', 'KEEP-C', 'KEEP-A']);
  });

  it('duplicatePdfPages: clones keep content, nothing unreachable is written', async () => {
    const input = await markedDoc(['KEEP-A', 'KEEP-B'], 'LEFTOVER');
    const out = await duplicatePdfPages(input, [1]);
    expect(rawContains(out, 'ORPHAN-LEFTOVER')).toBe(false);
    const c = await census(out, 'ORPHAN-');
    expect(c.carriers).toEqual([]);
    expect(c.unreachable).toEqual([]);
    expect((await pageTexts(out)).map((t) => /TXT-(\S+)\)/.exec(t)?.[1])).toEqual(['KEEP-A', 'KEEP-B', 'KEEP-B']);
    expect(await reopensWithPdfJs(out)).toBe(3);
  });
});

/**
 * SC-01: the save sites are DERIVED from the source, not listed. Any `.save(`
 * call in pageStructure.ts outside the GC chokepoint fails this test, so a new
 * page op cannot serialise without dropping unreachable objects.
 */
describe('pageStructure.ts: every save goes through the GC chokepoint', () => {
  // Comments are blanked (same length, newlines kept) so prose that mentions
  // `.save(` neither trips nor satisfies the scan; line numbers stay true.
  const source = fs
    .readFileSync(path.resolve(__dirname, '../pageStructure.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (c) => c.replace(/[^\n]/g, ' '));
  const CHOKEPOINT = 'saveWithoutOrphans';

  /** Body of `async function <name>(...) {...}` by brace matching. */
  function functionBody(name: string): { start: number; end: number; text: string } {
    const head = new RegExp(`async function ${name}\\s*\\(`).exec(source);
    if (!head) throw new Error(`${name} not found in pageStructure.ts`);
    const open = source.indexOf('{', head.index);
    let depth = 0;
    for (let i = open; i < source.length; i++) {
      if (source[i] === '{') depth++;
      else if (source[i] === '}' && --depth === 0) {
        return { start: head.index, end: i + 1, text: source.slice(open, i + 1) };
      }
    }
    throw new Error(`unbalanced braces in ${name}`);
  }

  it('the chokepoint flushes, then GCs, then saves', () => {
    const body = functionBody(CHOKEPOINT).text;
    const flush = body.indexOf('.flush()');
    const gc = body.indexOf('removeUnreachableObjects(');
    const save = body.indexOf('.save(');
    expect(flush).toBeGreaterThan(-1);
    expect(gc).toBeGreaterThan(flush);
    expect(save).toBeGreaterThan(gc);
  });

  it('no `.save(` call exists outside the chokepoint', () => {
    const { start, end } = functionBody(CHOKEPOINT);
    const sites = [...source.matchAll(/\.save\s*\(/g)].map((m) => m.index!);
    expect(sites.length).toBeGreaterThan(0);
    const outside = sites
      .filter((i) => i < start || i >= end)
      .map((i) => `line ${source.slice(0, i).split('\n').length}`);
    expect(outside).toEqual([]);
  });

  it('every function that removes a page serialises through the chokepoint', () => {
    const removals = [...source.matchAll(/\.removePage\s*\(/g)].map((m) => m.index!);
    expect(removals.length).toBeGreaterThan(0);
    for (const at of removals) {
      const fnStart = source.lastIndexOf('export async function', at);
      const nextFn = source.indexOf('\nexport ', at);
      const fn = source.slice(fnStart, nextFn === -1 ? undefined : nextFn);
      expect(fn.slice(fn.indexOf('removePage')), `removePage at line ${source.slice(0, at).split('\n').length}`)
        .toContain(`${CHOKEPOINT}(doc)`);
    }
  });
});

