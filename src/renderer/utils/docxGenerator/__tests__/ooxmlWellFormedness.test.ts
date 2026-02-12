/**
 * Tier 1 Unit Tests: OOXML Well-Formedness
 *
 * Validates that generated XML fragments are parseable as valid XML.
 * Uses a simple DOMParser-style check to verify structure.
 */
import { describe, test, expect } from 'vitest';
import { escXml, _testExports } from '../OoxmlParts';
import { StyleCollector } from '../StyleCollector';
import type { FormField, TextElement, DetectedTable, DetectedCell } from '../types';

const { generateFormFieldRuns, renderTextRunsFromElements, generateTableFromDetected } = _testExports;

// ─── XML Validation Helper ───────────────────────────────────

/**
 * Simple well-formedness check: verify that the XML fragment has
 * balanced tags and no obvious syntax errors.
 * We wrap in a root with OOXML namespace and verify it can parse.
 */
function assertWellFormedXml(fragment: string): void {
  const wrapped = `<?xml version="1.0"?><root xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture">${fragment}</root>`;

  // Check basic XML well-formedness:
  // 1. All < have matching >
  // 2. No unescaped & (except entity refs)
  // 3. Tags are balanced (simplified check)

  // Count opening and self-closing tags vs closing tags
  const openingTags = wrapped.match(/<[a-zA-Z][^/]*?[^/]>/g) || [];
  const closingTags = wrapped.match(/<\/[^>]+>/g) || [];
  const selfClosing = wrapped.match(/<[^>]+\/>/g) || [];

  // Basic sanity: document should have roughly balanced tags
  // (This is a simplified check — not a full XML parser)
  expect(openingTags.length).toBeGreaterThanOrEqual(closingTags.length - 1);

  // Verify no raw & (must be &amp;, &lt;, etc.)
  const rawAmpersands = wrapped.match(/&(?!(amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);)/g);
  expect(rawAmpersands).toBeNull();

  // Verify all < are part of tags (no raw < in content)
  // Simple heuristic: every < should be followed by a tag name, /, !, or ?
  const rawLessThan = wrapped.match(/<(?![a-zA-Z?!/])/g);
  expect(rawLessThan).toBeNull();
}

// ─── Test Helpers ────────────────────────────────────────────

function makeTextField(overrides?: Partial<FormField>): FormField {
  return {
    fieldType: 'Tx', fieldName: 'form[0].name[0]', fieldValue: '',
    isCheckBox: false, isRadioButton: false, isChecked: false,
    options: [], readOnly: false, rect: [100, 200, 300, 220],
    x: 100, y: 200, width: 200, height: 20, maxLength: 0,
    ...overrides,
  };
}

function makeCheckbox(overrides?: Partial<FormField>): FormField {
  return {
    fieldType: 'Btn', fieldName: 'form[0].agree[0]', fieldValue: 'Off',
    isCheckBox: true, isRadioButton: false, isChecked: false,
    options: [], readOnly: false, rect: [100, 200, 115, 215],
    x: 100, y: 200, width: 15, height: 15, maxLength: 0,
    ...overrides,
  };
}

function makeDropdown(overrides?: Partial<FormField>): FormField {
  return {
    fieldType: 'Ch', fieldName: 'form[0].state[0]', fieldValue: 'CA',
    isCheckBox: false, isRadioButton: false, isChecked: false,
    options: [
      { exportValue: 'CA', displayValue: 'California' },
      { exportValue: 'NY', displayValue: 'New York' },
    ],
    readOnly: false, rect: [100, 200, 250, 220],
    x: 100, y: 200, width: 150, height: 20, maxLength: 0,
    ...overrides,
  };
}

function makeTextElement(overrides?: Partial<TextElement>): TextElement {
  return {
    kind: 'text', x: 0, y: 0, width: 100, height: 12,
    text: 'Hello World', fontSize: 12, fontName: 'Arial',
    bold: false, italic: false, color: '000000',
    ...overrides,
  };
}

function make2x2Table(): DetectedTable {
  const cells: DetectedCell[] = [
    { row: 0, col: 0, rowSpan: 1, colSpan: 1, x: 50, y: 100, width: 200, height: 30, fillColor: null, texts: [], formFields: [] },
    { row: 0, col: 1, rowSpan: 1, colSpan: 1, x: 250, y: 100, width: 200, height: 30, fillColor: null, texts: [], formFields: [] },
    { row: 1, col: 0, rowSpan: 1, colSpan: 1, x: 50, y: 130, width: 200, height: 30, fillColor: null, texts: [], formFields: [] },
    { row: 1, col: 1, rowSpan: 1, colSpan: 1, x: 250, y: 130, width: 200, height: 30, fillColor: null, texts: [], formFields: [] },
  ];

  return {
    cells,
    rows: 2,
    cols: 2,
    columnWidths: [200, 200],
    rowHeights: [30, 30],
    x: 50,
    y: 100,
    width: 400,
    height: 60,
  };
}

// ─── Tests ───────────────────────────────────────────────────

describe('OOXML well-formedness', () => {
  test('text input field XML is well-formed', () => {
    const xml = generateFormFieldRuns(makeTextField());
    assertWellFormedXml(xml);
  });

  test('text input with value is well-formed', () => {
    const xml = generateFormFieldRuns(makeTextField({ fieldValue: 'John Doe' }));
    assertWellFormedXml(xml);
  });

  test('text input with special chars is well-formed', () => {
    const xml = generateFormFieldRuns(makeTextField({ fieldValue: 'A & B <Corp>' }));
    assertWellFormedXml(xml);
  });

  test('checkbox XML is well-formed', () => {
    const xml = generateFormFieldRuns(makeCheckbox());
    assertWellFormedXml(xml);
  });

  test('checked checkbox XML is well-formed', () => {
    const xml = generateFormFieldRuns(makeCheckbox({ isChecked: true }));
    assertWellFormedXml(xml);
  });

  test('dropdown XML is well-formed', () => {
    const xml = generateFormFieldRuns(makeDropdown());
    assertWellFormedXml(xml);
  });

  test('text runs are well-formed', () => {
    const texts: TextElement[] = [
      makeTextElement({ text: 'Hello', x: 0 }),
      makeTextElement({ text: 'World', x: 60 }),
    ];
    const styleCollector = new StyleCollector();
    const normalStyle = styleCollector.getNormalStyle();
    const xml = renderTextRunsFromElements(texts, normalStyle, styleCollector);
    assertWellFormedXml(xml);
  });

  test('bold italic text run is well-formed', () => {
    const texts: TextElement[] = [
      makeTextElement({ text: 'Bold Italic', bold: true, italic: true }),
    ];
    const styleCollector = new StyleCollector();
    const normalStyle = styleCollector.getNormalStyle();
    const xml = renderTextRunsFromElements(texts, normalStyle, styleCollector);
    assertWellFormedXml(xml);
  });

  test('table XML is well-formed', () => {
    const table = make2x2Table();
    const styleCollector = new StyleCollector();
    const normalStyle = styleCollector.getNormalStyle();
    const xml = generateTableFromDetected(table, [], normalStyle, styleCollector);
    assertWellFormedXml(xml);
  });

  test('table with cell content is well-formed', () => {
    const table = make2x2Table();
    table.cells[0].texts.push(
      makeTextElement({ text: 'Name:', x: 55, y: 105, bold: true })
    );
    const styleCollector = new StyleCollector();
    const normalStyle = styleCollector.getNormalStyle();
    const xml = generateTableFromDetected(table, [], normalStyle, styleCollector);
    assertWellFormedXml(xml);
  });

  test('empty cell produces valid XML', () => {
    const table = make2x2Table();
    const styleCollector = new StyleCollector();
    const normalStyle = styleCollector.getNormalStyle();
    const xml = generateTableFromDetected(table, [], normalStyle, styleCollector);
    // Empty cells should have <w:p/> placeholder
    expect(xml).toContain('<w:p/>');
    assertWellFormedXml(xml);
  });

  test('table with cell fills is well-formed', () => {
    const table = make2x2Table();
    table.cells[0].fillColor = { r: 0.9, g: 0.9, b: 0.9 };
    const styleCollector = new StyleCollector();
    const normalStyle = styleCollector.getNormalStyle();
    const xml = generateTableFromDetected(table, [], normalStyle, styleCollector);
    expect(xml).toContain('w:shd');
    assertWellFormedXml(xml);
  });

  test('table with merged cells is well-formed', () => {
    const table = make2x2Table();
    // Merge first two columns in first row
    table.cells[0].colSpan = 2;
    table.cells[0].width = 400;
    // Remove the second cell in first row (absorbed by merge)
    table.cells = table.cells.filter(c => !(c.row === 0 && c.col === 1));

    const styleCollector = new StyleCollector();
    const normalStyle = styleCollector.getNormalStyle();
    const xml = generateTableFromDetected(table, [], normalStyle, styleCollector);
    expect(xml).toContain('w:gridSpan');
    assertWellFormedXml(xml);
  });

  test('table with form fields in cells is well-formed', () => {
    const table = make2x2Table();
    table.cells[0].formFields.push(makeTextField({
      fieldName: 'name', x: 55, y: 105, width: 190, height: 20,
    }));
    const styleCollector = new StyleCollector();
    const normalStyle = styleCollector.getNormalStyle();
    const xml = generateTableFromDetected(table, [], normalStyle, styleCollector);
    expect(xml).toContain('FORMTEXT');
    assertWellFormedXml(xml);
  });
});
