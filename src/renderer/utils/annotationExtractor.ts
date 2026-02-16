/**
 * Source PDF Annotation Extractor
 *
 * Extracts annotations from PDF pages using pdfjs-dist's getAnnotations() API.
 * Filters OUT Widget (form field) annotations — those are handled by PageAnalyzer.
 * Extracts: Text notes, Links, FreeText, Highlights, Underlines, StrikeOuts,
 * Stamps, Ink, FileAttachments, Redact, etc.
 */

import type { PDFSourceAnnotation } from '../types';

/**
 * Extract source (non-widget) annotations from a PDF page.
 *
 * @param page        pdfjs page proxy
 * @param pageIndex   0-based page index
 * @param pageHeight  Page height for Y coordinate flipping
 * @returns Array of source annotations
 */
export async function extractSourceAnnotations(
  page: any,
  pageIndex: number,
  pageHeight: number,
): Promise<PDFSourceAnnotation[]> {
  const results: PDFSourceAnnotation[] = [];

  try {
    const annotations = await page.getAnnotations({ intent: 'display' });
    if (!annotations || annotations.length === 0) return results;

    let counter = 0;
    for (const ann of annotations) {
      // Skip Widget (form field) annotations
      if (ann.subtype === 'Widget') continue;
      // Skip Popup annotations (they are associated with other annotations)
      if (ann.subtype === 'Popup') continue;

      if (!ann.rect || ann.rect.length < 4) continue;

      const [x1, y1, x2, y2] = ann.rect;
      const width = Math.abs(x2 - x1);
      const height = Math.abs(y2 - y1);

      // Skip zero-size annotations
      if (width < 0.1 && height < 0.1) continue;

      const sourceAnn: PDFSourceAnnotation = {
        id: `src-ann-${pageIndex}-${counter++}`,
        subtype: ann.subtype || 'Unknown',
        pageIndex,
        rect: {
          x: Math.min(x1, x2),
          y: pageHeight - Math.max(y1, y2), // flip to top-left origin
          width,
          height,
        },
      };

      // Contents (text)
      if (ann.contents) {
        sourceAnn.contents = ann.contents;
      }

      // Author (T field)
      if (ann.titleObj?.str || ann.title) {
        sourceAnn.author = ann.titleObj?.str || ann.title;
      }

      // Modification date
      if (ann.modificationDate) {
        sourceAnn.modDate = ann.modificationDate;
      }

      // Creation date
      if (ann.creationDate) {
        sourceAnn.creationDate = ann.creationDate;
      }

      // Color (C array, normalized 0-1 RGB)
      if (ann.color && ann.color.length >= 3) {
        sourceAnn.color = {
          r: ann.color[0] / 255,
          g: ann.color[1] / 255,
          b: ann.color[2] / 255,
        };
      }

      // Opacity
      if (typeof ann.opacity === 'number') {
        sourceAnn.opacity = ann.opacity;
      }

      // Link-specific fields
      if (ann.subtype === 'Link') {
        if (ann.url) {
          sourceAnn.uri = ann.url;
        }
        if (ann.dest) {
          // dest can be a page ref or named destination
          try {
            if (Array.isArray(ann.dest) && ann.dest[0]) {
              // Direct page reference — would need page index resolution
              // For now, store as-is; full resolution would need the doc proxy
            }
          } catch { /* skip */ }
        }
      }

      // Rich text (RC entry)
      if (ann.richText) {
        sourceAnn.richText = ann.richText;
      }

      // QuadPoints for text markup annotations
      if (ann.quadPoints && ann.quadPoints.length > 0) {
        sourceAnn.quadPoints = ann.quadPoints;
      }

      // In-reply-to reference
      if (ann.inReplyTo) {
        sourceAnn.inReplyTo = ann.inReplyTo;
      }

      // Reply type
      if (ann.replyType) {
        sourceAnn.replyType = ann.replyType;
      }

      results.push(sourceAnn);
    }
  } catch (e) {
    console.warn(`[annotationExtractor] Failed to extract annotations from page ${pageIndex}:`, e);
  }

  return results;
}
