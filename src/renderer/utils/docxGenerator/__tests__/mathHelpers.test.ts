/**
 * Tier 1 Unit Tests: Math Helpers
 *
 * Tests for multiplyMatrices, applyTransform, cmykToRgb, rgbToHex
 * from PageAnalyzer.ts
 */
import { describe, test, expect } from 'vitest';
import { _testExports } from '../PageAnalyzer';

const { multiplyMatrices, applyTransform, cmykToRgb, rgbToHex } = _testExports;

// ─── multiplyMatrices ────────────────────────────────────────

describe('multiplyMatrices', () => {
  const identity: [number, number, number, number, number, number] = [1, 0, 0, 1, 0, 0];

  test('identity × anything = anything', () => {
    const m: [number, number, number, number, number, number] = [2, 0, 0, 3, 10, 20];
    expect(multiplyMatrices(identity, m)).toEqual([2, 0, 0, 3, 10, 20]);
    expect(multiplyMatrices(m, identity)).toEqual([2, 0, 0, 3, 10, 20]);
  });

  test('identity × identity = identity', () => {
    expect(multiplyMatrices(identity, identity)).toEqual([1, 0, 0, 1, 0, 0]);
  });

  test('scale matrix multiplication', () => {
    const scale2x: [number, number, number, number, number, number] = [2, 0, 0, 2, 0, 0];
    const translate: [number, number, number, number, number, number] = [1, 0, 0, 1, 50, 100];
    // multiplyMatrices(m1, m2): m1 applied first, then m2 (PDF convention)
    // scale first, then translate: translation is NOT affected by scale
    const result = multiplyMatrices(scale2x, translate);
    expect(result[0]).toBeCloseTo(2);
    expect(result[3]).toBeCloseTo(2);
    expect(result[4]).toBeCloseTo(50);
    expect(result[5]).toBeCloseTo(100);
  });

  test('rotation matrix (90 degrees)', () => {
    // 90-degree rotation: [cos(90), sin(90), -sin(90), cos(90), 0, 0] = [0, 1, -1, 0, 0, 0]
    const rot90: [number, number, number, number, number, number] = [0, 1, -1, 0, 0, 0];
    const result = multiplyMatrices(rot90, identity);
    expect(result).toEqual([0, 1, -1, 0, 0, 0]);
  });

  test('scale + translate composition', () => {
    const scale: [number, number, number, number, number, number] = [0.5, 0, 0, 0.5, 0, 0];
    const translate: [number, number, number, number, number, number] = [1, 0, 0, 1, 100, 200];
    // multiplyMatrices(translate, scale): translate first, then scale
    // Translation (100, 200) gets scaled by 0.5 -> (50, 100)
    const combined = multiplyMatrices(translate, scale);
    const pt = applyTransform({ x: 0, y: 0 }, combined);
    expect(pt.x).toBeCloseTo(50);
    expect(pt.y).toBeCloseTo(100);
  });

  test('two translations compose', () => {
    const t1: [number, number, number, number, number, number] = [1, 0, 0, 1, 10, 20];
    const t2: [number, number, number, number, number, number] = [1, 0, 0, 1, 30, 40];
    const result = multiplyMatrices(t1, t2);
    expect(result[4]).toBeCloseTo(40); // 10 + 30
    expect(result[5]).toBeCloseTo(60); // 20 + 40
  });
});

// ─── applyTransform ──────────────────────────────────────────

describe('applyTransform', () => {
  test('identity transform — no change', () => {
    const result = applyTransform({ x: 10, y: 20 }, [1, 0, 0, 1, 0, 0]);
    expect(result.x).toBeCloseTo(10);
    expect(result.y).toBeCloseTo(20);
  });

  test('translation only', () => {
    const result = applyTransform({ x: 10, y: 20 }, [1, 0, 0, 1, 30, 40]);
    expect(result.x).toBeCloseTo(40);
    expect(result.y).toBeCloseTo(60);
  });

  test('scale only', () => {
    const result = applyTransform({ x: 10, y: 20 }, [2, 0, 0, 3, 0, 0]);
    expect(result.x).toBeCloseTo(20);
    expect(result.y).toBeCloseTo(60);
  });

  test('rotation 90 degrees', () => {
    const rot90: [number, number, number, number, number, number] = [0, 1, -1, 0, 0, 0];
    const result = applyTransform({ x: 10, y: 0 }, rot90);
    expect(result.x).toBeCloseTo(0);
    expect(result.y).toBeCloseTo(10);
  });

  test('origin point with translation', () => {
    const result = applyTransform({ x: 0, y: 0 }, [1, 0, 0, 1, 100, 200]);
    expect(result.x).toBeCloseTo(100);
    expect(result.y).toBeCloseTo(200);
  });

  test('combined scale and translate', () => {
    // ctm = [2, 0, 0, 2, 50, 100] -> scale by 2, then translate by (50, 100)
    const result = applyTransform({ x: 10, y: 20 }, [2, 0, 0, 2, 50, 100]);
    // x' = 10*2 + 20*0 + 50 = 70
    // y' = 10*0 + 20*2 + 100 = 140
    expect(result.x).toBeCloseTo(70);
    expect(result.y).toBeCloseTo(140);
  });
});

// ─── cmykToRgb ───────────────────────────────────────────────

describe('cmykToRgb', () => {
  test('pure black', () => {
    const result = cmykToRgb(0, 0, 0, 1);
    expect(result.r).toBeCloseTo(0);
    expect(result.g).toBeCloseTo(0);
    expect(result.b).toBeCloseTo(0);
  });

  test('pure white', () => {
    const result = cmykToRgb(0, 0, 0, 0);
    expect(result.r).toBeCloseTo(1);
    expect(result.g).toBeCloseTo(1);
    expect(result.b).toBeCloseTo(1);
  });

  test('pure cyan', () => {
    const result = cmykToRgb(1, 0, 0, 0);
    expect(result.r).toBeCloseTo(0);
    expect(result.g).toBeCloseTo(1);
    expect(result.b).toBeCloseTo(1);
  });

  test('pure magenta', () => {
    const result = cmykToRgb(0, 1, 0, 0);
    expect(result.r).toBeCloseTo(1);
    expect(result.g).toBeCloseTo(0);
    expect(result.b).toBeCloseTo(1);
  });

  test('pure yellow', () => {
    const result = cmykToRgb(0, 0, 1, 0);
    expect(result.r).toBeCloseTo(1);
    expect(result.g).toBeCloseTo(1);
    expect(result.b).toBeCloseTo(0);
  });

  test('50% gray', () => {
    const result = cmykToRgb(0, 0, 0, 0.5);
    expect(result.r).toBeCloseTo(0.5);
    expect(result.g).toBeCloseTo(0.5);
    expect(result.b).toBeCloseTo(0.5);
  });

  test('mixed CMYK values', () => {
    // C=0.2, M=0.3, Y=0.4, K=0.1
    const result = cmykToRgb(0.2, 0.3, 0.4, 0.1);
    expect(result.r).toBeCloseTo((1 - 0.2) * (1 - 0.1));
    expect(result.g).toBeCloseTo((1 - 0.3) * (1 - 0.1));
    expect(result.b).toBeCloseTo((1 - 0.4) * (1 - 0.1));
  });
});

// ─── rgbToHex (PageAnalyzer version - takes r, g, b as numbers) ──

describe('rgbToHex', () => {
  test('black', () => {
    expect(rgbToHex(0, 0, 0)).toBe('000000');
  });

  test('white', () => {
    expect(rgbToHex(1, 1, 1)).toBe('ffffff');
  });

  test('red', () => {
    expect(rgbToHex(1, 0, 0)).toBe('ff0000');
  });

  test('green', () => {
    expect(rgbToHex(0, 1, 0)).toBe('00ff00');
  });

  test('blue', () => {
    expect(rgbToHex(0, 0, 1)).toBe('0000ff');
  });

  test('typical gray', () => {
    const hex = rgbToHex(0.75, 0.75, 0.75);
    expect(hex).toBe('bfbfbf');
  });

  test('clamps values above 1', () => {
    expect(rgbToHex(1.5, 0, 0)).toBe('ff0000');
  });

  test('clamps values below 0', () => {
    expect(rgbToHex(-0.5, 0, 0)).toBe('000000');
  });
});
