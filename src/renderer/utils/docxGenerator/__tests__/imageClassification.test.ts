/**
 * Tier 1 Unit Tests: Image Classification
 *
 * Tests for classifyImage from PageAnalyzer.ts
 *
 * classifyImage(displayWidth, displayHeight, intrinsicW, intrinsicH, filterName, bitsPerComponent)
 * Returns true if the image is genuine content worth including in DOCX.
 */
import { describe, test, expect } from 'vitest';
import { _testExports } from '../PageAnalyzer';

const { classifyImage } = _testExports;

describe('classifyImage', () => {
  // JPEG images are always genuine
  test('JPEG (DCTDecode) is always genuine regardless of size', () => {
    expect(classifyImage(1, 1, 1, 1, 'DCTDecode', 8)).toBe(true);
  });

  test('JPEG with small intrinsic dimensions is still genuine', () => {
    expect(classifyImage(500, 500, 10, 10, 'DCTDecode', 8)).toBe(true);
  });

  test('large JPEG is genuine', () => {
    expect(classifyImage(400, 300, 800, 600, 'DCTDecode', 8)).toBe(true);
  });

  // Tiny pixel source = UI chrome fill tile
  test('tiny 1x1 pixel is not genuine', () => {
    expect(classifyImage(1000, 1000, 1, 1, 'FlateDecode', 8)).toBe(false);
  });

  test('tiny 2x2 pixel is not genuine', () => {
    expect(classifyImage(400, 300, 2, 2, 'FlateDecode', 8)).toBe(false);
  });

  test('tiny 3x3 pixel is not genuine', () => {
    expect(classifyImage(400, 300, 3, 3, 'FlateDecode', 8)).toBe(false);
  });

  test('tiny area < 16 pixels is not genuine', () => {
    expect(classifyImage(400, 300, 3, 5, 'FlateDecode', 8)).toBe(false); // 15 < 16
  });

  // 1-bit small = form decoration
  test('1-bit small mask is not genuine', () => {
    expect(classifyImage(20, 20, 20, 20, 'FlateDecode', 1)).toBe(false);
  });

  test('1-bit with intrinsic area < 5000 is not genuine', () => {
    expect(classifyImage(100, 100, 50, 50, 'FlateDecode', 1)).toBe(false); // 2500 < 5000
  });

  test('1-bit large image IS genuine (scanned B&W document)', () => {
    expect(classifyImage(612, 792, 2000, 3000, 'FlateDecode', 1)).toBe(true);
  });

  // Small FlateDecode = fill tile
  test('small FlateDecode under 10000 pixels is not genuine', () => {
    expect(classifyImage(30, 30, 30, 30, 'FlateDecode', 8)).toBe(false); // 900 < 10000
  });

  // Reasonable photograph
  test('large FlateDecode (PNG photo) is genuine', () => {
    expect(classifyImage(400, 300, 800, 600, 'FlateDecode', 8)).toBe(true);
  });

  test('medium image above threshold is genuine', () => {
    expect(classifyImage(200, 150, 200, 150, 'FlateDecode', 8)).toBe(true); // 30000 > 10000
  });

  // Edge case: exactly at 10000 pixel threshold
  // The code uses > 10000 (strict), so exactly 10000 is NOT genuine
  test('exactly 10000 pixels is NOT genuine (strict threshold)', () => {
    expect(classifyImage(100, 100, 100, 100, 'FlateDecode', 8)).toBe(false);
  });

  test('just above 10000 is genuine', () => {
    expect(classifyImage(100, 100, 101, 100, 'FlateDecode', 8)).toBe(true); // 10100 > 10000
  });

  test('just below 10000 with 8bpc is not genuine', () => {
    expect(classifyImage(100, 100, 99, 100, 'FlateDecode', 8)).toBe(false); // 9900 < 10000
  });

  // No filter
  test('uncompressed large image is genuine', () => {
    expect(classifyImage(400, 300, 800, 600, '', 8)).toBe(true);
  });

  // Default bitsPerComponent
  test('default bpc is 8 when not specified', () => {
    // Small image without bpc specified should still be classified correctly
    expect(classifyImage(400, 300, 800, 600, 'FlateDecode')).toBe(true);
  });
});
