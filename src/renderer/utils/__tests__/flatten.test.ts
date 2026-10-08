import { describe, it, expect } from 'vitest';
import { PDFDocument, PDFName, PDFArray, PDFDict, StandardFonts } from 'pdf-lib';
import { flattenPdf } from '../flatten';
import { bakeFormValues, flattenDocument, refreshSourceAnnotations } from '../documentTransforms';
import { createFormField } from '../formBuilder';
import { buildFormFieldMapping } from '../formFieldSaver';
import type { PDFPage, ShapeAnnotation, StickyNoteAnnotation } from '../../types';
import { fixture, allText, openPdfJs, TestAnnotationStorage } from './formsFinalizeHelpers';

async function widgetCount(bytes: Uint8Array): Promise<number> {
  const doc = await PDFDocument.load(bytes);
  let n = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const d = annots.lookup(i);
      if (d instanceof PDFDict && d.lookup(PDFName.of('Subtype'))?.toString() === '/Widget') n++;
    }
  }
  return n;
}

async function annotSubtypes(bytes: Uint8Array): Promise<string[]> {
  const doc = await PDFDocument.load(bytes);
  const out: string[] = [];
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const d = annots.lookup(i);
      if (d instanceof PDFDict) out.push(String(d.lookup(PDFName.of('Subtype'))));
    }
  }
  return out;
}

function modelPages(n: number, width = 612, height = 792): PDFPage[] {
  return Array.from({ length: n }, (_, i) => ({
    index: i, width, height, rotation: 0, annotations: [], textItems: [], textEdits: [],
  }));
}

/** Add a markup annotation with an appearance whose BBox does not start at 0,0 and has a Matrix. */
async function withOffsetAppearanceAnnotation(bytes: Uint8Array): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes);
  const page = doc.getPage(0);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const ctx = doc.context;
  const ap = ctx.flateStream('BT /F1 12 Tf 105 108 Td (STAMPEDMARK) Tj ET', {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [100, 100, 220, 124],
    Matrix: [1, 0, 0, 1, 0, 0],
    Resources: { Font: { F1: font.ref } },
  });
  const annot = ctx.obj({
    Type: 'Annot',
    Subtype: 'FreeText',
    Rect: [300, 50, 420, 74],
    Contents: 'STAMPEDMARK',
    DA: '/Helv 12 Tf 0 g',
    AP: { N: ctx.register(ap) },
  });
  page.node.addAnnot(ctx.register(annot));
  return new Uint8Array(await doc.save());
}

describe('flatten: forms', () => {
  it('burns the current values of repair-calibration-form.pdf into the page and removes the AcroForm and widgets', async () => {
    const doc = await PDFDocument.load(fixture('repair-calibration-form.pdf'));
    const form = doc.getForm();
    form.getTextField('Name').setText('Zebulon Quixote');
    form.getTextField('Serial Number').setText('SN-778899');
    form.getCheckBox('Mail').check();
    const filled = new Uint8Array(await doc.save());
    expect(await widgetCount(filled)).toBe(47);

    const { bytes, report } = await flattenPdf(filled, { scope: 'forms' });
    expect(report.widgetsFlattened).toBe(47);
    expect(report.fieldsRemoved).toBe(47);

    const out = await PDFDocument.load(bytes);
    expect(out.catalog.has(PDFName.of('AcroForm'))).toBe(false);
    expect(await widgetCount(bytes)).toBe(0);
    expect(out.getPageCount()).toBe(1);

    const text = await allText(bytes);
    expect(text).toContain('Zebulon Quixote');
    expect(text).toContain('SN-778899');

    const pdf = await openPdfJs(bytes);
    try {
      expect(await pdf.getFieldObjects()).toBeNull();
    } finally {
      await pdf.destroy();
    }
  });

  it('bakes values typed into pdf.js widgets (text + radio) before flattening', async () => {
    let bytes = fixture('repair-calibration-form.pdf');
    bytes = (await createFormField(bytes, { kind: 'radio', name: 'Priority', pageIndex: 0, rect: { x: 40, y: 40, width: 14, height: 50 }, options: ['Low', 'High'] })).bytes;

    const pdf = await openPdfJs(bytes);
    const mappings = await buildFormFieldMapping(pdf);
    await pdf.destroy();

    const storage = new TestAnnotationStorage();
    const email = mappings.find((m) => m.fieldName === 'Email')!;
    storage.setValue(email.annotationId, { value: 'ron@example.test' });
    // pdf.js radio storage: one boolean per widget.
    const [low, high] = mappings.filter((m) => m.fieldName === 'Priority');
    storage.setValue(low.annotationId, { value: false });
    storage.setValue(high.annotationId, { value: true });

    const baked = await bakeFormValues(bytes, storage, mappings);
    expect(baked).not.toBe(bytes);
    const bakedDoc = await PDFDocument.load(baked);
    expect(bakedDoc.getForm().getTextField('Email').getText()).toBe('ron@example.test');
    expect(bakedDoc.getForm().getRadioGroup('Priority').getSelected()).toBe('High');

    const result = await flattenDocument({ pdfData: baked, pages: modelPages(1), scope: 'forms' });
    expect(await allText(result.pdfData)).toContain('ron@example.test');
    expect(await widgetCount(result.pdfData)).toBe(0);
  });

  it('returns the same bytes when there is nothing to bake', async () => {
    const bytes = fixture('repair-calibration-form.pdf');
    expect(await bakeFormValues(bytes, new TestAnnotationStorage(), [])).toBe(bytes);
    expect(await bakeFormValues(bytes, null, [])).toBe(bytes);
  });
});

describe('flatten: annotations', () => {
  it('maps an offset BBox appearance onto the annotation rect (§12.5.5) and removes the annotation', async () => {
    const bytes = await withOffsetAppearanceAnnotation(fixture('invoice.pdf'));
    const { bytes: out, report } = await flattenPdf(bytes, { scope: 'annotations' });
    expect(report.annotationsFlattened).toBe(1);
    expect(await annotSubtypes(out)).not.toContain('/FreeText');

    const pdf = await openPdfJs(out);
    try {
      const page = await pdf.getPage(1);
      const content = await page.getTextContent();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const item = content.items.find((it: any) => it.str === 'STAMPEDMARK') as any;
      expect(item, 'flattened appearance text').toBeTruthy();
      // BBox origin (100,100) maps to Rect origin (300,50); text was at (105,108).
      expect(item.transform[4]).toBeCloseTo(305, 1);
      expect(item.transform[5]).toBeCloseTo(58, 1);
    } finally {
      await pdf.destroy();
    }
  });

  it('annotation scope keeps form fields fillable', async () => {
    const bytes = await withOffsetAppearanceAnnotation(fixture('repair-calibration-form.pdf'));
    const { bytes: out } = await flattenPdf(bytes, { scope: 'annotations' });
    expect(await widgetCount(out)).toBe(47);
    expect((await PDFDocument.load(out)).getForm().getFields()).toHaveLength(47);
  });

  it('pending in-session annotations: burned for annotation scope, preserved for forms scope; text edits stay pending', async () => {
    const bytes = fixture('repair-calibration-form.pdf');
    const shape: ShapeAnnotation = {
      id: 'shape-1', type: 'shape', pageIndex: 1, shapeType: 'rectangle',
      position: { x: 50, y: 50 }, size: { width: 100, height: 40 },
      strokeColor: '#ff0000', fillColor: 'transparent', strokeWidth: 2, opacity: 1,
    };
    const note: StickyNoteAnnotation = {
      id: 'note-1', type: 'note', pageIndex: 1, position: { x: 400, y: 60 }, content: 'Check serial', color: '#FFF9C4',
    };
    const pages = modelPages(1);
    pages[0].annotations = [shape, note];
    pages[0].textEdits = [{ itemId: 'text-item-0-0', pageIndex: 0, originalText: 'Name', newText: 'Nom' }];

    const formsOnly = await flattenDocument({ pdfData: bytes, pages, scope: 'forms' });
    expect(formsOnly.pendingAnnotationsBurned).toBe(0);
    expect(formsOnly.pages[0].annotations).toEqual([shape, note]);
    expect(formsOnly.pages[0].textEdits).toEqual(pages[0].textEdits);

    const both = await flattenDocument({ pdfData: bytes, pages, scope: 'both' });
    expect(both.pendingAnnotationsBurned).toBe(2);
    expect(both.pages[0].annotations).toEqual([]);
    expect(both.pages[0].textEdits).toEqual(pages[0].textEdits);
    // The note's /Text annotation (no appearance; its marker is in content) is removed too.
    expect(await annotSubtypes(both.pdfData)).toEqual([]);
    // The burned rectangle is now page content: a red stroke colour operator exists on the page.
    const pdf = await openPdfJs(both.pdfData);
    try {
      const ops = await (await pdf.getPage(1)).getOperatorList();
      const lib = await import('pdfjs-dist/legacy/build/pdf.mjs');
      const strokeColors = ops.fnArray
        .map((fn: number, i: number) => (fn === lib.OPS.setStrokeRGBColor ? ops.argsArray[i] : null))
        .filter(Boolean);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect(strokeColors.some((c: any) => String(c[0]).toLowerCase() === '#ff0000' || (c[0] === 255 && c[1] === 0 && c[2] === 0))).toBe(true);

      const refreshed = await refreshSourceAnnotations(pdf, both.pages);
      expect(refreshed[0].sourceAnnotations).toEqual([]);
    } finally {
      await pdf.destroy();
    }
  });
});
