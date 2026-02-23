/**
 * Unified PDF Save Pipeline
 *
 * Single source of truth for applying all edits and annotations to a PDF document.
 * Replaces duplicated save logic in saveFile() and saveFileAs().
 *
 * Pipeline:
 * 1. Load PDF with pdf-lib
 * 2. Embed standard font (Helvetica for stamps/text)
 * 3. For each page:
 *    a. Blank deleted text items (content stream + cover rectangle)
 *    b. Apply text edits (content stream + fallback overlay via ContentStreamBuilder)
 *    c. Convert ALL annotations to content stream
 *    d. Register required resources
 *    e. Inject content stream
 * 4. Save form field values
 * 5. Return pdfDoc.save() bytes
 */

import {
  PDFDocument as PDFLib,
  StandardFonts,
  PDFFont,
  PDFRef,
  PDFName,
} from 'pdf-lib';

import type {
  PDFPage,
  PDFTextItem,
  Annotation,
  TextAnnotation,
  ImageAnnotation,
} from '../types';

import { replaceTextInPage } from './pdfTextReplacer';
import { blankTextInContentStream } from './blankText';
import { saveFormFieldValues, FormFieldMapping } from './formFieldSaver';
import { ContentStreamBuilder } from './pdfParser/ContentStreamBuilder';
import {
  writeAnnotation,
  AnnotationWriteResult,
} from './annotationContentStreamWriter';
import {
  ensureExtGState,
  ensureFont,
  ensureXObject,
  resetResourceCounter,
} from './pdfResourceManager';
import { appendContentStream } from './contentStreamInjector';

// Map common PDF font names to pdf-lib StandardFonts
function mapToStandardFont(fontName: string): typeof StandardFonts[keyof typeof StandardFonts] {
  const name = fontName.toLowerCase();

  if (name.includes('helvetica') || name.includes('arial') || name.includes('sans')) {
    if (name.includes('bold') && name.includes('oblique')) return StandardFonts.HelveticaBoldOblique;
    if (name.includes('bold')) return StandardFonts.HelveticaBold;
    if (name.includes('oblique') || name.includes('italic')) return StandardFonts.HelveticaOblique;
    return StandardFonts.Helvetica;
  }

  if (name.includes('times') || name.includes('serif')) {
    if (name.includes('bold') && name.includes('italic')) return StandardFonts.TimesRomanBoldItalic;
    if (name.includes('bold')) return StandardFonts.TimesRomanBold;
    if (name.includes('italic')) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }

  if (name.includes('courier') || name.includes('mono')) {
    if (name.includes('bold') && name.includes('oblique')) return StandardFonts.CourierBoldOblique;
    if (name.includes('bold')) return StandardFonts.CourierBold;
    if (name.includes('oblique') || name.includes('italic')) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }

  return StandardFonts.Helvetica;
}

export interface SavePipelineInput {
  pdfData: Uint8Array;
  pages: PDFPage[];
  annotationStorage: any;
  formFieldMappings: FormFieldMapping[];
}

/**
 * Apply all edits and annotations to a PDF and return the modified bytes.
 */
export async function applyEditsAndAnnotations(
  input: SavePipelineInput
): Promise<Uint8Array> {
  const { pdfData, pages, annotationStorage, formFieldMappings } = input;

  const pdfDoc = await PDFLib.load(pdfData);
  const helvetica = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const helveticaRef = getFontRef(pdfDoc, helvetica);

  resetResourceCounter();

  for (const page of pages) {
    const pdfPage = pdfDoc.getPage(page.index);
    const { height } = pdfPage.getSize();

    // --- (a) Blank deleted text items ---
    await processDeletedTextItems(pdfDoc, page, height);

    // --- (b) Apply text edits ---
    await processTextEdits(pdfDoc, page, height);

    // --- (c) Convert all annotations to content stream ---
    await processAnnotations(pdfDoc, page, height, helvetica, helveticaRef);
  }

  // --- (d) Save form field values ---
  if (annotationStorage && formFieldMappings.length > 0) {
    try {
      await saveFormFieldValues(pdfDoc, annotationStorage, formFieldMappings);
    } catch (e) {
      console.warn('Failed to save form field values:', e);
    }
  }

  return pdfDoc.save();
}

/**
 * Process deleted text items: blank in content stream + draw cover rectangle via ContentStreamBuilder.
 */
async function processDeletedTextItems(
  pdfDoc: PDFLib,
  page: PDFPage,
  pageHeight: number
): Promise<void> {
  const deletedItems = page.textItems?.filter(t => t.isDeleted) || [];
  if (deletedItems.length === 0) return;

  const builder = new ContentStreamBuilder();

  for (const deletedItem of deletedItems) {
    // Try to blank in content stream (best effort)
    await blankTextInContentStream(pdfDoc, page.index, deletedItem.originalStr);

    // Draw background-colored cover rectangle
    const textHeight = deletedItem.fontSize;
    const baselineY = deletedItem.transform
      ? deletedItem.transform[5]
      : (pageHeight - deletedItem.y - textHeight);
    const bgColor = deletedItem.backgroundColor || { r: 1, g: 1, b: 1 };

    builder.saveState();
    builder.setFillColor({
      space: 'DeviceRGB',
      values: [bgColor.r, bgColor.g, bgColor.b],
    });
    builder.rectangle(
      deletedItem.x - 1,
      baselineY - (textHeight * 0.25),
      deletedItem.width + 2,
      textHeight * 1.3
    );
    builder.fill();
    builder.restoreState();
  }

  if (builder.commandCount > 0) {
    appendContentStream(pdfDoc, page.index, builder.build());
  }
}

/**
 * Process text edits: try content stream modification first, fall back to overlay via ContentStreamBuilder.
 */
async function processTextEdits(
  pdfDoc: PDFLib,
  page: PDFPage,
  pageHeight: number
): Promise<void> {
  if (!page.textEdits || page.textEdits.length === 0) return;

  const fontCache = new Map<string, { font: PDFFont; ref: PDFRef }>();
  const builder = new ContentStreamBuilder();
  const fontsNeeded: Array<{ name: string; ref: PDFRef }> = [];

  for (const edit of page.textEdits) {
    const textItem = page.textItems?.find(t => t.id === edit.itemId);
    if (!textItem) continue;

    // First, try content stream modification
    const contentStreamModified = await replaceTextInPage(
      pdfDoc,
      page.index,
      edit.originalText,
      edit.newText
    );

    if (contentStreamModified) {
      continue; // Success - move to next edit
    }

    // Fall back to overlay: blank original + draw replacement
    await blankTextInContentStream(pdfDoc, page.index, edit.originalText);

    const standardFontName = mapToStandardFont(textItem.fontName);
    let fontEntry = fontCache.get(standardFontName);
    if (!fontEntry) {
      const font = await pdfDoc.embedFont(standardFontName);
      const ref = getFontRef(pdfDoc, font);
      fontEntry = { font, ref };
      fontCache.set(standardFontName, fontEntry);
    }

    // Register font on page if not already
    const fontResName = ensureFont(pdfDoc, page.index, fontEntry.ref);

    const textHeight = textItem.fontSize;
    const baselineY = textItem.transform
      ? textItem.transform[5]
      : (pageHeight - textItem.y - textHeight);

    // Draw background cover rectangle
    const bgColor = textItem.backgroundColor || { r: 1, g: 1, b: 1 };
    builder.saveState();
    builder.setFillColor({
      space: 'DeviceRGB',
      values: [bgColor.r, bgColor.g, bgColor.b],
    });
    builder.rectangle(
      textItem.x - 1,
      baselineY - (textHeight * 0.25),
      textItem.width + 2,
      textHeight * 1.3
    );
    builder.fill();
    builder.restoreState();

    // Draw replacement text
    const txtColor = textItem.textColor || { r: 0, g: 0, b: 0 };
    builder.saveState();
    builder.setFillColor({
      space: 'DeviceRGB',
      values: [txtColor.r, txtColor.g, txtColor.b],
    });
    builder.beginText();
    builder.setFont(fontResName, textItem.fontSize);
    builder.setTextMatrix({ a: 1, b: 0, c: 0, d: 1, e: textItem.x, f: baselineY });
    builder.showText(edit.newText);
    builder.endText();
    builder.restoreState();
  }

  if (builder.commandCount > 0) {
    appendContentStream(pdfDoc, page.index, builder.build());
  }
}

/**
 * Process all annotations on a page: convert to content stream and inject.
 */
async function processAnnotations(
  pdfDoc: PDFLib,
  page: PDFPage,
  pageHeight: number,
  helvetica: PDFFont,
  helveticaRef: PDFRef
): Promise<void> {
  if (page.annotations.length === 0) return;

  const builder = new ContentStreamBuilder();

  for (const annotation of page.annotations) {
    // Handle image embedding specially (needs to embed image data first)
    if (annotation.type === 'image') {
      await processImageAnnotation(pdfDoc, page.index, annotation, pageHeight, builder);
      continue;
    }

    const result = writeAnnotation(annotation, pageHeight);
    if (!result) continue;

    // Register required resources and patch placeholder names in content bytes
    let contentStr = new TextDecoder('latin1').decode(result.contentBytes);

    // Register ExtGStates
    for (let i = 0; i < result.resources.extGStates.length; i++) {
      const gs = result.resources.extGStates[i];
      const gsName = ensureExtGState(pdfDoc, page.index, {
        fillOpacity: gs.fillOpacity,
        strokeOpacity: gs.strokeOpacity,
      });
      contentStr = contentStr.replace(`/__GS_${i}__`, `/${gsName}`);
    }

    // Register Fonts
    for (let i = 0; i < result.resources.fonts.length; i++) {
      const fontResName = ensureFont(pdfDoc, page.index, helveticaRef);
      contentStr = contentStr.replace(`/__F_${i}__`, `/${fontResName}`);
      // Also patch Tf operator which has the font name without leading /
      contentStr = contentStr.replace(`/${`__F_${i}__`} `, `/${fontResName} `);
    }

    // Convert patched string back to bytes
    const patchedBytes = new Uint8Array(contentStr.length);
    for (let i = 0; i < contentStr.length; i++) {
      patchedBytes[i] = contentStr.charCodeAt(i) & 0xFF;
    }

    // Append the content for this annotation
    appendContentStream(pdfDoc, page.index, patchedBytes);
  }
}

/**
 * Process an image annotation: embed image, register XObject, write placement operators.
 */
async function processImageAnnotation(
  pdfDoc: PDFLib,
  pageIndex: number,
  annotation: ImageAnnotation,
  pageHeight: number,
  builder: ContentStreamBuilder
): Promise<void> {
  // Embed the image
  const imageBytes = Uint8Array.from(atob(annotation.data), c => c.charCodeAt(0));
  let image;
  if (annotation.imageType === 'png') {
    image = await pdfDoc.embedPng(imageBytes);
  } else {
    image = await pdfDoc.embedJpg(imageBytes);
  }

  // Get the image's indirect reference from pdf-lib
  const imageRef = getImageRef(image);

  // Register as XObject on the page
  const imName = ensureXObject(pdfDoc, pageIndex, imageRef);

  // Build placement content stream
  const imgBuilder = new ContentStreamBuilder();
  const x = annotation.position.x;
  const y = pageHeight - annotation.position.y - annotation.size.height;
  const w = annotation.size.width;
  const h = annotation.size.height;

  imgBuilder.saveState();
  imgBuilder.setMatrix({ a: w, b: 0, c: 0, d: h, e: x, f: y });
  imgBuilder.drawXObject(imName);
  imgBuilder.restoreState();

  appendContentStream(pdfDoc, pageIndex, imgBuilder.build());
}

/**
 * Extract the indirect PDFRef for an embedded font.
 * pdf-lib stores the ref internally; we access it to register in page resources.
 */
function getFontRef(pdfDoc: PDFLib, font: PDFFont): PDFRef {
  // pdf-lib PDFFont stores its ref at font.ref
  const ref = (font as any).ref;
  if (ref) return ref;

  // Fallback: search the document's font cache
  // This shouldn't normally be needed but provides robustness
  throw new Error('Could not extract font reference from pdf-lib PDFFont');
}

/**
 * Extract the indirect PDFRef for an embedded image.
 * pdf-lib stores the ref internally on the image object.
 */
function getImageRef(image: any): PDFRef {
  // pdf-lib PDFImage stores its ref at image.ref
  const ref = image.ref;
  if (ref) return ref;
  throw new Error('Could not extract image reference from pdf-lib PDFImage');
}
