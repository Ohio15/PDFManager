/**
 * Tier 1 Unit Tests: OOXML Parts Generator
 *
 * Tests for generateContentTypes, generateRootRels, generateDocumentRels,
 * generateSettingsXml, generateFontTableXml, and generateStylesXml.
 */
import { describe, test, expect } from 'vitest';
import {
  generateContentTypes,
  generateRootRels,
  generateDocumentRels,
  generateSettingsXml,
  generateFontTableXml,
  generateStylesXml,
  escXml,
  _testExports,
} from '../OoxmlParts';
import { StyleCollector } from '../StyleCollector';
import type { ImageFile } from '../types';

const { rgbToHex } = _testExports;

// ─── rgbToHex (OoxmlParts version - takes RGB object) ────────

describe('rgbToHex (OoxmlParts)', () => {
  test('black', () => {
    expect(rgbToHex({ r: 0, g: 0, b: 0 })).toBe('000000');
  });

  test('white', () => {
    expect(rgbToHex({ r: 1, g: 1, b: 1 })).toBe('ffffff');
  });

  test('red', () => {
    expect(rgbToHex({ r: 1, g: 0, b: 0 })).toBe('ff0000');
  });

  test('typical gray', () => {
    const hex = rgbToHex({ r: 0.75, g: 0.75, b: 0.75 });
    expect(hex).toBe('bfbfbf');
  });
});

// ─── generateContentTypes ────────────────────────────────────

describe('generateContentTypes', () => {
  test('includes XML declaration', () => {
    const xml = generateContentTypes([]);
    expect(xml).toContain('<?xml version="1.0"');
  });

  test('includes rels and xml defaults', () => {
    const xml = generateContentTypes([]);
    expect(xml).toContain('Extension="rels"');
    expect(xml).toContain('Extension="xml"');
  });

  test('includes JPEG extension when JPEGs present', () => {
    const images: ImageFile[] = [{
      rId: 'rId4', data: new Uint8Array(), mimeType: 'image/jpeg',
      fileName: 'image1.jpeg', resourceName: 'Im0', widthEmu: 100, heightEmu: 100,
    }];
    const xml = generateContentTypes(images);
    expect(xml).toContain('Extension="jpeg"');
  });

  test('includes PNG extension when PNGs present', () => {
    const images: ImageFile[] = [{
      rId: 'rId4', data: new Uint8Array(), mimeType: 'image/png',
      fileName: 'image1.png', resourceName: 'Im0', widthEmu: 100, heightEmu: 100,
    }];
    const xml = generateContentTypes(images);
    expect(xml).toContain('Extension="png"');
  });

  test('no image extensions when no images', () => {
    const xml = generateContentTypes([]);
    expect(xml).not.toContain('Extension="jpeg"');
    expect(xml).not.toContain('Extension="png"');
  });

  test('includes required override parts', () => {
    const xml = generateContentTypes([]);
    expect(xml).toContain('/word/document.xml');
    expect(xml).toContain('/word/styles.xml');
    expect(xml).toContain('/word/settings.xml');
    expect(xml).toContain('/word/fontTable.xml');
  });
});

// ─── generateRootRels ────────────────────────────────────────

describe('generateRootRels', () => {
  test('references word/document.xml', () => {
    const xml = generateRootRels();
    expect(xml).toContain('Target="word/document.xml"');
  });

  test('uses officeDocument relationship type', () => {
    const xml = generateRootRels();
    expect(xml).toContain('officeDocument');
  });
});

// ─── generateDocumentRels ────────────────────────────────────

describe('generateDocumentRels', () => {
  test('includes styles, settings, fontTable references', () => {
    const xml = generateDocumentRels([]);
    expect(xml).toContain('Target="styles.xml"');
    expect(xml).toContain('Target="settings.xml"');
    expect(xml).toContain('Target="fontTable.xml"');
  });

  test('includes image relationships', () => {
    const images: ImageFile[] = [{
      rId: 'rId4', data: new Uint8Array(), mimeType: 'image/jpeg',
      fileName: 'image1.jpeg', resourceName: 'Im0', widthEmu: 100, heightEmu: 100,
    }];
    const xml = generateDocumentRels(images);
    expect(xml).toContain('Id="rId4"');
    expect(xml).toContain('Target="media/image1.jpeg"');
  });
});

// ─── generateSettingsXml ─────────────────────────────────────

describe('generateSettingsXml', () => {
  test('includes compatibility mode 15', () => {
    const xml = generateSettingsXml();
    expect(xml).toContain('w:val="15"');
    expect(xml).toContain('compatibilityMode');
  });

  test('includes zoom and tab stop', () => {
    const xml = generateSettingsXml();
    expect(xml).toContain('w:zoom');
    expect(xml).toContain('w:defaultTabStop');
  });

  test('no form protection when no form fields', () => {
    const xml = generateSettingsXml(false);
    expect(xml).not.toContain('documentProtection');
  });

  test('includes form protection when form fields present', () => {
    const xml = generateSettingsXml(true);
    expect(xml).toContain('w:documentProtection');
    expect(xml).toContain('w:edit="forms"');
    expect(xml).toContain('w:enforcement="1"');
  });
});

// ─── generateFontTableXml ────────────────────────────────────

describe('generateFontTableXml', () => {
  test('includes all provided fonts', () => {
    const xml = generateFontTableXml(['Arial', 'Times New Roman', 'Calibri']);
    expect(xml).toContain('w:name="Arial"');
    expect(xml).toContain('w:name="Times New Roman"');
    expect(xml).toContain('w:name="Calibri"');
  });

  test('includes charset and panose', () => {
    const xml = generateFontTableXml(['Arial']);
    expect(xml).toContain('w:charset');
    expect(xml).toContain('w:panose1');
    expect(xml).toContain('w:family');
    expect(xml).toContain('w:pitch');
  });

  test('escapes special characters in font names', () => {
    const xml = generateFontTableXml(['Font & Co']);
    expect(xml).toContain('Font &amp; Co');
  });
});

// ─── generateStylesXml ──────────────────────────────────────

describe('generateStylesXml', () => {
  test('includes docDefaults with Normal style', () => {
    const sc = new StyleCollector();
    sc.registerRun('Arial', 24, false, false, '000000');
    const xml = generateStylesXml(sc);
    expect(xml).toContain('w:docDefaults');
    expect(xml).toContain('w:rPrDefault');
    expect(xml).toContain('w:pPrDefault');
  });

  test('includes Normal paragraph style', () => {
    const sc = new StyleCollector();
    sc.registerRun('Arial', 24, false, false, '000000');
    const xml = generateStylesXml(sc);
    expect(xml).toContain('w:styleId="Normal"');
    expect(xml).toContain('w:val="Normal"');
  });

  test('includes used custom styles that differ from Normal', () => {
    const sc = new StyleCollector();
    // Make Arial regular the Normal (5 uses)
    for (let i = 0; i < 5; i++) {
      sc.registerRun('Arial', 24, false, false, '000000');
    }
    // Add a bold variant (1 use)
    sc.registerRun('Arial', 24, true, false, '000000');

    const xml = generateStylesXml(sc);
    // Should have a custom style with bold
    expect(xml).toContain('w:customStyle="1"');
    expect(xml).toContain('<w:b/>');
  });
});
