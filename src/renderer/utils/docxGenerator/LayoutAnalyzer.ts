/**
 * Layout Analyzer — Structural Analysis Engine
 *
 * Converts a PageScene (flat list of PDF content-stream elements) into a PageLayout
 * (structured sequence of tables, paragraphs, and images in reading order).
 *
 * Two table detection strategies:
 *   1. VECTOR-BASED: Stroked rectangles form grid borders → table structure
 *   2. FORM-FIELD SPATIAL: When no vector rects exist (form fields in annotation streams),
 *      detect tables from the spatial arrangement of text input fields.
 *
 * Remaining text grouped into paragraphs by baseline proximity and line gaps.
 * Section headers (larger font size) trigger paragraph breaks.
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

  // Step 2: Group lines into paragraphs by gap analysis AND font size changes
  const paragraphs: ParagraphGroup[] = [];
  let paraLines: TextLine[] = [lines[0]];

  for (let i = 1; i < lines.length; i++) {
    const prevLine = lines[i - 1];
    const currLine = lines[i];

    // Compute gap between bottom of previous line and top of current line
    const prevLineBottom = prevLine.y + prevLine.avgFontSize * 1.2; // approximate line height
    const gap = currLine.y - prevLineBottom;
    const avgFontSize = (prevLine.avgFontSize + currLine.avgFontSize) / 2;

    // Break on large gap
    const largeGap = gap > avgFontSize * PARA_GAP_FACTOR;

    // Break on significant font size change (section headers at different size)
    const fontSizeRatio = Math.max(prevLine.avgFontSize, currLine.avgFontSize) /
                          Math.min(prevLine.avgFontSize, currLine.avgFontSize);
    const fontSizeChanged = fontSizeRatio > 1.15; // >15% size difference

    if (largeGap || fontSizeChanged) {
      // Start new paragraph
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

// ─── Form Field Spatial Table Detection ──────────────────────

/** Tolerance for grouping form fields into the same Y row */
const FIELD_ROW_TOLERANCE = 8;

/** Tolerance for X-alignment of columns across rows */
const FIELD_COL_TOLERANCE = 15;

/** Tolerance for associating text labels with form field rows */
const LABEL_Y_TOLERANCE = 10;

/**
 * A row of spatially-aligned form fields.
 */
interface FieldRow {
  centerY: number;
  fields: FormField[];
}

/**
 * Cluster form fields by Y position into rows.
 * Fields within FIELD_ROW_TOLERANCE of each other's center Y are grouped together.
 */
function clusterFieldsByY(fields: FormField[]): FieldRow[] {
  if (fields.length === 0) return [];

  const sorted = [...fields].sort((a, b) => a.y - b.y);
  const rows: FieldRow[] = [];

  for (const field of sorted) {
    const centerY = field.y + field.height / 2;
    let assigned = false;

    for (const row of rows) {
      if (Math.abs(centerY - row.centerY) <= FIELD_ROW_TOLERANCE) {
        row.fields.push(field);
        // Update center to running mean
        row.centerY = row.fields.reduce((s, f) => s + f.y + f.height / 2, 0) / row.fields.length;
        assigned = true;
        break;
      }
    }

    if (!assigned) {
      rows.push({ centerY, fields: [field] });
    }
  }

  // Sort fields within each row by X
  for (const row of rows) {
    row.fields.sort((a, b) => a.x - b.x);
  }

  return rows.sort((a, b) => a.centerY - b.centerY);
}

/**
 * Check if two field rows have matching X-alignment (same column structure).
 * Columns match when the X-start positions are within FIELD_COL_TOLERANCE.
 */
function rowsAlignX(rowA: FieldRow, rowB: FieldRow): boolean {
  if (rowA.fields.length !== rowB.fields.length) return false;

  for (let c = 0; c < rowA.fields.length; c++) {
    if (Math.abs(rowA.fields[c].x - rowB.fields[c].x) > FIELD_COL_TOLERANCE) {
      return false;
    }
  }
  return true;
}

/**
 * Find text elements that form a header row above a field table.
 * Returns texts matching the column positions of the first field row.
 *
 * Excludes section headers — texts that span multiple columns or have a
 * significantly larger font size than the column header candidates.
 */
function findTableHeaderTexts(
  firstRow: FieldRow,
  allTexts: TextElement[],
): TextElement[] {
  const tableTopY = firstRow.fields[0].y;

  // Look for text items just above the table (within ~30pt above)
  const candidates = allTexts.filter(t => {
    const textBottom = t.y + t.height;
    const gap = tableTopY - textBottom;
    return gap >= -2 && gap <= 30;
  });

  if (candidates.length === 0) return [];

  // Compute average single-column width for filtering
  const avgColWidth = firstRow.fields.reduce((s, f) => s + f.width, 0) / firstRow.fields.length;

  // Check if candidate texts align with the table columns
  const matched: TextElement[] = [];

  for (const text of candidates) {
    // Exclude texts that span wider than 1.5x a single column (section headers)
    if (text.width > avgColWidth * 1.5) continue;

    const textCenterX = text.x + text.width / 2;

    // Check if text center falls within any column's X range
    for (const field of firstRow.fields) {
      const colLeft = field.x - FIELD_COL_TOLERANCE;
      const colRight = field.x + field.width + FIELD_COL_TOLERANCE;

      if (textCenterX >= colLeft && textCenterX <= colRight) {
        matched.push(text);
        break;
      }
    }
  }

  // Exclude candidates with significantly different font sizes (section headers)
  if (matched.length >= 2) {
    const fontSizes = matched.map(t => t.fontSize);
    const medianFontSize = fontSizes.sort((a, b) => a - b)[Math.floor(fontSizes.length / 2)];

    const filtered = matched.filter(t =>
      Math.abs(t.fontSize - medianFontSize) / medianFontSize < 0.2 // within 20%
    );

    if (filtered.length >= 2) {
      return filtered;
    }
  }

  // Only return if we found headers matching the column structure
  if (matched.length >= 2) {
    return matched;
  }
  return [];
}

/**
 * Build a DetectedTable from spatially-aligned form field rows.
 *
 * Creates a table grid where:
 * - Each field row becomes a table row
 * - Columns are derived from the X positions of the fields
 * - Optionally includes a text header row above the fields
 * - Text labels near cells are assigned by coordinate proximity
 */
function buildTableFromFieldRows(
  fieldRows: FieldRow[],
  allTexts: TextElement[],
  headerTexts: TextElement[],
  nCols: number,
): DetectedTable | null {
  if (fieldRows.length === 0 || nCols < 2) return null;

  // Compute column boundaries from the first row's field positions
  // Each column spans from field.x to field.x + field.width
  const colStarts: number[] = [];
  const colEnds: number[] = [];

  for (let c = 0; c < nCols; c++) {
    // Average X-start and width across all rows for this column
    let sumX = 0;
    let sumRight = 0;
    let count = 0;

    for (const row of fieldRows) {
      if (c < row.fields.length) {
        sumX += row.fields[c].x;
        sumRight += row.fields[c].x + row.fields[c].width;
        count++;
      }
    }

    colStarts.push(count > 0 ? sumX / count : 0);
    colEnds.push(count > 0 ? sumRight / count : 0);
  }

  // Column boundaries: use midpoints between consecutive field starts.
  // Extend left/right edges to capture text labels that are outside the field boxes.
  const colBounds: number[] = [];

  // Find nearby texts in the table's Y range for better left boundary
  const tableMinY = fieldRows[0].fields[0].y - 5;
  const tableMaxY = fieldRows[fieldRows.length - 1].fields[0].y +
                    fieldRows[fieldRows.length - 1].fields[0].height + 5;
  const nearbyTexts = allTexts.filter(t => {
    const ty = t.y + t.height / 2;
    return ty >= tableMinY && ty <= tableMaxY;
  });

  // Left boundary: minimum of first column field start, header texts, and nearby labels
  const leftCandidates = [colStarts[0]];
  if (headerTexts.length > 0) leftCandidates.push(...headerTexts.map(t => t.x));
  for (const t of nearbyTexts) {
    if (t.x < colStarts[0]) leftCandidates.push(t.x);
  }
  colBounds.push(Math.min(...leftCandidates) - 2);

  for (let c = 0; c < nCols - 1; c++) {
    // Boundary between column c and c+1: midpoint between end of c and start of c+1
    colBounds.push((colEnds[c] + colStarts[c + 1]) / 2);
  }
  colBounds.push(colEnds[nCols - 1] + 2);

  // Row boundaries
  const rowBounds: number[] = [];
  const hasHeader = headerTexts.length > 0;

  if (hasHeader) {
    // Header row starts above the header texts
    const headerTopY = Math.min(...headerTexts.map(t => t.y)) - 2;
    rowBounds.push(headerTopY);

    // Boundary between header and first field row
    const headerBottomY = Math.max(...headerTexts.map(t => t.y + t.height));
    const firstFieldTopY = fieldRows[0].fields[0].y;
    rowBounds.push((headerBottomY + firstFieldTopY) / 2);
  } else {
    rowBounds.push(fieldRows[0].fields[0].y - 2);
  }

  // Field row boundaries
  for (let r = 0; r < fieldRows.length - 1; r++) {
    const thisBottom = Math.max(...fieldRows[r].fields.map(f => f.y + f.height));
    const nextTop = Math.min(...fieldRows[r + 1].fields.map(f => f.y));
    rowBounds.push((thisBottom + nextTop) / 2);
  }

  // Last row bottom
  const lastFields = fieldRows[fieldRows.length - 1].fields;
  rowBounds.push(Math.max(...lastFields.map(f => f.y + f.height)) + 2);

  const numRows = rowBounds.length - 1;
  const numCols2 = colBounds.length - 1;

  // Build cells
  const cells: DetectedCell[] = [];

  for (let r = 0; r < numRows; r++) {
    for (let c = 0; c < numCols2; c++) {
      const cellX = colBounds[c];
      const cellY = rowBounds[r];
      const cellW = colBounds[c + 1] - colBounds[c];
      const cellH = rowBounds[r + 1] - rowBounds[r];

      cells.push({
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
      });
    }
  }

  // Assign header texts to header row cells
  if (hasHeader) {
    for (const text of headerTexts) {
      const textCenterX = text.x + text.width / 2;
      for (const cell of cells) {
        if (cell.row !== 0) continue;
        if (textCenterX >= cell.x - FIELD_COL_TOLERANCE &&
            textCenterX <= cell.x + cell.width + FIELD_COL_TOLERANCE) {
          cell.texts.push(text);
          break;
        }
      }
    }
  }

  // Assign form fields to cells
  for (let ri = 0; ri < fieldRows.length; ri++) {
    const tableRow = hasHeader ? ri + 1 : ri;
    for (const field of fieldRows[ri].fields) {
      const fieldCenterX = field.x + field.width / 2;
      for (const cell of cells) {
        if (cell.row !== tableRow) continue;
        if (fieldCenterX >= cell.x - FIELD_COL_TOLERANCE &&
            fieldCenterX <= cell.x + cell.width + FIELD_COL_TOLERANCE) {
          cell.formFields.push(field);
          break;
        }
      }
    }
  }

  // Assign nearby text labels to data cells (labels just left of or above the field)
  // Determine typical body font size to exclude section headers
  const bodyFontSizes = allTexts.filter(t => !headerTexts.includes(t)).map(t => t.fontSize);
  const typicalBodyFontSize = bodyFontSizes.length > 0
    ? bodyFontSizes.sort((a, b) => a - b)[Math.floor(bodyFontSizes.length / 2)]
    : 12;

  for (const text of allTexts) {
    if (headerTexts.includes(text)) continue;

    // Skip section headers (font size >20% larger than typical body text)
    if (text.fontSize > typicalBodyFontSize * 1.2) continue;

    const textCenterX = text.x + text.width / 2;
    const textCenterY = text.y + text.height / 2;

    for (const cell of cells) {
      // Check if text is within the cell's vertical band
      if (textCenterY >= cell.y - LABEL_Y_TOLERANCE &&
          textCenterY <= cell.y + cell.height + LABEL_Y_TOLERANCE) {
        // Check if text is within or just left of the cell's horizontal band
        if (textCenterX >= cell.x - FIELD_COL_TOLERANCE &&
            textCenterX <= cell.x + cell.width + FIELD_COL_TOLERANCE) {
          cell.texts.push(text);
          break;
        }
      }
    }
  }

  // Column widths and row heights
  const columnWidths = colBounds.slice(1).map((b, i) => b - colBounds[i]);
  const rowHeights = rowBounds.slice(1).map((b, i) => b - rowBounds[i]);

  return {
    cells,
    rows: numRows,
    cols: numCols2,
    columnWidths,
    rowHeights,
    x: colBounds[0],
    y: rowBounds[0],
    width: colBounds[numCols2] - colBounds[0],
    height: rowBounds[numRows] - rowBounds[0],
  };
}

/**
 * Detect tables from form field spatial arrangement.
 *
 * Activates when the scene has form fields. Clusters text input (Tx) fields
 * by Y position into rows, then finds consecutive rows with matching column
 * count and X-alignment — these form tables.
 *
 * Also looks for text header rows immediately above field tables (e.g.,
 * "Model | Serial Number | Problem Observed" above a grid of input fields).
 */
function detectFormFieldTables(
  scene: PageScene,
  allTexts: TextElement[],
): DetectedTable[] {
  // Get text input fields (the rectangular input boxes)
  const txFields = scene.formFields.filter(f => f.fieldType === 'Tx');
  if (txFields.length < 4) return []; // Need at least 4 fields (2x2 minimum)

  const rows = clusterFieldsByY(txFields);
  const tables: DetectedTable[] = [];

  let runStart = 0;

  while (runStart < rows.length) {
    // Skip rows with fewer than 2 fields (not tabular)
    if (rows[runStart].fields.length < 2) {
      runStart++;
      continue;
    }

    // Find consecutive rows with same column count and aligned X positions
    const nCols = rows[runStart].fields.length;
    let runEnd = runStart + 1;

    while (runEnd < rows.length) {
      if (rows[runEnd].fields.length !== nCols) break;
      if (!rowsAlignX(rows[runStart], rows[runEnd])) break;
      runEnd++;
    }

    // Need at least 2 rows to form a meaningful table
    // (1 header + 1 data, or 2+ data rows)
    if (runEnd - runStart >= 2) {
      const headerTexts = findTableHeaderTexts(rows[runStart], allTexts);
      const table = buildTableFromFieldRows(
        rows.slice(runStart, runEnd),
        allTexts,
        headerTexts,
        nCols,
      );
      if (table) tables.push(table);
    } else if (runEnd - runStart === 1) {
      // Single row with 2+ fields: check if there's a text header above
      const headerTexts = findTableHeaderTexts(rows[runStart], allTexts);
      if (headerTexts.length >= 2) {
        const table = buildTableFromFieldRows(
          rows.slice(runStart, runEnd),
          allTexts,
          headerTexts,
          nCols,
        );
        if (table) tables.push(table);
      }
    }

    runStart = runEnd;
  }

  // Also detect two-column paired layouts:
  // Rows with exactly 2 Tx fields where both halves repeat across rows
  // (e.g., "Service Contact" left + "Bill to" right)
  const twoFieldRows = rows.filter(r => r.fields.length === 2);
  if (twoFieldRows.length >= 2) {
    // Check if these rows are already consumed by tables above
    const consumedFields = new Set<FormField>();
    for (const table of tables) {
      for (const cell of table.cells) {
        for (const f of cell.formFields) consumedFields.add(f);
      }
    }

    const unconsumedTwoFieldRows = twoFieldRows.filter(r =>
      r.fields.every(f => !consumedFields.has(f))
    );

    // Find consecutive aligned 2-field rows
    let i = 0;
    while (i < unconsumedTwoFieldRows.length) {
      let j = i + 1;
      while (j < unconsumedTwoFieldRows.length &&
             rowsAlignX(unconsumedTwoFieldRows[i], unconsumedTwoFieldRows[j])) {
        j++;
      }

      if (j - i >= 2) {
        // Build a 2-column table from these rows
        // Include text labels in the cells for proper rendering
        const fieldRowSlice = unconsumedTwoFieldRows.slice(i, j);
        const table = buildTableFromFieldRows(fieldRowSlice, allTexts, [], 2);
        if (table) tables.push(table);
      }

      i = j;
    }
  }

  return tables;
}

// ─── Main Entry Point ────────────────────────────────────────

/**
 * Analyze a PageScene and produce a structured PageLayout.
 *
 * Pipeline:
 * 1. Classify rectangles by visual role
 * 2. Detect tables from border rects (vector-based grid detection)
 * 2b. If no vector tables found, detect tables from form field spatial arrangement
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
  detectFormFieldTables,
  rectsOverlap,
  groupIntoParagraphs,
  EDGE_CLUSTER_TOLERANCE,
};

export function buildPageLayout(scene: PageScene): PageLayout {
  // Step 1: Classify all rectangles
  const rectRoles = classifyRectangles(scene);

  // Step 2: Detect tables from vector borders
  const tables = detectTables(scene, rectRoles);

  // Step 2b: If no vector tables found, try form field spatial detection
  const allTexts = scene.elements.filter((e): e is TextElement => e.kind === 'text');

  if (tables.length === 0 && scene.formFields.length >= 4) {
    const formTables = detectFormFieldTables(scene, allTexts);
    tables.push(...formTables);
  }

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
