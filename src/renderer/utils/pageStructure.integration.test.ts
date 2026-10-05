/**
 * Integration: structural ops + the REAL save pipeline must agree.
 *
 * Reproduces the class of bug fixed here — the save pipeline resolves
 * pdfDoc.getPage(page.index) against pdfData, so if a structural op mutates the
 * page model without rebuilding pdfData, the save either throws or writes the
 * wrong pages. We drive bytes and model through the same op sequence the hook
 * uses, then run applyEditsAndAnnotations and assert the output structure.
 */
import { describe, it, expect } from 'vitest';
import { PDFDocument as PDFLib } from 'pdf-lib';
import { applyEditsAndAnnotations } from './pdfSavePipeline';
import {
  deletePdfPage,
  insertBlankPdfPage,
  reorderPdfPage,
  setPdfPageRotation,
} from './pageStructure';
import type { PDFPage } from '../types';

async function makeBytes(n: number): Promise<Uint8Array> {
  const d = await PDFLib.create();
  for (let i = 0; i < n; i++) d.addPage([100 + i, 200]);
  return new Uint8Array(await d.save());
}
function makeModel(widths: number[], rotations?: number[]): PDFPage[] {
  return widths.map((w, i) => ({
    index: i,
    width: w,
    height: 200,
    rotation: rotations ? rotations[i] : 0,
    annotations: [],
    textItems: [],
    textEdits: [],
  })) as unknown as PDFPage[];
}
async function saveThrough(pdfData: Uint8Array, pages: PDFPage[]): Promise<Uint8Array> {
  return applyEditsAndAnnotations({
    pdfData,
    pages,
    annotationStorage: null,
    formFieldMappings: [],
  });
}
async function structure(bytes: Uint8Array) {
  const d = await PDFLib.load(bytes);
  return {
    widths: d.getPages().map((p) => Math.round(p.getSize().width)),
    rotations: d.getPages().map((p) => p.getRotation().angle),
  };
}

describe('structural ops survive the real save pipeline', () => {
  it('delete → save keeps the surviving pages and no more', async () => {
    let bytes = await makeBytes(5);
    bytes = await deletePdfPage(bytes, 1); // drop width 101
    const model = makeModel([100, 102, 103, 104]);
    const out = await saveThrough(bytes, model);
    expect((await structure(out)).widths).toEqual([100, 102, 103, 104]);
  });

  it('insert blank → save is possible (regression: used to brick the save)', async () => {
    let bytes = await makeBytes(3);
    bytes = await insertBlankPdfPage(bytes, 1, 999, 200); // after page index 1
    const model = makeModel([100, 101, 999, 102]);
    const out = await saveThrough(bytes, model);
    expect((await structure(out)).widths).toEqual([100, 101, 999, 102]);
  });

  it('reorder → save writes the new order', async () => {
    let bytes = await makeBytes(5);
    bytes = await reorderPdfPage(bytes, 0, 3);
    const model = makeModel([101, 102, 103, 100, 104]);
    const out = await saveThrough(bytes, model);
    expect((await structure(out)).widths).toEqual([101, 102, 103, 100, 104]);
  });

  it('rotate → save preserves the baked /Rotate', async () => {
    let bytes = await makeBytes(4);
    bytes = await setPdfPageRotation(bytes, 2, 90);
    const model = makeModel([100, 101, 102, 103], [0, 0, 90, 0]);
    const out = await saveThrough(bytes, model);
    expect((await structure(out)).rotations).toEqual([0, 0, 90, 0]);
  });

  it('a full delete+insert+reorder+rotate sequence stays aligned through save', async () => {
    let bytes = await makeBytes(5); // 100,101,102,103,104
    bytes = await deletePdfPage(bytes, 4); // 100,101,102,103
    bytes = await insertBlankPdfPage(bytes, 0, 999, 200); // 100,999,101,102,103
    bytes = await reorderPdfPage(bytes, 1, 4); // 100,101,102,103,999
    bytes = await setPdfPageRotation(bytes, 0, 270); // rotate first page
    const model = makeModel([100, 101, 102, 103, 999], [270, 0, 0, 0, 0]);
    const out = await saveThrough(bytes, model);
    const s = await structure(out);
    expect(s.widths).toEqual([100, 101, 102, 103, 999]);
    expect(s.rotations).toEqual([270, 0, 0, 0, 0]);
  });
});
