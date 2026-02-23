/**
 * PDF Content Stream Builder
 *
 * Generates valid PDF content stream operators from high-level editing operations.
 * Acts as a "compiler" from editor actions to PDF drawing instructions.
 */

import {
  TextMatrix,
  Color,
  ContentStreamBuilder as IContentStreamBuilder,
  FontInfo,
  PDFValue,
} from './types';

/**
 * Escape a string for PDF literal string format
 */
function escapePDFString(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    const ch = str.charCodeAt(i);
    switch (ch) {
      case 0x0A: result += '\\n'; break;
      case 0x0D: result += '\\r'; break;
      case 0x09: result += '\\t'; break;
      case 0x08: result += '\\b'; break;
      case 0x0C: result += '\\f'; break;
      case 0x28: result += '\\('; break;
      case 0x29: result += '\\)'; break;
      case 0x5C: result += '\\\\'; break;
      default:
        if (ch < 32 || ch > 126) {
          // Octal escape for non-printable
          result += '\\' + ch.toString(8).padStart(3, '0');
        } else {
          result += str[i];
        }
    }
  }
  return result;
}

/**
 * Convert string to hex for PDF hex string format
 */
function stringToHex(str: string): string {
  let hex = '';
  for (let i = 0; i < str.length; i++) {
    hex += str.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase();
  }
  return hex;
}

/**
 * Format a number for PDF (remove unnecessary decimals)
 */
function formatNumber(n: number): string {
  if (Number.isInteger(n)) {
    return n.toString();
  }
  // Limit to 6 decimal places and remove trailing zeros
  return n.toFixed(6).replace(/\.?0+$/, '');
}

/**
 * Format a matrix for PDF
 */
function formatMatrix(m: TextMatrix): string {
  return `${formatNumber(m.a)} ${formatNumber(m.b)} ${formatNumber(m.c)} ${formatNumber(m.d)} ${formatNumber(m.e)} ${formatNumber(m.f)}`;
}

/**
 * ContentStreamBuilder implementation
 */
export class ContentStreamBuilder implements IContentStreamBuilder {
  private commands: string[] = [];
  private fonts: Map<string, FontInfo> = new Map();

  constructor(fonts?: Map<string, FontInfo>) {
    if (fonts) {
      this.fonts = fonts;
    }
  }

  // Text Object Operators
  beginText(): void {
    this.commands.push('BT');
  }

  endText(): void {
    this.commands.push('ET');
  }

  // Text State Operators
  setFont(fontName: string, size: number): void {
    this.commands.push(`/${fontName} ${formatNumber(size)} Tf`);
  }

  setCharacterSpacing(spacing: number): void {
    this.commands.push(`${formatNumber(spacing)} Tc`);
  }

  setWordSpacing(spacing: number): void {
    this.commands.push(`${formatNumber(spacing)} Tw`);
  }

  setHorizontalScale(scale: number): void {
    this.commands.push(`${formatNumber(scale)} Tz`);
  }

  setLeading(leading: number): void {
    this.commands.push(`${formatNumber(leading)} TL`);
  }

  setTextRise(rise: number): void {
    this.commands.push(`${formatNumber(rise)} Ts`);
  }

  setRenderingMode(mode: number): void {
    this.commands.push(`${mode} Tr`);
  }

  // Text Positioning Operators
  setTextMatrix(matrix: TextMatrix): void {
    this.commands.push(`${formatMatrix(matrix)} Tm`);
  }

  moveText(tx: number, ty: number): void {
    this.commands.push(`${formatNumber(tx)} ${formatNumber(ty)} Td`);
  }

  moveTextWithLeading(tx: number, ty: number): void {
    this.commands.push(`${formatNumber(tx)} ${formatNumber(ty)} TD`);
  }

  nextLine(): void {
    this.commands.push('T*');
  }

  // Text Showing Operators
  showText(text: string, useHex: boolean = false): void {
    if (useHex) {
      this.commands.push(`<${stringToHex(text)}> Tj`);
    } else {
      this.commands.push(`(${escapePDFString(text)}) Tj`);
    }
  }

  showTextWithPositioning(items: (string | number)[], useHex: boolean = false): void {
    const parts: string[] = [];
    for (const item of items) {
      if (typeof item === 'string') {
        if (useHex) {
          parts.push(`<${stringToHex(item)}>`);
        } else {
          parts.push(`(${escapePDFString(item)})`);
        }
      } else {
        parts.push(formatNumber(item));
      }
    }
    this.commands.push(`[${parts.join(' ')}] TJ`);
  }

  showTextNextLine(text: string, useHex: boolean = false): void {
    if (useHex) {
      this.commands.push(`<${stringToHex(text)}> '`);
    } else {
      this.commands.push(`(${escapePDFString(text)}) '`);
    }
  }

  showTextWithSpacing(wordSpacing: number, charSpacing: number, text: string, useHex: boolean = false): void {
    if (useHex) {
      this.commands.push(`${formatNumber(wordSpacing)} ${formatNumber(charSpacing)} <${stringToHex(text)}> "`);
    } else {
      this.commands.push(`${formatNumber(wordSpacing)} ${formatNumber(charSpacing)} (${escapePDFString(text)}) "`);
    }
  }

  // Graphics State Operators
  saveState(): void {
    this.commands.push('q');
  }

  restoreState(): void {
    this.commands.push('Q');
  }

  setMatrix(matrix: TextMatrix): void {
    this.commands.push(`${formatMatrix(matrix)} cm`);
  }

  setLineWidth(width: number): void {
    this.commands.push(`${formatNumber(width)} w`);
  }

  setLineCap(cap: number): void {
    this.commands.push(`${cap} J`);
  }

  setLineJoin(join: number): void {
    this.commands.push(`${join} j`);
  }

  setMiterLimit(limit: number): void {
    this.commands.push(`${formatNumber(limit)} M`);
  }

  setDashPattern(array: number[], phase: number): void {
    this.commands.push(`[${array.map(formatNumber).join(' ')}] ${formatNumber(phase)} d`);
  }

  // Color Operators
  setFillColor(color: Color): void {
    switch (color.space) {
      case 'DeviceGray':
        this.commands.push(`${formatNumber(color.values[0])} g`);
        break;
      case 'DeviceRGB':
        this.commands.push(`${formatNumber(color.values[0])} ${formatNumber(color.values[1])} ${formatNumber(color.values[2])} rg`);
        break;
      case 'DeviceCMYK':
        this.commands.push(`${formatNumber(color.values[0])} ${formatNumber(color.values[1])} ${formatNumber(color.values[2])} ${formatNumber(color.values[3])} k`);
        break;
      default:
        // Extended color space
        this.commands.push(`/${color.space} cs`);
        this.commands.push(`${color.values.map(formatNumber).join(' ')} scn`);
    }
  }

  setStrokeColor(color: Color): void {
    switch (color.space) {
      case 'DeviceGray':
        this.commands.push(`${formatNumber(color.values[0])} G`);
        break;
      case 'DeviceRGB':
        this.commands.push(`${formatNumber(color.values[0])} ${formatNumber(color.values[1])} ${formatNumber(color.values[2])} RG`);
        break;
      case 'DeviceCMYK':
        this.commands.push(`${formatNumber(color.values[0])} ${formatNumber(color.values[1])} ${formatNumber(color.values[2])} ${formatNumber(color.values[3])} K`);
        break;
      default:
        // Extended color space
        this.commands.push(`/${color.space} CS`);
        this.commands.push(`${color.values.map(formatNumber).join(' ')} SCN`);
    }
  }

  // Path Construction Operators
  moveTo(x: number, y: number): void {
    this.commands.push(`${formatNumber(x)} ${formatNumber(y)} m`);
  }

  lineTo(x: number, y: number): void {
    this.commands.push(`${formatNumber(x)} ${formatNumber(y)} l`);
  }

  curveTo(x1: number, y1: number, x2: number, y2: number, x3: number, y3: number): void {
    this.commands.push(`${formatNumber(x1)} ${formatNumber(y1)} ${formatNumber(x2)} ${formatNumber(y2)} ${formatNumber(x3)} ${formatNumber(y3)} c`);
  }

  curveToInitial(x2: number, y2: number, x3: number, y3: number): void {
    this.commands.push(`${formatNumber(x2)} ${formatNumber(y2)} ${formatNumber(x3)} ${formatNumber(y3)} v`);
  }

  curveToFinal(x1: number, y1: number, x3: number, y3: number): void {
    this.commands.push(`${formatNumber(x1)} ${formatNumber(y1)} ${formatNumber(x3)} ${formatNumber(y3)} y`);
  }

  rectangle(x: number, y: number, width: number, height: number): void {
    this.commands.push(`${formatNumber(x)} ${formatNumber(y)} ${formatNumber(width)} ${formatNumber(height)} re`);
  }

  closePath(): void {
    this.commands.push('h');
  }

  // Path Painting Operators
  stroke(): void {
    this.commands.push('S');
  }

  closeAndStroke(): void {
    this.commands.push('s');
  }

  fill(): void {
    this.commands.push('f');
  }

  fillEvenOdd(): void {
    this.commands.push('f*');
  }

  fillStroke(): void {
    this.commands.push('B');
  }

  fillStrokeEvenOdd(): void {
    this.commands.push('B*');
  }

  closeFillStroke(): void {
    this.commands.push('b');
  }

  closeFillStrokeEvenOdd(): void {
    this.commands.push('b*');
  }

  endPath(): void {
    this.commands.push('n');
  }

  // Clipping Path Operators
  clip(): void {
    this.commands.push('W');
  }

  clipEvenOdd(): void {
    this.commands.push('W*');
  }

  // XObject Operators
  drawXObject(name: string): void {
    this.commands.push(`/${name} Do`);
  }

  // Extended Graphics State
  setExtGState(name: string): void {
    this.commands.push(`/${name} gs`);
  }

  // Marked Content
  beginMarkedContent(tag: string): void {
    this.commands.push(`/${tag} BMC`);
  }

  beginMarkedContentWithProperties(tag: string, properties: string): void {
    this.commands.push(`/${tag} /${properties} BDC`);
  }

  endMarkedContent(): void {
    this.commands.push('EMC');
  }

  // Raw command (for advanced usage)
  raw(command: string): void {
    this.commands.push(command);
  }

  /**
   * Build the final content stream as bytes
   */
  build(): Uint8Array {
    const content = this.commands.join('\n') + '\n';
    const bytes = new Uint8Array(content.length);
    for (let i = 0; i < content.length; i++) {
      bytes[i] = content.charCodeAt(i) & 0xFF;
    }
    return bytes;
  }

  /**
   * Build as string (for debugging)
   */
  buildString(): string {
    return this.commands.join('\n');
  }

  /**
   * Clear all commands
   */
  clear(): void {
    this.commands = [];
  }

  /**
   * Get current command count
   */
  get commandCount(): number {
    return this.commands.length;
  }
}

/**
 * High-level text editing helper
 * Translates text edits into content stream operations
 */
export class TextEditCompiler {
  private builder: ContentStreamBuilder;
  private fonts: Map<string, FontInfo>;

  constructor(fonts: Map<string, FontInfo>) {
    this.fonts = fonts;
    this.builder = new ContentStreamBuilder(fonts);
  }

  /**
   * Generate content stream to replace text at a specific position
   */
  replaceText(
    originalText: string,
    newText: string,
    x: number,
    y: number,
    fontName: string,
    fontSize: number,
    color: Color
  ): Uint8Array {
    this.builder.clear();

    // Save graphics state
    this.builder.saveState();

    // Set color
    this.builder.setFillColor(color);

    // Begin text
    this.builder.beginText();

    // Set font
    this.builder.setFont(fontName, fontSize);

    // Position text
    this.builder.setTextMatrix({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });

    // Get font info for width calculations
    const fontInfo = this.fonts.get(fontName);

    // If we need to match original width, calculate kerning
    if (fontInfo && originalText.length > 0) {
      const originalWidth = this.calculateTextWidth(originalText, fontInfo, fontSize);
      const newWidth = this.calculateTextWidth(newText, fontInfo, fontSize);

      if (Math.abs(originalWidth - newWidth) > 1) {
        // Use Tc operator to distribute width difference evenly across all characters
        const widthDiff = originalWidth - newWidth;
        const tcValue = widthDiff / newText.length;
        this.builder.setCharacterSpacing(tcValue);
        this.builder.showText(newText);
        this.builder.setCharacterSpacing(0);
      } else {
        this.builder.showText(newText);
      }
    } else {
      this.builder.showText(newText);
    }

    // End text
    this.builder.endText();

    // Restore graphics state
    this.builder.restoreState();

    return this.builder.build();
  }

  /**
   * Generate content stream to cover (white-out) text at a specific position
   */
  coverText(
    x: number,
    y: number,
    width: number,
    height: number,
    backgroundColor: Color = { space: 'DeviceGray', values: [1] }
  ): Uint8Array {
    this.builder.clear();

    // Save graphics state
    this.builder.saveState();

    // Set fill color to background
    this.builder.setFillColor(backgroundColor);

    // Draw covering rectangle
    // Extend slightly beyond text bounds
    this.builder.rectangle(x - 1, y - height * 0.25, width + 2, height * 1.3);
    this.builder.fill();

    // Restore graphics state
    this.builder.restoreState();

    return this.builder.build();
  }

  /**
   * Generate content stream for deleted text (cover + optionally strikethrough)
   */
  deleteText(
    x: number,
    y: number,
    width: number,
    height: number,
    backgroundColor: Color = { space: 'DeviceGray', values: [1] },
    showStrikethrough: boolean = false
  ): Uint8Array {
    this.builder.clear();

    // Save graphics state
    this.builder.saveState();

    // Cover the text
    this.builder.setFillColor(backgroundColor);
    this.builder.rectangle(x - 1, y - height * 0.25, width + 2, height * 1.3);
    this.builder.fill();

    // Optionally add strikethrough
    if (showStrikethrough) {
      this.builder.setStrokeColor({ space: 'DeviceRGB', values: [1, 0, 0] }); // Red
      this.builder.setLineWidth(1);
      const strikeY = y + height * 0.35;
      this.builder.moveTo(x - 1, strikeY);
      this.builder.lineTo(x + width + 1, strikeY);
      this.builder.stroke();
    }

    // Restore graphics state
    this.builder.restoreState();

    return this.builder.build();
  }

  /**
   * Generate content stream for inserting new text
   */
  insertText(
    text: string,
    x: number,
    y: number,
    fontName: string,
    fontSize: number,
    color: Color
  ): Uint8Array {
    this.builder.clear();

    this.builder.saveState();
    this.builder.setFillColor(color);
    this.builder.beginText();
    this.builder.setFont(fontName, fontSize);
    this.builder.setTextMatrix({ a: 1, b: 0, c: 0, d: 1, e: x, f: y });
    this.builder.showText(text);
    this.builder.endText();
    this.builder.restoreState();

    return this.builder.build();
  }

  /**
   * Calculate text width using font metrics
   */
  private calculateTextWidth(text: string, fontInfo: FontInfo, fontSize: number): number {
    let width = 0;
    for (let i = 0; i < text.length; i++) {
      const charCode = text.charCodeAt(i);
      const glyphWidth = fontInfo.widths.get(charCode) || 500; // Default width
      width += glyphWidth;
    }
    return (width / 1000) * fontSize;
  }
}

/**
 * Content Stream Merger
 * Combines existing content with modifications
 */
export class ContentStreamMerger {
  /**
   * Prepend new content before existing content
   */
  static prepend(existing: Uint8Array, newContent: Uint8Array): Uint8Array {
    const result = new Uint8Array(newContent.length + 1 + existing.length);
    result.set(newContent, 0);
    result[newContent.length] = 0x0A; // Newline
    result.set(existing, newContent.length + 1);
    return result;
  }

  /**
   * Append new content after existing content
   */
  static append(existing: Uint8Array, newContent: Uint8Array): Uint8Array {
    const result = new Uint8Array(existing.length + 1 + newContent.length);
    result.set(existing, 0);
    result[existing.length] = 0x0A; // Newline
    result.set(newContent, existing.length + 1);
    return result;
  }

  /**
   * Wrap existing content with save/restore state
   * Useful when adding content that should not affect original state
   */
  static wrapWithState(content: Uint8Array): Uint8Array {
    const prefix = new TextEncoder().encode('q\n');
    const suffix = new TextEncoder().encode('\nQ');
    const result = new Uint8Array(prefix.length + content.length + suffix.length);
    result.set(prefix, 0);
    result.set(content, prefix.length);
    result.set(suffix, prefix.length + content.length);
    return result;
  }
}
