import { PDFDocument, PDFName, PDFStream, PDFRawStream, PDFDict, PDFArray, decodePDFRawStream } from 'pdf-lib';
import * as pako from 'pako';

interface FontInfo {
  name: string;
  subtype: string;
  encoding: string | null;
  toUnicode: Map<number, string> | null;
  cidToGid: Map<number, number> | null;
  isSubset: boolean;
  isCIDFont: boolean;
}

// Cache for font mappings per document
const fontCache = new WeakMap<PDFDocument, Map<string, FontInfo>>();

/**
 * Blank out text in content stream by replacing with spaces.
 * This is used when overlay fallback is applied - we blank the original text
 * so that PDF.js doesn't re-extract it when the PDF is reopened.
 */
export async function blankTextInContentStream(
  pdfDoc: PDFDocument,
  pageIndex: number,
  originalText: string
): Promise<boolean> {
  try {
    console.log('[blankText] Attempting to blank text:', originalText, 'on page', pageIndex + 1);

    const pages = pdfDoc.getPages();
    const page = pages[pageIndex];
    if (!page) {
      console.log('[blankText] Page not found');
      return false;
    }

    const pageDict = page.node;
    const contentsRef = pageDict.get(PDFName.of('Contents'));
    if (!contentsRef) {
      console.log('[blankText] No contents ref');
      return false;
    }

    const context = pdfDoc.context;
    const contentStreams = getContentStreams(context, contentsRef);

    let blanked = false;

    for (const stream of contentStreams) {
      const contentBytes = decodeStream(stream);
      if (!contentBytes) continue;

      let contentStr = new TextDecoder('latin1').decode(contentBytes);
      const originalContent = contentStr;

      // Create a space string of the same length as the original
      const spaces = ' '.repeat(originalText.length);

      // Strategy 1: Blank in direct (text) Tj patterns
      contentStr = blankDirectTj(contentStr, originalText, spaces);

      // Strategy 2: Blank in TJ arrays
      contentStr = blankTJArrays(contentStr, originalText, spaces);

      // Strategy 3: Blank hex-encoded text
      contentStr = blankHexTj(contentStr, originalText, spaces);

      // Strategy 4: Try to blank using CID font mappings
      await buildFontCache(pdfDoc, pageIndex);
      const cache = fontCache.get(pdfDoc);
      if (cache) {
        contentStr = blankCIDText(contentStr, originalText, spaces, cache);
      }

      if (contentStr !== originalContent) {
        blanked = true;
        console.log('[blankText] Successfully blanked text in content stream');
        updateStream(stream, contentStr, pdfDoc);
      }
    }

    if (!blanked) {
      console.log('[blankText] Could not find text to blank in content stream');
    }

    return blanked;
  } catch (error) {
    console.error('[blankText] Error blanking text:', error);
    return false;
  }
}

/**
 * Get content streams from page
 */
function getContentStreams(context: any, contentsRef: any): PDFStream[] {
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
function decodeStream(stream: PDFStream): Uint8Array | null {
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
function updateStream(stream: PDFStream, contentStr: string, pdfDoc: PDFDocument): void {
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
async function buildFontCache(pdfDoc: PDFDocument, pageIndex: number): Promise<void> {
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
function extractFontInfo(pdfDoc: PDFDocument, fontRef: any): FontInfo | null {
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
function parseToUnicodeCMap(pdfDoc: PDFDocument, toUnicodeRef: any): Map<number, string> | null {
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
 * Blank direct (text) Tj patterns
 */
function blankDirectTj(content: string, original: string, spaces: string): string {
  const escapedOrig = escapePDFString(original);
  const escapedSpaces = escapePDFString(spaces);

  const pattern = new RegExp('\\(' + escapeRegex(escapedOrig) + '\\)\\s*Tj', 'g');
  return content.replace(pattern, '(' + escapedSpaces + ') Tj');
}

/**
 * Blank text within TJ arrays
 */
function blankTJArrays(content: string, original: string, spaces: string): string {
  const escapedOrig = escapePDFString(original);
  const tjArrayPattern = /\[([^\]]*)\]\s*TJ/gi;

  return content.replace(tjArrayPattern, (match, arrayContent) => {
    let fullText = '';
    let pos = 0;
    while (pos < arrayContent.length) {
      while (pos < arrayContent.length && /\s/.test(arrayContent[pos])) pos++;
      if (pos >= arrayContent.length) break;

      if (arrayContent[pos] === '(') {
        let text = '';
        pos++;
        let depth = 1;
        while (pos < arrayContent.length && depth > 0) {
          if (arrayContent[pos] === '\\' && pos + 1 < arrayContent.length) {
            text += arrayContent[pos] + arrayContent[pos + 1];
            pos += 2;
          } else if (arrayContent[pos] === '(') {
            depth++;
            text += arrayContent[pos++];
          } else if (arrayContent[pos] === ')') {
            depth--;
            if (depth > 0) text += arrayContent[pos];
            pos++;
          } else {
            text += arrayContent[pos++];
          }
        }
        fullText += unescapePDFString(text);
      } else if (arrayContent[pos] === '<') {
        pos++;
        let hex = '';
        while (pos < arrayContent.length && arrayContent[pos] !== '>') {
          hex += arrayContent[pos++];
        }
        pos++;
        fullText += hexToString(hex);
      } else if (arrayContent[pos] === '-' || /\d/.test(arrayContent[pos])) {
        if (arrayContent[pos] === '-') pos++;
        while (pos < arrayContent.length && /[\d.]/.test(arrayContent[pos])) {
          pos++;
        }
      } else {
        pos++;
      }
    }

    const unescapedOrig = unescapePDFString(escapedOrig);
    if (fullText.includes(unescapedOrig)) {
      const newFullText = fullText.replace(unescapedOrig, spaces);
      return '[(' + escapePDFString(newFullText) + ')] TJ';
    }

    return match;
  });
}

/**
 * Blank hex-encoded text
 */
function blankHexTj(content: string, original: string, spaces: string): string {
  const originalHex = stringToHex(original);
  const spacesHex = stringToHex(spaces);

  const pattern = new RegExp('<' + escapeRegex(originalHex) + '>\\s*Tj', 'gi');
  return content.replace(pattern, '<' + spacesHex + '> Tj');
}

/**
 * Blank text using CID font ToUnicode mappings
 */
function blankCIDText(
  content: string,
  original: string,
  spaces: string,
  fontCacheMap: Map<string, FontInfo>
): string {
  let currentFont: FontInfo | null = null;
  const fontPattern = /\/([A-Za-z0-9+]+)\s+[\d.]+\s+Tf/g;
  const hexPattern = /<([0-9A-Fa-f]+)>/g;

  const buildReverseMap = (toUnicode: Map<number, string>): Map<string, number> => {
    const reverse = new Map<string, number>();
    for (const [code, char] of toUnicode) {
      reverse.set(char, code);
    }
    return reverse;
  };

  const lines = content.split('\n');
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    const fontMatch = fontPattern.exec(line);
    if (fontMatch) {
      const fontName = fontMatch[1];
      currentFont = fontCacheMap.get(fontName) || null;
    }
    fontPattern.lastIndex = 0;

    if (currentFont && currentFont.toUnicode) {
      const toUnicode = currentFont.toUnicode;
      const hexMatches: Array<{match: string, hex: string, start: number}> = [];
      let hexMatch;
      while ((hexMatch = hexPattern.exec(line)) !== null) {
        hexMatches.push({
          match: hexMatch[0],
          hex: hexMatch[1],
          start: hexMatch.index
        });
      }
      hexPattern.lastIndex = 0;

      if (hexMatches.length > 0) {
        let decodedText = '';
        for (const hm of hexMatches) {
          const hex = hm.hex;
          const byteSize = hex.length >= 4 && (hex.length % 4 === 0) ? 4 : 2;
          for (let j = 0; j < hex.length; j += byteSize) {
            const code = parseInt(hex.substr(j, byteSize), 16);
            const char = toUnicode.get(code);
            if (char) {
              decodedText += char;
            }
          }
        }

        if (decodedText.includes(original)) {
          const reverseMap = buildReverseMap(toUnicode);
          const newDecodedText = decodedText.replace(original, spaces);

          let newHex = '';
          let encodingSucceeded = true;
          for (const char of newDecodedText) {
            const code = reverseMap.get(char);
            if (code !== undefined) {
              const byteSize = hexMatches[0].hex.length >= 4 ? 4 : 2;
              newHex += code.toString(16).padStart(byteSize, '0').toUpperCase();
            } else if (char === ' ') {
              const byteSize = hexMatches[0].hex.length >= 4 ? 4 : 2;
              newHex += (32).toString(16).padStart(byteSize, '0').toUpperCase();
            } else {
              const asciiCode = char.charCodeAt(0);
              if (asciiCode < 256) {
                newHex += asciiCode.toString(16).padStart(2, '0').toUpperCase();
              } else {
                encodingSucceeded = false;
                break;
              }
            }
          }

          if (encodingSucceeded && hexMatches.length > 0) {
            let newLine = line.substring(0, hexMatches[0].start);
            newLine += '<' + newHex + '>';
            const lastMatch = hexMatches[hexMatches.length - 1];
            const lastEnd = lastMatch.start + lastMatch.match.length;
            newLine += line.substring(lastEnd);

            lines[i] = newLine;
            modified = true;
          }
        }
      }
    }
  }

  return modified ? lines.join('\n') : content;
}

// Helper functions
function escapePDFString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

function unescapePDFString(str: string): string {
  return str
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hexToString(hex: string): string {
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

function stringToHex(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    result += str.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase();
  }
  return result;
}
