/**
 * Layout Analyzer — Structural Analysis Engine
 *
 * Converts a PageScene (flat list of PDF content-stream elements) into a PageLayout
 * (structured sequence of tables, paragraphs, and images in reading order).
 *
 * Core algorithm: VECTOR-BASED table detection.
 *   - Stroked rectangles form grid borders → table structure
 *   - Filled rectangles provide cell shading
 *   - Text/form fields assigned to cells by coordinate containment (center point)
 *   - Remaining text grouped into paragraphs by baseline proximity and line gaps
 *
 * This replaces the old text-gap heuristic approach which was fundamentally broken
 * for any non-trivial table layout.
 */

import type {
  TextElement,
  RectElement,
  ImageElement,
  FormField,
  PageScene,
  PageLayout,
  LayoutElement,
  DetectedTable,
  DetectedCell,
  ParagraphGroup,
  RectRole,
} from './types';

// ─── Constants ───────────────────────────────────────────────

/** Tolerance for snapping nearby edge coordinates to the same grid line */
const EDGE_CLUSTER_TOLERANCE = 2;

/** Tolerance for grouping text elements onto the same baseline */
const BASELINE_TOLERANCE = 3;

/** Paragraph gap threshold as a multiplier of average font size */
const PARA_GAP_FACTOR = 1.5;

/** Form field Y proximity tolerance for paragraph association */
const FORM_FIELD_Y_TOLERANCE = 5;

// ─── Helper Functions ────────────────────────────────────────

/**
 * Cluster nearby numeric values within the given tolerance.
 * Returns sorted unique representative values (mean of each cluster).
 */
function clusterValues(values: number[], tolerance: number): number[] {
  if (values.length === 0) return [];

  const sorted = [...values].sort((a, b) => a - b);
  const clusters: number[][] = [[sorted[0]]];

  for (let i = 1; i < sorted.length; i++) {
    const lastCluster = clusters[clusters.length - 1];
    const clusterMean = lastCluster.reduce((s, v) => s + v, 0) / lastCluster.length;

    if (Math.abs(sorted[i] - clusterMean) <= tolerance) {
      lastCluster.push(sorted[i]);
    } else {
      clusters.push([sorted[i]]);
    }
  }

  return clusters.map(c => c.reduce((s, v) => s + v, 0) / c.length).sort((a, b) => a - b);
}

/**
 * Check if two axis-aligned rectangles overlap (non-zero intersection area).
 */
function rectsOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
): boolean {
  return ax < bx + bw && ax + aw > bx && ay < by + bh && ay + ah > by;
}

/**
 * Check if two rectangles share an edge or overlap (for connected-component grouping).
 * Uses a small tolerance to handle near-touching borders.
 */
function rectsShareEdgeOrOverlap(
  ax: number, ay: number, aw: number, ah: number,
  bx: number, by: number, bw: number, bh: number,
  tolerance: number,
): boolean {
  return (
    ax - tolerance < bx + bw &&
    ax + aw + tolerance > bx &&
    ay - tolerance < by + bh &&
    ay + ah + tolerance > by
  );
}

/**
 * Find which cell in a table's grid contains the given center point.
 * Returns {row, col} or null if the point is outside all cells.
 */
function findContainingCell(
  centerX: number,
  centerY: number,
  colBounds: number[],
  rowBounds: number[],
): { row: number; col: number } | null {
  let col = -1;
  for (let c = 0; c < colBounds.length - 1; c++) {
    if (centerX >= colBounds[c] - EDGE_CLUSTER_TOLERANCE &&
        centerX <= colBounds[c + 1] + EDGE_CLUSTER_TOLERANCE) {
      col = c;
      break;
    }
  }

  let row = -1;
  for (let r = 0; r < rowBounds.length - 1; r++) {
    if (centerY >= rowBounds[r] - EDGE_CLUSTER_TOLERANCE &&
        centerY <= rowBounds[r + 1] + EDGE_CLUSTER_TOLERANCE) {
      row = r;
      break;
    }
  }

  if (row >= 0 && col >= 0) {
    return { row, col };
  }
  return null;
}

/**
 * Group border rects into connected components. Rects that share edges or overlap
 * belong to the same table group.
 */
function identifySeparateTables(borderRects: RectElement[]): RectElement[][] {
  if (borderRects.length === 0) return [];

  // Union-Find for connected components
  const parent: number[] = borderRects.map((_, i) => i);
  const rank: number[] = new Array(borderRects.length).fill(0);

  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]; // path compression
      i = parent[i];
    }
    return i;
  }

  function union(a: number, b: number): void {
    const ra = find(a);
    const rb = find(b);
    if (ra === rb) return;
    if (rank[ra] < rank[rb]) {
      parent[ra] = rb;
    } else if (rank[ra] > rank[rb]) {
      parent[rb] = ra;
    } else {
      parent[rb] = ra;
      rank[ra]++;
    }
  }

  // Merge rects that share edges or overlap
  for (let i = 0; i < borderRects.length; i++) {
    const a = borderRects[i];
    for (let j = i + 1; j < borderRects.length; j++) {
      const b = borderRects[j];
      if (rectsShareEdgeOrOverlap(
        a.x, a.y, a.width, a.height,
        b.x, b.y, b.width, b.height,
        EDGE_CLUSTER_TOLERANCE * 2,
      )) {
        union(i, j);
      }
    }
  }

  // Collect groups
  const groups = new Map<number, RectElement[]>();
  for (let i = 0; i < borderRects.length; i++) {
    const root = find(i);
    if (!groups.has(root)) {
      groups.set(root, []);
    }
    groups.get(root)!.push(borderRects[i]);
  }

  return Array.from(groups.values());
}

// ─── Rectangle Classification ────────────────────────────────

/**
 * Classify each RectElement by its visual role on the page.
 */
function classifyRectangles(scene: PageScene): Map<RectElement, RectRole> {
  const roles = new Map<RectElement, RectRole>();
  const pageArea = scene.width * scene.height;

  for (const el of scene.elements) {
    if (el.kind !== 'rect') continue;
    const rect = el as RectElement;

    // Normalize dimensions (width/height might be negative in some PDF streams)
    const w = Math.abs(rect.width);
    const h = Math.abs(rect.height);
    const rectArea = w * h;

    // Page background: covers >90% of page area
    if (rectArea > pageArea * 0.9) {
      roles.set(rect, 'page-background');
      continue;
    }

    // Separator: very thin rect spanning >50% page width
    if ((h < 2 || w < 2) && (w > scene.width * 0.5 || h > scene.height * 0.5)) {
      roles.set(rect, 'separator');
      continue;
    }

    // Table border: stroked rect (has strokeColor and lineWidth > 0) that isn't page-sized
    if (rect.strokeColor !== null && rect.lineWidth > 0) {
      roles.set(rect, 'table-border');
      continue;
    }

    // Cell fill: filled rect (has fillColor) with no stroke, not page-sized
    if (rect.fillColor !== null && rect.strokeColor === null) {
      roles.set(rect, 'cell-fill');
      continue;
    }

    // Everything else is decorative
    roles.set(rect, 'decorative');
  }

  return roles;
}

// ─── Table Detection ─────────────────────────────────────────

/**
 * Build a DetectedTable from a set of border rects that form a single table group.
 *
 * Algorithm:
 * 1. Extract all horizontal and vertical edge values from border rects
 * 2. Cluster edges to snap to grid lines
 * 3. Validate minimum grid dimensions (2 cols, 2 rows)
 * 4. Build cells from grid intersections
 * 5. Verify cells have actual border rects overlapping them
 * 6. Detect merged cells (adjacent cells with no border between them)
 */
function buildTableFromBorderGroup(
  borderRects: RectElement[],
  allTexts: TextElement[],
  allFields: FormField[],
  cellFills: RectElement[],
): DetectedTable | null {
  // Step 1: Extract edge values
  const xEdges: number[] = [];
  const yEdges: number[] = [];

  for (const rect of borderRects) {
    const x = Math.min(rect.x, rect.x + rect.width);
    const y = Math.min(rect.y, rect.y + rect.height);
    const w = Math.abs(rect.width);
    const h = Math.abs(rect.height);

    xEdges.push(x, x + w);
    yEdges.push(y, y + h);
  }

  // Step 2: Cluster to grid lines
  const colBounds = clusterValues(xEdges, EDGE_CLUSTER_TOLERANCE);
  const rowBounds = clusterValues(yEdges, EDGE_CLUSTER_TOLERANCE);

  // Step 3: Validate minimum grid
  if (colBounds.length < 3 || rowBounds.length < 3) {
    // Need at least 3 boundaries = 2 columns/rows
    return null;
  }

  const numRows = rowBounds.length - 1;
  const numCols = colBounds.length - 1;

  // Step 4: Build initial cell grid
  // Grid is [row][col], each cell knows its bounds
  const grid: (DetectedCell | null)[][] = [];
  for (let r = 0; r < numRows; r++) {
    grid[r] = [];
    for (let c = 0; c < numCols; c++) {
      const cellX = colBounds[c];
      const cellY = rowBounds[r];
      const cellW = colBounds[c + 1] - colBounds[c];
      const cellH = rowBounds[r + 1] - rowBounds[r];

      grid[r][c] = {
        row: r,
        col: c,
        rowSpan: 1,
        colSpan: 1,
        x: cellX,
        y: cellY,
        width: cellW,
        height: cellH,
        fillColor: null,
        texts: [],
        formFields: [],
      };
    }
  }

  // Step 5: Verify each cell has at least one border rect overlapping it.
  // Count how many cells are verified — if too few, this isn't a real table.
  let verifiedCells = 0;
  const totalCells = numRows * numCols;

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cell = grid[r][c]!;
      let hasOverlap = false;

      for (const rect of borderRects) {
        const rx = Math.min(rect.x, rect.x + rect.width);
        const ry = Math.min(rect.y, rect.y + rect.height);
        const rw = Math.abs(rect.width);
        const rh = Math.abs(rect.height);

        if (rectsOverlap(
          cell.x - EDGE_CLUSTER_TOLERANCE,
          cell.y - EDGE_CLUSTER_TOLERANCE,
          cell.width + EDGE_CLUSTER_TOLERANCE * 2,
          cell.height + EDGE_CLUSTER_TOLERANCE * 2,
          rx, ry, rw, rh,
        )) {
          hasOverlap = true;
          break;
        }
      }

      if (hasOverlap) {
        verifiedCells++;
      }
    }
  }

  // If fewer than half the cells are backed by border rects, reject
  if (verifiedCells < totalCells * 0.5) {
    return null;
  }

  // Step 6: Detect merged cells.
  // Two adjacent cells are merged if there's no border rect edge between them.
  // We check for the existence of a border segment along shared edges.

  // Build a set of horizontal border segments and vertical border segments
  // from the actual border rects for precise edge detection.
  const hasBorderBetween = (
    x1: number, y1: number, x2: number, y2: number,
    isHorizontal: boolean,
  ): boolean => {
    // Check if any border rect has an edge segment along (x1,y1)-(x2,y2)
    for (const rect of borderRects) {
      const rx = Math.min(rect.x, rect.x + rect.width);
      const ry = Math.min(rect.y, rect.y + rect.height);
      const rw = Math.abs(rect.width);
      const rh = Math.abs(rect.height);

      if (isHorizontal) {
        // Horizontal edge: check if border rect has a horizontal edge at y1 spanning x1..x2
        const topEdge = ry;
        const bottomEdge = ry + rh;
        const rLeft = rx;
        const rRight = rx + rw;

        // Check top edge
        if (Math.abs(topEdge - y1) <= EDGE_CLUSTER_TOLERANCE) {
          if (rLeft <= x1 + EDGE_CLUSTER_TOLERANCE && rRight >= x2 - EDGE_CLUSTER_TOLERANCE) {
            return true;
          }
        }
        // Check bottom edge
        if (Math.abs(bottomEdge - y1) <= EDGE_CLUSTER_TOLERANCE) {
          if (rLeft <= x1 + EDGE_CLUSTER_TOLERANCE && rRight >= x2 - EDGE_CLUSTER_TOLERANCE) {
            return true;
          }
        }
      } else {
        // Vertical edge: check if border rect has a vertical edge at x1 spanning y1..y2
        const leftEdge = rx;
        const rightEdge = rx + rw;
        const rTop = ry;
        const rBottom = ry + rh;

        // Check left edge
        if (Math.abs(leftEdge - x1) <= EDGE_CLUSTER_TOLERANCE) {
          if (rTop <= y1 + EDGE_CLUSTER_TOLERANCE && rBottom >= y2 - EDGE_CLUSTER_TOLERANCE) {
            return true;
          }
        }
        // Check right edge
        if (Math.abs(rightEdge - x1) <= EDGE_CLUSTER_TOLERANCE) {
          if (rTop <= y1 + EDGE_CLUSTER_TOLERANCE && rBottom >= y2 - EDGE_CLUSTER_TOLERANCE) {
            return true;
          }
        }
      }
    }
    return false;
  };

  // Track which cells have been consumed by merges (set to null in grid)
  const merged = new Set<string>(); // "row,col" keys of cells consumed

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      if (merged.has(`${r},${c}`)) continue;
      const cell = grid[r][c];
      if (!cell) continue;

      // Try to extend colSpan
      let colSpan = 1;
      while (c + colSpan < numCols) {
        const borderX = colBounds[c + colSpan];
        const segY1 = rowBounds[r];
        const segY2 = rowBounds[r + 1];
        if (hasBorderBetween(borderX, segY1, borderX, segY2, false)) {
          break;
        }
        colSpan++;
      }

      // Try to extend rowSpan
      let rowSpan = 1;
      while (r + rowSpan < numRows) {
        // Check all columns in the current colSpan range
        let allMissing = true;
        for (let cc = c; cc < c + colSpan; cc++) {
          const borderY = rowBounds[r + rowSpan];
          const segX1 = colBounds[cc];
          const segX2 = colBounds[cc + 1];
          if (hasBorderBetween(segX1, borderY, segX2, borderY, true)) {
            allMissing = false;
            break;
          }
        }
        if (!allMissing) break;
        rowSpan++;
      }

      // Apply merge
      cell.colSpan = colSpan;
      cell.rowSpan = rowSpan;
      cell.width = colBounds[c + colSpan] - colBounds[c];
      cell.height = rowBounds[r + rowSpan] - rowBounds[r];

      // Mark consumed cells
      for (let rr = r; rr < r + rowSpan; rr++) {
        for (let cc = c; cc < c + colSpan; cc++) {
          if (rr === r && cc === c) continue; // skip the origin cell
          merged.add(`${rr},${cc}`);
          grid[rr][cc] = null;
        }
      }
    }
  }

  // Collect surviving cells
  const cells: DetectedCell[] = [];
  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols; c++) {
      const cell = grid[r][c];
      if (cell && !merged.has(`${r},${c}`)) {
        cells.push(cell);
      }
    }
  }

  if (cells.length === 0) return null;

  // Step 7: Apply cell fills from 'cell-fill' rects by overlap matching
  for (const fill of cellFills) {
    const fx = Math.min(fill.x, fill.x + fill.width);
    const fy = Math.min(fill.y, fill.y + fill.height);
    const fw = Math.abs(fill.width);
    const fh = Math.abs(fill.height);
    const fillCenterX = fx + fw / 2;
    const fillCenterY = fy + fh / 2;

    const loc = findContainingCell(fillCenterX, fillCenterY, colBounds, rowBounds);
    if (loc) {
      // Find the cell at this location (accounting for merges)
      const targetCell = cells.find(cell =>
        loc.row >= cell.row && loc.row < cell.row + cell.rowSpan &&
        loc.col >= cell.col && loc.col < cell.col + cell.colSpan
      );
      if (targetCell && fill.fillColor) {
        targetCell.fillColor = fill.fillColor;
      }
    }
  }

  // Step 8: Assign text elements to cells by center-point containment
  for (const text of allTexts) {
    const centerX = text.x + text.width / 2;
    const centerY = text.y + text.height / 2;

    const loc = findContainingCell(centerX, centerY, colBounds, rowBounds);
    if (loc) {
      const targetCell = cells.find(cell =>
        loc.row >= cell.row && loc.row < cell.row + cell.rowSpan &&
        loc.col >= cell.col && loc.col < cell.col + cell.colSpan
      );
      if (targetCell) {
        targetCell.texts.push(text);
      }
    }
  }

  // Step 9: Assign form fields to cells by center-point containment
  for (const field of allFields) {
    const centerX = field.x + field.width / 2;
    const centerY = field.y + field.height / 2;

    const loc = findContainingCell(centerX, centerY, colBounds, rowBounds);
    if (loc) {
      const targetCell = cells.find(cell =>
        loc.row >= cell.row && loc.row < cell.row + cell.rowSpan &&
        loc.col >= cell.col && loc.col < cell.col + cell.colSpan
      );
      if (targetCell) {
        targetCell.formFields.push(field);
      }
    }
  }

  // Compute table bounding box
  const tableX = colBounds[0];
  const tableY = rowBounds[0];
  const tableW = colBounds[colBounds.length - 1] - colBounds[0];
  const tableH = rowBounds[rowBounds.length - 1] - rowBounds[0];

  // Column widths and row heights
  const columnWidths: number[] = [];
  for (let c = 0; c < numCols; c++) {
    columnWidths.push(colBounds[c + 1] - colBounds[c]);
  }
  const rowHeights: number[] = [];
  for (let r = 0; r < numRows; r++) {
    rowHeights.push(rowBounds[r + 1] - rowBounds[r]);
  }

  return {
    cells,
    rows: numRows,
    cols: numCols,
    columnWidths,
    rowHeights,
    x: tableX,
    y: tableY,
    width: tableW,
    height: tableH,
  };
}

/**
 * Detect all tables on the page using vector-based border analysis.
 */
function detectTables(
  scene: PageScene,
  rectRoles: Map<RectElement, RectRole>,
): DetectedTable[] {
  // Collect border rects and cell-fill rects
  const borderRects: RectElement[] = [];
  const cellFills: RectElement[] = [];

  for (const [rect, role] of rectRoles) {
    if (role === 'table-border') {
      borderRects.push(rect);
    } else if (role === 'cell-fill') {
      cellFills.push(rect);
    }
  }

  if (borderRects.length === 0) return [];

  // Separate border rects into connected groups (each group = one table)
  const groups = identifySeparateTables(borderRects);

  // Collect all text and form field elements for assignment
  const allTexts = scene.elements.filter((e): e is TextElement => e.kind === 'text');
  const allFields = scene.formFields;

  const tables: DetectedTable[] = [];

  for (const group of groups) {
    const table = buildTableFromBorderGroup(group, allTexts, allFields, cellFills);
    if (table) {
      tables.push(table);
    }
  }

  return tables;
}

// ─── Paragraph Grouping ──────────────────────────────────────

/**
 * Group unstructured text elements and form fields into paragraph groups.
 *
 * Algorithm:
 * 1. Sort text elements by Y then X
 * 2. Group texts with Y values within baseline tolerance into lines
 * 3. Group consecutive lines into paragraphs when gap exceeds threshold
 * 4. Associate form fields with paragraphs by Y proximity
 */
function groupIntoParagraphs(
  texts: TextElement[],
  formFields: FormField[],
): ParagraphGroup[] {
  if (texts.length === 0 && formFields.length === 0) return [];

  if (texts.length === 0) {
    // Only form fields, no text — group each field as its own paragraph
    const fieldGroups: ParagraphGroup[] = [];
    const sortedFields = [...formFields].sort((a, b) => {
      const yDiff = a.y - b.y;
      if (Math.abs(yDiff) > BASELINE_TOLERANCE) return yDiff;
      return a.x - b.x;
    });

    for (const field of sortedFields) {
      fieldGroups.push({
        texts: [],
        formFields: [field],
        y: field.y,
        x: field.x,
      });
    }
    return fieldGroups;
  }

  // Sort texts by Y, then X
  const sorted = [...texts].sort((a, b) => {
    const yDiff = a.y - b.y;
    if (Math.abs(yDiff) > BASELINE_TOLERANCE) return yDiff;
    return a.x - b.x;
  });

  // Step 1: Group into lines by baseline proximity
  interface TextLine {
    texts: TextElement[];
    y: number;
    avgFontSize: number;
    minX: number;
  }

  const lines: TextLine[] = [];
  let currentLineTexts: TextElement[] = [sorted[0]];
  let currentLineY = sorted[0].y;

  for (let i = 1; i < sorted.length; i++) {
    const text = sorted[i];
    if (Math.abs(text.y - currentLineY) <= BASELINE_TOLERANCE) {
      currentLineTexts.push(text);
    } else {
      // Finalize current line
      const avgFS = currentLineTexts.reduce((s, t) => s + t.fontSize, 0) / currentLineTexts.length;
      const minX = Math.min(...currentLineTexts.map(t => t.x));
      lines.push({ texts: currentLineTexts, y: currentLineY, avgFontSize: avgFS, minX });

      currentLineTexts = [text];
      currentLineY = text.y;
    }
  }
  // Finalize last line
  if (currentLineTexts.length > 0) {
    const avgFS = currentLineTexts.reduce((s, t) => s + t.fontSize, 0) / currentLineTexts.length;
    const minX = Math.min(...currentLineTexts.map(t => t.x));
    lines.push({ texts: currentLineTexts, y: currentLineY, avgFontSize: avgFS, minX });
  }

  // Sort lines within each by X (already mostly sorted but ensure)
  for (const line of lines) {
    line.texts.sort((a, b) => a.x - b.x);
  }

  // Step 2: Group lines into paragraphs by gap analysis
  const paragraphs: ParagraphGroup[] = [];
  let paraLines: TextLine[] = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prevLine = lines[i - 1];
    const currLine = lines[i];

    // Compute gap between bottom of previous line and top of current line
    const prevLineBottom = prevLine.y + prevLine.avgFontSize * 1.2; // approximate line height
    const gap = currLine.y - prevLineBottom;
    const avgFontSize = (prevLine.avgFontSize + currLine.avgFontSize) / 2;

    if (gap > avgFontSize * PARA_GAP_FACTOR) {
      // Large gap — start new paragraph
      paragraphs.push(finalizeParagraphGroup(paraLines));
      paraLines = [currLine];
    } else {
      paraLines.push(currLine);
    }
  }
  if (paraLines.length > 0) {
    paragraphs.push(finalizeParagraphGroup(paraLines));
  }

  // Step 3: Associate form fields with paragraphs by Y proximity
  const consumedFieldIndices = new Set<number>();

  for (const para of paragraphs) {
    for (let fi = 0; fi < formFields.length; fi++) {
      if (consumedFieldIndices.has(fi)) continue;
      const field = formFields[fi];

      // Check if the field's baseline is within tolerance of the paragraph's Y range
      const paraYMin = para.y;
      // Compute paragraph Y extent from the texts
      let paraYMax = para.y;
      for (const text of para.texts) {
        const textBottom = text.y + text.height;
        if (textBottom > paraYMax) paraYMax = textBottom;
      }

      const fieldCenterY = field.y + field.height / 2;

      if (fieldCenterY >= paraYMin - FORM_FIELD_Y_TOLERANCE &&
          fieldCenterY <= paraYMax + FORM_FIELD_Y_TOLERANCE) {
        para.formFields.push(field);
        consumedFieldIndices.add(fi);
      }
    }
  }

  // Any remaining orphan form fields get their own paragraph groups
  for (let fi = 0; fi < formFields.length; fi++) {
    if (!consumedFieldIndices.has(fi)) {
      const field = formFields[fi];
      paragraphs.push({
        texts: [],
        formFields: [field],
        y: field.y,
        x: field.x,
      });
    }
  }

  // Sort all paragraphs by Y
  paragraphs.sort((a, b) => a.y - b.y);

  return paragraphs;
}

/**
 * Build a ParagraphGroup from a contiguous run of text lines.
 */
function finalizeParagraphGroup(
  lines: Array<{ texts: TextElement[]; y: number; avgFontSize: number; minX: number }>,
): ParagraphGroup {
  const allTexts: TextElement[] = [];
  for (const line of lines) {
    allTexts.push(...line.texts);
  }

  return {
    texts: allTexts,
    formFields: [],
    y: lines[0].y,
    x: Math.min(...lines.map(l => l.minX)),
  };
}

// ─── Main Entry Point ────────────────────────────────────────

/**
 * Analyze a PageScene and produce a structured PageLayout.
 *
 * Pipeline:
 * 1. Classify rectangles by visual role
 * 2. Detect tables from border rects (vector-based grid detection)
 * 3. Collect consumed text/field sets from table cells
 * 4. Collect genuine images
 * 5. Group remaining (non-table) texts and fields into paragraphs
 * 6. Combine all layout elements sorted by Y position (reading order)
 */
// ─── Test Exports ─────────────────────────────────────────────────
// These are exported for unit testing only. Do not use in production code.
export const _testExports = {
  clusterValues,
  findContainingCell,
  classifyRectangles,
  detectTables,
  rectsOverlap,
  groupIntoParagraphs,
  EDGE_CLUSTER_TOLERANCE,
};

export function buildPageLayout(scene: PageScene): PageLayout {
  // Step 1: Classify all rectangles
  const rectRoles = classifyRectangles(scene);

  // Step 2: Detect tables
  const tables = detectTables(scene, rectRoles);

  // Step 3: Determine which texts and form fields are consumed by table cells
  const consumedTexts = new Set<TextElement>();
  const consumedFields = new Set<FormField>();

  for (const table of tables) {
    for (const cell of table.cells) {
      for (const t of cell.texts) {
        consumedTexts.add(t);
      }
      for (const f of cell.formFields) {
        consumedFields.add(f);
      }
    }
  }

  // Step 4: Collect genuine images
  const genuineImages: ImageElement[] = [];
  for (const el of scene.elements) {
    if (el.kind === 'image' && (el as ImageElement).isGenuine) {
      genuineImages.push(el as ImageElement);
    }
  }

  // Step 5: Gather remaining (non-table) texts and form fields
  const freeTexts: TextElement[] = [];
  for (const el of scene.elements) {
    if (el.kind === 'text' && !consumedTexts.has(el as TextElement)) {
      freeTexts.push(el as TextElement);
    }
  }

  const freeFields: FormField[] = [];
  for (const field of scene.formFields) {
    if (!consumedFields.has(field)) {
      freeFields.push(field);
    }
  }

  // Group free text and fields into paragraphs
  const paragraphs = groupIntoParagraphs(freeTexts, freeFields);

  // Step 6: Combine all layout elements and sort by Y position
  const layoutElements: LayoutElement[] = [];

  for (const table of tables) {
    layoutElements.push({ type: 'table', element: table });
  }

  for (const para of paragraphs) {
    layoutElements.push({ type: 'paragraph', element: para });
  }

  for (const img of genuineImages) {
    layoutElements.push({ type: 'image', element: img });
  }

  // Sort by Y position for reading order
  layoutElements.sort((a, b) => {
    const yA = getElementY(a);
    const yB = getElementY(b);
    return yA - yB;
  });

  return {
    elements: layoutElements,
    width: scene.width,
    height: scene.height,
  };
}

/**
 * Extract the Y position of a layout element for reading-order sorting.
 */
function getElementY(el: LayoutElement): number {
  switch (el.type) {
    case 'table':
      return el.element.y;
    case 'paragraph':
      return el.element.y;
    case 'image':
      return el.element.y;
  }
}
