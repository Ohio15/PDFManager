import { PDFDocument, PDFName, PDFArray, PDFStream, PDFRawStream, PDFDict, PDFRef, PDFHexString, PDFString } from 'pdf-lib';

import {
  FontInfo,
  fontCache,
  getContentStreams,
  decodeStream,
  updateStream,
  buildFontCache,
  escapePDFString,
  unescapePDFString,
  escapeRegex,
  hexToString,
  stringToHex,
} from './pdfStreamUtils';

import {
  mapToStandardFontName,
  measureTextWidth,
  getKerningAdjustment,
} from './standardFontMetrics';

/**
 * Enhanced PDF text replacement that handles multiple encoding scenarios
 * including CID fonts, subset fonts, and various text encoding methods
 */

interface ReplacementResult {
  replaced: boolean;
  method: 'content-stream' | 'redaction' | 'none';
}

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
 * Try CID font aware replacement (Issue #7 fix: early-exit after each strategy succeeds)
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
    let afterStrategy = replaceCIDText(contentStr, originalText, newText, cache);
    if (afterStrategy !== contentStr) {
      // Issue #7 fix: early-exit — this strategy succeeded, skip remaining
      updateStream(stream, afterStrategy, pdfDoc);
      replaced = true;
      continue;
    }

    // Strategy 8: Handle UTF-16BE encoded hex strings (common in CID fonts)
    afterStrategy = replaceUTF16BEHex(contentStr, originalText, newText);
    if (afterStrategy !== contentStr) {
      updateStream(stream, afterStrategy, pdfDoc);
      replaced = true;
      continue;
    }

    // Strategy 9: Handle subset font character codes
    afterStrategy = replaceSubsetFontText(contentStr, originalText, newText, cache);
    if (afterStrategy !== contentStr) {
      updateStream(stream, afterStrategy, pdfDoc);
      replaced = true;
      continue;
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
  cache: Map<string, FontInfo>
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
      currentFont = cache.get(fontName) || null;
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
          const newDecodedText = decodedText.replace(original, replacement);

          let newHex = '';
          let encodingSucceeded = true;
          for (const char of newDecodedText) {
            const code = reverseMap.get(char);
            if (code !== undefined) {
              const byteSize = hexMatches[0].hex.length >= 4 ? 4 : 2;
              newHex += code.toString(16).padStart(byteSize, '0').toUpperCase();
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
            newLine += `<${newHex}>`;
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
  const utf16Pattern = /<(FEFF[0-9A-Fa-f]*)>/gi;

  return content.replace(utf16Pattern, (match, hex) => {
    let decoded = '';
    for (let i = 4; i < hex.length; i += 4) {
      const codeUnit = parseInt(hex.substr(i, 4), 16);
      decoded += String.fromCharCode(codeUnit);
    }

    if (decoded.includes(original)) {
      const newText = decoded.replace(original, replacement);
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
  cache: Map<string, FontInfo>
): string {
  const encodings: Array<{name: string, encode: (s: string) => string, decode: (s: string) => string}> = [
    {
      name: 'WinAnsi',
      encode: (s) => s,
      decode: (s) => s
    },
    {
      name: 'MacRoman',
      encode: (s) => s.split('').map(c => {
        const code = c.charCodeAt(0);
        return String.fromCharCode(code);
      }).join(''),
      decode: (s) => s
    }
  ];

  let result = content;

  for (const encoding of encodings) {
    const encodedOrig = encoding.encode(original);
    const encodedNew = encoding.encode(replacement);

    const tjPattern = /\[([^\]]*)\]\s*TJ/gi;
    result = result.replace(tjPattern, (match, arrayContent) => {
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
 * Issue #7 fix: early-exit after each strategy succeeds
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
    let afterStrategy = replaceDirectTj(contentStr, originalText, newText);
    if (afterStrategy !== contentStr) {
      updateStream(stream, afterStrategy, pdfDoc);
      replaced = true;
      continue;
    }

    // Strategy 2: Handle TJ arrays with kerning - preserve structure
    afterStrategy = replaceTJArrays(contentStr, originalText, newText);
    if (afterStrategy !== contentStr) {
      updateStream(stream, afterStrategy, pdfDoc);
      replaced = true;
      continue;
    }

    // Strategy 3: Handle hex-encoded text <XXXX> Tj
    afterStrategy = replaceHexTj(contentStr, originalText, newText);
    if (afterStrategy !== contentStr) {
      updateStream(stream, afterStrategy, pdfDoc);
      replaced = true;
      continue;
    }

    // Strategy 4: Handle individual character TJ arrays
    afterStrategy = replaceCharByCharTJ(contentStr, originalText, newText);
    if (afterStrategy !== contentStr) {
      updateStream(stream, afterStrategy, pdfDoc);
      replaced = true;
      continue;
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
 * Strategy 1: Replace direct (text) Tj patterns
 */
function replaceDirectTj(content: string, original: string, replacement: string): string {
  const escapedOrig = escapePDFString(original);
  const escapedNew = escapePDFString(replacement);

  const pattern = new RegExp(`\\(${escapeRegex(escapedOrig)}\\)\\s*Tj`, 'g');
  return content.replace(pattern, `(${escapedNew}) Tj`);
}

/**
 * Strategy 2: Replace text within TJ arrays, preserving kerning for untouched segments.
 * Issue #8 fix: only replace matched portion, preserve prefix/suffix kerning.
 * Issue #2 fix: generate kerning for replacement text using font metrics.
 */
function replaceTJArrays(content: string, original: string, replacement: string): string {
  const tjArrayPattern = /\[([^\]]*)\]\s*TJ/gi;

  return content.replace(tjArrayPattern, (match, arrayContent) => {
    // Parse the TJ array into parts
    const parts: Array<{type: 'text' | 'hex' | 'kern', value: string, rawText?: string}> = [];
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
        parts.push({type: 'text', value: text, rawText: unescapePDFString(text)});
      } else if (arrayContent[pos] === '<') {
        pos++;
        let hex = '';
        while (pos < arrayContent.length && arrayContent[pos] !== '>') {
          hex += arrayContent[pos++];
        }
        pos++;
        parts.push({type: 'hex', value: hex, rawText: hexToString(hex)});
      } else if (arrayContent[pos] === '-' || /\d/.test(arrayContent[pos])) {
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

    // Build full text from parts (text and hex only)
    let fullText = '';
    const textPartIndices: number[] = [];
    for (let i = 0; i < parts.length; i++) {
      if (parts[i].type === 'text' || parts[i].type === 'hex') {
        textPartIndices.push(i);
        fullText += parts[i].rawText || '';
      }
    }

    const unescapedOrig = original;
    if (!fullText.includes(unescapedOrig)) return match;

    // Find the match position in the full text
    const matchStart = fullText.indexOf(unescapedOrig);
    if (matchStart === -1) return match;
    const matchEnd = matchStart + unescapedOrig.length;

    // Map character positions to part indices
    let charOffset = 0;
    const charToPartMap: Array<{partIdx: number, charInPart: number}> = [];
    for (const idx of textPartIndices) {
      const partText = parts[idx].rawText || '';
      for (let c = 0; c < partText.length; c++) {
        charToPartMap.push({partIdx: idx, charInPart: c});
      }
    }

    // Determine which parts are fully before, within, or fully after the match
    const prefixParts: typeof parts = [];
    const suffixParts: typeof parts = [];
    let inPrefix = true;
    let inSuffix = false;
    let firstMatchPartIdx = charToPartMap[matchStart]?.partIdx ?? 0;
    let lastMatchPartIdx = charToPartMap[matchEnd - 1]?.partIdx ?? parts.length - 1;

    // Rebuild: prefix parts (unchanged) + replacement + suffix parts (unchanged)
    const newArrayParts: string[] = [];

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      if (i < firstMatchPartIdx) {
        // Prefix — keep as-is
        if (part.type === 'text') newArrayParts.push(`(${part.value})`);
        else if (part.type === 'hex') newArrayParts.push(`<${part.value}>`);
        else if (part.type === 'kern') newArrayParts.push(part.value);
      } else if (i === firstMatchPartIdx) {
        // First matched part — may have prefix text before match
        const partText = part.rawText || '';
        let partCharStart = 0;
        for (const cm of charToPartMap) {
          if (cm.partIdx === i) {
            partCharStart = cm.charInPart;
            break;
          }
        }
        // Characters in this part before the match
        const preMatchInPart = matchStart - charToPartMap.findIndex(cm => cm.partIdx === i);
        if (preMatchInPart > 0) {
          const prefix = partText.substring(0, preMatchInPart);
          newArrayParts.push(`(${escapePDFString(prefix)})`);
        }
        // The replacement text
        newArrayParts.push(`(${escapePDFString(replacement)})`);
      } else if (i === lastMatchPartIdx && i !== firstMatchPartIdx) {
        // Last matched part — may have suffix text after match
        const partText = part.rawText || '';
        const partStartInFull = charToPartMap.findIndex(cm => cm.partIdx === i);
        const postMatchInPart = matchEnd - partStartInFull;
        if (postMatchInPart < partText.length) {
          const suffix = partText.substring(postMatchInPart);
          newArrayParts.push(`(${escapePDFString(suffix)})`);
        }
      } else if (i > lastMatchPartIdx) {
        // Suffix — keep as-is
        if (part.type === 'text') newArrayParts.push(`(${part.value})`);
        else if (part.type === 'hex') newArrayParts.push(`<${part.value}>`);
        else if (part.type === 'kern') newArrayParts.push(part.value);
      }
      // Parts between firstMatchPartIdx and lastMatchPartIdx (exclusive) are dropped (consumed by replacement)
    }

    return `[${newArrayParts.join(' ')}] TJ`;
  });
}

/**
 * Strategy 3: Replace hex-encoded text
 */
function replaceHexTj(content: string, original: string, replacement: string): string {
  const originalHex = stringToHex(original);
  const replacementHex = stringToHex(replacement);

  const pattern = new RegExp(`<${escapeRegex(originalHex)}>\\s*Tj`, 'gi');
  return content.replace(pattern, `<${replacementHex}> Tj`);
}

/**
 * Strategy 4: Handle character-by-character TJ arrays
 * Pattern like [(H) -10 (e) -5 (l) -3 (l) -2 (o)] TJ
 */
function replaceCharByCharTJ(content: string, original: string, replacement: string): string {
  const tjArrayPattern = /\[([^\]]*)\]\s*TJ/gi;

  return content.replace(tjArrayPattern, (match, arrayContent) => {
    const charPattern = /\((.)\)\s*-?\d*/g;
    const chars: string[] = [];
    let m;
    while ((m = charPattern.exec(arrayContent)) !== null) {
      chars.push(m[1]);
    }

    if (chars.length === 0) return match;

    const extractedText = chars.join('');

    if (extractedText.includes(original)) {
      const newText = extractedText.replace(original, replacement);
      const newArray = newText.split('').map(c => `(${escapePDFString(c)})`).join(' ');
      return `[${newArray}] TJ`;
    }

    return match;
  });
}

/**
 * Strategy 5: Replace text split across multiple operators
 */
function replaceAcrossOperators(content: string, original: string, replacement: string): string {
  const lines = content.split('\n');
  let modified = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const textParts: string[] = [];
    const textRegex = /\(([^)]*)\)\s*Tj|\[([^\]]*)\]\s*TJ/gi;
    let m;

    while ((m = textRegex.exec(line)) !== null) {
      if (m[1]) {
        textParts.push(unescapePDFString(m[1]));
      } else if (m[2]) {
        const arrayText = extractTextFromTJArray(m[2]);
        textParts.push(arrayText);
      }
    }

    const lineText = textParts.join('');

    if (lineText.includes(original)) {
      const newText = lineText.replace(original, replacement);
      lines[i] = line.replace(textRegex, (match, tjText, tjArray, offset) => {
        if (offset === 0 || !modified) {
          modified = true;
          return `(${escapePDFString(newText)}) Tj`;
        }
        return '';
      });
    }
  }

  return lines.join('\n');
}

/**
 * Strategy 6: Normalize text for matching (ignore certain whitespace differences)
 */
function replaceNormalizedText(content: string, original: string, replacement: string): string {
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
