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
  PathElement,
  ImageElement,
  FormField,
  PageScene,
  PageLayout,
  LayoutElement,
  TwoColumnRegion,
  DetectedTable,
  DetectedCell,
  ParagraphGroup,
  RectRole,
  RGB,
} from './types';
import { groupNearbyPaths, rasterizePathGroup } from './PathRasterizer';

// ─── Constants ───────────────────────────────────────────────

/** Tolerance for snapping nearby edge coordinates to the same grid line */
const EDGE_CLUSTER_TOLERANCE = 2;

/** Tolerance for grouping text elements onto the same baseline */
const BASELINE_TOLERANCE = 3;

/** Paragraph gap threshold as a multiplier of average font size */
const PARA_GAP_FACTOR = 1.5;

/**
 * Tolerance for connecting border rects into table groups.
 * Many PDF forms use consistent spacing (~7pt) between adjacent field boxes.
 * This tolerance bridges those gaps so the rects form connected table groups.
 */
const TABLE_GROUP_TOLERANCE = 8;

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

  // Merge rects that share edges or overlap.
  // Uses TABLE_GROUP_TOLERANCE to bridge consistent spacing between adjacent
  // form field boxes (typically ~7pt in many PDF forms).
  for (let i = 0; i < borderRects.length; i++) {
    const a = borderRects[i];
    for (let j = i + 1; j < borderRects.length; j++) {
      const b = borderRects[j];
      if (rectsShareEdgeOrOverlap(
        a.x, a.y, a.width, a.height,
        b.x, b.y, b.width, b.height,
        TABLE_GROUP_TOLERANCE,
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
  const rawColBounds = clusterValues(xEdges, EDGE_CLUSTER_TOLERANCE);
  const rawRowBounds = clusterValues(yEdges, EDGE_CLUSTER_TOLERANCE);

  // Step 2b: Collapse tiny gap rows and columns.
  // PDF forms often have visual spacing (~7pt) between adjacent field boxes,
  // creating alternating data/gap patterns. Remove bounds that are too close
  // to the previous bound, merging gaps into the preceding data cell.
  const MIN_CELL_SIZE = 10;

  const colBounds: number[] = [rawColBounds[0]];
  for (let i = 1; i < rawColBounds.length; i++) {
    const gap = rawColBounds[i] - colBounds[colBounds.length - 1];
    if (gap < MIN_CELL_SIZE && i < rawColBounds.length - 1) {
      continue;
    }
    colBounds.push(rawColBounds[i]);
  }

  const rowBounds: number[] = [rawRowBounds[0]];
  for (let i = 1; i < rawRowBounds.length; i++) {
    const gap = rawRowBounds[i] - rowBounds[rowBounds.length - 1];
    if (gap < MIN_CELL_SIZE && i < rawRowBounds.length - 1) {
      continue;
    }
    rowBounds.push(rawRowBounds[i]);
  }

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
  // After gap collapse, border rects may be offset from cell boundaries by
  // up to MIN_CELL_SIZE, so use a larger tolerance for span checks.
  const spanTolerance = MIN_CELL_SIZE + EDGE_CLUSTER_TOLERANCE;
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
        if (Math.abs(topEdge - y1) <= spanTolerance) {
          if (rLeft <= x1 + spanTolerance && rRight >= x2 - spanTolerance) {
            return true;
          }
        }
        // Check bottom edge
        if (Math.abs(bottomEdge - y1) <= spanTolerance) {
          if (rLeft <= x1 + spanTolerance && rRight >= x2 - spanTolerance) {
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
        if (Math.abs(leftEdge - x1) <= spanTolerance) {
          if (rTop <= y1 + spanTolerance && rBottom >= y2 - spanTolerance) {
            return true;
          }
        }
        // Check right edge
        if (Math.abs(rightEdge - x1) <= spanTolerance) {
          if (rTop <= y1 + spanTolerance && rBottom >= y2 - spanTolerance) {
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

  // Step 10: Capture text labels positioned to the LEFT of the table.
  // Many PDF forms draw labels (e.g., "Name", "Email") to the left of bordered
  // input field boxes. These labels fall outside the grid's column bounds.
  // Assign them to the leftmost cell of the matching row.
  const LABEL_CAPTURE_DISTANCE = 120; // max pt distance left of table
  const assignedTexts = new Set<TextElement>();
  for (const cell of cells) {
    for (const t of cell.texts) assignedTexts.add(t);
  }

  const tableLeft = colBounds[0];
  let leftExtension = 0;

  for (const text of allTexts) {
    if (assignedTexts.has(text)) continue;

    const textCenterX = text.x + text.width / 2;
    const textCenterY = text.y + text.height / 2;

    // Only capture text whose center is to the left of the first column
    if (textCenterX >= colBounds[0]) continue;
    if (text.x < colBounds[0] - LABEL_CAPTURE_DISTANCE) continue;

    // Find the row this text belongs to
    let matchRow = -1;
    for (let r = 0; r < numRows; r++) {
      if (textCenterY >= rowBounds[r] - EDGE_CLUSTER_TOLERANCE &&
          textCenterY <= rowBounds[r + 1] + EDGE_CLUSTER_TOLERANCE) {
        matchRow = r;
        break;
      }
    }

    if (matchRow < 0) continue;

    // Find the leftmost cell in this row (accounting for merges)
    const targetCell = cells.find(cell =>
      matchRow >= cell.row && matchRow < cell.row + cell.rowSpan &&
      cell.col === 0
    );

    if (targetCell) {
      targetCell.texts.push(text);
      assignedTexts.add(text);
      const extension = colBounds[0] - text.x;
      if (extension > leftExtension) leftExtension = extension;
    }
  }

  // If labels were captured, extend first column to accommodate them
  if (leftExtension > 0) {
    leftExtension += 4; // small padding
    for (const cell of cells) {
      if (cell.col === 0) {
        cell.x -= leftExtension;
        cell.width += leftExtension;
      }
    }
  }

  // Step 11: Capture column header text positioned ABOVE the table.
  // Column headers (e.g., "Model", "Serial Number") may sit just above the
  // top border row. Assign them to the first row by matching X to columns.
  const HEADER_CAPTURE_DISTANCE = 20; // max pt distance above/below table
  const tableTop = rowBounds[0];
  const tableBottom = rowBounds[rowBounds.length - 1];

  for (const text of allTexts) {
    if (assignedTexts.has(text)) continue;

    const textCenterX = text.x + text.width / 2;
    const textBottom = text.y + text.height;

    // Text just ABOVE the table (bottom edge within tolerance of table top)
    if (textBottom >= tableTop - HEADER_CAPTURE_DISTANCE &&
        textBottom <= tableTop + EDGE_CLUSTER_TOLERANCE) {
      // Find which column this text belongs to by X center
      let matchCol = -1;
      for (let c = 0; c < numCols; c++) {
        if (textCenterX >= colBounds[c] - EDGE_CLUSTER_TOLERANCE &&
            textCenterX <= colBounds[c + 1] + EDGE_CLUSTER_TOLERANCE) {
          matchCol = c;
          break;
        }
      }
      // Also check extended left column
      if (matchCol < 0 && leftExtension > 0 &&
          textCenterX >= colBounds[0] - leftExtension &&
          textCenterX <= colBounds[1] + EDGE_CLUSTER_TOLERANCE) {
        matchCol = 0;
      }

      if (matchCol >= 0) {
        const targetCell = cells.find(cell =>
          0 >= cell.row && 0 < cell.row + cell.rowSpan &&
          matchCol >= cell.col && matchCol < cell.col + cell.colSpan
        );
        if (targetCell) {
          targetCell.texts.push(text);
          assignedTexts.add(text);
        }
      }
    }

    // Text just BELOW the table (top edge within tolerance of table bottom)
    if (text.y >= tableBottom - EDGE_CLUSTER_TOLERANCE &&
        text.y <= tableBottom + HEADER_CAPTURE_DISTANCE) {
      let matchCol = -1;
      for (let c = 0; c < numCols; c++) {
        if (textCenterX >= colBounds[c] - EDGE_CLUSTER_TOLERANCE &&
            textCenterX <= colBounds[c + 1] + EDGE_CLUSTER_TOLERANCE) {
          matchCol = c;
          break;
        }
      }
      if (matchCol < 0 && leftExtension > 0 &&
          textCenterX >= colBounds[0] - leftExtension &&
          textCenterX <= colBounds[1] + EDGE_CLUSTER_TOLERANCE) {
        matchCol = 0;
      }

      if (matchCol >= 0) {
        const lastRow = numRows - 1;
        const targetCell = cells.find(cell =>
          lastRow >= cell.row && lastRow < cell.row + cell.rowSpan &&
          matchCol >= cell.col && matchCol < cell.col + cell.colSpan
        );
        if (targetCell) {
          targetCell.texts.push(text);
          assignedTexts.add(text);
        }
      }
    }
  }

  // Compute table bounding box
  const tableX = colBounds[0] - leftExtension;
  const tableY = rowBounds[0];
  const tableW = colBounds[colBounds.length - 1] - colBounds[0] + leftExtension;
  const tableH = rowBounds[rowBounds.length - 1] - rowBounds[0];

  // Column widths and row heights
  const columnWidths: number[] = [];
  for (let c = 0; c < numCols; c++) {
    columnWidths.push(colBounds[c + 1] - colBounds[c]);
  }
  // Add the label extension to first column
  if (leftExtension > 0) {
    columnWidths[0] += leftExtension;
  }

  const rowHeights: number[] = [];
  for (let r = 0; r < numRows; r++) {
    rowHeights.push(rowBounds[r + 1] - rowBounds[r]);
  }

  // Extract median border color and width from source rects
  const strokeColors: RGB[] = [];
  const lineWidths: number[] = [];
  for (const rect of borderRects) {
    if (rect.strokeColor) {
      strokeColors.push(rect.strokeColor);
    }
    if (rect.lineWidth > 0) {
      lineWidths.push(rect.lineWidth);
    }
  }

  let borderColor: RGB | undefined;
  if (strokeColors.length > 0) {
    // Median color: sort by luminance and pick middle
    strokeColors.sort((a, b) => (a.r + a.g + a.b) - (b.r + b.g + b.b));
    borderColor = strokeColors[Math.floor(strokeColors.length / 2)];
  }

  let borderWidthPt: number | undefined;
  if (lineWidths.length > 0) {
    lineWidths.sort((a, b) => a - b);
    borderWidthPt = lineWidths[Math.floor(lineWidths.length / 2)];
  }

  // Step 12: Per-cell border detection from individual border rects
  // Check which border rects overlap each cell's edges for per-cell styling
  for (const cell of cells) {
    const cellLeft = cell.x;
    const cellRight = cell.x + cell.width;
    const cellTop = cell.y;
    const cellBottom = cell.y + cell.height;
    const edgeTol = EDGE_CLUSTER_TOLERANCE + 1;

    // Check each border rect for overlap with cell edges
    const topBorders: { color: RGB; width: number }[] = [];
    const bottomBorders: { color: RGB; width: number }[] = [];
    const leftBorders: { color: RGB; width: number }[] = [];
    const rightBorders: { color: RGB; width: number }[] = [];

    for (const rect of borderRects) {
      const rLeft = rect.x;
      const rRight = rect.x + rect.width;
      const rTop = rect.y;
      const rBottom = rect.y + rect.height;
      const isHorizontal = rect.width > rect.height * 2;
      const isVertical = rect.height > rect.width * 2;

      if (isHorizontal) {
        // Check if this horizontal line overlaps with cell top or bottom
        const xOverlap = Math.max(0, Math.min(rRight, cellRight) - Math.max(rLeft, cellLeft));
        if (xOverlap > cell.width * 0.3) {
          if (Math.abs(rTop - cellTop) < edgeTol || Math.abs(rBottom - cellTop) < edgeTol) {
            if (rect.strokeColor) topBorders.push({ color: rect.strokeColor, width: rect.lineWidth || Math.abs(rect.height) });
          }
          if (Math.abs(rTop - cellBottom) < edgeTol || Math.abs(rBottom - cellBottom) < edgeTol) {
            if (rect.strokeColor) bottomBorders.push({ color: rect.strokeColor, width: rect.lineWidth || Math.abs(rect.height) });
          }
        }
      }
      if (isVertical) {
        // Check if this vertical line overlaps with cell left or right
        const yOverlap = Math.max(0, Math.min(rBottom, cellBottom) - Math.max(rTop, cellTop));
        if (yOverlap > cell.height * 0.3) {
          if (Math.abs(rLeft - cellLeft) < edgeTol || Math.abs(rRight - cellLeft) < edgeTol) {
            if (rect.strokeColor) leftBorders.push({ color: rect.strokeColor, width: rect.lineWidth || Math.abs(rect.width) });
          }
          if (Math.abs(rLeft - cellRight) < edgeTol || Math.abs(rRight - cellRight) < edgeTol) {
            if (rect.strokeColor) rightBorders.push({ color: rect.strokeColor, width: rect.lineWidth || Math.abs(rect.width) });
          }
        }
      }
    }

    // Set per-cell borders if they differ from the table default
    if (topBorders.length > 0) {
      const b = topBorders[0];
      cell.borderTop = { color: b.color, widthPt: b.width };
    }
    if (bottomBorders.length > 0) {
      const b = bottomBorders[0];
      cell.borderBottom = { color: b.color, widthPt: b.width };
    }
    if (leftBorders.length > 0) {
      const b = leftBorders[0];
      cell.borderLeft = { color: b.color, widthPt: b.width };
    }
    if (rightBorders.length > 0) {
      const b = rightBorders[0];
      cell.borderRight = { color: b.color, widthPt: b.width };
    }
  }

  // Step 13: Per-cell padding and vertical alignment from text positions
  for (const cell of cells) {
    if (cell.texts.length === 0) continue;

    const textMinX = Math.min(...cell.texts.map(t => t.x));
    const textMinY = Math.min(...cell.texts.map(t => t.y));
    const textMaxX = Math.max(...cell.texts.map(t => t.x + t.width));
    const textMaxY = Math.max(...cell.texts.map(t => t.y + t.height));

    // Padding: gap from cell boundary to text boundary
    const padLeft = Math.max(0, textMinX - cell.x);
    const padTop = Math.max(0, textMinY - cell.y);
    const padRight = Math.max(0, (cell.x + cell.width) - textMaxX);
    const padBottom = Math.max(0, (cell.y + cell.height) - textMaxY);

    // Only set padding if it's meaningful (> 2pt to avoid noise)
    if (padLeft > 2) cell.paddingLeft = padLeft;
    if (padTop > 2) cell.paddingTop = padTop;
    if (padRight > 2) cell.paddingRight = padRight;
    if (padBottom > 2) cell.paddingBottom = padBottom;

    // Vertical alignment: detect from text Y position within cell
    const cellHeight = cell.height;
    const textCenter = (textMinY + textMaxY) / 2;
    const cellCenter = cell.y + cellHeight / 2;
    const textHeight = textMaxY - textMinY;
    const availableSpace = cellHeight - textHeight;

    if (availableSpace > 6) { // Only set vAlign if there's meaningful space
      const topGap = textMinY - cell.y;
      const bottomGap = (cell.y + cellHeight) - textMaxY;
      const ratio = topGap / (topGap + bottomGap);

      if (ratio < 0.3) {
        cell.vAlign = 'top';
      } else if (ratio > 0.7) {
        cell.vAlign = 'bottom';
      } else {
        cell.vAlign = 'center';
      }
    }
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
    borderColor,
    borderWidthPt,
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

  // Step 1b: Split lines at large X gaps.
  // Text elements at the same baseline may come from different columns
  // (e.g., "Evaluation" at x=26 and "Rush Job" at x=245). If the gap
  // between consecutive elements exceeds 30pt, split into separate lines
  // so they become independent paragraphs.
  const X_GAP_SPLIT_THRESHOLD = 30;
  const splitLines: TextLine[] = [];
  for (const line of lines) {
    if (line.texts.length <= 1) {
      splitLines.push(line);
      continue;
    }
    let segStart = 0;
    for (let i = 1; i < line.texts.length; i++) {
      const prev = line.texts[i - 1];
      const prevRight = prev.x + prev.width;
      const gap = line.texts[i].x - prevRight;
      if (gap > X_GAP_SPLIT_THRESHOLD) {
        // Emit segment [segStart..i-1]
        const seg = line.texts.slice(segStart, i);
        const avgFS = seg.reduce((s, t) => s + t.fontSize, 0) / seg.length;
        const minX = Math.min(...seg.map(t => t.x));
        splitLines.push({ texts: seg, y: line.y, avgFontSize: avgFS, minX });
        segStart = i;
      }
    }
    // Emit final segment
    const seg = line.texts.slice(segStart);
    const avgFS = seg.reduce((s, t) => s + t.fontSize, 0) / seg.length;
    const minX = Math.min(...seg.map(t => t.x));
    splitLines.push({ texts: seg, y: line.y, avgFontSize: avgFS, minX });
  }

  // Replace lines with split lines for subsequent paragraph grouping
  lines.length = 0;
  lines.push(...splitLines);

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

  // Step 3: Associate form fields with paragraphs by CLOSEST TEXT MATCH.
  // For each field, find the paragraph containing the text element whose
  // center Y is closest to the field's center Y. This prevents fields from
  // being mis-assigned to the first-matching paragraph (e.g., a section header
  // grabbing a field that belongs to the next data line).
  const MAX_FIELD_TEXT_DISTANCE = 25; // ~2 line heights for 12pt text

  for (const field of formFields) {
    const fieldCenterY = field.y + field.height / 2;

    let bestPara: ParagraphGroup | null = null;
    let bestDist = Infinity;

    for (const para of paragraphs) {
      for (const text of para.texts) {
        const textCenterY = text.y + text.height / 2;
        const dist = Math.abs(fieldCenterY - textCenterY);
        if (dist < bestDist) {
          bestDist = dist;
          bestPara = para;
        }
      }
    }

    if (bestPara && bestDist <= MAX_FIELD_TEXT_DISTANCE) {
      bestPara.formFields.push(field);
    } else {
      // Orphan field — no nearby text; gets its own paragraph
      paragraphs.push({
        texts: [],
        formFields: [field],
        y: field.y,
        x: field.x,
      });
    }
  }

  // Step 4: Split large paragraphs that span multiple visual lines into
  // per-line sub-paragraphs. This handles form sections (address areas,
  // checkbox groups) where tightly-spaced lines weren't split by gap analysis.
  const splitResult = splitFormFieldParagraphs(paragraphs);

  // Sort all paragraphs by Y
  splitResult.sort((a, b) => a.y - b.y);

  return splitResult;
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

  // Compute inter-line spacing from consecutive line Y deltas
  let lineSpacingPt: number | undefined;
  if (lines.length >= 2) {
    const deltas: number[] = [];
    for (let i = 1; i < lines.length; i++) {
      deltas.push(lines[i].y - lines[i - 1].y);
    }
    // Average the deltas
    lineSpacingPt = deltas.reduce((sum, d) => sum + d, 0) / deltas.length;
  }

  return {
    texts: allTexts,
    formFields: [],
    y: lines[0].y,
    x: Math.min(...lines.map(l => l.minX)),
    lineSpacingPt,
  };
}

// ─── Per-Line Paragraph Splitting ─────────────────────────────

/**
 * Split paragraphs that contain many items across multiple visual lines
 * into per-line sub-paragraphs.
 *
 * This handles form sections (address areas, checkbox groups) where
 * tightly-spaced rows weren't separated during initial gap-based paragraph
 * grouping. Items are clustered by Y center into bands, and each band
 * becomes its own paragraph.
 */
function splitFormFieldParagraphs(paragraphs: ParagraphGroup[]): ParagraphGroup[] {
  const result: ParagraphGroup[] = [];
  const BAND_TOLERANCE = 8; // Same as FIELD_ROW_TOLERANCE

  for (const para of paragraphs) {
    // Only split paragraphs with enough items to warrant it
    if (para.formFields.length < 2 ||
        (para.texts.length + para.formFields.length) < 4) {
      result.push(para);
      continue;
    }

    // Collect all items with Y positions
    interface YItem {
      y: number;
      height: number;
      text?: TextElement;
      field?: FormField;
    }

    const items: YItem[] = [];
    for (const t of para.texts) {
      items.push({ y: t.y, height: t.height, text: t });
    }
    for (const f of para.formFields) {
      items.push({ y: f.y, height: f.height, field: f });
    }

    items.sort((a, b) => a.y - b.y);

    // Cluster by Y center into visual bands
    const bands: YItem[][] = [[items[0]]];

    for (let i = 1; i < items.length; i++) {
      const lastBand = bands[bands.length - 1];
      const bandCenterY = lastBand.reduce((s, it) => s + it.y + it.height / 2, 0) / lastBand.length;
      const itemCenterY = items[i].y + items[i].height / 2;

      if (Math.abs(itemCenterY - bandCenterY) <= BAND_TOLERANCE) {
        lastBand.push(items[i]);
      } else {
        bands.push([items[i]]);
      }
    }

    // If only 1 band, nothing to split
    if (bands.length <= 1) {
      result.push(para);
      continue;
    }

    // Emit one sub-paragraph per band
    for (const band of bands) {
      const texts: TextElement[] = [];
      const fields: FormField[] = [];

      for (const item of band) {
        if (item.text) texts.push(item.text);
        if (item.field) fields.push(item.field);
      }

      // Sort by X within each band for reading order
      texts.sort((a, b) => a.x - b.x);
      fields.sort((a, b) => a.x - b.x);

      const yValues = band.map(it => it.y);
      const xValues = [...texts.map(t => t.x), ...fields.map(f => f.x)];

      result.push({
        texts,
        formFields: fields,
        y: Math.min(...yValues),
        x: xValues.length > 0 ? Math.min(...xValues) : 0,
      });
    }
  }

  return result;
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

  // Assign nearby text labels to data cells by finding the CLOSEST matching cell.
  // Uses closest-match to prevent labels at column boundaries from being assigned
  // to the wrong column when tolerances cause overlap.
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

    // Find the closest cell that matches in Y band
    let bestCell: DetectedCell | null = null;
    let bestDist = Infinity;

    for (const cell of cells) {
      // Check vertical band
      if (textCenterY < cell.y - LABEL_Y_TOLERANCE ||
          textCenterY > cell.y + cell.height + LABEL_Y_TOLERANCE) {
        continue;
      }
      // Check horizontal band (with tolerance for labels just outside the cell)
      if (textCenterX < cell.x - FIELD_COL_TOLERANCE ||
          textCenterX > cell.x + cell.width + FIELD_COL_TOLERANCE) {
        continue;
      }

      // Distance from text center to cell center
      const cellCenterX = cell.x + cell.width / 2;
      const cellCenterY = cell.y + cell.height / 2;
      const dist = Math.abs(textCenterX - cellCenterX) + Math.abs(textCenterY - cellCenterY);

      if (dist < bestDist) {
        bestDist = dist;
        bestCell = cell;
      }
    }

    if (bestCell) {
      bestCell.texts.push(text);
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

// ─── Rect-to-Paragraph Styling ───────────────────────────────

/**
 * Apply visual styling from classified rectangles to paragraph groups.
 *
 * Handles two cases:
 * 1. TALL cell-fill rects → paragraph backgroundColor (colored section headers)
 * 2. THIN cell-fill rects & separators → paragraph bottomBorder (colored underlines)
 *
 * Many PDFs draw section headers as colored underlines (thin 1-2pt rects) just
 * below the header text, not as tall background rectangles. This function
 * detects both patterns.
 */
function applyRectStylingToParagraphs(
  paragraphs: ParagraphGroup[],
  rectRoles: Map<RectElement, RectRole>,
  scene: PageScene,
): void {
  // Collect styled rects
  const cellFills: RectElement[] = [];
  const separators: RectElement[] = [];

  for (const [rect, role] of rectRoles) {
    if (role === 'cell-fill') cellFills.push(rect);
    if (role === 'separator') separators.push(rect);
  }

  if (cellFills.length === 0 && separators.length === 0) return;

  // Split cell-fills into background rects (tall) and underline rects (thin)
  const bgFills: RectElement[] = [];
  const underlineFills: RectElement[] = [];

  for (const fill of cellFills) {
    const fh = Math.abs(fill.height);
    if (fh >= 5) {
      bgFills.push(fill); // Tall enough to be a background
    } else if (fh > 0.2) {
      underlineFills.push(fill); // Thin colored line (likely underline/border)
    }
  }

  // For each paragraph, compute its bounding box from texts and fields
  for (const para of paragraphs) {
    const items = [
      ...para.texts.map(t => ({ x: t.x, y: t.y, w: t.width, h: t.height })),
      ...para.formFields.map(f => ({ x: f.x, y: f.y, w: f.width, h: f.height })),
    ];
    if (items.length === 0) continue;

    const paraLeft = Math.min(...items.map(it => it.x));
    const paraTop = Math.min(...items.map(it => it.y));
    const paraRight = Math.max(...items.map(it => it.x + it.w));
    const paraBottom = Math.max(...items.map(it => it.y + it.h));
    const paraCenterY = (paraTop + paraBottom) / 2;

    // Check tall cell-fill rects for background color
    for (const fill of bgFills) {
      if (!fill.fillColor) continue;

      const fx = Math.min(fill.x, fill.x + fill.width);
      const fy = Math.min(fill.y, fill.y + fill.height);
      const fw = Math.abs(fill.width);
      const fh = Math.abs(fill.height);

      // Check if the paragraph center falls within the rect
      if (paraCenterY >= fy - 2 && paraCenterY <= fy + fh + 2 &&
          paraLeft >= fx - 5 && paraLeft <= fx + fw + 5) {
        // Skip white or near-white fills
        const { r, g, b } = fill.fillColor;
        if (r > 0.95 && g > 0.95 && b > 0.95) continue;

        para.backgroundColor = fill.fillColor;
        break;
      }
    }

    // Check thin colored rects (underlines) for bottom borders
    // These are typically 1-2pt tall colored lines just below section header text
    if (!para.bottomBorder) {
      // Find the best matching underline: closest one just below the paragraph
      let bestUnderline: RectElement | null = null;
      let bestGap = Infinity;

      for (const ul of underlineFills) {
        if (!ul.fillColor) continue;

        const ux = Math.min(ul.x, ul.x + ul.width);
        const uy = Math.min(ul.y, ul.y + ul.height);
        const uw = Math.abs(ul.width);
        const uh = Math.abs(ul.height);

        // Skip white or near-white fills
        const { r, g, b } = ul.fillColor;
        if (r > 0.95 && g > 0.95 && b > 0.95) continue;

        // Skip full-page-width decorative bars (header/footer decoration)
        if (uw > scene.width * 0.9) continue;

        // The underline should be just below the paragraph (within ~15pt)
        const ulCenterY = uy + uh / 2;
        const gap = ulCenterY - paraBottom;

        if (gap >= -2 && gap <= 15 && gap < bestGap) {
          // Check horizontal overlap — the underline should overlap the paragraph X range
          if (ux < paraRight + 5 && ux + uw > paraLeft - 5) {
            bestGap = gap;
            bestUnderline = ul;
          }
        }
      }

      if (bestUnderline && bestUnderline.fillColor) {
        para.bottomBorder = {
          color: bestUnderline.fillColor,
          widthPt: Math.max(Math.abs(bestUnderline.height), 1),
        };
      }
    }

    // Check separator rects for bottom borders
    if (!para.bottomBorder) {
      for (const sep of separators) {
        const sx = Math.min(sep.x, sep.x + sep.width);
        const sy = Math.min(sep.y, sep.y + sep.height);
        const sw = Math.abs(sep.width);
        const sh = Math.abs(sep.height);

        const sepY = sy + sh / 2;
        const gap = sepY - paraBottom;

        if (gap >= -2 && gap <= 15) {
          if (sx < paraRight && sx + sw > paraLeft) {
            const color: RGB = sep.strokeColor || sep.fillColor || { r: 0, g: 0, b: 0 };
            para.bottomBorder = { color, widthPt: Math.max(sh, sep.lineWidth || 0.5) };
            break;
          }
        }
      }
    }
  }
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
// ─── Two-Column Detection ──────────────────────────────────

/** Minimum X gap between columns to trigger two-column detection */
const TWO_COL_MIN_GAP = 40;

/** Minimum number of elements per side to qualify as two-column (unused after rewrite, kept for tests) */
const TWO_COL_MIN_ELEMENTS = 2;

/**
 * Get the X position of a layout element.
 */
function getElementX(el: LayoutElement): number {
  switch (el.type) {
    case 'paragraph':
      return el.element.x;
    case 'image':
      return el.element.x;
    case 'table':
      return el.element.x;
    case 'two-column':
      return 0;
  }
}

/**
 * Get the bottom Y of a layout element.
 */
function getElementBottom(el: LayoutElement): number {
  switch (el.type) {
    case 'paragraph': {
      const texts = el.element.texts;
      if (texts.length === 0) return el.element.y;
      return Math.max(...texts.map(t => t.y + t.height));
    }
    case 'image':
      return el.element.y + el.element.height;
    case 'table':
      return el.element.y + el.element.height;
    case 'two-column':
      return el.element.y + el.element.height;
  }
}

/**
 * Detect side-by-side element groups and merge them into TwoColumnRegion
 * elements. ALL element types (tables, paragraphs, images) participate.
 *
 * Algorithm:
 * 1. Collect ALL non-two-column elements with their positions
 * 2. Group elements into Y-bands of vertically overlapping elements
 * 3. For each band with ≥2 elements, find the largest X gap
 * 4. If gap > threshold, split band into left/right columns → TwoColumnRegion
 * 5. Support multiple independent two-column regions per page
 */
function detectTwoColumnRegions(
  layoutElements: LayoutElement[],
  pageWidth: number
): LayoutElement[] {
  // Collect ALL elements (including tables) as candidates
  interface Candidate {
    elem: LayoutElement;
    idx: number;
    x: number;
    rightEdge: number;
    y: number;
    bottom: number;
  }

  const candidates: Candidate[] = [];
  for (let i = 0; i < layoutElements.length; i++) {
    const el = layoutElements[i];
    if (el.type === 'two-column') continue;
    const x = getElementX(el);
    let rightEdge: number;
    if (el.type === 'paragraph') {
      const texts = el.element.texts;
      if (texts.length > 0) {
        rightEdge = Math.max(...texts.map(t => t.x + t.width));
      } else if (el.element.formFields.length > 0) {
        rightEdge = Math.max(...el.element.formFields.map(f => f.x + f.width));
      } else {
        rightEdge = x + 100;
      }
    } else if (el.type === 'image') {
      rightEdge = el.element.x + el.element.width;
    } else if (el.type === 'table') {
      rightEdge = el.element.x + el.element.width;
    } else {
      rightEdge = x + 100;
    }
    candidates.push({
      elem: el,
      idx: i,
      x,
      rightEdge,
      y: getElementY(el),
      bottom: getElementBottom(el),
    });
  }

  if (candidates.length < 2) return layoutElements;

  // Sort by Y for band detection
  const sorted = [...candidates].sort((a, b) => a.y - b.y);

  // Build Y-bands: groups of elements that overlap vertically (tolerance 20pt)
  const Y_BAND_TOLERANCE = 20;
  interface YBand {
    items: Candidate[];
    top: number;
    bottom: number;
  }

  const bands: YBand[] = [];
  const assigned = new Set<number>(); // candidate indices already in a band

  for (let i = 0; i < sorted.length; i++) {
    if (assigned.has(i)) continue;
    const band: Candidate[] = [sorted[i]];
    assigned.add(i);
    let bandTop = sorted[i].y;
    let bandBottom = sorted[i].bottom;

    // Expand band with overlapping elements
    let changed = true;
    while (changed) {
      changed = false;
      for (let j = i + 1; j < sorted.length; j++) {
        if (assigned.has(j)) continue;
        // Element overlaps band if its top is within the band's bottom + tolerance
        if (sorted[j].y <= bandBottom + Y_BAND_TOLERANCE &&
            sorted[j].bottom >= bandTop - Y_BAND_TOLERANCE) {
          band.push(sorted[j]);
          assigned.add(j);
          bandTop = Math.min(bandTop, sorted[j].y);
          bandBottom = Math.max(bandBottom, sorted[j].bottom);
          changed = true;
        }
      }
    }

    if (band.length >= 2) {
      bands.push({ items: band, top: bandTop, bottom: bandBottom });
    }
  }

  // For each band, check for X-gap based two-column structure
  const consumedIndices = new Set<number>();
  const twoColRegions: Array<{ region: TwoColumnRegion; y: number }> = [];

  for (const band of bands) {
    // Sort band items by X
    const byX = [...band.items].sort((a, b) => a.x - b.x);

    // Find largest X gap between consecutive element right-edges and next left-edges
    let bestGap = 0;
    let bestGapIdx = -1;
    for (let i = 0; i < byX.length - 1; i++) {
      const gap = byX[i + 1].x - byX[i].rightEdge;
      if (gap > bestGap) {
        bestGap = gap;
        bestGapIdx = i;
      }
    }

    if (bestGap < TWO_COL_MIN_GAP || bestGapIdx < 0) continue;

    // Split into left (0..bestGapIdx) and right (bestGapIdx+1..end)
    const leftItems = byX.slice(0, bestGapIdx + 1);
    const rightItems = byX.slice(bestGapIdx + 1);

    if (leftItems.length < 1 || rightItems.length < 1) continue;

    // Compute gapX as midpoint between left right-edge and right left-edge
    const leftMaxRight = Math.max(...leftItems.map(c => c.rightEdge));
    const rightMinLeft = Math.min(...rightItems.map(c => c.x));
    const gapX = (leftMaxRight + rightMinLeft) / 2;

    const regionTop = Math.min(...band.items.map(c => c.y));
    const regionBottom = Math.max(...band.items.map(c => c.bottom));

    const twoColRegion: TwoColumnRegion = {
      leftElements: leftItems.map(c => c.elem),
      rightElements: rightItems.map(c => c.elem),
      gapX,
      y: regionTop,
      height: regionBottom - regionTop,
      pageWidth,
    };

    twoColRegions.push({ region: twoColRegion, y: regionTop });

    // Mark all items in this band as consumed
    for (const item of band.items) {
      consumedIndices.add(item.idx);
    }
  }

  if (twoColRegions.length === 0) return layoutElements;

  // Build new element list: unconsumed elements + two-column regions
  const result: LayoutElement[] = [];
  for (let i = 0; i < layoutElements.length; i++) {
    if (!consumedIndices.has(i)) {
      result.push(layoutElements[i]);
    }
  }
  for (const { region } of twoColRegions) {
    result.push({ type: 'two-column', element: region });
  }

  return result;
}

// These are exported for unit testing only. Do not use in production code.
export const _testExports = {
  clusterValues,
  findContainingCell,
  classifyRectangles,
  detectTables,
  detectFormFieldTables,
  rectsOverlap,
  groupIntoParagraphs,
  detectTwoColumnRegions,
  EDGE_CLUSTER_TOLERANCE,
};

export async function buildPageLayout(scene: PageScene): Promise<PageLayout> {
  // Step 1: Classify all rectangles
  const rectRoles = classifyRectangles(scene);

  // Step 2: Detect tables from vector borders
  const tables = detectTables(scene, rectRoles);

  // Step 2b: Also try form field spatial detection for uncaptured fields.
  // Form-field tables complement vector tables by detecting tabular field
  // arrangements that may not have vector borders (e.g., annotation-only fields).
  const allTexts = scene.elements.filter((e): e is TextElement => e.kind === 'text');

  if (scene.formFields.length >= 4) {
    // Determine which form fields are already captured by vector tables
    const capturedFields = new Set<FormField>();
    for (const table of tables) {
      for (const cell of table.cells) {
        for (const f of cell.formFields) capturedFields.add(f);
      }
    }

    // Only run form-field detection on uncaptured fields
    const uncapturedFields = scene.formFields.filter(f => !capturedFields.has(f));
    if (uncapturedFields.length >= 4) {
      const sceneForFormTables: PageScene = {
        ...scene,
        formFields: uncapturedFields,
      };
      const formTables = detectFormFieldTables(sceneForFormTables, allTexts);
      tables.push(...formTables);
    }
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

  // Step 4b: Rasterize vector paths into synthetic images
  const pathElements: PathElement[] = [];
  for (const el of scene.elements) {
    if (el.kind === 'path') {
      pathElements.push(el as PathElement);
    }
  }

  if (pathElements.length > 0) {
    const pathGroups = groupNearbyPaths(pathElements, 25);
    let pathGroupIdx = 0;
    for (const group of pathGroups) {
      try {
        const result = await rasterizePathGroup(group);
        if (result.data.length > 0 && result.widthPt > 0 && result.heightPt > 0) {
          // Compute bounding box Y from the group's points for placement
          let minY = Infinity;
          let minX = Infinity;
          for (const path of group) {
            for (const pt of path.points) {
              if (pt.y < minY) minY = pt.y;
              if (pt.x < minX) minX = pt.x;
            }
          }

          const syntheticImage: ImageElement = {
            kind: 'image',
            x: minX,
            y: minY,
            width: result.widthPt,
            height: result.heightPt,
            resourceName: `path-group-${pathGroupIdx}`,
            intrinsicWidth: Math.ceil(result.widthPt * 2),
            intrinsicHeight: Math.ceil(result.heightPt * 2),
            isGenuine: true,
            data: result.data,
            mimeType: 'image/png',
          };
          genuineImages.push(syntheticImage);
          pathGroupIdx++;
        }
      } catch (err) {
        console.warn(`[LayoutAnalyzer] Failed to rasterize path group:`, err);
      }
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

  // Step 5b: Apply visual styling from rects to paragraphs
  // Map cell-fill rects (colored backgrounds) and separator rects to paragraphs
  applyRectStylingToParagraphs(paragraphs, rectRoles, scene);

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

  // Step 6b: Detect two-column regions from side-by-side paragraphs/images
  const finalElements = detectTwoColumnRegions(layoutElements, scene.width);

  // Sort by Y position for reading order
  finalElements.sort((a, b) => {
    const yA = getElementY(a);
    const yB = getElementY(b);
    return yA - yB;
  });

  // Compute content bounding box from all text elements and form fields
  let contentLeft = scene.width;
  let contentTop = scene.height;
  let contentRight = 0;
  let contentBottom = 0;
  let hasContent = false;

  for (const el of scene.elements) {
    if (el.kind === 'text') {
      const t = el as TextElement;
      contentLeft = Math.min(contentLeft, t.x);
      contentTop = Math.min(contentTop, t.y);
      contentRight = Math.max(contentRight, t.x + t.width);
      contentBottom = Math.max(contentBottom, t.y + t.height);
      hasContent = true;
    }
  }
  for (const f of scene.formFields) {
    contentLeft = Math.min(contentLeft, f.x);
    contentTop = Math.min(contentTop, f.y);
    contentRight = Math.max(contentRight, f.x + f.width);
    contentBottom = Math.max(contentBottom, f.y + f.height);
    hasContent = true;
  }

  // Clamp to reasonable margin range: 36pt (0.5") to 108pt (1.5")
  let contentBounds: { left: number; top: number; right: number; bottom: number } | undefined;
  if (hasContent) {
    contentBounds = {
      left: Math.max(36, Math.min(108, contentLeft)),
      top: Math.max(36, Math.min(108, contentTop)),
      right: Math.max(36, Math.min(108, scene.width - contentRight)),
      bottom: Math.max(36, Math.min(108, scene.height - contentBottom)),
    };
  }

  // Heading detection: classify paragraphs by font size relative to body text
  const fontSizeCounts = new Map<number, number>();
  for (const el of finalElements) {
    if (el.type === 'paragraph') {
      const para = el.element as ParagraphGroup;
      if (para.texts.length > 0) {
        // Use rounded font size of first text as representative
        const size = Math.round(para.texts[0].fontSize * 2) / 2; // round to 0.5pt
        fontSizeCounts.set(size, (fontSizeCounts.get(size) || 0) + 1);
      }
    }
  }

  // Find body font size (most common)
  let bodyFontSize = 10;
  let maxCount = 0;
  for (const [size, count] of fontSizeCounts) {
    if (count > maxCount) {
      maxCount = count;
      bodyFontSize = size;
    }
  }

  // Classify heading levels
  for (const el of finalElements) {
    if (el.type !== 'paragraph') continue;
    const para = el.element as ParagraphGroup;
    if (para.texts.length === 0) continue;

    const firstTextSize = para.texts[0].fontSize;
    const ratio = firstTextSize / bodyFontSize;

    // Only short paragraphs (≤3 lines by Y grouping) qualify as headings
    const uniqueYs = new Set(para.texts.map(t => Math.round(t.y)));
    if (uniqueYs.size > 3) continue;

    if (ratio >= 1.5) {
      para.headingLevel = 1;
    } else if (ratio >= 1.25) {
      para.headingLevel = 2;
    } else if (ratio >= 1.1 && para.texts[0].bold) {
      para.headingLevel = 3;
    }
  }

  // Paragraph spacing: compute spacingBefore/After from Y gaps between consecutive paragraphs
  // Also compute rightX for right indent calculation
  const paraElements = finalElements
    .map((el, idx) => ({ el, idx }))
    .filter(({ el }) => el.type === 'paragraph');

  for (let i = 0; i < paraElements.length; i++) {
    const para = paraElements[i].el.element as ParagraphGroup;

    // Right edge X for right indent
    if (para.texts.length > 0) {
      para.rightX = Math.max(...para.texts.map(t => t.x + t.width));
    }

    // Spacing before: gap from previous element bottom to this paragraph top
    if (i > 0) {
      const prevPara = paraElements[i - 1].el.element as ParagraphGroup;
      if (prevPara.texts.length > 0 && para.texts.length > 0) {
        const prevBottom = Math.max(...prevPara.texts.map(t => t.y + t.height));
        const currTop = Math.min(...para.texts.map(t => t.y));
        const gap = currTop - prevBottom;
        // Only set meaningful spacing (> 2pt to avoid noise)
        if (gap > 2) {
          para.spacingBeforePt = gap;
        }
      }
    }

    // Spacing after: gap from this paragraph bottom to next element top
    if (i < paraElements.length - 1) {
      const nextPara = paraElements[i + 1].el.element as ParagraphGroup;
      if (para.texts.length > 0 && nextPara.texts.length > 0) {
        const currBottom = Math.max(...para.texts.map(t => t.y + t.height));
        const nextTop = Math.min(...nextPara.texts.map(t => t.y));
        const gap = nextTop - currBottom;
        if (gap > 2) {
          para.spacingAfterPt = gap;
        }
      }
    }
  }

  return {
    elements: finalElements,
    width: scene.width,
    height: scene.height,
    contentBounds,
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
    case 'two-column':
      return el.element.y;
  }
}
