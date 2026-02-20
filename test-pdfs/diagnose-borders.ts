/**
 * Analyze table-border rect connectivity at different tolerances.
 * Usage: npx tsx test-pdfs/diagnose-borders.ts
 */
import * as fs from 'fs';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';
import { analyzePage } from '../src/renderer/utils/docxGenerator/PageAnalyzer';
import type { RectElement } from '../src/renderer/utils/docxGenerator/types';

async function run() {
  const data = new Uint8Array(fs.readFileSync('test-pdfs/repair-calibration-form.pdf'));
  const doc = await pdfjsLib.getDocument({ data: data.slice() }).promise;
  let pdfLib: PDFDocument | null = null;
  try { pdfLib = await PDFDocument.load(data, { ignoreEncryption: true }); } catch {}

  const page = await doc.getPage(1);
  const scene = await analyzePage(page, pdfLib, 0);
  const pageArea = scene.width * scene.height;

  // Get table-border rects
  const borderRects: RectElement[] = [];
  for (const el of scene.elements) {
    if (el.kind !== 'rect') continue;
    const rect = el as RectElement;
    const w = Math.abs(rect.width);
    const h = Math.abs(rect.height);
    if (w * h > pageArea * 0.9) continue;
    if ((h < 2 || w < 2) && (w > scene.width * 0.5 || h > scene.height * 0.5)) continue;
    if (rect.strokeColor !== null && rect.lineWidth > 0) {
      borderRects.push(rect);
    }
  }

  console.log(`Total table-border rects: ${borderRects.length}\n`);

  // Show all border rects with positions
  console.log('--- Border Rect Positions ---');
  for (const r of borderRects) {
    const x = Math.min(r.x, r.x + r.width);
    const y = Math.min(r.y, r.y + r.height);
    const w = Math.abs(r.width);
    const h = Math.abs(r.height);
    const stroke = r.strokeColor ? `stroke=rgb(${(r.strokeColor.r*255).toFixed(0)},${(r.strokeColor.g*255).toFixed(0)},${(r.strokeColor.b*255).toFixed(0)})` : '';
    const fill = r.fillColor ? `fill=rgb(${(r.fillColor.r*255).toFixed(0)},${(r.fillColor.g*255).toFixed(0)},${(r.fillColor.b*255).toFixed(0)})` : 'no-fill';
    console.log(`  x=${x.toFixed(1).padStart(6)} y=${y.toFixed(1).padStart(6)} w=${w.toFixed(1).padStart(6)} h=${h.toFixed(1).padStart(5)} ${stroke} ${fill}`);
  }

  // Find minimum gaps between rects at different tolerances
  console.log('\n--- Connectivity Analysis ---');
  function countGroups(tol: number): number {
    const parent = borderRects.map((_, i) => i);
    function find(i: number): number {
      while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; }
      return i;
    }
    function union(a: number, b: number) {
      const ra = find(a), rb = find(b);
      if (ra !== rb) parent[ra] = rb;
    }

    for (let i = 0; i < borderRects.length; i++) {
      const a = borderRects[i];
      const ax = Math.min(a.x, a.x + a.width);
      const ay = Math.min(a.y, a.y + a.height);
      const aw = Math.abs(a.width);
      const ah = Math.abs(a.height);
      for (let j = i + 1; j < borderRects.length; j++) {
        const b = borderRects[j];
        const bx = Math.min(b.x, b.x + b.width);
        const by = Math.min(b.y, b.y + b.height);
        const bw = Math.abs(b.width);
        const bh = Math.abs(b.height);
        if (ax - tol < bx + bw && ax + aw + tol > bx &&
            ay - tol < by + bh && ay + ah + tol > by) {
          union(i, j);
        }
      }
    }

    const roots = new Set<number>();
    for (let i = 0; i < borderRects.length; i++) roots.add(find(i));
    return roots.size;
  }

  for (const tol of [2, 4, 6, 8, 10, 12, 15, 20]) {
    const groups = countGroups(tol);
    console.log(`  tolerance=${tol.toString().padStart(2)}pt → ${groups} groups`);
  }

  // Find all pairwise minimum gaps
  let minGap = Infinity;
  let gapCount = 0;
  const gapHistogram: Record<string, number> = {};

  for (let i = 0; i < borderRects.length; i++) {
    const a = borderRects[i];
    const ax = Math.min(a.x, a.x + a.width);
    const ay = Math.min(a.y, a.y + a.height);
    const aw = Math.abs(a.width);
    const ah = Math.abs(a.height);

    for (let j = i + 1; j < borderRects.length; j++) {
      const b = borderRects[j];
      const bx = Math.min(b.x, b.x + b.width);
      const by = Math.min(b.y, b.y + b.height);
      const bw = Math.abs(b.width);
      const bh = Math.abs(b.height);

      // Compute gap (negative = overlap)
      const gapX = Math.max(ax, bx) - Math.min(ax + aw, bx + bw);
      const gapY = Math.max(ay, by) - Math.min(ay + ah, by + bh);
      const gap = Math.max(gapX, gapY);

      if (gap < minGap) minGap = gap;
      if (gap < 25) {
        gapCount++;
        const bucket = Math.floor(gap);
        gapHistogram[bucket] = (gapHistogram[bucket] || 0) + 1;
      }
    }
  }

  console.log(`\nMin gap between any two border rects: ${minGap.toFixed(2)}pt`);
  console.log(`Gaps < 25pt: ${gapCount}`);
  console.log('Gap histogram:');
  for (const [bucket, count] of Object.entries(gapHistogram).sort((a, b) => Number(a[0]) - Number(b[0]))) {
    console.log(`  ${bucket}pt: ${'█'.repeat(Math.min(count, 40))} (${count})`);
  }

  page.cleanup();
  await doc.destroy();
}

run().catch(e => { console.error(e); process.exit(1); });
