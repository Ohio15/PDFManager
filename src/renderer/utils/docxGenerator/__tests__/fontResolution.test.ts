/**
 * Tier 1 Unit Tests: Font Resolution and Text Helpers
 *
 * Tests for resolveFontFamily, isBoldFont, isItalicFont from PageAnalyzer.ts
 * Tests for escXml from OoxmlParts.ts
 * Tests for sanitizeFieldName from OoxmlParts.ts
 */
import { describe, test, expect } from 'vitest';
import { _testExports } from '../PageAnalyzer';
import { escXml, _testExports as ooxmlExports } from '../OoxmlParts';

const { resolveFontFamily, isBoldFont, isItalicFont } = _testExports;
const { sanitizeFieldName, mapFontName } = ooxmlExports;

// ─── resolveFontFamily ───────────────────────────────────────

describe('resolveFontFamily', () => {
  test('maps ArialMT', () => {
    expect(resolveFontFamily('ArialMT')).toBe('Arial');
  });

  test('maps Helvetica', () => {
    expect(resolveFontFamily('Helvetica')).toBe('Arial');
  });

  test('maps Helvetica-Bold', () => {
    expect(resolveFontFamily('Helvetica-Bold')).toBe('Arial');
  });

  test('maps TimesNewRomanPSMT', () => {
    expect(resolveFontFamily('TimesNewRomanPSMT')).toBe('Times New Roman');
  });

  test('maps CourierNewPSMT', () => {
    expect(resolveFontFamily('CourierNewPSMT')).toBe('Courier New');
  });

  test('strips subset prefix', () => {
    expect(resolveFontFamily('ABCDEF+ArialMT')).toBe('Arial');
  });

  test('strips subset prefix for Helvetica', () => {
    expect(resolveFontFamily('BCDFGH+Helvetica')).toBe('Arial');
  });

  test('handles null/undefined', () => {
    expect(resolveFontFamily(null as any)).toBe('Calibri');
    expect(resolveFontFamily(undefined as any)).toBe('Calibri');
    expect(resolveFontFamily('')).toBe('Calibri');
  });

  test('strips Bold suffix from unknown font', () => {
    expect(resolveFontFamily('MyCustomFont-Bold')).toBe('MyCustomFont');
  });

  test('strips Italic suffix from unknown font', () => {
    expect(resolveFontFamily('MyCustomFont-Italic')).toBe('MyCustomFont');
  });

  test('strips MT suffix', () => {
    expect(resolveFontFamily('SomeFontMT')).toBe('SomeFont');
  });

  test('maps ZapfDingbats', () => {
    expect(resolveFontFamily('ZapfDingbats')).toBe('Wingdings');
  });

  test('maps Symbol', () => {
    expect(resolveFontFamily('Symbol')).toBe('Symbol');
  });
});

// ─── isBoldFont / isItalicFont ───────────────────────────────

describe('isBoldFont', () => {
  test('detects bold in name', () => {
    expect(isBoldFont('Arial-Bold')).toBe(true);
    expect(isBoldFont('Arial-BoldMT')).toBe(true);
    expect(isBoldFont('HelveticaBold')).toBe(true);
  });

  test('returns false for non-bold', () => {
    expect(isBoldFont('Arial')).toBe(false);
    expect(isBoldFont('ArialMT')).toBe(false);
  });
});

describe('isItalicFont', () => {
  test('detects italic in name', () => {
    expect(isItalicFont('Arial-Italic')).toBe(true);
    expect(isItalicFont('Arial-ItalicMT')).toBe(true);
  });

  test('detects oblique as italic', () => {
    expect(isItalicFont('Helvetica-Oblique')).toBe(true);
  });

  test('returns false for non-italic', () => {
    expect(isItalicFont('Arial')).toBe(false);
    expect(isItalicFont('ArialMT')).toBe(false);
  });
});

// ─── escXml ──────────────────────────────────────────────────

describe('escXml', () => {
  test('escapes ampersand', () => {
    expect(escXml('A & B')).toBe('A &amp; B');
  });

  test('escapes angle brackets', () => {
    expect(escXml('<tag>')).toBe('&lt;tag&gt;');
  });

  test('escapes double quotes', () => {
    expect(escXml('"hello"')).toBe('&quot;hello&quot;');
  });

  test('escapes single quotes', () => {
    expect(escXml("it's")).toBe('it&apos;s');
  });

  test('handles empty string', () => {
    expect(escXml('')).toBe('');
  });

  test('passes clean text through', () => {
    expect(escXml('Normal text')).toBe('Normal text');
  });

  test('escapes multiple special chars', () => {
    expect(escXml('A & B < C > "D"')).toBe('A &amp; B &lt; C &gt; &quot;D&quot;');
  });
});

// ─── sanitizeFieldName ───────────────────────────────────────

describe('sanitizeFieldName', () => {
  test('extracts last segment', () => {
    expect(sanitizeFieldName('topmostSubform[0].Page1[0].f1_01[0]')).toBe('f1_01');
  });

  test('strips array indices', () => {
    expect(sanitizeFieldName('form[0].fields[3].name[0]')).toBe('name');
  });

  test('truncates to 20 chars', () => {
    const result = sanitizeFieldName('a.very_long_field_name_that_exceeds_twenty_characters[0]');
    expect(result.length).toBeLessThanOrEqual(20);
  });

  test('handles simple names', () => {
    expect(sanitizeFieldName('Email')).toBe('Email');
  });

  test('handles empty string', () => {
    expect(sanitizeFieldName('')).toBe('');
  });

  test('handles name with only array index', () => {
    expect(sanitizeFieldName('field[0]')).toBe('field');
  });

  test('handles deeply nested paths', () => {
    expect(sanitizeFieldName('root[0].form[1].section[2].subsection[3].field[0]')).toBe('field');
  });
});

// ─── mapFontName (OoxmlParts version) ────────────────────────

describe('mapFontName (OoxmlParts)', () => {
  test('maps ArialMT', () => {
    expect(mapFontName('ArialMT')).toBe('Arial');
  });

  test('maps Helvetica', () => {
    expect(mapFontName('Helvetica')).toBe('Arial');
  });

  test('strips subset prefix', () => {
    expect(mapFontName('ABCDEF+ArialMT')).toBe('Arial');
  });

  test('handles null/undefined', () => {
    expect(mapFontName(null as any)).toBe('Calibri');
    expect(mapFontName('')).toBe('Calibri');
  });
});
