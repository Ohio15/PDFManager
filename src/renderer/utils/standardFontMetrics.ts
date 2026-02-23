/**
 * Standard Font Metrics
 *
 * Provides real character widths, kerning, and ascender/descender data
 * using @pdf-lib/standard-fonts (transitive dep of pdf-lib).
 *
 * Used by Steps 3-8 for precision text measurement — replaces hardcoded
 * bounding box proportions (fontSize * 1.2, fontSize * 0.25, etc).
 */

import { Font, FontNames, Encodings } from '@pdf-lib/standard-fonts';

// Cache loaded Font objects
const fontObjectCache = new Map<string, Font>();

function getFont(fontName: FontNames): Font {
  const key = fontName as string;
  let cached = fontObjectCache.get(key);
  if (!cached) {
    cached = Font.load(fontName);
    fontObjectCache.set(key, cached);
  }
  return cached;
}

/**
 * Map any PDF font name to the closest Standard 14 FontNames enum value.
 * Handles subset prefixes (ABCDEF+FontName), common system fonts, and
 * bold/italic variants.
 */
export function mapToStandardFontName(pdfFontName: string): FontNames {
  // Strip subset prefix (e.g., "ABCDEF+Helvetica" → "Helvetica")
  let name = pdfFontName.replace(/^[A-Z]{6}\+/, '');
  const lower = name.toLowerCase();

  // Detect style modifiers
  const isBold = lower.includes('bold') || lower.includes('-bd') || lower.endsWith('bd');
  const isItalic = lower.includes('italic') || lower.includes('oblique') || lower.includes('-it');

  // Courier / monospace family
  if (
    lower.includes('courier') || lower.includes('mono') ||
    lower.includes('consolas') || lower.includes('menlo') || lower.includes('monaco')
  ) {
    if (isBold && isItalic) return FontNames.CourierBoldOblique;
    if (isBold) return FontNames.CourierBold;
    if (isItalic) return FontNames.CourierOblique;
    return FontNames.Courier;
  }

  // Times / serif family
  if (
    lower.includes('times') || lower.includes('georgia') ||
    lower.includes('garamond') || lower.includes('palatino') ||
    (lower.includes('serif') && !lower.includes('sans'))
  ) {
    if (isBold && isItalic) return FontNames.TimesRomanBoldItalic;
    if (isBold) return FontNames.TimesRomanBold;
    if (isItalic) return FontNames.TimesRomanItalic;
    return FontNames.TimesRoman;
  }

  // Helvetica / sans-serif family (default)
  // Includes: Arial, Calibri, Verdana, Segoe UI, Tahoma, etc.
  if (isBold && isItalic) return FontNames.HelveticaBoldOblique;
  if (isBold) return FontNames.HelveticaBold;
  if (isItalic) return FontNames.HelveticaOblique;
  return FontNames.Helvetica;
}

/**
 * Get the glyph name for a Unicode character via WinAnsi encoding.
 * Returns undefined if the character cannot be encoded.
 */
function getGlyphName(char: string): string | undefined {
  const codePoint = char.codePointAt(0);
  if (codePoint === undefined) return undefined;
  try {
    if (!Encodings.WinAnsi.canEncodeUnicodeCodePoint(codePoint)) return undefined;
    const { name } = Encodings.WinAnsi.encodeUnicodeCodePoint(codePoint);
    return name;
  } catch {
    return undefined;
  }
}

/**
 * Measure the total width of a text string using real glyph widths.
 *
 * @param text            Text to measure
 * @param fontName        Standard font name (FontNames enum value)
 * @param fontSize        Font size in points
 * @param includeKerning  Whether to add kerning adjustments (default false)
 * @returns Width in points
 */
export function measureTextWidth(
  text: string,
  fontName: FontNames,
  fontSize: number,
  includeKerning: boolean = false,
): number {
  const font = getFont(fontName);
  let totalWidth = 0;

  for (let i = 0; i < text.length; i++) {
    const glyphName = getGlyphName(text[i]);
    const charWidth = glyphName ? (font.getWidthOfGlyph(glyphName) ?? 500) : 500;
    totalWidth += charWidth;

    if (includeKerning && i > 0) {
      const prevGlyph = getGlyphName(text[i - 1]);
      if (prevGlyph && glyphName) {
        const kern = font.getXAxisKerningForPair(prevGlyph, glyphName);
        if (kern) totalWidth += kern;
      }
    }
  }

  return (totalWidth / 1000) * fontSize;
}

/**
 * Get per-character widths in 1/1000 units.
 */
export function getCharWidths(text: string, fontName: FontNames): number[] {
  const font = getFont(fontName);
  const widths: number[] = [];

  for (let i = 0; i < text.length; i++) {
    const glyphName = getGlyphName(text[i]);
    widths.push(glyphName ? (font.getWidthOfGlyph(glyphName) ?? 500) : 500);
  }

  return widths;
}

/**
 * Get kerning adjustment for a single character pair in 1/1000 units.
 */
export function getKerningAdjustment(
  leftChar: string,
  rightChar: string,
  fontName: FontNames,
): number {
  const font = getFont(fontName);
  const leftGlyph = getGlyphName(leftChar);
  const rightGlyph = getGlyphName(rightChar);
  if (!leftGlyph || !rightGlyph) return 0;
  return font.getXAxisKerningForPair(leftGlyph, rightGlyph) ?? 0;
}

/**
 * Get font ascender in 1/1000 units (e.g., 718 for Helvetica).
 */
export function getFontAscender(fontName: FontNames): number {
  const font = getFont(fontName);
  return (font.Ascender as number) ?? 750;
}

/**
 * Get font descender in 1/1000 units (e.g., -207 for Helvetica).
 * Returns a negative number.
 */
export function getFontDescender(fontName: FontNames): number {
  const font = getFont(fontName);
  return (font.Descender as number) ?? -250;
}

/**
 * Get text height = (ascender - descender) / 1000 * fontSize.
 * This is the full vertical extent of the font.
 */
export function getTextHeight(fontName: FontNames, fontSize: number): number {
  const ascender = getFontAscender(fontName);
  const descender = getFontDescender(fontName);
  return ((ascender - descender) / 1000) * fontSize;
}

/**
 * Get the distance from the baseline to the bottom of descenders.
 * Returns a positive value (abs(descender) / 1000 * fontSize).
 */
export function getDescentBelow(fontName: FontNames, fontSize: number): number {
  const descender = getFontDescender(fontName);
  return (Math.abs(descender) / 1000) * fontSize;
}

/**
 * Calculate the Tc (character spacing) value needed to make newText
 * fit within targetWidth at the given fontSize.
 *
 * @returns Tc value in points, or null if the text already fits within 0.5pt
 */
export function calculateCharacterSpacing(
  newText: string,
  targetWidth: number,
  fontName: FontNames,
  fontSize: number,
): number | null {
  if (newText.length === 0) return null;

  const naturalWidth = measureTextWidth(newText, fontName, fontSize, false);
  const widthDiff = targetWidth - naturalWidth;

  // If within 0.5pt, no adjustment needed
  if (Math.abs(widthDiff) < 0.5) return null;

  // Tc is applied between characters, so divide by character count
  // (Tc is added after each character including the last, per PDF spec)
  const tcValue = widthDiff / newText.length;
  return tcValue;
}
