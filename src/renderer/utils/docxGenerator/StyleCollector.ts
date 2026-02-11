/**
 * Style Collector
 *
 * Dynamically tracks styles used during PDF-to-DOCX conversion.
 * Only styles that are actually used end up in styles.xml — no bloat.
 *
 * The most frequently used style combination becomes the "Normal" default,
 * so runs matching that style need no explicit style reference.
 */

import type { DocxStyle } from './types';

/** Key used to deduplicate style registrations */
function makeStyleKey(
  fontName: string,
  fontSize: number,
  bold: boolean,
  italic: boolean,
  color: string
): string {
  return `${fontName}|${fontSize}|${bold ? 1 : 0}|${italic ? 1 : 0}|${color}`;
}

export class StyleCollector {
  private styles: Map<string, DocxStyle> = new Map();
  private nextId = 1;

  /**
   * Register a text run's formatting. Returns the styleId to reference in document.xml.
   */
  registerRun(
    fontName: string,
    fontSize: number,
    bold: boolean,
    italic: boolean,
    color: string
  ): string {
    const key = makeStyleKey(fontName, fontSize, bold, italic, color);

    const existing = this.styles.get(key);
    if (existing) {
      existing.usageCount++;
      return existing.id;
    }

    const id = `Style${this.nextId++}`;
    const cleanFont = fontName.replace(/,.*$/, '').trim() || 'Calibri';

    this.styles.set(key, {
      id,
      name: `${cleanFont} ${fontSize / 2}pt`,
      fontName: cleanFont,
      fontSize,
      bold,
      italic,
      color,
      usageCount: 1,
    });

    return id;
  }

  /**
   * Determine the "Normal" default style (most frequently used combination).
   * Returns the style definition that should be used for w:docDefaults.
   */
  getNormalStyle(): DocxStyle {
    let maxUsage = 0;
    let normalStyle: DocxStyle | null = null;

    for (const style of this.styles.values()) {
      if (style.usageCount > maxUsage) {
        maxUsage = style.usageCount;
        normalStyle = style;
      }
    }

    return normalStyle ?? {
      id: 'Normal',
      name: 'Normal',
      fontName: 'Calibri',
      fontSize: 22, // 11pt in half-points
      bold: false,
      italic: false,
      color: '000000',
      usageCount: 0,
    };
  }

  /**
   * Get only the styles that differ from the Normal default.
   * These are the ones emitted as <w:style> elements in styles.xml.
   */
  getUsedStyles(): DocxStyle[] {
    const normal = this.getNormalStyle();
    const used: DocxStyle[] = [];

    for (const style of this.styles.values()) {
      // Skip the style that became "Normal"
      if (style.id === normal.id) continue;

      // Only include if it actually differs from normal
      if (
        style.fontName !== normal.fontName ||
        style.fontSize !== normal.fontSize ||
        style.bold !== normal.bold ||
        style.italic !== normal.italic ||
        style.color !== normal.color
      ) {
        used.push(style);
      }
    }

    return used;
  }

  /**
   * Get all unique font names for fontTable.xml.
   */
  getUsedFonts(): string[] {
    const fonts = new Set<string>();
    for (const style of this.styles.values()) {
      fonts.add(style.fontName);
    }
    // Always include Calibri as a fallback
    fonts.add('Calibri');
    return Array.from(fonts);
  }

  /**
   * Check if a given run's formatting matches the Normal default.
   * If true, no explicit style reference is needed for this run.
   */
  isNormalStyle(styleId: string): boolean {
    return styleId === this.getNormalStyle().id;
  }

  /**
   * Get a specific style by its ID.
   */
  getStyle(styleId: string): DocxStyle | undefined {
    for (const style of this.styles.values()) {
      if (style.id === styleId) return style;
    }
    return undefined;
  }
}
