import { describe, it, expect } from 'vitest';
import { PDFDocument as PDFLib } from 'pdf-lib';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import {
  deletePdfPage,
  insertBlankPdfPage,
  reorderPdfPage,
  setPdfPageRotation,
} from './pageStructure';

// Build a doc where page i has width = 100+i, so page order is identifiable by width.
async function makeDoc(n: number): Promise<Uint8Array> {
  const d = await PDFLib.create();
  for (let i = 0; i < n; i++) d.addPage([100 + i, 200]);
  return new Uint8Array(await d.save());
}
async function widths(bytes: Uint8Array): Promise<number[]> {
  const d = await PDFLib.load(bytes);
  return d.getPages().map((p) => Math.round(p.getSize().width));
}
async function rotations(bytes: Uint8Array): Promise<number[]> {
  const d = await PDFLib.load(bytes);
  return d.getPages().map((p) => p.getRotation().angle);
}

describe('pageStructure — delete', () => {
  it('removes the targeted page and preserves order of the rest', async () => {
    const bytes = await makeDoc(5);
    expect(await widths(await deletePdfPage(bytes, 1))).toEqual([100, 102, 103, 104]);
    expect(await widths(await deletePdfPage(bytes, 0))).toEqual([101, 102, 103, 104]);
    expect(await widths(await deletePdfPage(bytes, 4))).toEqual([100, 101, 102, 103]);
  });
  it('refuses to delete the only page', async () => {
    const bytes = await makeDoc(1);
    await expect(deletePdfPage(bytes, 0)).rejects.toThrow(/only page/);
  });
  it('rejects an out-of-range index', async () => {
    const bytes = await makeDoc(3);
    await expect(deletePdfPage(bytes, 3)).rejects.toThrow(/out of range/);
    await expect(deletePdfPage(bytes, -1)).rejects.toThrow(/out of range/);
  });
});

describe('pageStructure — insert blank', () => {
  it('inserts a blank page after the given index', async () => {
    const bytes = await makeDoc(5);
    expect(await widths(await insertBlankPdfPage(bytes, 2, 999, 200)))
      .toEqual([100, 101, 102, 999, 103, 104]);
  });
  it('inserts at the front when afterIndex is -1', async () => {
    const bytes = await makeDoc(3);
    expect(await widths(await insertBlankPdfPage(bytes, -1, 999, 200)))
      .toEqual([999, 100, 101, 102]);
  });
  it('appends when afterIndex is the last page', async () => {
    const bytes = await makeDoc(3);
    expect(await widths(await insertBlankPdfPage(bytes, 2, 999, 200)))
      .toEqual([100, 101, 102, 999]);
  });
});

describe('pageStructure — reorder', () => {
  it('matches array splice(from,1)+splice(to,0) semantics', async () => {
    const bytes = await makeDoc(5);
    expect(await widths(await reorderPdfPage(bytes, 0, 3))).toEqual([101, 102, 103, 100, 104]);
    expect(await widths(await reorderPdfPage(bytes, 4, 0))).toEqual([104, 100, 101, 102, 103]);
    expect(await widths(await reorderPdfPage(bytes, 2, 2))).toEqual([100, 101, 102, 103, 104]);
  });
  it('rejects out-of-range indices', async () => {
    const bytes = await makeDoc(3);
    await expect(reorderPdfPage(bytes, 3, 0)).rejects.toThrow(/out of range/);
    await expect(reorderPdfPage(bytes, 0, 5)).rejects.toThrow(/out of range/);
  });
});

describe('pageStructure — rotate', () => {
  it('bakes an absolute rotation into only the target page', async () => {
    const bytes = await makeDoc(5);
    expect(await rotations(await setPdfPageRotation(bytes, 2, 90))).toEqual([0, 0, 90, 0, 0]);
    expect(await rotations(await setPdfPageRotation(bytes, 0, 270))).toEqual([270, 0, 0, 0, 0]);
  });
  it('normalises negative and >=360 angles', async () => {
    const bytes = await makeDoc(2);
    expect(await rotations(await setPdfPageRotation(bytes, 0, -90))).toEqual([270, 0]);
    expect(await rotations(await setPdfPageRotation(bytes, 1, 450))).toEqual([0, 90]);
  });
  it('rejects a non-multiple-of-90 angle', async () => {
    const bytes = await makeDoc(1);
    await expect(setPdfPageRotation(bytes, 0, 45)).rejects.toThrow(/multiple of 90/);
  });
  it('rotation travels with the page through a reorder', async () => {
    const bytes = await makeDoc(5);
    const rotated = await setPdfPageRotation(bytes, 2, 90);
    const moved = await reorderPdfPage(rotated, 2, 0);
    expect(await rotations(moved)).toEqual([90, 0, 0, 0, 0]);
    expect(await widths(moved)).toEqual([102, 100, 101, 103, 104]);
  });
});

describe('pageStructure — AcroForm preservation', () => {
  const formPath = join(process.cwd(), 'test-pdfs', 'repair-calibration-form.pdf');
  const hasFixture = existsSync(formPath);
  (hasFixture ? it : it.skip)('preserves form fields through rotate', async () => {
    const bytes = new Uint8Array(readFileSync(formPath));
    const before = (await PDFLib.load(bytes)).getForm().getFields().length;
    expect(before).toBeGreaterThan(0);
    const after = await setPdfPageRotation(bytes, 0, 90);
    expect((await PDFLib.load(after)).getForm().getFields().length).toBe(before);
  });
  (hasFixture ? it : it.skip)('preserves form fields through insert', async () => {
    const bytes = new Uint8Array(readFileSync(formPath));
    const before = (await PDFLib.load(bytes)).getForm().getFields().length;
    const after = await insertBlankPdfPage(bytes, 0, 595, 842);
    const doc = await PDFLib.load(after);
    expect(doc.getForm().getFields().length).toBe(before);
    expect(doc.getPageCount()).toBe(2);
  });
});
