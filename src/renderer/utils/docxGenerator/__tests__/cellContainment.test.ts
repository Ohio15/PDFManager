/**
 * Tier 1 Unit Tests: Cell Containment
 *
 * Tests for findContainingCell from LayoutAnalyzer.ts
 *
 * findContainingCell(centerX, centerY, colBounds, rowBounds): {row, col} | null
 */
import { describe, test, expect } from 'vitest';
import { _testExports } from '../LayoutAnalyzer';

const { findContainingCell, EDGE_CLUSTER_TOLERANCE } = _testExports;

// Simple 2x2 grid:
// Columns: 50 | 250 | 450
// Rows:    100 | 130 | 160
const colBounds = [50, 250, 450];
const rowBounds = [100, 130, 160];

describe('findContainingCell', () => {
  test('point in top-left cell (row=0, col=0)', () => {
    const result = findContainingCell(100, 115, colBounds, rowBounds);
    expect(result).toEqual({ row: 0, col: 0 });
  });

  test('point in top-right cell (row=0, col=1)', () => {
    const result = findContainingCell(300, 115, colBounds, rowBounds);
    expect(result).toEqual({ row: 0, col: 1 });
  });

  test('point in bottom-left cell (row=1, col=0)', () => {
    const result = findContainingCell(100, 145, colBounds, rowBounds);
    expect(result).toEqual({ row: 1, col: 0 });
  });

  test('point in bottom-right cell (row=1, col=1)', () => {
    const result = findContainingCell(300, 145, colBounds, rowBounds);
    expect(result).toEqual({ row: 1, col: 1 });
  });

  test('point outside table (right of all columns)', () => {
    const result = findContainingCell(500, 115, colBounds, rowBounds);
    expect(result).toBeNull();
  });

  test('point outside table (below all rows)', () => {
    const result = findContainingCell(100, 200, colBounds, rowBounds);
    expect(result).toBeNull();
  });

  test('point outside table (above all rows)', () => {
    const result = findContainingCell(100, 50, colBounds, rowBounds);
    expect(result).toBeNull();
  });

  test('point outside table (left of all columns)', () => {
    const result = findContainingCell(10, 115, colBounds, rowBounds);
    expect(result).toBeNull();
  });

  test('point on column edge (within tolerance)', () => {
    // X = 250 is exactly on the column boundary
    const result = findContainingCell(250, 115, colBounds, rowBounds);
    // Should match one of the cells due to tolerance
    expect(result).not.toBeNull();
  });

  test('point on row edge (within tolerance)', () => {
    // Y = 130 is exactly on the row boundary
    const result = findContainingCell(100, 130, colBounds, rowBounds);
    expect(result).not.toBeNull();
  });

  test('point just inside tolerance at outer edge', () => {
    // Just barely inside the left boundary with tolerance
    const result = findContainingCell(50 - EDGE_CLUSTER_TOLERANCE, 115, colBounds, rowBounds);
    expect(result).toEqual({ row: 0, col: 0 });
  });

  test('3x3 grid navigation', () => {
    const cols = [0, 100, 200, 300];
    const rows = [0, 50, 100, 150];

    expect(findContainingCell(50, 25, cols, rows)).toEqual({ row: 0, col: 0 });
    expect(findContainingCell(150, 25, cols, rows)).toEqual({ row: 0, col: 1 });
    expect(findContainingCell(250, 25, cols, rows)).toEqual({ row: 0, col: 2 });
    expect(findContainingCell(50, 75, cols, rows)).toEqual({ row: 1, col: 0 });
    expect(findContainingCell(150, 75, cols, rows)).toEqual({ row: 1, col: 1 });
    expect(findContainingCell(250, 125, cols, rows)).toEqual({ row: 2, col: 2 });
  });
});
