import { PDFDocument, PDFName, PDFStream, PDFRawStream, PDFDict, PDFArray } from 'pdf-lib';

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
