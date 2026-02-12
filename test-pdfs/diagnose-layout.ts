/**
 * Diagnose LayoutAnalyzer — traces exactly what happens to rects in the pipeline.
 * Usage: npx tsx test-pdfs/diagnose-layout.ts test-pdfs/repair-calibration-form.pdf
 */
import * as fs from 'fs';
import * as path from 'path';
import * as pdfjsLib from 'pdfjs-dist/legacy/build/pdf.mjs';
import { PDFDocument } from 'pdf-lib';

// Import pipeline modules
import { analyzePage } from '../src/renderer/utils/docxGenerator/PageAnalyzer';
import { buildPageLayout, _testExports } from '../src/renderer/utils/docxGenerator/LayoutAnalyzer';
import type { RectElement, TextElement, PageScene, RectRole } from '../src/renderer/utils/docxGenerator/types';

const {
  classifyRectangles,
  detectTables,
  clusterValues,
  EDGE_CLUSTER_TOLERANCE,
} = _testExports;

async function diagnose(pdfPath: string): Promise<void> {
  const absPath = path.resolve(pdfPath);
  console.log(`\n=== LayoutAnalyzer Diagnostic: ${path.basename(absPath)} ===\n`);

  const data = new Uint8Array(fs.readFileSync(absPath));

  // Load with pdfjs + pdf-lib
  const pdfJsDoc = await pdfjsLib.getDocument({ data: data.slice() }).promise;
  let pdfLibDoc: PDFDocument | null = null;
  try {
    pdfLibDoc = await PDFDocument.load(data, { ignoreEncryption: true });
  } catch { /* ok */ }

  for (let pageIdx = 0; pageIdx < pdfJsDoc.numPages; pageIdx++) {
    console.log(`\n--- Page ${pageIdx + 1} ---\n`);

    const page = await pdfJsDoc.getPage(pageIdx + 1);
    const scene = await analyzePage(page, pdfLibDoc, pageIdx);

    // ─── Stage 1: Scene Element Counts ───
    const rects = scene.elements.filter(e => e.kind === 'rect') as RectElement[];
    const texts = scene.elements.filter(e => e.kind === 'text') as TextElement[];
    const paths = scene.elements.filter(e => e.kind === 'path');
    const images = scene.elements.filter(e => e.kind === 'image');

    console.log(`Scene elements: ${rects.length} rects, ${texts.length} texts, ${paths.length} paths, ${images.length} images`);
    console.log(`Form fields: ${scene.formFields.length}`);

    // ─── Stage 2: Rectangle Classification ───
    const rectRoles = classifyRectangles(scene);
    const roleCounts: Record<string, number> = {};
    const borderRects: RectElement[] = [];
    const cellFills: RectElement[] = [];

    for (const [rect, role] of rectRoles) {
      roleCounts[role] = (roleCounts[role] || 0) + 1;
      if (role === 'table-border') borderRects.push(rect);
      if (role === 'cell-fill') cellFills.push(rect);
    }

    console.log(`\nRect classification:`);
    for (const [role, count] of Object.entries(roleCounts).sort()) {
      console.log(`  ${role}: ${count}`);
    }

    // ─── Stage 3: Border Rect Details ───
    if (borderRects.length > 0) {
      console.log(`\nBorder rect details (first 20):`);
      for (let i = 0; i < Math.min(20, borderRects.length); i++) {
        const r = borderRects[i];
        console.log(`  [${i}] x=${r.x.toFixed(1)}, y=${r.y.toFixed(1)}, w=${r.width.toFixed(1)}, h=${r.height.toFixed(1)}, lw=${r.lineWidth}, stroke=${r.strokeColor ? `rgb(${r.strokeColor.r.toFixed(2)},${r.strokeColor.g.toFixed(2)},${r.strokeColor.b.toFixed(2)})` : 'null'}`);
      }
      if (borderRects.length > 20) {
        console.log(`  ... (${borderRects.length - 20} more)`);
      }
    }

    // ─── Stage 4: Connected Component Analysis ───
    if (borderRects.length > 0) {
      // Replicate the union-find logic from identifySeparateTables
      const parent: number[] = borderRects.map((_, i) => i);
      const rank: number[] = new Array(borderRects.length).fill(0);

      function find(i: number): number {
        while (parent[i] !== i) {
          parent[i] = parent[parent[i]];
          i = parent[i];
        }
        return i;
      }

      function union(a: number, b: number): void {
        const ra = find(a);
        const rb = find(b);
        if (ra === rb) return;
        if (rank[ra] < rank[rb]) parent[ra] = rb;
        else if (rank[ra] > rank[rb]) parent[rb] = ra;
        else { parent[rb] = ra; rank[ra]++; }
      }

      // Check which pairs share edges/overlap
      const tolerance = EDGE_CLUSTER_TOLERANCE * 2;
      let mergeCount = 0;

      for (let i = 0; i < borderRects.length; i++) {
        const a = borderRects[i];
        for (let j = i + 1; j < borderRects.length; j++) {
          const b = borderRects[j];
          // rectsShareEdgeOrOverlap
          const overlaps =
            a.x - tolerance < b.x + b.width &&
            a.x + a.width + tolerance > b.x &&
            a.y - tolerance < b.y + b.height &&
            a.y + a.height + tolerance > b.y;

          if (overlaps) {
            union(i, j);
            mergeCount++;
          }
        }
      }

      // Count groups
      const groups = new Map<number, number[]>();
      for (let i = 0; i < borderRects.length; i++) {
        const root = find(i);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root)!.push(i);
      }

      console.log(`\nConnected component analysis:`);
      console.log(`  Total border rects: ${borderRects.length}`);
      console.log(`  Merge operations: ${mergeCount}`);
      console.log(`  Number of groups: ${groups.size}`);

      // Sort groups by size descending
      const sortedGroups = [...groups.entries()].sort((a, b) => b[1].length - a[1].length);

      console.log(`\nGroup sizes (largest first):`);
      for (const [root, members] of sortedGroups.slice(0, 15)) {
        console.log(`  Group (root=${root}): ${members.length} rects`);

        // Show the bounding box of this group
        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const idx of members) {
          const r = borderRects[idx];
          minX = Math.min(minX, r.x);
          minY = Math.min(minY, r.y);
          maxX = Math.max(maxX, r.x + r.width);
          maxY = Math.max(maxY, r.y + r.height);
        }
        console.log(`    Bounds: (${minX.toFixed(1)}, ${minY.toFixed(1)}) to (${maxX.toFixed(1)}, ${maxY.toFixed(1)})`);

        // Check edge clustering for this group
        const xEdges: number[] = [];
        const yEdges: number[] = [];
        for (const idx of members) {
          const r = borderRects[idx];
          xEdges.push(r.x, r.x + r.width);
          yEdges.push(r.y, r.y + r.height);
        }
        const colBounds = clusterValues(xEdges, EDGE_CLUSTER_TOLERANCE);
        const rowBounds = clusterValues(yEdges, EDGE_CLUSTER_TOLERANCE);
        console.log(`    X edges -> ${colBounds.length} clustered columns (need >=3 for table)`);
        console.log(`    Y edges -> ${rowBounds.length} clustered rows (need >=3 for table)`);

        if (members.length <= 6) {
          // Show individual rects in small groups
          for (const idx of members) {
            const r = borderRects[idx];
            console.log(`      rect[${idx}]: (${r.x.toFixed(1)}, ${r.y.toFixed(1)}, ${r.width.toFixed(1)}x${r.height.toFixed(1)})`);
          }
        }
      }
      if (sortedGroups.length > 15) {
        console.log(`  ... (${sortedGroups.length - 15} more groups)`);
      }

      // Count isolated (single-rect) groups
      const isolated = sortedGroups.filter(g => g[1].length === 1).length;
      console.log(`\nIsolated (single-rect) groups: ${isolated} of ${groups.size}`);
    }

    // ─── Stage 5: Run Actual Table Detection ───
    console.log(`\n--- Running detectTables ---`);
    const tables = detectTables(scene, rectRoles);
    console.log(`Detected tables: ${tables.length}`);

    for (let ti = 0; ti < tables.length; ti++) {
      const t = tables[ti];
      console.log(`  Table ${ti}: ${t.rows}x${t.cols} at (${t.x.toFixed(1)}, ${t.y.toFixed(1)}) ${t.width.toFixed(1)}x${t.height.toFixed(1)}`);
      console.log(`    Column widths: ${t.columnWidths.map(w => w.toFixed(1)).join(', ')}`);
      console.log(`    Row heights: ${t.rowHeights.map(h => h.toFixed(1)).join(', ')}`);
      console.log(`    Cells: ${t.cells.length}`);
      for (const cell of t.cells) {
        const textPreview = cell.texts.map(t => t.text).join(' ').substring(0, 50);
        console.log(`      [${cell.row},${cell.col}] span=${cell.rowSpan}x${cell.colSpan} texts=${cell.texts.length} fields=${cell.formFields.length} "${textPreview}"`);
      }
    }

    // ─── Stage 6: Run Full Layout ───
    console.log(`\n--- Running buildPageLayout ---`);
    const layout = buildPageLayout(scene);

    console.log(`Layout elements: ${layout.elements.length}`);
    for (const elem of layout.elements) {
      if (elem.type === 'table') {
        console.log(`  TABLE: ${elem.element.rows}x${elem.element.cols} at y=${elem.element.y.toFixed(1)}`);
      } else if (elem.type === 'paragraph') {
        const preview = elem.element.texts.map(t => t.text).join(' ').substring(0, 60);
        console.log(`  PARA: y=${elem.element.y.toFixed(1)} texts=${elem.element.texts.length} fields=${elem.element.formFields.length} "${preview}"`);
      } else if (elem.type === 'image') {
        console.log(`  IMAGE: ${elem.element.resourceName} at y=${elem.element.y.toFixed(1)}`);
      }
    }

    // ─── Stage 7: Gap Analysis ───
    // Show how far apart border rects are from each other
    if (borderRects.length > 1 && borderRects.length <= 200) {
      // For each rect, find its nearest neighbor distance
      const nearestDistances: number[] = [];
      for (let i = 0; i < borderRects.length; i++) {
        let minDist = Infinity;
        const a = borderRects[i];
        for (let j = 0; j < borderRects.length; j++) {
          if (i === j) continue;
          const b = borderRects[j];
          // Gap between closest edges
          const gapX = Math.max(0, Math.max(b.x - (a.x + a.width), a.x - (b.x + b.width)));
          const gapY = Math.max(0, Math.max(b.y - (a.y + a.height), a.y - (b.y + b.height)));
          const dist = Math.sqrt(gapX * gapX + gapY * gapY);
          minDist = Math.min(minDist, dist);
        }
        nearestDistances.push(minDist);
      }

      nearestDistances.sort((a, b) => a - b);
      const touching = nearestDistances.filter(d => d <= EDGE_CLUSTER_TOLERANCE * 2).length;
      const close = nearestDistances.filter(d => d <= 10).length;
      const medium = nearestDistances.filter(d => d <= 30).length;

      console.log(`\nNearest-neighbor distance distribution for border rects:`);
      console.log(`  Touching (<=4pt): ${touching} rects`);
      console.log(`  Close (<=10pt): ${close} rects`);
      console.log(`  Medium (<=30pt): ${medium} rects`);
      console.log(`  Min: ${nearestDistances[0]?.toFixed(1)}pt`);
      console.log(`  Median: ${nearestDistances[Math.floor(nearestDistances.length / 2)]?.toFixed(1)}pt`);
      console.log(`  Max: ${nearestDistances[nearestDistances.length - 1]?.toFixed(1)}pt`);
    }

    page.cleanup();
  }

  await pdfJsDoc.destroy();
  console.log('\n=== Diagnostic complete ===\n');
}

// Run
const pdfPath = process.argv[2] || 'test-pdfs/repair-calibration-form.pdf';
diagnose(pdfPath).catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
