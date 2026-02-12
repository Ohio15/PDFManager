/**
 * Tier 1 Unit Tests: StyleCollector
 *
 * Tests for the style tracking and Normal style derivation.
 */
import { describe, test, expect } from 'vitest';
import { StyleCollector } from '../StyleCollector';

describe('StyleCollector', () => {
  test('default Normal style when no runs registered', () => {
    const sc = new StyleCollector();
    const normal = sc.getNormalStyle();
    expect(normal.fontName).toBe('Calibri');
    expect(normal.fontSize).toBe(22); // 11pt in half-points
    expect(normal.bold).toBe(false);
    expect(normal.italic).toBe(false);
    expect(normal.color).toBe('000000');
  });

  test('most frequent style becomes Normal', () => {
    const sc = new StyleCollector();
    // Register Arial 24 (12pt) 5 times
    for (let i = 0; i < 5; i++) {
      sc.registerRun('Arial', 24, false, false, '000000');
    }
    // Register Times 20 (10pt) 2 times
    for (let i = 0; i < 2; i++) {
      sc.registerRun('Times New Roman', 20, false, false, '000000');
    }

    const normal = sc.getNormalStyle();
    expect(normal.fontName).toBe('Arial');
    expect(normal.fontSize).toBe(24);
  });

  test('registerRun returns consistent styleId', () => {
    const sc = new StyleCollector();
    const id1 = sc.registerRun('Arial', 24, false, false, '000000');
    const id2 = sc.registerRun('Arial', 24, false, false, '000000');
    expect(id1).toBe(id2);
  });

  test('different formatting gets different styleId', () => {
    const sc = new StyleCollector();
    const id1 = sc.registerRun('Arial', 24, false, false, '000000');
    const id2 = sc.registerRun('Arial', 24, true, false, '000000'); // bold
    expect(id1).not.toBe(id2);
  });

  test('getUsedStyles excludes Normal', () => {
    const sc = new StyleCollector();
    for (let i = 0; i < 5; i++) {
      sc.registerRun('Arial', 24, false, false, '000000');
    }
    sc.registerRun('Arial', 24, true, false, '000000'); // bold variant

    const used = sc.getUsedStyles();
    const normal = sc.getNormalStyle();

    // Used styles should not include the Normal style
    expect(used.find(s => s.id === normal.id)).toBeUndefined();
    // But should include the bold variant
    expect(used.length).toBe(1);
    expect(used[0].bold).toBe(true);
  });

  test('getUsedFonts includes all fonts plus Calibri', () => {
    const sc = new StyleCollector();
    sc.registerRun('Arial', 24, false, false, '000000');
    sc.registerRun('Times New Roman', 20, false, false, '000000');

    const fonts = sc.getUsedFonts();
    expect(fonts).toContain('Arial');
    expect(fonts).toContain('Times New Roman');
    expect(fonts).toContain('Calibri');
  });

  test('isNormalStyle checks against most frequent', () => {
    const sc = new StyleCollector();
    const normalId = sc.registerRun('Arial', 24, false, false, '000000');
    sc.registerRun('Arial', 24, false, false, '000000'); // bump count
    sc.registerRun('Times New Roman', 20, false, false, '000000');

    expect(sc.isNormalStyle(normalId)).toBe(true);
  });
});
