/**
 * FontManager - Font subsetting, embedding, and management for PDF editing
 *
 * Handles:
 * - Font extraction from existing PDFs
 * - Font subsetting to include only used glyphs
 * - Embedding new fonts (TrueType, OpenType)
 * - ToUnicode CMap generation
 * - Glyph width calculation
 */

import type {
  FontInfo,
  FontDescriptor,
  TextMatrix,
  PDFValue,
  PDFDict,
  PDFArray,
  PDFName,
  PDFNumber,
  PDFString
} from './types';

// Font file structures
interface TrueTypeTable {
  tag: string;
  checksum: number;
  offset: number;
  length: number;
}

interface TrueTypeFont {
  tables: Map<string, Uint8Array>;
  numGlyphs: number;
  unitsPerEm: number;
  glyphWidths: Map<number, number>;
  cmap: Map<number, number>; // Unicode -> Glyph ID
  reverseCmap: Map<number, number>; // Glyph ID -> Unicode
  hmtx: { advanceWidth: number; lsb: number }[];
  head: {
    unitsPerEm: number;
    xMin: number;
    yMin: number;
    xMax: number;
    yMax: number;
  };
  hhea: {
    ascent: number;
    descent: number;
    lineGap: number;
  };
  os2?: {
    sTypoAscender: number;
    sTypoDescender: number;
    sCapHeight: number;
    sxHeight: number;
    usWeightClass: number;
    fsSelection: number;
  };
  name: Map<number, string>;
  post: {
    italicAngle: number;
    isFixedPitch: boolean;
  };
}

interface SubsetResult {
  fontData: Uint8Array;
  glyphToNewGlyph: Map<number, number>;
  usedGlyphIds: Set<number>;
  widths: Map<number, number>;
}

interface EmbeddedFont {
  fontName: string;
  fontRef: string; // PDF object reference like "F1"
  fontStream: Uint8Array;
  widths: number[];
  firstChar: number;
  lastChar: number;
  toUnicode: string;
  descriptor: FontDescriptor;
  isSubset: boolean;
  subsetPrefix?: string;
}

/**
 * TrueType/OpenType font parser
 */
export class TrueTypeFontParser {
  private data: DataView;
  private offset: number = 0;

  constructor(fontData: Uint8Array) {
    this.data = new DataView(fontData.buffer, fontData.byteOffset, fontData.byteLength);
  }

  parse(): TrueTypeFont {
    const sfntVersion = this.readUint32();
    const numTables = this.readUint16();
    const searchRange = this.readUint16();
    const entrySelector = this.readUint16();
    const rangeShift = this.readUint16();

    // Read table directory
    const tableDirectory: TrueTypeTable[] = [];
    for (let i = 0; i < numTables; i++) {
      const tag = this.readTag();
      const checksum = this.readUint32();
      const offset = this.readUint32();
      const length = this.readUint32();
      tableDirectory.push({ tag, checksum, offset, length });
    }

    // Extract tables
    const tables = new Map<string, Uint8Array>();
    const buffer = new Uint8Array(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    for (const table of tableDirectory) {
      tables.set(table.tag, buffer.slice(table.offset, table.offset + table.length));
    }

    // Parse required tables
    const head = this.parseHead(tables.get('head')!);
    const hhea = this.parseHhea(tables.get('hhea')!);
    const maxp = this.parseMaxp(tables.get('maxp')!);
    const hmtx = this.parseHmtx(tables.get('hmtx')!, hhea.numberOfHMetrics, maxp.numGlyphs);
    const cmap = this.parseCmap(tables.get('cmap')!);
    const name = this.parseName(tables.get('name')!);
    const post = this.parsePost(tables.get('post')!);
    const os2 = tables.has('OS/2') ? this.parseOS2(tables.get('OS/2')!) : undefined;

    // Build glyph widths map
    const glyphWidths = new Map<number, number>();
    for (let i = 0; i < hmtx.length; i++) {
      glyphWidths.set(i, hmtx[i].advanceWidth);
    }

    // Build reverse cmap
    const reverseCmap = new Map<number, number>();
    for (const [unicode, glyphId] of cmap) {
      if (!reverseCmap.has(glyphId)) {
        reverseCmap.set(glyphId, unicode);
      }
    }

    return {
      tables,
      numGlyphs: maxp.numGlyphs,
      unitsPerEm: head.unitsPerEm,
      glyphWidths,
      cmap,
      reverseCmap,
      hmtx,
      head,
      hhea,
      os2,
      name,
      post
    };
  }

  private readUint8(): number {
    return this.data.getUint8(this.offset++);
  }

  private readUint16(): number {
    const value = this.data.getUint16(this.offset);
    this.offset += 2;
    return value;
  }

  private readInt16(): number {
    const value = this.data.getInt16(this.offset);
    this.offset += 2;
    return value;
  }

  private readUint32(): number {
    const value = this.data.getUint32(this.offset);
    this.offset += 4;
    return value;
  }

  private readInt32(): number {
    const value = this.data.getInt32(this.offset);
    this.offset += 4;
    return value;
  }

  private readTag(): string {
    return String.fromCharCode(
      this.readUint8(),
      this.readUint8(),
      this.readUint8(),
      this.readUint8()
    );
  }

  private parseHead(data: Uint8Array): TrueTypeFont['head'] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      unitsPerEm: view.getUint16(18),
      xMin: view.getInt16(36),
      yMin: view.getInt16(38),
      xMax: view.getInt16(40),
      yMax: view.getInt16(42)
    };
  }

  private parseHhea(data: Uint8Array): TrueTypeFont['hhea'] & { numberOfHMetrics: number } {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      ascent: view.getInt16(4),
      descent: view.getInt16(6),
      lineGap: view.getInt16(8),
      numberOfHMetrics: view.getUint16(34)
    };
  }

  private parseMaxp(data: Uint8Array): { numGlyphs: number } {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      numGlyphs: view.getUint16(4)
    };
  }

  private parseHmtx(data: Uint8Array, numberOfHMetrics: number, numGlyphs: number): TrueTypeFont['hmtx'] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const metrics: { advanceWidth: number; lsb: number }[] = [];
    let offset = 0;

    // Read full metrics
    let lastAdvanceWidth = 0;
    for (let i = 0; i < numberOfHMetrics; i++) {
      lastAdvanceWidth = view.getUint16(offset);
      const lsb = view.getInt16(offset + 2);
      metrics.push({ advanceWidth: lastAdvanceWidth, lsb });
      offset += 4;
    }

    // Read remaining lsb values (use last advance width)
    for (let i = numberOfHMetrics; i < numGlyphs; i++) {
      const lsb = view.getInt16(offset);
      metrics.push({ advanceWidth: lastAdvanceWidth, lsb });
      offset += 2;
    }

    return metrics;
  }

  private parseCmap(data: Uint8Array): Map<number, number> {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const numTables = view.getUint16(2);
    const cmap = new Map<number, number>();

    // Find best cmap subtable (prefer format 4 or 12)
    let bestOffset = -1;
    let bestFormat = -1;

    for (let i = 0; i < numTables; i++) {
      const platformId = view.getUint16(4 + i * 8);
      const encodingId = view.getUint16(6 + i * 8);
      const offset = view.getUint32(8 + i * 8);
      const format = view.getUint16(offset);

      // Prefer Unicode platform (0 or 3) with BMP encoding
      if ((platformId === 0 || platformId === 3) && (format === 4 || format === 12)) {
        if (format > bestFormat) {
          bestFormat = format;
          bestOffset = offset;
        }
      }
    }

    if (bestOffset === -1) {
      return cmap;
    }

    if (bestFormat === 4) {
      this.parseCmapFormat4(view, bestOffset, cmap);
    } else if (bestFormat === 12) {
      this.parseCmapFormat12(view, bestOffset, cmap);
    }

    return cmap;
  }

  private parseCmapFormat4(view: DataView, offset: number, cmap: Map<number, number>): void {
    const segCount = view.getUint16(offset + 6) / 2;
    const endCodesOffset = offset + 14;
    const startCodesOffset = endCodesOffset + segCount * 2 + 2;
    const idDeltaOffset = startCodesOffset + segCount * 2;
    const idRangeOffset = idDeltaOffset + segCount * 2;

    for (let i = 0; i < segCount; i++) {
      const endCode = view.getUint16(endCodesOffset + i * 2);
      const startCode = view.getUint16(startCodesOffset + i * 2);
      const idDelta = view.getInt16(idDeltaOffset + i * 2);
      const idRangeOffsetValue = view.getUint16(idRangeOffset + i * 2);

      if (startCode === 0xFFFF) break;

      for (let code = startCode; code <= endCode; code++) {
        let glyphId: number;
        if (idRangeOffsetValue === 0) {
          glyphId = (code + idDelta) & 0xFFFF;
        } else {
          const glyphIdOffset = idRangeOffset + i * 2 + idRangeOffsetValue + (code - startCode) * 2;
          glyphId = view.getUint16(glyphIdOffset);
          if (glyphId !== 0) {
            glyphId = (glyphId + idDelta) & 0xFFFF;
          }
        }
        if (glyphId !== 0) {
          cmap.set(code, glyphId);
        }
      }
    }
  }

  private parseCmapFormat12(view: DataView, offset: number, cmap: Map<number, number>): void {
    const numGroups = view.getUint32(offset + 12);
    let groupOffset = offset + 16;

    for (let i = 0; i < numGroups; i++) {
      const startCharCode = view.getUint32(groupOffset);
      const endCharCode = view.getUint32(groupOffset + 4);
      const startGlyphId = view.getUint32(groupOffset + 8);

      for (let code = startCharCode; code <= endCharCode; code++) {
        const glyphId = startGlyphId + (code - startCharCode);
        cmap.set(code, glyphId);
      }

      groupOffset += 12;
    }
  }

  private parseName(data: Uint8Array): Map<number, string> {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    const names = new Map<number, string>();

    const count = view.getUint16(2);
    const stringOffset = view.getUint16(4);

    for (let i = 0; i < count; i++) {
      const recordOffset = 6 + i * 12;
      const platformId = view.getUint16(recordOffset);
      const encodingId = view.getUint16(recordOffset + 2);
      const nameId = view.getUint16(recordOffset + 6);
      const length = view.getUint16(recordOffset + 8);
      const offset = view.getUint16(recordOffset + 10);

      // Prefer Windows Unicode or Mac Roman
      if (platformId === 3 && encodingId === 1) {
        // Windows Unicode BMP
        const strData = data.slice(stringOffset + offset, stringOffset + offset + length);
        let str = '';
        for (let j = 0; j < strData.length; j += 2) {
          str += String.fromCharCode((strData[j] << 8) | strData[j + 1]);
        }
        names.set(nameId, str);
      } else if (platformId === 1 && encodingId === 0 && !names.has(nameId)) {
        // Mac Roman (fallback)
        const strData = data.slice(stringOffset + offset, stringOffset + offset + length);
        names.set(nameId, new TextDecoder('macintosh').decode(strData));
      }
    }

    return names;
  }

  private parsePost(data: Uint8Array): TrueTypeFont['post'] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      italicAngle: view.getInt32(4) / 65536,
      isFixedPitch: view.getUint32(12) !== 0
    };
  }

  private parseOS2(data: Uint8Array): TrueTypeFont['os2'] {
    const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
    return {
      usWeightClass: view.getUint16(4),
      fsSelection: view.getUint16(62),
      sTypoAscender: view.getInt16(68),
      sTypoDescender: view.getInt16(70),
      sCapHeight: data.length >= 90 ? view.getInt16(88) : 0,
      sxHeight: data.length >= 88 ? view.getInt16(86) : 0
    };
  }
}

/**
 * Font subsetting - creates a new font containing only the glyphs used
 */
export class FontSubsetter {
  private font: TrueTypeFont;

  constructor(font: TrueTypeFont) {
    this.font = font;
  }

  /**
   * Create a subset font containing only the specified glyphs
   */
  subset(usedGlyphIds: Set<number>): SubsetResult {
    // Always include glyph 0 (notdef)
    const glyphSet = new Set([0, ...usedGlyphIds]);

    // Add composite glyph components
    this.addCompositeGlyphComponents(glyphSet);

    // Create mapping from old glyph IDs to new ones
    const sortedGlyphs = Array.from(glyphSet).sort((a, b) => a - b);
    const glyphToNewGlyph = new Map<number, number>();
    sortedGlyphs.forEach((oldId, newId) => {
      glyphToNewGlyph.set(oldId, newId);
    });

    // Build subset tables
    const tables = this.buildSubsetTables(sortedGlyphs, glyphToNewGlyph);

    // Assemble font file
    const fontData = this.assembleFontFile(tables);

    // Build widths map for the subset
    const widths = new Map<number, number>();
    for (const [oldId, newId] of glyphToNewGlyph) {
      const width = this.font.glyphWidths.get(oldId) || 0;
      widths.set(newId, width);
    }

    return {
      fontData,
      glyphToNewGlyph,
      usedGlyphIds: glyphSet,
      widths
    };
  }

  private addCompositeGlyphComponents(glyphSet: Set<number>): void {
    const glyfTable = this.font.tables.get('glyf');
    const locaTable = this.font.tables.get('loca');
    if (!glyfTable || !locaTable) return;

    // Simplified: in a full implementation, parse loca and glyf to find composite glyphs
    // For now, we assume all glyphs are simple
  }

  private buildSubsetTables(sortedGlyphs: number[], mapping: Map<number, number>): Map<string, Uint8Array> {
    const tables = new Map<string, Uint8Array>();

    // Copy and modify required tables
    tables.set('head', this.subsetHead());
    tables.set('hhea', this.subsetHhea(sortedGlyphs.length));
    tables.set('maxp', this.subsetMaxp(sortedGlyphs.length));
    tables.set('hmtx', this.subsetHmtx(sortedGlyphs));
    tables.set('cmap', this.subsetCmap(mapping));
    tables.set('loca', this.subsetLoca(sortedGlyphs));
    tables.set('glyf', this.subsetGlyf(sortedGlyphs));
    tables.set('name', this.font.tables.get('name') || new Uint8Array(0));
    tables.set('post', this.subsetPost());

    if (this.font.tables.has('OS/2')) {
      tables.set('OS/2', this.font.tables.get('OS/2')!);
    }

    return tables;
  }

  private subsetHead(): Uint8Array {
    const original = this.font.tables.get('head')!;
    const result = new Uint8Array(original.length);
    result.set(original);
    // Set indexToLocFormat to 0 (short offsets) for simplicity
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    view.setInt16(50, 0);
    return result;
  }

  private subsetHhea(numGlyphs: number): Uint8Array {
    const original = this.font.tables.get('hhea')!;
    const result = new Uint8Array(original.length);
    result.set(original);
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    view.setUint16(34, numGlyphs); // numberOfHMetrics
    return result;
  }

  private subsetMaxp(numGlyphs: number): Uint8Array {
    const original = this.font.tables.get('maxp')!;
    const result = new Uint8Array(original.length);
    result.set(original);
    const view = new DataView(result.buffer, result.byteOffset, result.byteLength);
    view.setUint16(4, numGlyphs);
    return result;
  }

  private subsetHmtx(sortedGlyphs: number[]): Uint8Array {
    const result = new Uint8Array(sortedGlyphs.length * 4);
    const view = new DataView(result.buffer);

    for (let i = 0; i < sortedGlyphs.length; i++) {
      const oldId = sortedGlyphs[i];
      const metrics = this.font.hmtx[oldId] || { advanceWidth: 0, lsb: 0 };
      view.setUint16(i * 4, metrics.advanceWidth);
      view.setInt16(i * 4 + 2, metrics.lsb);
    }

    return result;
  }

  private subsetCmap(mapping: Map<number, number>): Uint8Array {
    // Build format 4 cmap for BMP characters
    const unicodeToNewGlyph = new Map<number, number>();
    for (const [oldGlyphId, newGlyphId] of mapping) {
      const unicode = this.font.reverseCmap.get(oldGlyphId);
      if (unicode !== undefined && unicode <= 0xFFFF) {
        unicodeToNewGlyph.set(unicode, newGlyphId);
      }
    }

    // Build segments
    const sortedUnicodes = Array.from(unicodeToNewGlyph.keys()).sort((a, b) => a - b);
    const segments: { start: number; end: number; delta: number }[] = [];

    if (sortedUnicodes.length > 0) {
      let segStart = sortedUnicodes[0];
      let segEnd = sortedUnicodes[0];
      let segDelta = unicodeToNewGlyph.get(segStart)! - segStart;

      for (let i = 1; i < sortedUnicodes.length; i++) {
        const unicode = sortedUnicodes[i];
        const newGlyph = unicodeToNewGlyph.get(unicode)!;
        const expectedDelta = newGlyph - unicode;

        if (unicode === segEnd + 1 && expectedDelta === segDelta) {
          segEnd = unicode;
        } else {
          segments.push({ start: segStart, end: segEnd, delta: segDelta });
          segStart = unicode;
          segEnd = unicode;
          segDelta = expectedDelta;
        }
      }
      segments.push({ start: segStart, end: segEnd, delta: segDelta });
    }

    // Add terminating segment
    segments.push({ start: 0xFFFF, end: 0xFFFF, delta: 1 });

    const segCount = segments.length;
    const searchRange = 2 * Math.pow(2, Math.floor(Math.log2(segCount)));
    const entrySelector = Math.floor(Math.log2(segCount));
    const rangeShift = 2 * segCount - searchRange;

    // Calculate size
    const format4Length = 16 + segCount * 8;
    const cmapLength = 4 + 8 + format4Length; // header + encoding record + format 4

    const result = new Uint8Array(cmapLength);
    const view = new DataView(result.buffer);

    // Cmap header
    view.setUint16(0, 0); // version
    view.setUint16(2, 1); // numTables

    // Encoding record
    view.setUint16(4, 3); // platformID (Windows)
    view.setUint16(6, 1); // encodingID (Unicode BMP)
    view.setUint32(8, 12); // offset

    // Format 4 subtable
    let offset = 12;
    view.setUint16(offset, 4); // format
    view.setUint16(offset + 2, format4Length); // length
    view.setUint16(offset + 4, 0); // language
    view.setUint16(offset + 6, segCount * 2); // segCountX2
    view.setUint16(offset + 8, searchRange);
    view.setUint16(offset + 10, entrySelector);
    view.setUint16(offset + 12, rangeShift);

    // endCode
    offset = 26;
    for (const seg of segments) {
      view.setUint16(offset, seg.end);
      offset += 2;
    }

    // reservedPad
    view.setUint16(offset, 0);
    offset += 2;

    // startCode
    for (const seg of segments) {
      view.setUint16(offset, seg.start);
      offset += 2;
    }

    // idDelta
    for (const seg of segments) {
      view.setInt16(offset, seg.delta);
      offset += 2;
    }

    // idRangeOffset (all zeros for delta-based mapping)
    for (let i = 0; i < segCount; i++) {
      view.setUint16(offset, 0);
      offset += 2;
    }

    return result;
  }

  private subsetLoca(sortedGlyphs: number[]): Uint8Array {
    // Short format loca table
    const result = new Uint8Array((sortedGlyphs.length + 1) * 2);
    const view = new DataView(result.buffer);

    const glyfTable = this.font.tables.get('glyf');
    const locaTable = this.font.tables.get('loca');

    if (!glyfTable || !locaTable) {
      // Return empty loca
      return result;
    }

    // Parse original loca to get glyph offsets
    const origLocaView = new DataView(locaTable.buffer, locaTable.byteOffset, locaTable.byteLength);
    const isLongFormat = locaTable.length > (this.font.numGlyphs + 1) * 2;

    let currentOffset = 0;
    for (let i = 0; i <= sortedGlyphs.length; i++) {
      view.setUint16(i * 2, currentOffset / 2);

      if (i < sortedGlyphs.length) {
        const oldGlyphId = sortedGlyphs[i];
        let glyphStart: number, glyphEnd: number;

        if (isLongFormat) {
          glyphStart = origLocaView.getUint32(oldGlyphId * 4);
          glyphEnd = origLocaView.getUint32((oldGlyphId + 1) * 4);
        } else {
          glyphStart = origLocaView.getUint16(oldGlyphId * 2) * 2;
          glyphEnd = origLocaView.getUint16((oldGlyphId + 1) * 2) * 2;
        }

        currentOffset += glyphEnd - glyphStart;
        // Align to 2-byte boundary
        if (currentOffset % 2 !== 0) currentOffset++;
      }
    }

    return result;
  }

  private subsetGlyf(sortedGlyphs: number[]): Uint8Array {
    const glyfTable = this.font.tables.get('glyf');
    const locaTable = this.font.tables.get('loca');

    if (!glyfTable || !locaTable) {
      return new Uint8Array(0);
    }

    const origLocaView = new DataView(locaTable.buffer, locaTable.byteOffset, locaTable.byteLength);
    const isLongFormat = locaTable.length > (this.font.numGlyphs + 1) * 2;

    // Calculate total size
    let totalSize = 0;
    for (const oldGlyphId of sortedGlyphs) {
      let glyphStart: number, glyphEnd: number;

      if (isLongFormat) {
        glyphStart = origLocaView.getUint32(oldGlyphId * 4);
        glyphEnd = origLocaView.getUint32((oldGlyphId + 1) * 4);
      } else {
        glyphStart = origLocaView.getUint16(oldGlyphId * 2) * 2;
        glyphEnd = origLocaView.getUint16((oldGlyphId + 1) * 2) * 2;
      }

      const glyphLen = glyphEnd - glyphStart;
      totalSize += glyphLen;
      if (totalSize % 2 !== 0) totalSize++;
    }

    const result = new Uint8Array(totalSize);
    let offset = 0;

    for (const oldGlyphId of sortedGlyphs) {
      let glyphStart: number, glyphEnd: number;

      if (isLongFormat) {
        glyphStart = origLocaView.getUint32(oldGlyphId * 4);
        glyphEnd = origLocaView.getUint32((oldGlyphId + 1) * 4);
      } else {
        glyphStart = origLocaView.getUint16(oldGlyphId * 2) * 2;
        glyphEnd = origLocaView.getUint16((oldGlyphId + 1) * 2) * 2;
      }

      const glyphData = glyfTable.slice(glyphStart, glyphEnd);
      result.set(glyphData, offset);
      offset += glyphData.length;
      if (offset % 2 !== 0) offset++;
    }

    return result;
  }

  private subsetPost(): Uint8Array {
    // Create minimal post table (version 3.0 - no glyph names)
    const result = new Uint8Array(32);
    const view = new DataView(result.buffer);

    view.setUint32(0, 0x00030000); // version 3.0
    view.setInt32(4, Math.round(this.font.post.italicAngle * 65536)); // italicAngle
    view.setInt16(8, 0); // underlinePosition
    view.setInt16(10, 0); // underlineThickness
    view.setUint32(12, this.font.post.isFixedPitch ? 1 : 0); // isFixedPitch
    view.setUint32(16, 0); // minMemType42
    view.setUint32(20, 0); // maxMemType42
    view.setUint32(24, 0); // minMemType1
    view.setUint32(28, 0); // maxMemType1

    return result;
  }

  private assembleFontFile(tables: Map<string, Uint8Array>): Uint8Array {
    const tableOrder = ['head', 'hhea', 'maxp', 'OS/2', 'hmtx', 'cmap', 'loca', 'glyf', 'name', 'post'];
    const orderedTables = tableOrder.filter(t => tables.has(t));

    const numTables = orderedTables.length;
    const searchRange = Math.pow(2, Math.floor(Math.log2(numTables))) * 16;
    const entrySelector = Math.floor(Math.log2(numTables));
    const rangeShift = numTables * 16 - searchRange;

    // Calculate offsets
    let offset = 12 + numTables * 16; // header + table directory
    // Align to 4-byte boundary
    if (offset % 4 !== 0) offset += 4 - (offset % 4);

    const tableInfo: { tag: string; offset: number; length: number; checksum: number }[] = [];

    for (const tag of orderedTables) {
      const data = tables.get(tag)!;
      tableInfo.push({
        tag,
        offset,
        length: data.length,
        checksum: this.calculateChecksum(data)
      });
      offset += data.length;
      // Align to 4-byte boundary
      if (offset % 4 !== 0) offset += 4 - (offset % 4);
    }

    // Create the font file
    const result = new Uint8Array(offset);
    const view = new DataView(result.buffer);

    // Write header
    view.setUint32(0, 0x00010000); // sfntVersion
    view.setUint16(4, numTables);
    view.setUint16(6, searchRange);
    view.setUint16(8, entrySelector);
    view.setUint16(10, rangeShift);

    // Write table directory
    for (let i = 0; i < tableInfo.length; i++) {
      const info = tableInfo[i];
      const dirOffset = 12 + i * 16;

      // Write tag
      for (let j = 0; j < 4; j++) {
        result[dirOffset + j] = info.tag.charCodeAt(j);
      }
      view.setUint32(dirOffset + 4, info.checksum);
      view.setUint32(dirOffset + 8, info.offset);
      view.setUint32(dirOffset + 12, info.length);
    }

    // Write table data
    for (const info of tableInfo) {
      const data = tables.get(info.tag)!;
      result.set(data, info.offset);
    }

    return result;
  }

  private calculateChecksum(data: Uint8Array): number {
    let checksum = 0;
    const paddedLength = Math.ceil(data.length / 4) * 4;
    const padded = new Uint8Array(paddedLength);
    padded.set(data);
    const view = new DataView(padded.buffer);

    for (let i = 0; i < paddedLength; i += 4) {
      checksum = (checksum + view.getUint32(i)) >>> 0;
    }

    return checksum;
  }
}

/**
 * ToUnicode CMap generator
 */
export class ToUnicodeCMapGenerator {
  /**
   * Generate a ToUnicode CMap for a subset font
   */
  generate(mapping: Map<number, number>, reverseCmap: Map<number, number>): string {
    const lines: string[] = [
      '/CIDInit /ProcSet findresource begin',
      '12 dict begin',
      'begincmap',
      '/CIDSystemInfo <<',
      '  /Registry (Adobe)',
      '  /Ordering (UCS)',
      '  /Supplement 0',
      '>> def',
      '/CMapName /Adobe-Identity-UCS def',
      '/CMapType 2 def',
      '1 begincodespacerange',
      '<0000> <FFFF>',
      'endcodespacerange'
    ];

    // Build char mappings
    const charMappings: { newGlyph: number; unicode: number }[] = [];
    for (const [oldGlyph, newGlyph] of mapping) {
      const unicode = reverseCmap.get(oldGlyph);
      if (unicode !== undefined) {
        charMappings.push({ newGlyph, unicode });
      }
    }

    charMappings.sort((a, b) => a.newGlyph - b.newGlyph);

    // Output in chunks of 100
    for (let i = 0; i < charMappings.length; i += 100) {
      const chunk = charMappings.slice(i, i + 100);
      lines.push(`${chunk.length} beginbfchar`);
      for (const { newGlyph, unicode } of chunk) {
        const glyphHex = newGlyph.toString(16).padStart(4, '0').toUpperCase();
        const unicodeHex = unicode.toString(16).padStart(4, '0').toUpperCase();
        lines.push(`<${glyphHex}> <${unicodeHex}>`);
      }
      lines.push('endbfchar');
    }

    lines.push(
      'endcmap',
      'CMapName currentdict /CMap defineresource pop',
      'end',
      'end'
    );

    return lines.join('\n');
  }
}

/**
 * Main FontManager class
 */
export class FontManager {
  private fonts: Map<string, TrueTypeFont> = new Map();
  private embeddedFonts: Map<string, EmbeddedFont> = new Map();
  private subsetPrefix: number = 0;

  /**
   * Load a TrueType/OpenType font from data
   */
  loadFont(fontName: string, fontData: Uint8Array): void {
    const parser = new TrueTypeFontParser(fontData);
    const font = parser.parse();
    this.fonts.set(fontName, font);
  }

  /**
   * Get font metrics for a loaded font
   */
  getFontMetrics(fontName: string): {
    ascent: number;
    descent: number;
    unitsPerEm: number;
    capHeight: number;
    xHeight: number;
  } | null {
    const font = this.fonts.get(fontName);
    if (!font) return null;

    return {
      ascent: font.os2?.sTypoAscender ?? font.hhea.ascent,
      descent: font.os2?.sTypoDescender ?? font.hhea.descent,
      unitsPerEm: font.head.unitsPerEm,
      capHeight: font.os2?.sCapHeight ?? 0,
      xHeight: font.os2?.sxHeight ?? 0
    };
  }

  /**
   * Get glyph width for a character
   */
  getCharWidth(fontName: string, charCode: number): number {
    const font = this.fonts.get(fontName);
    if (!font) return 0;

    const glyphId = font.cmap.get(charCode);
    if (glyphId === undefined) return 0;

    return font.glyphWidths.get(glyphId) || 0;
  }

  /**
   * Get text width in font units
   */
  getTextWidth(fontName: string, text: string): number {
    let width = 0;
    for (const char of text) {
      width += this.getCharWidth(fontName, char.charCodeAt(0));
    }
    return width;
  }

  /**
   * Create a subset font for the given text
   */
  createSubset(fontName: string, text: string): SubsetResult | null {
    const font = this.fonts.get(fontName);
    if (!font) return null;

    // Get all glyph IDs used by the text
    const usedGlyphIds = new Set<number>();
    for (const char of text) {
      const glyphId = font.cmap.get(char.charCodeAt(0));
      if (glyphId !== undefined) {
        usedGlyphIds.add(glyphId);
      }
    }

    const subsetter = new FontSubsetter(font);
    return subsetter.subset(usedGlyphIds);
  }

  /**
   * Embed a font into a PDF, creating a subset with only the required characters
   */
  embedFont(fontName: string, usedText: string): EmbeddedFont | null {
    const font = this.fonts.get(fontName);
    if (!font) return null;

    // Generate subset prefix
    const prefix = this.generateSubsetPrefix();
    const subsetFontName = `${prefix}+${fontName}`;

    // Create subset
    const subsetResult = this.createSubset(fontName, usedText);
    if (!subsetResult) return null;

    // Generate ToUnicode CMap
    const toUnicodeGen = new ToUnicodeCMapGenerator();
    const toUnicode = toUnicodeGen.generate(
      subsetResult.glyphToNewGlyph,
      font.reverseCmap
    );

    // Calculate widths array
    const widthsArray: number[] = [];
    const sortedNewGlyphs = Array.from(subsetResult.glyphToNewGlyph.values()).sort((a, b) => a - b);
    const firstChar = sortedNewGlyphs[0] || 0;
    const lastChar = sortedNewGlyphs[sortedNewGlyphs.length - 1] || 0;

    for (let i = firstChar; i <= lastChar; i++) {
      const width = subsetResult.widths.get(i) || 0;
      // Convert to PDF units (1000 units per em)
      widthsArray.push(Math.round(width * 1000 / font.head.unitsPerEm));
    }

    // Build font descriptor
    const descriptor: FontDescriptor = {
      fontName: subsetFontName,
      fontFamily: font.name.get(1) || fontName,
      flags: this.calculateFontFlags(font),
      fontBBox: {
        x: font.head.xMin,
        y: font.head.yMin,
        width: font.head.xMax - font.head.xMin,
        height: font.head.yMax - font.head.yMin
      },
      italicAngle: font.post.italicAngle,
      ascent: Math.round((font.os2?.sTypoAscender ?? font.hhea.ascent) * 1000 / font.head.unitsPerEm),
      descent: Math.round((font.os2?.sTypoDescender ?? font.hhea.descent) * 1000 / font.head.unitsPerEm),
      capHeight: Math.round((font.os2?.sCapHeight ?? 0) * 1000 / font.head.unitsPerEm),
      xHeight: Math.round((font.os2?.sxHeight ?? 0) * 1000 / font.head.unitsPerEm),
      stemV: 80, // Default value
      stemH: 80,
      avgWidth: 0,
      maxWidth: 0,
      missingWidth: 0
    };

    const embedded: EmbeddedFont = {
      fontName: subsetFontName,
      fontRef: `F${this.embeddedFonts.size + 1}`,
      fontStream: subsetResult.fontData,
      widths: widthsArray,
      firstChar,
      lastChar,
      toUnicode,
      descriptor,
      isSubset: true,
      subsetPrefix: prefix
    };

    this.embeddedFonts.set(fontName, embedded);
    return embedded;
  }

  /**
   * Get an embedded font by name
   */
  getEmbeddedFont(fontName: string): EmbeddedFont | undefined {
    return this.embeddedFonts.get(fontName);
  }

  private generateSubsetPrefix(): string {
    // Generate 6-letter prefix (A-Z)
    let prefix = '';
    let n = this.subsetPrefix++;
    for (let i = 0; i < 6; i++) {
      prefix = String.fromCharCode(65 + (n % 26)) + prefix;
      n = Math.floor(n / 26);
    }
    return prefix;
  }

  private calculateFontFlags(font: TrueTypeFont): number {
    let flags = 0;

    // FixedPitch
    if (font.post.isFixedPitch) flags |= 1;

    // Serif - can't determine easily, skip

    // Symbolic - if no cmap entries in standard range
    // For now, assume non-symbolic
    flags |= 32; // Nonsymbolic

    // Italic
    if (font.post.italicAngle !== 0 || (font.os2?.fsSelection ?? 0) & 1) {
      flags |= 64;
    }

    return flags;
  }

  /**
   * Extract font info from a PDF font dictionary
   */
  extractFontInfo(fontDict: any): FontInfo {
    // This would parse PDF font dictionaries
    // Implementation depends on PDF library being used
    return {
      name: fontDict.name || 'Unknown',
      subtype: fontDict.subtype || 'Type1',
      baseFont: fontDict.baseFont || 'Helvetica',
      encoding: 'WinAnsiEncoding',
      toUnicode: null,
      widths: new Map(),
      descriptor: null,
      isEmbedded: false,
      isSubset: false,
      isCIDFont: false
    };
  }
}

export default FontManager;
