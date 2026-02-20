/**
 * Diagnose rect classification and paragraph overlap.
 * Usage: npx tsx test-pdfs/diagnose-rects.ts test-pdfs/repair-calibration-form.pdf
 */
import * as fs from 'fs';
import * as path from 'path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { analyzePage } from '../src/renderer/utils/docxGenerator/PageAnalyzer';
import { buildPageLayout } from '../src/renderer/utils/docxGenerator/LayoutAnalyzer';
import type { RectElement } from '../src/renderer/utils/docxGenerator/types';

async function diagnose(pdfPath: string): Promise<void> {
  const absPath = path.resolve(pdfPath);
  console.log(`Diagnosing: ${path.basename(absPath)}\n`);

  const data = new Uint8Array(fs.readFileSync(absPath));
  const doc = await pdfjsLib.getDocument({ data: data.slice() }).promise;
  let pdfLib: PDFDocument | null = null;
  try { pdfLib = await PDFDocument.load(data, { ignoreEncryption: true }); } catch {}

  const page = await doc.getPage(1);
  const scene = await analyzePage(page, pdfLib, 0);

  const rects = scene.elements.filter(e => e.kind === 'rect') as RectElement[];
  console.log(`Total rects: ${rects.length}`);
  console.log(`Page size: ${scene.width}x${scene.height}`);
  const pageArea = scene.width * scene.height;

  // Classify each rect
  console.log('\n--- All Rect Classifications ---');
  const counts: Record<string, number> = {};

  for (const rect of rects) {
    const fx = Math.min(rect.x, rect.x + rect.width);
    const fy = Math.min(rect.y, rect.y + rect.height);
    const fw = Math.abs(rect.width);
    const fh = Math.abs(rect.height);
    const area = fw * fh;

    let role = 'decorative';
    if (area > pageArea * 0.9) role = 'page-background';
    else if ((fh < 2 || fw < 2) && (fw > scene.width * 0.5 || fh > scene.height * 0.5)) role = 'separator';
    else if (rect.strokeColor !== null && rect.lineWidth > 0) role = 'table-border';
    else if (rect.fillColor !== null && rect.strokeColor === null) role = 'cell-fill';

    counts[role] = (counts[role] || 0) + 1;

    if (role === 'cell-fill' || role === 'separator' || role === 'decorative') {
      const fill = rect.fillColor
        ? `fill=rgb(${(rect.fillColor.r*255).toFixed(0)},${(rect.fillColor.g*255).toFixed(0)},${(rect.fillColor.b*255).toFixed(0)})`
        : 'no-fill';
      const stroke = rect.strokeColor
        ? `stroke=rgb(${(rect.strokeColor.r*255).toFixed(0)},${(rect.strokeColor.g*255).toFixed(0)},${(rect.strokeColor.b*255).toFixed(0)})`
        : 'no-stroke';
      console.log(`  ${role.padEnd(14)} x=${fx.toFixed(1).padStart(6)} y=${fy.toFixed(1).padStart(6)} w=${fw.toFixed(1).padStart(6)} h=${fh.toFixed(1).padStart(5)} ${fill} ${stroke} lw=${rect.lineWidth}`);
    }
  }

  console.log('\nClassification summary:', counts);

  // Store cell-fill rects for manual matching below
  const cellFillRects = rects.filter(r => {
    const w = Math.abs(r.width);
    const h = Math.abs(r.height);
    const area = w * h;
    if (area > pageArea * 0.9) return false;
    if ((h < 2 || w < 2) && (w > scene.width * 0.5 || h > scene.height * 0.5)) return false;
    if (r.strokeColor !== null && r.lineWidth > 0) return false;
    return r.fillColor !== null && r.strokeColor === null;
  });

  // Now build layout and check paragraph backgrounds
  const layout = buildPageLayout(scene);
  console.log('\n--- ALL Paragraphs with Bounding Boxes ---');
  for (const elem of layout.elements) {
    if (elem.type === 'paragraph') {
      const para = elem.element;
      const items = [
        ...para.texts.map(t => ({ x: t.x, y: t.y, w: t.width, h: t.height })),
        ...para.formFields.map(f => ({ x: f.x, y: f.y, w: f.width, h: f.height })),
      ];
      const preview = para.texts.map(t => t.text).join(' ').substring(0, 40);

      if (items.length > 0) {
        const paraTop = Math.min(...items.map(it => it.y));
        const paraBottom = Math.max(...items.map(it => it.y + it.h));
        const paraLeft = Math.min(...items.map(it => it.x));
        const paraRight = Math.max(...items.map(it => it.x + it.w));

        const bg = para.backgroundColor
          ? ` BG=rgb(${(para.backgroundColor.r*255).toFixed(0)},${(para.backgroundColor.g*255).toFixed(0)},${(para.backgroundColor.b*255).toFixed(0)})`
          : '';
        const border = para.bottomBorder
          ? ` BORDER=${(para.bottomBorder.widthPt).toFixed(1)}pt color=rgb(${(para.bottomBorder.color.r*255).toFixed(0)},${(para.bottomBorder.color.g*255).toFixed(0)},${(para.bottomBorder.color.b*255).toFixed(0)})`
          : '';

        console.log(`  PARA y=${paraTop.toFixed(1)}-${paraBottom.toFixed(1)} x=${paraLeft.toFixed(1)}-${paraRight.toFixed(1)} "${preview}"${bg}${border}`);
      }
    }
  }

  // Manually check overlap for underline rects
  console.log('\n--- Manual Underline Matching ---');
  const underlines = cellFillRects.filter(r => Math.abs(r.height) < 3 && Math.abs(r.width) > 50 && Math.abs(r.width) < scene.width * 0.9);
  console.log(`Found ${underlines.length} potential underline rects`);
  for (const ul of underlines) {
    const uy = Math.min(ul.y, ul.y + ul.height);
    const uh = Math.abs(ul.height);
    console.log(`  Underline at y=${uy.toFixed(1)} h=${uh.toFixed(1)} w=${Math.abs(ul.width).toFixed(1)}`);
  }

  console.log('\nTotal layout elements:', layout.elements.length);

  page.cleanup();
  await doc.destroy();
}

const pdfPath = process.argv[2] || 'test-pdfs/repair-calibration-form.pdf';
diagnose(pdfPath).catch(e => { console.error('Fatal:', e); process.exit(1); });
