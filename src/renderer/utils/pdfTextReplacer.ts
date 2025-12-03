import { PDFDocument, PDFName, PDFArray, PDFStream, PDFRawStream, decodePDFRawStream, PDFDict, PDFRef, PDFHexString, PDFString } from 'pdf-lib';
import * as pako from 'pako';

/**
 * Enhanced PDF text replacement that handles multiple encoding scenarios
 * including CID fonts, subset fonts, and various text encoding methods
 */

interface FontInfo {
  name: string;
  subtype: string;
  encoding: string | null;
  toUnicode: Map<number, string> | null;
  cidToGid: Map<number, number> | null;
  isSubset: boolean;
  isCIDFont: boolean;
}

interface ReplacementResult {
  replaced: boolean;
  method: 'content-stream' | 'redaction' | 'none';
}

// Cache for font mappings per document
const fontCache = new WeakMap<PDFDocument, Map<string, FontInfo>>();

/**
 * Replace text in a PDF page using multiple strategies
 * 1. First try direct content stream text replacement
 * 2. If that fails, try CID/subset font aware replacement
 * 3. Finally use fuzzy matching approaches
 */
export async function replaceTextInPage(
  pdfDoc: PDFDocument,
  pageIndex: number,
  originalText: string,
  newText: string
): Promise<boolean> {
  try {
    const pages = pdfDoc.getPages();
    const page = pages[pageIndex];
    if (!page) return false;

    // Check if document is encrypted
    if (isEncrypted(pdfDoc)) {
      console.log('Document appears to be encrypted, attempting decrypted access...');
      // pdf-lib handles decryption transparently if password was provided during load
      // If we get here, it means the document was already decrypted or wasn't encrypted
    }

    // Build font information for this page
    await buildFontCache(pdfDoc, pageIndex);

    // Try content stream modification first
    const contentResult = await tryContentStreamReplacement(pdfDoc, pageIndex, originalText, newText);
    if (contentResult) {
      console.log('Content stream replacement successful');
      return true;
    }

    // Try CID font aware replacement
    const cidResult = await tryCIDFontReplacement(pdfDoc, pageIndex, originalText, newText);
    if (cidResult) {
      console.log('CID font replacement successful');
      return true;
    }

    // If content stream didn't work, try fuzzy matching
    const fuzzyResult = await tryFuzzyContentStreamReplacement(pdfDoc, pageIndex, originalText, newText);
    if (fuzzyResult) {
      console.log('Fuzzy content stream replacement successful');
      return true;
    }

    console.log('Content stream replacement failed, will use overlay fallback');
    return false;
  } catch (error) {
    console.error('Error in replaceTextInPage:', error);
    return false;
  }
}

/**
 * Check if PDF document is encrypted
 */
function isEncrypted(pdfDoc: PDFDocument): boolean {
  try {
    const trailer = (pdfDoc as any).context?.trailerInfo;
    if (trailer && trailer.Encrypt) {
      return true;
    }
    // Also check document catalog for encryption indicators
    const catalog = pdfDoc.catalog;
    if (catalog) {
      const encrypt = (catalog as any).get?.(PDFName.of('Encrypt'));
      if (encrypt) return true;
    }
    return false;
  } catch {
    return false;
  }
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

  // Get Resources dictionary
  const resources = pageDict.get(PDFName.of('Resources'));
  if (!resources) return;

  const resourcesDict = pdfDoc.context.lookup(resources);
  if (!(resourcesDict instanceof PDFDict)) return;

  // Get Font dictionary
  const fonts = resourcesDict.get(PDFName.of('Font'));
  if (!fonts) return;

  const fontsDict = pdfDoc.context.lookup(fonts);
  if (!(fontsDict instanceof PDFDict)) return;

  // Iterate through fonts
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

    // Check if subset font (name starts with 6 uppercase letters + '+')
    const isSubset = /^[A-Z]{6}\+/.test(baseFontStr);

    // Check if CID font
    const isCIDFont = subtypeStr === 'Type0' || subtypeStr === 'CIDFontType0' || subtypeStr === 'CIDFontType2';

    // Extract encoding
    let encoding: string | null = null;
    const encodingObj = fontDict.get(PDFName.of('Encoding'));
    if (encodingObj) {
      if (encodingObj instanceof PDFName) {
        encoding = encodingObj.toString().replace('/', '');
      }
    }

    // Extract ToUnicode CMap
    let toUnicode: Map<number, string> | null = null;
    const toUnicodeRef = fontDict.get(PDFName.of('ToUnicode'));
    if (toUnicodeRef) {
      toUnicode = parseToUnicodeCMap(pdfDoc, toUnicodeRef);
    }

    // For CID fonts, also try to get the CIDToGIDMap
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
              // Identity mapping
              if (cidToGidRef.toString() === '/Identity') {
                cidToGid = null; // Identity means CID = GID
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

    // Parse bfchar mappings: <srcCode> <dstString>
    const bfcharPattern = /beginbfchar\s+([\s\S]*?)\s*endbfchar/g;
    let match;
    while ((match = bfcharPattern.exec(cmapStr)) !== null) {
      const content = match[1];
      const linePattern = /<([0-9A-Fa-f]+)>\s*<([0-9A-Fa-f]+)>/g;
      let lineMatch;
      while ((lineMatch = linePattern.exec(content)) !== null) {
        const srcCode = parseInt(lineMatch[1], 16);
        const dstHex = lineMatch[2];
        // Convert hex to Unicode string
        let dstStr = '';
        for (let i = 0; i < dstHex.length; i += 4) {
          const codePoint = parseInt(dstHex.substr(i, 4), 16);
          dstStr += String.fromCodePoint(codePoint);
        }
        mapping.set(srcCode, dstStr);
      }
    }

    // Parse bfrange mappings: <srcCodeLo> <srcCodeHi> <dstStringLo>
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
          // Array of destination strings
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
          // Single start value, increment for range
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
 * Try CID font aware replacement
 */
async function tryCIDFontReplacement(
  pdfDoc: PDFDocument,
  pageIndex: number,
  originalText: string,
  newText: string
): Promise<boolean> {
  const cache = fontCache.get(pdfDoc);
  if (!cache || cache.size === 0) return false;

  const pages = pdfDoc.getPages();
  const page = pages[pageIndex];
  const pageDict = page.node;
  const contentsRef = pageDict.get(PDFName.of('Contents'));

  if (!contentsRef) return false;

  const context = pdfDoc.context;
  const contentStreams = getContentStreams(context, contentsRef);

  let replaced = false;

  for (const stream of contentStreams) {
    const contentBytes = decodeStream(stream);
    if (!contentBytes) continue;

    let contentStr = new TextDecoder('latin1').decode(contentBytes);
    const originalContent = contentStr;

    // Strategy 7: Use ToUnicode mapping to find and replace CID text
    contentStr = replaceCIDText(contentStr, originalText, newText, cache);

    // Strategy 8: Handle UTF-16BE encoded hex strings (common in CID fonts)
    contentStr = replaceUTF16BEHex(contentStr, originalText, newText);

    // Strategy 9: Handle subset font character codes
    contentStr = replaceSubsetFontText(contentStr, originalText, newText, cache);

    if (contentStr !== originalContent) {
      replaced = true;
      updateStream(stream, contentStr, pdfDoc);
    }
  }

  return replaced;
}

/**
 * Strategy 7: Replace text using CID font ToUnicode mappings
 */
function replaceCIDText(
  content: string,
  original: string,
  replacement: string,
  fontCache: Map<string, FontInfo>
): string {
  // Find font setting commands and track current font
  let currentFont: FontInfo | null = null;

  // Pattern to match font selection: /FontName size Tf
  const fontPattern = /\/([A-Za-z0-9+]+)\s+[\d.]+\s+Tf/g;

  // Pattern to match hex strings in TJ arrays or standalone
  const hexPattern = /<([0-9A-Fa-f]+)>/g;

  // Build reverse mapping for replacement
  const buildReverseMap = (toUnicode: Map<number, string>): Map<string, number> => {
    const reverse = new Map<string, number>();
    for (const [code, char] of toUnicode) {
      reverse.set(char, code);
    }
    return reverse;
  };

  // Process content line by line to track font changes
  const lines = content.split('\n');
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Check for font changes
    const fontMatch = fontPattern.exec(line);
    if (fontMatch) {
      const fontName = fontMatch[1];
      currentFont = fontCache.get(fontName) || null;
    }
    fontPattern.lastIndex = 0;

    // If we have a font with ToUnicode mapping
    if (currentFont && currentFont.toUnicode) {
      const toUnicode = currentFont.toUnicode;

      // Extract text from hex strings on this line
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
        // Decode hex strings to text using ToUnicode
        let decodedText = '';
        for (const hm of hexMatches) {
          const hex = hm.hex;
          // Determine if this is 2-byte or 4-byte encoding
          const byteSize = hex.length >= 4 && (hex.length % 4 === 0) ? 4 : 2;
          for (let j = 0; j < hex.length; j += byteSize) {
            const code = parseInt(hex.substr(j, byteSize), 16);
            const char = toUnicode.get(code);
            if (char) {
              decodedText += char;
            }
          }
        }

        // Check if decoded text contains our target
        if (decodedText.includes(original)) {
          // Build reverse mapping
          const reverseMap = buildReverseMap(toUnicode);

          // Replace and re-encode
          const newDecodedText = decodedText.replace(original, replacement);

          // Encode new text back to hex
          let newHex = '';
          let encodingSucceeded = true;
          for (const char of newDecodedText) {
            const code = reverseMap.get(char);
            if (code !== undefined) {
              // Preserve original byte size
              const byteSize = hexMatches[0].hex.length >= 4 ? 4 : 2;
              newHex += code.toString(16).padStart(byteSize, '0').toUpperCase();
            } else {
              // Character not in font - try ASCII fallback or mark as failed
              const asciiCode = char.charCodeAt(0);
              if (asciiCode < 256) {
                newHex += asciiCode.toString(16).padStart(2, '0').toUpperCase();
              } else {
                // Can't encode this character with current font
                encodingSucceeded = false;
                break;
              }
            }
          }

          if (encodingSucceeded && hexMatches.length > 0) {
            // Replace the first hex string with new content, remove others
            let newLine = line.substring(0, hexMatches[0].start);
            newLine += `<${newHex}>`;

            // Find end of last hex match
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

/**
 * Strategy 8: Replace UTF-16BE encoded hex strings
 */
function replaceUTF16BEHex(content: string, original: string, replacement: string): string {
  // UTF-16BE encoded text starts with FEFF BOM
  const utf16Pattern = /<(FEFF[0-9A-Fa-f]*)>/gi;

  return content.replace(utf16Pattern, (match, hex) => {
    // Decode UTF-16BE
    let decoded = '';
    for (let i = 4; i < hex.length; i += 4) { // Skip FEFF BOM
      const codeUnit = parseInt(hex.substr(i, 4), 16);
      decoded += String.fromCharCode(codeUnit);
    }

    if (decoded.includes(original)) {
      const newText = decoded.replace(original, replacement);
      // Re-encode as UTF-16BE
      let newHex = 'FEFF';
      for (let i = 0; i < newText.length; i++) {
        newHex += newText.charCodeAt(i).toString(16).padStart(4, '0').toUpperCase();
      }
      return `<${newHex}>`;
    }

    return match;
  });
}

/**
 * Strategy 9: Handle subset fonts by matching character patterns
 */
function replaceSubsetFontText(
  content: string,
  original: string,
  replacement: string,
  fontCache: Map<string, FontInfo>
): string {
  // For subset fonts without ToUnicode, we try to match by character patterns
  // This works when the character codes happen to match standard encodings

  // Try various encodings
  const encodings: Array<{name: string, encode: (s: string) => string, decode: (s: string) => string}> = [
    {
      name: 'WinAnsi',
      encode: (s) => s, // WinAnsi is close to latin1
      decode: (s) => s
    },
    {
      name: 'MacRoman',
      encode: (s) => s.split('').map(c => {
        const code = c.charCodeAt(0);
        // Basic MacRoman to WinAnsi mapping for common chars
        return String.fromCharCode(code);
      }).join(''),
      decode: (s) => s
    }
  ];

  let result = content;

  for (const encoding of encodings) {
    const encodedOrig = encoding.encode(original);
    const encodedNew = encoding.encode(replacement);

    // Try in TJ arrays
    const tjPattern = /\[([^\]]*)\]\s*TJ/gi;
    result = result.replace(tjPattern, (match, arrayContent) => {
      // Extract text parts
      let fullText = '';
      const textPattern = /\(([^)]*)\)|<([^>]*)>/g;
      let m;
      while ((m = textPattern.exec(arrayContent)) !== null) {
        if (m[1] !== undefined) {
          fullText += m[1];
        } else if (m[2] !== undefined) {
          fullText += hexToString(m[2]);
        }
      }

      const decoded = encoding.decode(fullText);
      if (decoded.includes(original)) {
        const newText = decoded.replace(original, encodedNew);
        return `[(${escapePDFString(newText)})] TJ`;
      }

      return match;
    });
  }

  return result;
}

/**
 * Try direct content stream text replacement
 */
async function tryContentStreamReplacement(
  pdfDoc: PDFDocument,
  pageIndex: number,
  originalText: string,
  newText: string
): Promise<boolean> {
  const pages = pdfDoc.getPages();
  const page = pages[pageIndex];
  const pageDict = page.node;
  const contentsRef = pageDict.get(PDFName.of('Contents'));

  if (!contentsRef) return false;

  const context = pdfDoc.context;
  const contentStreams = getContentStreams(context, contentsRef);

  let replaced = false;

  for (const stream of contentStreams) {
    const contentBytes = decodeStream(stream);
    if (!contentBytes) continue;

    let contentStr = new TextDecoder('latin1').decode(contentBytes);
    const originalContent = contentStr;

    // Strategy 1: Direct (text) Tj replacement
    contentStr = replaceDirectTj(contentStr, originalText, newText);

    // Strategy 2: Handle TJ arrays with kerning - preserve structure
    contentStr = replaceTJArrays(contentStr, originalText, newText);

    // Strategy 3: Handle hex-encoded text <XXXX> Tj
    contentStr = replaceHexTj(contentStr, originalText, newText);

    // Strategy 4: Handle individual character TJ arrays like [(H) -10 (e) -5 (l) ...] TJ
    contentStr = replaceCharByCharTJ(contentStr, originalText, newText);

    if (contentStr !== originalContent) {
      replaced = true;
      updateStream(stream, contentStr, pdfDoc);
    }
  }

  return replaced;
}

/**
 * Try fuzzy matching for text that might be split across operators
 */
async function tryFuzzyContentStreamReplacement(
  pdfDoc: PDFDocument,
  pageIndex: number,
  originalText: string,
  newText: string
): Promise<boolean> {
  const pages = pdfDoc.getPages();
  const page = pages[pageIndex];
  const pageDict = page.node;
  const contentsRef = pageDict.get(PDFName.of('Contents'));

  if (!contentsRef) return false;

  const context = pdfDoc.context;
  const contentStreams = getContentStreams(context, contentsRef);

  let replaced = false;

  for (const stream of contentStreams) {
    const contentBytes = decodeStream(stream);
    if (!contentBytes) continue;

    let contentStr = new TextDecoder('latin1').decode(contentBytes);
    const originalContent = contentStr;

    // Strategy 5: Look for text split across multiple Tj/TJ operators on same line
    contentStr = replaceAcrossOperators(contentStr, originalText, newText);

    // Strategy 6: Normalize and match ignoring whitespace differences
    contentStr = replaceNormalizedText(contentStr, originalText, newText);

    if (contentStr !== originalContent) {
      replaced = true;
      updateStream(stream, contentStr, pdfDoc);
    }
  }

  return replaced;
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
      // Check if already compressed
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
 * Strategy 1: Replace direct (text) Tj patterns
 */
function replaceDirectTj(content: string, original: string, replacement: string): string {
  const escapedOrig = escapePDFString(original);
  const escapedNew = escapePDFString(replacement);

  // Match (text) Tj with possible whitespace
  const pattern = new RegExp(`\\(${escapeRegex(escapedOrig)}\\)\\s*Tj`, 'g');
  return content.replace(pattern, `(${escapedNew}) Tj`);
}

/**
 * Strategy 2: Replace text within TJ arrays, preserving kerning where possible
 */
function replaceTJArrays(content: string, original: string, replacement: string): string {
  const escapedOrig = escapePDFString(original);

  // Match TJ arrays: [...] TJ
  const tjArrayPattern = /\[([^\]]*)\]\s*TJ/gi;

  return content.replace(tjArrayPattern, (match, arrayContent) => {
    // Extract all text from the array
    let fullText = '';
    const parts: Array<{type: 'text' | 'hex' | 'kern', value: string}> = [];

    // Parse the array content
    let pos = 0;
    while (pos < arrayContent.length) {
      // Skip whitespace
      while (pos < arrayContent.length && /\s/.test(arrayContent[pos])) pos++;
      if (pos >= arrayContent.length) break;

      if (arrayContent[pos] === '(') {
        // Text string
        let text = '';
        pos++; // skip (
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
        parts.push({type: 'text', value: text});
        fullText += unescapePDFString(text);
      } else if (arrayContent[pos] === '<') {
        // Hex string
        pos++; // skip <
        let hex = '';
        while (pos < arrayContent.length && arrayContent[pos] !== '>') {
          hex += arrayContent[pos++];
        }
        pos++; // skip >
        parts.push({type: 'hex', value: hex});
        fullText += hexToString(hex);
      } else if (arrayContent[pos] === '-' || /\d/.test(arrayContent[pos])) {
        // Kerning value
        let num = '';
        if (arrayContent[pos] === '-') num += arrayContent[pos++];
        while (pos < arrayContent.length && /[\d.]/.test(arrayContent[pos])) {
          num += arrayContent[pos++];
        }
        parts.push({type: 'kern', value: num});
      } else {
        pos++;
      }
    }

    // Check if text contains our target
    const unescapedOrig = unescapePDFString(escapedOrig);
    if (fullText.includes(unescapedOrig)) {
      // Replace in the full text
      const newFullText = fullText.replace(unescapedOrig, replacement);
      // Return simplified array with new text
      return `[(${escapePDFString(newFullText)})] TJ`;
    }

    return match;
  });
}

/**
 * Strategy 3: Replace hex-encoded text
 */
function replaceHexTj(content: string, original: string, replacement: string): string {
  const originalHex = stringToHex(original);
  const replacementHex = stringToHex(replacement);

  // Match <hex> Tj
  const pattern = new RegExp(`<${escapeRegex(originalHex)}>\\s*Tj`, 'gi');
  return content.replace(pattern, `<${replacementHex}> Tj`);
}

/**
 * Strategy 4: Handle character-by-character TJ arrays
 * Pattern like [(H) -10 (e) -5 (l) -3 (l) -2 (o)] TJ
 */
function replaceCharByCharTJ(content: string, original: string, replacement: string): string {
  // This regex finds TJ arrays where text is split character by character
  const tjArrayPattern = /\[([^\]]*)\]\s*TJ/gi;

  return content.replace(tjArrayPattern, (match, arrayContent) => {
    // Check if this looks like char-by-char encoding
    const charPattern = /\((.)\)\s*-?\d*/g;
    const chars: string[] = [];
    let m;
    while ((m = charPattern.exec(arrayContent)) !== null) {
      chars.push(m[1]);
    }

    if (chars.length === 0) return match;

    const extractedText = chars.join('');

    if (extractedText.includes(original)) {
      // Rebuild with replacement, preserving single-char format
      const newText = extractedText.replace(original, replacement);
      // Convert to char-by-char format with minimal kerning
      const newArray = newText.split('').map(c => `(${escapePDFString(c)})`).join(' ');
      return `[${newArray}] TJ`;
    }

    return match;
  });
}

/**
 * Strategy 5: Replace text split across multiple operators
 * Looks for text that spans multiple Tj commands
 */
function replaceAcrossOperators(content: string, original: string, replacement: string): string {
  // Find sequences of text operators
  const lines = content.split('\n');
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Extract all text from this line
    const textParts: string[] = [];
    const textRegex = /\(([^)]*)\)\s*Tj|\[([^\]]*)\]\s*TJ/gi;
    let m;

    while ((m = textRegex.exec(line)) !== null) {
      if (m[1]) {
        textParts.push(unescapePDFString(m[1]));
      } else if (m[2]) {
        // Extract from TJ array
        const arrayText = extractTextFromTJArray(m[2]);
        textParts.push(arrayText);
      }
    }

    const lineText = textParts.join('');

    if (lineText.includes(original)) {
      // This line contains our text - do a simple replacement of all text operators
      const newText = lineText.replace(original, replacement);
      // Replace the entire line's text content
      lines[i] = line.replace(textRegex, (match, tjText, tjArray, offset) => {
        if (offset === 0 || !modified) {
          modified = true;
          return `(${escapePDFString(newText)}) Tj`;
        }
        return ''; // Remove subsequent operators
      });
    }
  }

  return lines.join('\n');
}

/**
 * Strategy 6: Normalize text for matching (ignore certain whitespace differences)
 */
function replaceNormalizedText(content: string, original: string, replacement: string): string {
  // Normalize the search text
  const normalizedOrig = original.replace(/\s+/g, ' ').trim();

  const tjArrayPattern = /\[([^\]]*)\]\s*TJ/gi;

  return content.replace(tjArrayPattern, (match, arrayContent) => {
    const fullText = extractTextFromTJArray(arrayContent);
    const normalizedContent = fullText.replace(/\s+/g, ' ').trim();

    if (normalizedContent === normalizedOrig || normalizedContent.includes(normalizedOrig)) {
      const newText = fullText.replace(new RegExp(escapeRegex(normalizedOrig).replace(/\\ /g, '\\s+'), 'g'), replacement);
      return `[(${escapePDFString(newText)})] TJ`;
    }

    return match;
  });
}

/**
 * Extract text from a TJ array content string
 */
function extractTextFromTJArray(arrayContent: string): string {
  let fullText = '';
  const partPattern = /\(([^)]*)\)|<([^>]*)>/g;
  let m;

  while ((m = partPattern.exec(arrayContent)) !== null) {
    if (m[1] !== undefined) {
      fullText += unescapePDFString(m[1]);
    } else if (m[2] !== undefined) {
      fullText += hexToString(m[2]);
    }
  }

  return fullText;
}

/**
 * Escape special characters for PDF string literals
 */
function escapePDFString(str: string): string {
  return str
    .replace(/\\/g, '\\\\')
    .replace(/\(/g, '\\(')
    .replace(/\)/g, '\\)');
}

/**
 * Unescape PDF string literals
 */
function unescapePDFString(str: string): string {
  return str
    .replace(/\\\(/g, '(')
    .replace(/\\\)/g, ')')
    .replace(/\\\\/g, '\\');
}

/**
 * Escape special regex characters
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Convert hex string to text
 */
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

/**
 * Convert text to hex string
 */
function stringToHex(str: string): string {
  let result = '';
  for (let i = 0; i < str.length; i++) {
    result += str.charCodeAt(i).toString(16).padStart(2, '0').toUpperCase();
  }
  return result;
}
