/**
 * Diagnose form field positions — shows exact spatial layout of fields and texts.
 * Usage: npx tsx test-pdfs/diagnose-fields.ts test-pdfs/repair-calibration-form.pdf
 */
import * as fs from 'fs';
import * as path from 'path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { analyzePage } from '../src/renderer/utils/docxGenerator/PageAnalyzer';
import type { TextElement, FormField } from '../src/renderer/utils/docxGenerator/types';

async function diagnose(pdfPath: string): Promise<void> {
  const absPath = path.resolve(pdfPath);
  console.log(`\n=== Field Position Diagnostic: ${path.basename(absPath)} ===\n`);

  const data = new Uint8Array(fs.readFileSync(absPath));
  const pdfJsDoc = await pdfjsLib.getDocument({ data: data.slice() }).promise;
  let pdfLibDoc: PDFDocument | null = null;
  try { pdfLibDoc = await PDFDocument.load(data, { ignoreEncryption: true }); } catch { }

  for (let pageIdx = 0; pageIdx < pdfJsDoc.numPages; pageIdx++) {
    const page = await pdfJsDoc.getPage(pageIdx + 1);
    const scene = await analyzePage(page, pdfLibDoc, pageIdx);

    const texts = scene.elements.filter(e => e.kind === 'text') as TextElement[];
    const fields = scene.formFields;

    console.log(`Page ${pageIdx + 1}: ${texts.length} texts, ${fields.length} fields`);
    console.log(`Page size: ${scene.width}x${scene.height}`);

    // Show all text items sorted by Y then X
    console.log(`\n--- Text Items (sorted by Y, X) ---`);
    const sortedTexts = [...texts].sort((a, b) => {
      if (Math.abs(a.y - b.y) > 3) return a.y - b.y;
      return a.x - b.x;
    });
    for (const t of sortedTexts) {
      console.log(`  TEXT x=${t.x.toFixed(1).padStart(6)} y=${t.y.toFixed(1).padStart(6)} w=${t.width.toFixed(1).padStart(6)} h=${t.height.toFixed(1).padStart(5)} fs=${t.fontSize.toFixed(1)} ${t.bold ? 'B' : ' '} "${t.text}"`);
    }

    // Show all form fields sorted by Y then X
    console.log(`\n--- Form Fields (sorted by Y, X) ---`);
    const sortedFields = [...fields].sort((a, b) => {
      if (Math.abs(a.y - b.y) > 5) return a.y - b.y;
      return a.x - b.x;
    });
    for (const f of sortedFields) {
      const type = f.fieldType === 'Tx' ? 'TEXT' : f.fieldType === 'Btn' ? (f.isCheckBox ? 'CHKB' : 'BTN ') : 'DROP';
      console.log(`  ${type} x=${f.x.toFixed(1).padStart(6)} y=${f.y.toFixed(1).padStart(6)} w=${f.width.toFixed(1).padStart(6)} h=${f.height.toFixed(1).padStart(5)} name="${f.fieldName}" val="${f.fieldValue?.substring(0, 20) || ''}"`);
    }

    // Merged view: all items sorted by Y then X
    console.log(`\n--- Merged View (all items by Y, X) ---`);
    interface PositionedItem {
      type: 'text' | 'field';
      x: number;
      y: number;
      width: number;
      height: number;
      label: string;
    }

    const allItems: PositionedItem[] = [];
    for (const t of texts) {
      allItems.push({
        type: 'text',
        x: t.x, y: t.y, width: t.width, height: t.height,
        label: `TEXT "${t.text}" (fs=${t.fontSize.toFixed(0)}${t.bold ? ',bold' : ''})`
      });
    }
    for (const f of fields) {
      const ftype = f.fieldType === 'Tx' ? 'INPUT' : f.isCheckBox ? 'CHECK' : f.fieldType;
      allItems.push({
        type: 'field',
        x: f.x, y: f.y, width: f.width, height: f.height,
        label: `${ftype} "${f.fieldName}" val="${f.fieldValue?.substring(0, 15) || ''}"`
      });
    }

    allItems.sort((a, b) => {
      if (Math.abs(a.y - b.y) > 5) return a.y - b.y;
      return a.x - b.x;
    });

    // Group into visual rows
    let currentRowY = allItems[0]?.y ?? 0;
    let rowNum = 0;
    for (const item of allItems) {
      if (Math.abs(item.y - currentRowY) > 5) {
        rowNum++;
        currentRowY = item.y;
        console.log('');
      }
      const typeChar = item.type === 'text' ? 'T' : 'F';
      console.log(`  Row${String(rowNum).padStart(2)} [${typeChar}] x=${item.x.toFixed(1).padStart(6)} y=${item.y.toFixed(1).padStart(6)} w=${item.width.toFixed(1).padStart(6)} ${item.label}`);
    }

    // Y-band clustering analysis
    console.log(`\n--- Y-Band Clustering (fields only) ---`);
    const BAND_TOL = 8;
    const fieldYs = sortedFields.map(f => f.y + f.height / 2);
    const bands: { y: number; fields: FormField[] }[] = [];

    for (let i = 0; i < sortedFields.length; i++) {
      const centerY = fieldYs[i];
      let found = false;
      for (const band of bands) {
        if (Math.abs(centerY - band.y) <= BAND_TOL) {
          band.fields.push(sortedFields[i]);
          // Update band center
          band.y = band.fields.reduce((s, f) => s + f.y + f.height / 2, 0) / band.fields.length;
          found = true;
          break;
        }
      }
      if (!found) {
        bands.push({ y: centerY, fields: [sortedFields[i]] });
      }
    }

    bands.sort((a, b) => a.y - b.y);
    for (const band of bands) {
      const xs = band.fields.map(f => f.x.toFixed(0)).join(', ');
      const names = band.fields.map(f => f.fieldName.split('.').pop()).join(', ');
      console.log(`  Band y≈${band.y.toFixed(1)}: ${band.fields.length} fields at x=[${xs}] names=[${names}]`);
    }

    page.cleanup();
  }

  await pdfJsDoc.destroy();
  console.log('\n=== Diagnostic complete ===\n');
}

const pdfPath = process.argv[2] || 'test-pdfs/repair-calibration-form.pdf';
diagnose(pdfPath).catch(err => { console.error('Fatal error:', err); process.exit(1); });
