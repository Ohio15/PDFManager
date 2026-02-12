/**
 * Tier 1 Unit Tests: OOXML Form Field Generation
 *
 * Tests for generateFormFieldRuns (dispatcher), generateTextFieldRuns,
 * generateCheckBoxRuns, generateDropdownRuns from OoxmlParts.ts
 */
import { describe, test, expect } from 'vitest';
import { _testExports } from '../OoxmlParts';
import type { FormField } from '../types';

const { generateFormFieldRuns, sanitizeFieldName } = _testExports;

// ─── Test Helpers ────────────────────────────────────────────

function makeTextField(overrides?: Partial<FormField>): FormField {
  return {
    fieldType: 'Tx',
    fieldName: 'form[0].name[0]',
    fieldValue: '',
    isCheckBox: false,
    isRadioButton: false,
    isChecked: false,
    options: [],
    readOnly: false,
    rect: [100, 200, 300, 220],
    x: 100,
    y: 200,
    width: 200,
    height: 20,
    maxLength: 0,
    ...overrides,
  };
}

function makeCheckbox(overrides?: Partial<FormField>): FormField {
  return {
    fieldType: 'Btn',
    fieldName: 'form[0].agree[0]',
    fieldValue: 'Off',
    isCheckBox: true,
    isRadioButton: false,
    isChecked: false,
    options: [],
    readOnly: false,
    rect: [100, 200, 115, 215],
    x: 100,
    y: 200,
    width: 15,
    height: 15,
    maxLength: 0,
    ...overrides,
  };
}

function makeDropdown(overrides?: Partial<FormField>): FormField {
  return {
    fieldType: 'Ch',
    fieldName: 'form[0].state[0]',
    fieldValue: 'CA',
    isCheckBox: false,
    isRadioButton: false,
    isChecked: false,
    options: [
      { exportValue: 'CA', displayValue: 'California' },
      { exportValue: 'NY', displayValue: 'New York' },
      { exportValue: 'TX', displayValue: 'Texas' },
    ],
    readOnly: false,
    rect: [100, 200, 250, 220],
    x: 100,
    y: 200,
    width: 150,
    height: 20,
    maxLength: 0,
    ...overrides,
  };
}

// ─── Text Input ──────────────────────────────────────────────

describe('Text Input (FORMTEXT)', () => {
  test('contains FORMTEXT', () => {
    const xml = generateFormFieldRuns(makeTextField());
    expect(xml).toContain('FORMTEXT');
  });

  test('has begin/separate/end fldChar sequence in correct order', () => {
    const xml = generateFormFieldRuns(makeTextField());
    const beginIdx = xml.indexOf('fldCharType="begin"');
    const sepIdx = xml.indexOf('fldCharType="separate"');
    const endIdx = xml.indexOf('fldCharType="end"');
    expect(beginIdx).toBeGreaterThan(-1);
    expect(sepIdx).toBeGreaterThan(-1);
    expect(endIdx).toBeGreaterThan(-1);
    expect(beginIdx).toBeLessThan(sepIdx);
    expect(sepIdx).toBeLessThan(endIdx);
  });

  test('has sanitized field name', () => {
    const xml = generateFormFieldRuns(makeTextField({ fieldName: 'top[0].page[0].f1_name[0]' }));
    expect(xml).toContain('w:val="f1_name"');
    expect(xml).not.toContain('[0]');
  });

  test('has ffData with textInput element', () => {
    const xml = generateFormFieldRuns(makeTextField());
    expect(xml).toContain('<w:ffData>');
    expect(xml).toContain('<w:textInput');
    expect(xml).toContain('<w:enabled/>');
  });

  test('preserves existing value', () => {
    const xml = generateFormFieldRuns(makeTextField({ fieldValue: 'John Doe' }));
    expect(xml).toContain('John Doe');
  });

  test('uses placeholder spaces when empty', () => {
    const xml = generateFormFieldRuns(makeTextField({ fieldValue: '' }));
    expect(xml).toContain('xml:space="preserve"');
  });

  test('escapes XML special chars in value', () => {
    const xml = generateFormFieldRuns(makeTextField({ fieldValue: 'A & B <Corp>' }));
    expect(xml).toContain('A &amp; B &lt;Corp&gt;');
    expect(xml).not.toContain('A & B');
  });

  test('includes maxLength when specified', () => {
    const xml = generateFormFieldRuns(makeTextField({ maxLength: 50 }));
    expect(xml).toContain('w:maxLength');
    expect(xml).toContain('w:val="50"');
  });
});

// ─── Checkbox ────────────────────────────────────────────────

describe('Checkbox (FORMCHECKBOX)', () => {
  test('contains FORMCHECKBOX', () => {
    const xml = generateFormFieldRuns(makeCheckbox());
    expect(xml).toContain('FORMCHECKBOX');
  });

  test('unchecked checkbox has default val 0', () => {
    const xml = generateFormFieldRuns(makeCheckbox({ isChecked: false }));
    expect(xml).toContain('w:val="0"');
  });

  test('checked checkbox has default val 1', () => {
    const xml = generateFormFieldRuns(makeCheckbox({ isChecked: true }));
    expect(xml).toContain('w:val="1"');
  });

  test('checkbox has sizeAuto', () => {
    const xml = generateFormFieldRuns(makeCheckbox());
    expect(xml).toContain('<w:sizeAuto/>');
  });

  test('has begin/separate/end sequence', () => {
    const xml = generateFormFieldRuns(makeCheckbox());
    const beginIdx = xml.indexOf('fldCharType="begin"');
    const sepIdx = xml.indexOf('fldCharType="separate"');
    const endIdx = xml.indexOf('fldCharType="end"');
    expect(beginIdx).toBeLessThan(sepIdx);
    expect(sepIdx).toBeLessThan(endIdx);
  });

  test('has sanitized field name', () => {
    const xml = generateFormFieldRuns(makeCheckbox({ fieldName: 'form[0].agree[0]' }));
    expect(xml).toContain('w:val="agree"');
  });
});

// ─── Dropdown ────────────────────────────────────────────────

describe('Dropdown (FORMDROPDOWN)', () => {
  test('contains FORMDROPDOWN', () => {
    const xml = generateFormFieldRuns(makeDropdown());
    expect(xml).toContain('FORMDROPDOWN');
  });

  test('lists all options', () => {
    const xml = generateFormFieldRuns(makeDropdown());
    expect(xml).toContain('California');
    expect(xml).toContain('New York');
    expect(xml).toContain('Texas');
  });

  test('selects correct index for matching value', () => {
    const xml = generateFormFieldRuns(makeDropdown({ fieldValue: 'NY' }));
    // NY is at index 1
    expect(xml).toContain('w:val="1"');
  });

  test('selects index 0 for first option', () => {
    const xml = generateFormFieldRuns(makeDropdown({ fieldValue: 'CA' }));
    expect(xml).toContain('w:val="0"');
  });

  test('defaults to index 0 if value not found', () => {
    const xml = generateFormFieldRuns(makeDropdown({ fieldValue: 'XX' }));
    expect(xml).toContain('<w:result w:val="0"/>');
  });

  test('has begin/separate/end sequence', () => {
    const xml = generateFormFieldRuns(makeDropdown());
    const beginIdx = xml.indexOf('fldCharType="begin"');
    const sepIdx = xml.indexOf('fldCharType="separate"');
    const endIdx = xml.indexOf('fldCharType="end"');
    expect(beginIdx).toBeLessThan(sepIdx);
    expect(sepIdx).toBeLessThan(endIdx);
  });
});

// ─── Dispatcher ──────────────────────────────────────────────

describe('Form field dispatcher', () => {
  test('routes Tx to text input', () => {
    const xml = generateFormFieldRuns(makeTextField());
    expect(xml).toContain('FORMTEXT');
  });

  test('routes Btn to checkbox', () => {
    const xml = generateFormFieldRuns(makeCheckbox());
    expect(xml).toContain('FORMCHECKBOX');
  });

  test('routes Ch to dropdown', () => {
    const xml = generateFormFieldRuns(makeDropdown());
    expect(xml).toContain('FORMDROPDOWN');
  });

  test('returns empty for unknown type', () => {
    const field = makeTextField({ fieldType: 'Sig' as any });
    expect(generateFormFieldRuns(field)).toBe('');
  });
});
