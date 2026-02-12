/**
 * Tier 1 Unit Tests: Cluster Values (table edge detection)
 *
 * Tests for clusterValues from LayoutAnalyzer.ts
 *
 * clusterValues(values: number[], tolerance: number): number[]
 * Returns sorted unique representative values (mean of each cluster).
 */
import { describe, test, expect } from 'vitest';
import { _testExports } from '../LayoutAnalyzer';

const { clusterValues } = _testExports;

describe('clusterValues', () => {
  test('empty array', () => {
    expect(clusterValues([], 3)).toEqual([]);
  });

  test('single value', () => {
    expect(clusterValues([50], 3)).toEqual([50]);
  });

  test('clusters nearby values (returns means)', () => {
    const result = clusterValues([50, 51, 52, 100, 101, 200], 3);
    expect(result).toHaveLength(3);
    // First cluster: mean of [50, 51, 52] = 51
    expect(result[0]).toBeCloseTo(51, 0);
    // Second cluster: mean of [100, 101] = 100.5
    expect(result[1]).toBeCloseTo(100.5, 0);
    // Third cluster: [200]
    expect(result[2]).toBeCloseTo(200, 0);
  });

  test('keeps distinct values that are far apart', () => {
    const result = clusterValues([10, 20, 30, 40], 3);
    expect(result).toHaveLength(4);
    expect(result).toEqual([10, 20, 30, 40]);
  });

  test('handles duplicates', () => {
    const result = clusterValues([50, 50, 50, 100, 100], 3);
    expect(result).toHaveLength(2);
    expect(result[0]).toBeCloseTo(50, 0);
    expect(result[1]).toBeCloseTo(100, 0);
  });

  test('respects tolerance boundary', () => {
    // 10 and 13 are exactly 3 apart — should cluster (within tolerance)
    const close = clusterValues([10, 13], 3);
    expect(close).toHaveLength(1);

    // 10 and 14 are 4 apart — should NOT cluster (exceeds tolerance)
    const far = clusterValues([10, 14], 3);
    expect(far).toHaveLength(2);
  });

  test('real-world border edges from incident report', () => {
    // Simulate: multiple borders at roughly x=50, x=250, x=450
    const edges = [49.5, 50, 50.2, 249, 250, 250.5, 449.8, 450, 451];
    const clustered = clusterValues(edges, 3);
    expect(clustered).toHaveLength(3);
    // First cluster near 50
    expect(clustered[0]).toBeGreaterThan(49);
    expect(clustered[0]).toBeLessThan(51);
    // Second cluster near 250
    expect(clustered[1]).toBeGreaterThan(249);
    expect(clustered[1]).toBeLessThan(251);
    // Third cluster near 450
    expect(clustered[2]).toBeGreaterThan(449);
    expect(clustered[2]).toBeLessThan(452);
  });

  test('unsorted input is handled correctly', () => {
    const result = clusterValues([200, 50, 100, 51, 101, 52], 3);
    expect(result).toHaveLength(3);
    // Should be sorted ascending
    expect(result[0]).toBeLessThan(result[1]);
    expect(result[1]).toBeLessThan(result[2]);
  });

  test('zero tolerance only groups exact duplicates', () => {
    const result = clusterValues([50, 50, 51, 100], 0);
    // 50 and 51 are 1 apart, tolerance 0 means no clustering
    expect(result.length).toBeGreaterThanOrEqual(3);
  });

  test('large tolerance clusters everything', () => {
    const result = clusterValues([10, 20, 30, 40], 100);
    expect(result).toHaveLength(1);
  });
});
