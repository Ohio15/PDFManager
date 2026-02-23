/**
 * Shared PDF content stream utilities.
 *
 * Extracted from pdfTextReplacer.ts and blankText.ts to eliminate ~200 lines
 * of byte-identical duplicated code (Issue #11).
 */

import {
  PDFDocument,
  PDFName,
  PDFStream,
  PDFRawStream,
  PDFDict,
  PDFArray,
  PDFRef,
  decodePDFRawStream,
} from 'pdf-lib';
import * as pako from 'pako';

export interface FontInfo {
  name: string;
  subtype: string;
  encoding: string | null;
  toUnicode: Map<number, string> | null;
  cidToGid: Map<number, number> | null;
  isSubset: boolean;
  isCIDFont: boolean;
}

// Cache for font mappings per document
export const fontCache = new WeakMap<PDFDocument, Map<string, FontInfo>>();

/**
 * Get content streams from page
 */
export function getContentStreams(context: any, contentsRef: any): PDFStream[] {
  const contentStreams: PDFStream[] = [];
  const contentsObj = context.lookup(contentsRef);

  if (contentsObj instanceof PDFArray) {
    for (let i = 0; i < contentsObj.size(); i++) {
      const streamRef = contentsObj.get(i);
      const stream = context.lookup(streamRef);
      if (stream instanceof PDFStream || stream instanceof PDFRawStream) {
        contentStreams.push(stream as PDFStream);
      }
    }
  } else if (contentsObj instanceof PDFStream || contentsObj instanceof PDFRawStream) {
    contentStreams.push(contentsObj as PDFStream);
  }

  return contentStreams;
}

/**
 * Decode a content stream
 */
export function decodeStream(stream: PDFStream): Uint8Array | null {
  try {
    const decoded = decodePDFRawStream(stream as PDFRawStream);
    return decoded.decode();
  } catch (e) {
    const rawStream = stream as any;
    if (rawStream.contents) {
      try {
        return pako.inflate(rawStream.contents);
      } catch {
        return rawStream.contents;
      }
    }
    return null;
  }
}

/**
 * Update stream with new content
 */
export function updateStream(stream: PDFStream, contentStr: string, pdfDoc: PDFDocument): void {
  // Use latin1 encoding to match PDF content stream encoding (not UTF-8!)
  const newContentBytes = new Uint8Array(contentStr.length);
  for (let i = 0; i < contentStr.length; i++) {
    newContentBytes[i] = contentStr.charCodeAt(i) & 0xFF;
  }
  const compressed = pako.deflate(newContentBytes);

  const streamDict = stream.dict;
  streamDict.set(PDFName.of('Length'), pdfDoc.context.obj(compressed.length));
  streamDict.set(PDFName.of('Filter'), PDFName.of('FlateDecode'));

  (stream as any).contents = compressed;
}

/**
 * Build font cache for a page
 */
export async function buildFontCache(pdfDoc: PDFDocument, pageIndex: number): Promise<void> {
  if (!fontCache.has(pdfDoc)) {
    fontCache.set(pdfDoc, new Map());
  }
  const cache = fontCache.get(pdfDoc)!;

  const pages = pdfDoc.getPages();
  const page = pages[pageIndex];
  const pageDict = page.node;

  const resources = pageDict.get(PDFName.of('Resources'));
  if (!resources) return;

  const resourcesDict = pdfDoc.context.lookup(resources);
  if (!(resourcesDict instanceof PDFDict)) return;

  const fonts = resourcesDict.get(PDFName.of('Font'));
  if (!fonts) return;

  const fontsDict = pdfDoc.context.lookup(fonts);
  if (!(fontsDict instanceof PDFDict)) return;

  const fontEntries = fontsDict.entries();
  for (const [fontName, fontRef] of fontEntries) {
    const fontNameStr = fontName.toString().replace('/', '');
    if (cache.has(fontNameStr)) continue;

    const fontInfo = extractFontInfo(pdfDoc, fontRef);
    if (fontInfo) {
      cache.set(fontNameStr, fontInfo);
    }
  }
}

/**
 * Extract font information including ToUnicode mapping
 */
export function extractFontInfo(pdfDoc: PDFDocument, fontRef: any): FontInfo | null {
  try {
    const fontDict = pdfDoc.context.lookup(fontRef);
    if (!(fontDict instanceof PDFDict)) return null;

    const subtype = fontDict.get(PDFName.of('Subtype'));
    const subtypeStr = subtype ? subtype.toString().replace('/', '') : 'Unknown';

    const baseFont = fontDict.get(PDFName.of('BaseFont'));
    const baseFontStr = baseFont ? baseFont.toString().replace('/', '') : 'Unknown';

    const isSubset = /^[A-Z]{6}\+/.test(baseFontStr);
    const isCIDFont = subtypeStr === 'Type0' || subtypeStr === 'CIDFontType0' || subtypeStr === 'CIDFontType2';

    let encoding: string | null = null;
    const encodingObj = fontDict.get(PDFName.of('Encoding'));
    if (encodingObj) {
      if (encodingObj instanceof PDFName) {
        encoding = encodingObj.toString().replace('/', '');
      }
    }

    let toUnicode: Map<number, string> | null = null;
    const toUnicodeRef = fontDict.get(PDFName.of('ToUnicode'));
    if (toUnicodeRef) {
      toUnicode = parseToUnicodeCMap(pdfDoc, toUnicodeRef);
    }

    let cidToGid: Map<number, number> | null = null;
    if (isCIDFont) {
      const descendantFonts = fontDict.get(PDFName.of('DescendantFonts'));
      if (descendantFonts) {
        const descArray = pdfDoc.context.lookup(descendantFonts);
        if (descArray instanceof PDFArray && descArray.size() > 0) {
          const cidFontRef = descArray.get(0);
          const cidFontDict = pdfDoc.context.lookup(cidFontRef);
          if (cidFontDict instanceof PDFDict) {
            const cidToGidRef = cidFontDict.get(PDFName.of('CIDToGIDMap'));
            if (cidToGidRef && cidToGidRef instanceof PDFName) {
              if (cidToGidRef.toString() === '/Identity') {
                cidToGid = null;
              }
            }
          }
        }
      }
    }

    return {
      name: baseFontStr,
      subtype: subtypeStr,
      encoding,
      toUnicode,
      cidToGid,
      isSubset,
      isCIDFont
    };
  } catch (e) {
    console.error('Error extracting font info:', e);
    return null;
  }
}

/**
 * Parse ToUnicode CMap stream
 */
export function parseToUnicodeCMap(pdfDoc: PDFDocument, toUnicodeRef: any): Map<number, string> | null {
  try {
    const stream = pdfDoc.context.lookup(toUnicodeRef);
    if (!(stream instanceof PDFStream) && !(stream instanceof PDFRawStream)) {
      return null;
    }

    const bytes = decodeStream(stream);
    if (!bytes) return null;

    const cmapStr = new TextDecoder('latin1').decode(bytes);
    const mapping = new Map<number, string>();

    // Parse bfchar mappings
    const bfcharPattern = /beginbfchar\s+([\s\S]*?)\s*endbfchar/g;
    let match;
    while ((match = bfcharPattern.exec(cmapStr)) !== null) {
      const content = match[1];
      const linePattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let lineMatch;
      while ((lineMatch = linePattern.exec(content)) !== null) {
        const srcCode = parseInt(lineMatch[1], 16);
        const dstHex = lineMatch[2];
        let dstStr = '';
        for (let i = 0; i < dstHex.length; i += 4) {
          const codePoint = parseInt(dstHex.substr(i, 4), 16);
          dstStr += String.fromCodePoint(codePoint);
        }
        mapping.set(srcCode, dstStr);
      }
    }

    // Parse bfrange mappings
    const bfrangePattern = /beginbfrange\s+([\s\S]*?)\s*endbfrange/g;
    while ((match = bfrangePattern.exec(cmapStr)) !== null) {
      const content = match[1];
      const linePattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>\s*(<[0-9A-Fa-f]+>|\[[\s\S]*?\])/g;
      let lineMatch;
      while ((lineMatch = linePattern.exec(content)) !== null) {
        const srcLo = parseInt(lineMatch[1], 16);
        const srcHi = parseInt(lineMatch[2], 16);
        const dstPart = lineMatch[3];

        if (dstPart.startsWith('[')) {
          const arrayPattern = /<([0-9A-Fa-f]+)>/g;
          let arrayMatch;
          let idx = 0;
          while ((arrayMatch = arrayPattern.exec(dstPart)) !== null) {
            const dstHex = arrayMatch[1];
            let dstStr = '';
            for (let i = 0; i < dstHex.length; i += 4) {
              const codePoint = parseInt(dstHex.substr(i, 4), 16);
              dstStr += String.fromCodePoint(codePoint);
            }
            mapping.set(srcLo + idx, dstStr);
            idx++;
          }
        } else {
          const dstHex = dstPart.replace(/[<>]/g, '');
          let baseCode = parseInt(dstHex, 16);
          for (let code = srcLo; code <= srcHi; code++) {
            let dstStr = '';
            const currentHex = baseCode.toString(16).padStart(dstHex.length, '0');
            for (let i = 0; i < currentHex.length; i += 4) {
              const chunk = currentHex.substr(i, Math.min(4, currentHex.length - i)).padStart(4, '0');
              const codePoint = parseInt(chunk, 16);
              dstStr += String.fromCodePoint(codePoint);
            }
            mapping.set(code, dstStr);
            baseCode++;
          }
        }
      }
    }

    return mapping.size > 0 ? mapping : null;
  } catch (e) {
    console.error('Error parsing ToUnicode CMap:', e);
    return null;
  }
}

/**
 * Escape special characters for PDF string literals
 */
export function escapePDFString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * Unescape PDF string literals
 */
export function unescapePDFString(str: string): string {
  return str
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

/**
 * Escape special regex characters
 */
export function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert hex string to text
 */
export function hexToString(hex: string): string {
  let result = '';
  const cleanHex = hex.replace(/\s/g, '');
  for (let i = 0; i < cleanHex.length; i += 2) {
    const code = parseInt(cleanHex.substr(i, 2), 16);
    if (!isNaN(code)) {
      result += String.fromCharCode(code);
    }
  }
  return result;
}

/**
 * Convert text to hex string
 */
export function stringToHex(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    result += str.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase();
  }
  return result;
}
