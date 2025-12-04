/**
 * PDF Layout Analyzer
 *
 * Reconstructs document structure from raw text runs:
 * - Groups glyphs into words
 * - Groups words into lines
 * - Groups lines into paragraphs
 * - Detects columns and tables
 * - Establishes reading order
 */

import {
  TextRun,
  Word,
  TextLine,
  Paragraph,
  Column,
  Table,
  TableRow,
  TableCell,
  BoundingBox,
  Glyph,
} from './types';

// Layout analysis thresholds (can be tuned)
const WORD_SPACING_THRESHOLD = 0.3; // Fraction of font size
const LINE_SPACING_THRESHOLD = 1.5; // Fraction of font size
const PARAGRAPH_SPACING_THRESHOLD = 2.0; // Fraction of font size
const COLUMN_GAP_THRESHOLD = 30; // Minimum gap between columns in points
const BASELINE_TOLERANCE = 3; // Points tolerance for baseline alignment

/**
 * Generate unique IDs
 */
let idCounter = 0;
function generateId(prefix: string): string {
  return `${prefix}-${++idCounter}`;
}

/**
 * Calculate distance between two bounding boxes
 */
function horizontalDistance(a: BoundingBox, b: BoundingBox): number {
  const aRight = a.x + a.width;
  const bRight = b.x + b.width;

  if (aRight <= b.x) {
    return b.x - aRight;
  } else if (bRight <= a.x) {
    return a.x - bRight;
  }
  return 0; // Overlapping
}

function verticalDistance(a: BoundingBox, b: BoundingBox): number {
  const aBottom = a.y + a.height;
  const bBottom = b.y + b.height;

  if (aBottom <= b.y) {
    return b.y - aBottom;
  } else if (bBottom <= a.y) {
    return a.y - bBottom;
  }
  return 0; // Overlapping
}

/**
 * Check if two bounding boxes overlap vertically (same line level)
 */
function verticallyOverlaps(a: BoundingBox, b: BoundingBox, tolerance: number = 0): boolean {
  const aTop = a.y;
  const aBottom = a.y + a.height;
  const bTop = b.y;
  const bBottom = b.y + b.height;

  return !(aBottom + tolerance < bTop || bBottom + tolerance < aTop);
}

/**
 * Check if two y positions are on the same baseline
 */
function sameBaseline(y1: number, y2: number, tolerance: number): boolean {
  return Math.abs(y1 - y2) <= tolerance;
}

/**
 * Merge multiple bounding boxes into one
 */
function mergeBoundingBoxes(boxes: BoundingBox[]): BoundingBox {
  if (boxes.length === 0) {
    return { x: 0, y: 0, width: 0, height: 0 };
  }

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;

  for (const box of boxes) {
    minX = Math.min(minX, box.x);
    minY = Math.min(minY, box.y);
    maxX = Math.max(maxX, box.x + box.width);
    maxY = Math.max(maxY, box.y + box.height);
  }

  return {
    x: minX,
    y: minY,
    width: maxX - minX,
    height: maxY - minY
  };
}

/**
 * Sort text runs by reading order (top-to-bottom, left-to-right)
 */
function sortByReadingOrder<T extends { boundingBox: BoundingBox }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    // First sort by Y (top to bottom)
    const yDiff = a.boundingBox.y - b.boundingBox.y;
    if (Math.abs(yDiff) > BASELINE_TOLERANCE) {
      return yDiff;
    }
    // Then by X (left to right)
    return a.boundingBox.x - b.boundingBox.x;
  });
}

/**
 * Layout Analyzer class
 */
export class LayoutAnalyzer {
  private textRuns: TextRun[];
  private pageWidth: number;
  private pageHeight: number;

  constructor(textRuns: TextRun[], pageWidth: number, pageHeight: number) {
    this.textRuns = textRuns;
    this.pageWidth = pageWidth;
    this.pageHeight = pageHeight;
    idCounter = 0; // Reset ID counter
  }

  /**
   * Perform full layout analysis
   */
  analyze(): {
    words: Word[];
    lines: TextLine[];
    paragraphs: Paragraph[];
    columns: Column[];
    tables: Table[];
    readingOrder: TextRun[];
  } {
    // Step 1: Group runs into words
    const words = this.groupIntoWords();

    // Step 2: Group words into lines
    const lines = this.groupIntoLines(words);

    // Step 3: Detect columns
    const columns = this.detectColumns(lines);

    // Step 4: Group lines into paragraphs within columns
    const paragraphs = this.groupIntoParagraphs(lines, columns);

    // Step 5: Detect tables
    const tables = this.detectTables(lines);

    // Step 6: Establish reading order
    const readingOrder = this.establishReadingOrder(columns);

    return {
      words,
      lines,
      paragraphs,
      columns,
      tables,
      readingOrder
    };
  }

  /**
   * Group text runs into words based on spacing
   */
  private groupIntoWords(): Word[] {
    const words: Word[] = [];
    const sortedRuns = sortByReadingOrder(this.textRuns);

    let currentWord: TextRun[] = [];
    let lastRun: TextRun | null = null;

    for (const run of sortedRuns) {
      if (lastRun === null) {
        currentWord = [run];
      } else {
        // Check if this run is part of the same word
        const avgFontSize = (lastRun.fontSize + run.fontSize) / 2;
        const threshold = avgFontSize * WORD_SPACING_THRESHOLD;
        const hDist = horizontalDistance(lastRun.boundingBox, run.boundingBox);
        const sameLine = sameBaseline(lastRun.boundingBox.y, run.boundingBox.y, BASELINE_TOLERANCE);

        if (sameLine && hDist <= threshold && hDist >= 0) {
          // Same word
          currentWord.push(run);
        } else {
          // New word - save current
          if (currentWord.length > 0) {
            words.push(this.createWord(currentWord));
          }
          currentWord = [run];
        }
      }
      lastRun = run;
    }

    // Don't forget the last word
    if (currentWord.length > 0) {
      words.push(this.createWord(currentWord));
    }

    return words;
  }

  private createWord(runs: TextRun[]): Word {
    return {
      id: generateId('word'),
      runs: runs,
      text: runs.map(r => r.text).join(''),
      boundingBox: mergeBoundingBoxes(runs.map(r => r.boundingBox))
    };
  }

  /**
   * Group words into lines based on baseline alignment
   */
  private groupIntoLines(words: Word[]): TextLine[] {
    const lines: TextLine[] = [];
    const sortedWords = sortByReadingOrder(words);

    // Group by approximate baseline
    const lineGroups: Map<number, Word[]> = new Map();

    for (const word of sortedWords) {
      const baseline = Math.round(word.boundingBox.y / BASELINE_TOLERANCE) * BASELINE_TOLERANCE;

      // Find existing line within tolerance
      let foundLine = false;
      for (const [existingBaseline, lineWords] of lineGroups) {
        if (Math.abs(existingBaseline - baseline) <= BASELINE_TOLERANCE) {
          lineWords.push(word);
          foundLine = true;
          break;
        }
      }

      if (!foundLine) {
        lineGroups.set(baseline, [word]);
      }
    }

    // Create line objects
    for (const [baseline, lineWords] of lineGroups) {
      // Sort words in line by X position
      lineWords.sort((a, b) => a.boundingBox.x - b.boundingBox.x);

      const avgFontSize = lineWords.reduce((sum, w) =>
        sum + w.runs.reduce((s, r) => s + r.fontSize, 0) / w.runs.length, 0
      ) / lineWords.length;

      lines.push({
        id: generateId('line'),
        words: lineWords,
        text: lineWords.map(w => w.text).join(' '),
        boundingBox: mergeBoundingBoxes(lineWords.map(w => w.boundingBox)),
        baseline,
        leading: avgFontSize * 1.2 // Estimate
      });
    }

    // Sort lines by Y position
    return lines.sort((a, b) => a.boundingBox.y - b.boundingBox.y);
  }

  /**
   * Detect column structure in the page
   */
  private detectColumns(lines: TextLine[]): Column[] {
    if (lines.length === 0) {
      return [];
    }

    // Find gaps in X coordinates that might indicate column boundaries
    const xPositions: { x: number; width: number }[] = [];

    for (const line of lines) {
      xPositions.push({
        x: line.boundingBox.x,
        width: line.boundingBox.width
      });
    }

    // Find clusters of X positions
    const xClusters = this.clusterXPositions(xPositions);

    if (xClusters.length <= 1) {
      // Single column
      return [{
        id: generateId('column'),
        paragraphs: [],
        boundingBox: mergeBoundingBoxes(lines.map(l => l.boundingBox))
      }];
    }

    // Create columns based on clusters
    const columns: Column[] = [];
    for (const cluster of xClusters) {
      columns.push({
        id: generateId('column'),
        paragraphs: [],
        boundingBox: { x: cluster.minX, y: 0, width: cluster.maxX - cluster.minX, height: this.pageHeight }
      });
    }

    return columns;
  }

  private clusterXPositions(positions: { x: number; width: number }[]): { minX: number; maxX: number }[] {
    if (positions.length === 0) return [];

    // Sort by X
    const sorted = [...positions].sort((a, b) => a.x - b.x);

    const clusters: { minX: number; maxX: number }[] = [];
    let currentCluster = { minX: sorted[0].x, maxX: sorted[0].x + sorted[0].width };

    for (let i = 1; i < sorted.length; i++) {
      const pos = sorted[i];
      const right = pos.x + pos.width;

      // Check if this position starts a new column (large gap)
      if (pos.x - currentCluster.maxX > COLUMN_GAP_THRESHOLD) {
        clusters.push(currentCluster);
        currentCluster = { minX: pos.x, maxX: right };
      } else {
        // Extend current cluster
        currentCluster.maxX = Math.max(currentCluster.maxX, right);
      }
    }

    clusters.push(currentCluster);
    return clusters;
  }

  /**
   * Group lines into paragraphs
   */
  private groupIntoParagraphs(lines: TextLine[], columns: Column[]): Paragraph[] {
    const paragraphs: Paragraph[] = [];
    const sortedLines = [...lines].sort((a, b) => a.boundingBox.y - b.boundingBox.y);

    let currentParagraph: TextLine[] = [];
    let lastLine: TextLine | null = null;

    for (const line of sortedLines) {
      if (lastLine === null) {
        currentParagraph = [line];
      } else {
        // Check spacing between lines
        const vDist = verticalDistance(lastLine.boundingBox, line.boundingBox);
        const avgFontSize = (lastLine.leading + line.leading) / 2;
        const threshold = avgFontSize * PARAGRAPH_SPACING_THRESHOLD;

        // Also check if lines are in the same column
        const sameColumn = this.linesInSameColumn(lastLine, line, columns);

        if (sameColumn && vDist < threshold) {
          // Same paragraph
          currentParagraph.push(line);
        } else {
          // New paragraph
          if (currentParagraph.length > 0) {
            paragraphs.push(this.createParagraph(currentParagraph));
          }
          currentParagraph = [line];
        }
      }
      lastLine = line;
    }

    // Last paragraph
    if (currentParagraph.length > 0) {
      paragraphs.push(this.createParagraph(currentParagraph));
    }

    return paragraphs;
  }

  private linesInSameColumn(line1: TextLine, line2: TextLine, columns: Column[]): boolean {
    for (const column of columns) {
      const inCol1 = line1.boundingBox.x >= column.boundingBox.x &&
                     line1.boundingBox.x < column.boundingBox.x + column.boundingBox.width;
      const inCol2 = line2.boundingBox.x >= column.boundingBox.x &&
                     line2.boundingBox.x < column.boundingBox.x + column.boundingBox.width;

      if (inCol1 && inCol2) return true;
    }
    return columns.length === 0; // If no columns detected, assume same column
  }

  private createParagraph(lines: TextLine[]): Paragraph {
    const bbox = mergeBoundingBoxes(lines.map(l => l.boundingBox));

    // Detect alignment
    const alignment = this.detectAlignment(lines);

    // Detect first line indent
    const firstLineIndent = lines.length > 1 ?
      Math.max(0, lines[0].boundingBox.x - lines[1].boundingBox.x) : 0;

    return {
      id: generateId('paragraph'),
      lines,
      text: lines.map(l => l.text).join('\n'),
      boundingBox: bbox,
      alignment,
      firstLineIndent
    };
  }

  private detectAlignment(lines: TextLine[]): 'left' | 'center' | 'right' | 'justify' {
    if (lines.length === 0) return 'left';

    // Calculate left and right edges
    const leftEdges = lines.map(l => l.boundingBox.x);
    const rightEdges = lines.map(l => l.boundingBox.x + l.boundingBox.width);

    const leftVariance = this.variance(leftEdges);
    const rightVariance = this.variance(rightEdges);

    // Low variance on both sides = justified
    // Low left variance, high right = left aligned
    // Low right variance, high left = right aligned
    // High variance on both = centered (roughly)

    const LOW_VARIANCE_THRESHOLD = 10;

    if (leftVariance < LOW_VARIANCE_THRESHOLD && rightVariance < LOW_VARIANCE_THRESHOLD) {
      return 'justify';
    } else if (leftVariance < LOW_VARIANCE_THRESHOLD) {
      return 'left';
    } else if (rightVariance < LOW_VARIANCE_THRESHOLD) {
      return 'right';
    } else {
      // Check if centers are aligned
      const centers = lines.map(l => l.boundingBox.x + l.boundingBox.width / 2);
      const centerVariance = this.variance(centers);
      if (centerVariance < LOW_VARIANCE_THRESHOLD) {
        return 'center';
      }
      return 'left'; // Default
    }
  }

  private variance(numbers: number[]): number {
    if (numbers.length === 0) return 0;
    const mean = numbers.reduce((a, b) => a + b, 0) / numbers.length;
    return numbers.reduce((sum, n) => sum + Math.pow(n - mean, 2), 0) / numbers.length;
  }

  /**
   * Detect tables in the document
   */
  private detectTables(lines: TextLine[]): Table[] {
    const tables: Table[] = [];

    // Simple table detection: look for grid patterns
    // This is a basic implementation - production would need more sophisticated detection

    // Group lines that might be table rows (same Y, multiple distinct X clusters)
    const potentialRows: Map<number, TextLine[]> = new Map();

    for (const line of lines) {
      const yKey = Math.round(line.boundingBox.y / 10) * 10;
      const existing = potentialRows.get(yKey) || [];
      existing.push(line);
      potentialRows.set(yKey, existing);
    }

    // Find rows with multiple columns (potential table)
    const tableRows: TextLine[][] = [];

    for (const [y, rowLines] of potentialRows) {
      // Sort by X
      const sorted = [...rowLines].sort((a, b) => a.boundingBox.x - b.boundingBox.x);

      // Check if there are clear gaps between lines (indicating columns)
      if (sorted.length >= 2) {
        let hasColumnGaps = true;
        for (let i = 1; i < sorted.length; i++) {
          const gap = sorted[i].boundingBox.x - (sorted[i - 1].boundingBox.x + sorted[i - 1].boundingBox.width);
          if (gap < COLUMN_GAP_THRESHOLD / 2) {
            hasColumnGaps = false;
            break;
          }
        }

        if (hasColumnGaps) {
          tableRows.push(sorted);
        }
      }
    }

    // If we have consecutive rows with similar column structure, it's a table
    if (tableRows.length >= 2) {
      // This is a simplified table detection - a real implementation would be more sophisticated
      const rows: TableRow[] = tableRows.map(rowLines => ({
        id: generateId('row'),
        cells: rowLines.map(line => ({
          id: generateId('cell'),
          content: [{
            id: generateId('para'),
            lines: [line],
            text: line.text,
            boundingBox: line.boundingBox,
            alignment: 'left' as const,
            firstLineIndent: 0
          }],
          boundingBox: line.boundingBox,
          rowSpan: 1,
          colSpan: 1
        })),
        boundingBox: mergeBoundingBoxes(rowLines.map(l => l.boundingBox))
      }));

      if (rows.length > 0) {
        // Calculate column widths
        const columnWidths: number[] = [];
        const firstRow = rows[0];
        for (const cell of firstRow.cells) {
          columnWidths.push(cell.boundingBox.width);
        }

        tables.push({
          id: generateId('table'),
          rows,
          boundingBox: mergeBoundingBoxes(rows.map(r => r.boundingBox)),
          columnWidths
        });
      }
    }

    return tables;
  }

  /**
   * Establish reading order across columns
   */
  private establishReadingOrder(columns: Column[]): TextRun[] {
    const orderedRuns: TextRun[] = [];

    // Sort columns left to right
    const sortedColumns = [...columns].sort((a, b) => a.boundingBox.x - b.boundingBox.x);

    // For each column, process paragraphs top to bottom
    for (const column of sortedColumns) {
      for (const paragraph of column.paragraphs) {
        for (const line of paragraph.lines) {
          for (const word of line.words) {
            orderedRuns.push(...word.runs);
          }
        }
      }
    }

    // If no columns/paragraphs were populated, fall back to simple ordering
    if (orderedRuns.length === 0) {
      return sortByReadingOrder(this.textRuns);
    }

    return orderedRuns;
  }

  /**
   * Find text at a specific point (for selection/editing)
   */
  findTextAtPoint(x: number, y: number): TextRun | null {
    for (const run of this.textRuns) {
      const bbox = run.boundingBox;
      if (x >= bbox.x && x <= bbox.x + bbox.width &&
          y >= bbox.y && y <= bbox.y + bbox.height) {
        return run;
      }
    }
    return null;
  }

  /**
   * Find all text in a rectangular region
   */
  findTextInRegion(region: BoundingBox): TextRun[] {
    return this.textRuns.filter(run => {
      const bbox = run.boundingBox;
      // Check for intersection
      return !(bbox.x + bbox.width < region.x ||
               bbox.x > region.x + region.width ||
               bbox.y + bbox.height < region.y ||
               bbox.y > region.y + region.height);
    });
  }

  /**
   * Get text between two positions (for selection)
   */
  getTextInRange(start: { x: number; y: number }, end: { x: number; y: number }): TextRun[] {
    const region: BoundingBox = {
      x: Math.min(start.x, end.x),
      y: Math.min(start.y, end.y),
      width: Math.abs(end.x - start.x),
      height: Math.abs(end.y - start.y)
    };
    return this.findTextInRegion(region);
  }
}

/**
 * Reading Order Detector
 * More sophisticated reading order detection using spatial analysis
 */
export class ReadingOrderDetector {
  /**
   * Detect reading order using XY-cut algorithm
   */
  static detectUsingXYCut(elements: { boundingBox: BoundingBox }[], pageWidth: number, pageHeight: number): number[] {
    // XY-cut is a recursive algorithm that alternately cuts the page
    // horizontally and vertically at the largest whitespace gaps

    const indices = elements.map((_, i) => i);
    const order: number[] = [];

    function recursiveCut(
      elementIndices: number[],
      minX: number, minY: number, maxX: number, maxY: number,
      horizontal: boolean
    ): void {
      if (elementIndices.length === 0) return;
      if (elementIndices.length === 1) {
        order.push(elementIndices[0]);
        return;
      }

      // Find the largest gap
      const boxes = elementIndices.map(i => elements[i].boundingBox);

      if (horizontal) {
        // Sort by Y and find horizontal cut
        const sortedByY = [...elementIndices].sort((a, b) =>
          elements[a].boundingBox.y - elements[b].boundingBox.y
        );

        let maxGap = 0;
        let cutY = -1;

        for (let i = 1; i < sortedByY.length; i++) {
          const prevBottom = elements[sortedByY[i - 1]].boundingBox.y +
                            elements[sortedByY[i - 1]].boundingBox.height;
          const currTop = elements[sortedByY[i]].boundingBox.y;
          const gap = currTop - prevBottom;

          if (gap > maxGap) {
            maxGap = gap;
            cutY = (prevBottom + currTop) / 2;
          }
        }

        if (maxGap > 10 && cutY > 0) {
          // Make the cut
          const above = elementIndices.filter(i => elements[i].boundingBox.y + elements[i].boundingBox.height / 2 < cutY);
          const below = elementIndices.filter(i => elements[i].boundingBox.y + elements[i].boundingBox.height / 2 >= cutY);

          recursiveCut(above, minX, minY, maxX, cutY, false);
          recursiveCut(below, minX, cutY, maxX, maxY, false);
        } else {
          // Can't cut horizontally, try vertical
          recursiveCut(elementIndices, minX, minY, maxX, maxY, false);
        }
      } else {
        // Sort by X and find vertical cut
        const sortedByX = [...elementIndices].sort((a, b) =>
          elements[a].boundingBox.x - elements[b].boundingBox.x
        );

        let maxGap = 0;
        let cutX = -1;

        for (let i = 1; i < sortedByX.length; i++) {
          const prevRight = elements[sortedByX[i - 1]].boundingBox.x +
                           elements[sortedByX[i - 1]].boundingBox.width;
          const currLeft = elements[sortedByX[i]].boundingBox.x;
          const gap = currLeft - prevRight;

          if (gap > maxGap) {
            maxGap = gap;
            cutX = (prevRight + currLeft) / 2;
          }
        }

        if (maxGap > 10 && cutX > 0) {
          // Make the cut
          const left = elementIndices.filter(i => elements[i].boundingBox.x + elements[i].boundingBox.width / 2 < cutX);
          const right = elementIndices.filter(i => elements[i].boundingBox.x + elements[i].boundingBox.width / 2 >= cutX);

          recursiveCut(left, minX, minY, cutX, maxY, true);
          recursiveCut(right, cutX, minY, maxX, maxY, true);
        } else {
          // Can't cut further, add in current order
          const sorted = [...elementIndices].sort((a, b) => {
            const yDiff = elements[a].boundingBox.y - elements[b].boundingBox.y;
            if (Math.abs(yDiff) > 5) return yDiff;
            return elements[a].boundingBox.x - elements[b].boundingBox.x;
          });
          order.push(...sorted);
        }
      }
    }

    recursiveCut(indices, 0, 0, pageWidth, pageHeight, true);
    return order;
  }
}
