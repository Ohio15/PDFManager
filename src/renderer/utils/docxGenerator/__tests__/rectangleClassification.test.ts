/**
 * Tier 1 Unit Tests: Rectangle Classification
 *
 * Tests for classifyRectangles from LayoutAnalyzer.ts
 *
 * classifyRectangles(scene: PageScene): Map<RectElement, RectRole>
 */
import { describe, test, expect } from 'vitest';
import { _testExports } from '../LayoutAnalyzer';
import type { PageScene, RectElement, RectRole } from '../types';

const { classifyRectangles } = _testExports;

const PAGE_WIDTH = 612;
const PAGE_HEIGHT = 792;

function makeScene(rects: RectElement[]): PageScene {
  return {
    elements: rects,
    formFields: [],
    width: PAGE_WIDTH,
    height: PAGE_HEIGHT,
  };
}

function makeRect(overrides: Partial<RectElement>): RectElement {
  return {
    kind: 'rect',
    x: 0,
    y: 0,
    width: 100,
    height: 50,
    fillColor: null,
    strokeColor: null,
    lineWidth: 1,
    ...overrides,
  };
}

describe('classifyRectangles', () => {
  // Thin horizontal line → separator
  test('thin horizontal line → separator', () => {
    const rect = makeRect({
      width: 400, height: 1,
      strokeColor: { r: 0, g: 0, b: 0 },
    });
    const scene = makeScene([rect]);
    const roles = classifyRectangles(scene);
    expect(roles.get(rect)).toBe('separator');
  });

  // Thin vertical line → separator
  test('thin vertical line → separator', () => {
    const rect = makeRect({
      width: 1, height: 500,
      strokeColor: { r: 0, g: 0, b: 0 },
    });
    const scene = makeScene([rect]);
    const roles = classifyRectangles(scene);
    expect(roles.get(rect)).toBe('separator');
  });

  // Stroked rectangle → table-border
  test('stroked rectangle → table-border', () => {
    const rect = makeRect({
      width: 200, height: 30,
      strokeColor: { r: 0, g: 0, b: 0 },
      fillColor: null,
      lineWidth: 1,
    });
    const scene = makeScene([rect]);
    const roles = classifyRectangles(scene);
    expect(roles.get(rect)).toBe('table-border');
  });

  // Stroked + filled → table-border (strokeColor check comes first)
  test('stroked and filled rectangle → table-border', () => {
    const rect = makeRect({
      width: 200, height: 30,
      strokeColor: { r: 0, g: 0, b: 0 },
      fillColor: { r: 0.9, g: 0.9, b: 0.9 },
      lineWidth: 1,
    });
    const scene = makeScene([rect]);
    const roles = classifyRectangles(scene);
    expect(roles.get(rect)).toBe('table-border');
  });

  // Full-page fill → page-background
  test('full-page fill → page-background', () => {
    const rect = makeRect({
      x: 0, y: 0,
      width: PAGE_WIDTH, height: PAGE_HEIGHT,
      fillColor: { r: 1, g: 1, b: 1 },
      strokeColor: null,
    });
    const scene = makeScene([rect]);
    const roles = classifyRectangles(scene);
    expect(roles.get(rect)).toBe('page-background');
  });

  // Filled rect → cell-fill
  test('moderate filled rect → cell-fill', () => {
    const rect = makeRect({
      width: 150, height: 25,
      fillColor: { r: 0.75, g: 0.75, b: 0.75 },
      strokeColor: null,
    });
    const scene = makeScene([rect]);
    const roles = classifyRectangles(scene);
    expect(roles.get(rect)).toBe('cell-fill');
  });

  // No fill, no stroke → decorative
  test('no fill and no stroke → decorative', () => {
    const rect = makeRect({
      width: 100, height: 50,
      fillColor: null,
      strokeColor: null,
      lineWidth: 0,
    });
    const scene = makeScene([rect]);
    const roles = classifyRectangles(scene);
    expect(roles.get(rect)).toBe('decorative');
  });

  // Multiple rects classified correctly
  test('multiple rects get correct roles', () => {
    const border = makeRect({
      x: 50, y: 100, width: 200, height: 30,
      strokeColor: { r: 0, g: 0, b: 0 },
    });
    const fill = makeRect({
      x: 50, y: 100, width: 200, height: 30,
      fillColor: { r: 0.9, g: 0.9, b: 0.9 },
      strokeColor: null,
    });
    const separator = makeRect({
      x: 0, y: 50, width: 400, height: 0.5,
      strokeColor: { r: 0, g: 0, b: 0 },
    });

    const scene = makeScene([border, fill, separator]);
    const roles = classifyRectangles(scene);

    expect(roles.get(border)).toBe('table-border');
    expect(roles.get(fill)).toBe('cell-fill');
    expect(roles.get(separator)).toBe('separator');
  });

  // Non-rect elements are ignored
  test('non-rect elements are ignored', () => {
    const scene: PageScene = {
      elements: [
        { kind: 'text', text: 'Hello', x: 0, y: 0, width: 50, height: 12,
          fontName: 'Arial', fontSize: 12, bold: false, italic: false, color: '000000' },
      ],
      formFields: [],
      width: PAGE_WIDTH,
      height: PAGE_HEIGHT,
    };
    const roles = classifyRectangles(scene);
    expect(roles.size).toBe(0);
  });
});
