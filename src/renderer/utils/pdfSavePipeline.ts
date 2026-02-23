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
 *    c. Convert ALL annotations to content stream (batched per page)
 *    d. Register required resources
 *    e. Inject single content stream per page
 *    f. Add PDF /Text annotation dicts for sticky notes
 * 4. Save form field values
 * 5. Return pdfDoc.save() bytes
 */

import {
  PDFDocument as PDFLib,
  StandardFonts,
  PDFFont,
  PDFRef,
  PDFName,
  PDFArray,
  PDFDict,
  PDFNumber,
  PDFHexString,
  PDFString,
} from 'pdf-lib';

import type {
  PDFPage,
  Annotation,
  ImageAnnotation,
  StampAnnotation,
} from '../types';

import { replaceTextInPage } from './pdfTextReplacer';
import { blankTextInContentStream } from './blankText';
import { saveFormFieldValues, FormFieldMapping } from './formFieldSaver';
import { ContentStreamBuilder } from './pdfParser/ContentStreamBuilder';
import {
  writeAnnotation,
  AnnotationWriteResult,
} from './annotationContentStreamWriter';
import { ResourceAllocator } from './pdfResourceManager';
import { appendContentStream } from './contentStreamInjector';
import {
  mapToStandardFontName,
  measureTextWidth,
  getTextHeight,
  getDescentBelow,
  calculateCharacterSpacing,
} from './standardFontMetrics';

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

  // Per-save resource allocator (Fix #6: no global counter)
  const resources = new ResourceAllocator();

  for (const page of pages) {
    const pdfPage = pdfDoc.getPage(page.index);
    const { height, width } = pdfPage.getSize();

    // --- (a) Blank deleted text items ---
    await processDeletedTextItems(pdfDoc, resources, page, height);

    // --- (b) Apply text edits (Issue #10: two-pass) ---
    await processTextEdits(pdfDoc, resources, page, height, width);

    // --- (c) Convert all annotations to content stream (batched) ---
    await processAnnotations(pdfDoc, resources, page, height, helvetica, helveticaRef);
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
 * Process deleted text items: blank in content stream + draw cover rectangle.
 * Issue #5 fix: use real font metrics for cover rectangle dimensions.
 */
async function processDeletedTextItems(
  pdfDoc: PDFLib,
  resources: ResourceAllocator,
  page: PDFPage,
  pageHeight: number
): Promise<void> {
  const deletedItems = page.textItems?.filter(t => t.isDeleted) || [];
  if (deletedItems.length === 0) return;

  const builder = new ContentStreamBuilder();

  for (const deletedItem of deletedItems) {
    await blankTextInContentStream(pdfDoc, page.index, deletedItem.originalStr);

    const stdFont = mapToStandardFontName(deletedItem.fontName);
    const textHeight = getTextHeight(stdFont, deletedItem.fontSize);
    const descentBelow = getDescentBelow(stdFont, deletedItem.fontSize);
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
      baselineY - descentBelow,
      deletedItem.width + 2,
      textHeight
    );
    builder.fill();
    builder.restoreState();
  }

  if (builder.commandCount > 0) {
    appendContentStream(pdfDoc, page.index, builder.build());
  }
}

/**
 * Process text edits: Issue #10 — two-pass approach.
 * Pass 1: Try replaceTextInPage() for ALL edits (no blanking yet).
 * Pass 2: For failed edits only, blank + overlay.
 *
 * This prevents early blanking from corrupting the stream for later replacements.
 */
async function processTextEdits(
  pdfDoc: PDFLib,
  resources: ResourceAllocator,
  page: PDFPage,
  pageHeight: number,
  pageWidth: number
): Promise<void> {
  if (!page.textEdits || page.textEdits.length === 0) return;

  // Pass 1: Try content stream replacement for ALL edits first
  const failedEdits: typeof page.textEdits = [];

  for (const edit of page.textEdits) {
    const textItem = page.textItems?.find(t => t.id === edit.itemId);
    if (!textItem) continue;

    const contentStreamModified = await replaceTextInPage(
      pdfDoc,
      page.index,
      edit.originalText,
      edit.newText
    );

    if (!contentStreamModified) {
      failedEdits.push(edit);
    }
  }

  // Pass 2: For failed edits, apply blank + overlay fallback
  if (failedEdits.length === 0) return;

  const fontCache = new Map<string, { font: PDFFont; ref: PDFRef }>();
  const builder = new ContentStreamBuilder();

  for (const edit of failedEdits) {
    const textItem = page.textItems?.find(t => t.id === edit.itemId);
    if (!textItem) continue;

    await blankTextInContentStream(pdfDoc, page.index, edit.originalText);

    const standardFontName = mapToStandardFontName(textItem.fontName);
    const stdFontEnum = standardFontName;

    // Map to pdf-lib StandardFonts for embedding
    const pdfLibFontName = mapToPdfLibStandardFont(textItem.fontName);
    let fontEntry = fontCache.get(pdfLibFontName);
    if (!fontEntry) {
      const font = await pdfDoc.embedFont(pdfLibFontName);
      const ref = getFontRef(pdfDoc, font);
      fontEntry = { font, ref };
      fontCache.set(pdfLibFontName, fontEntry);
    }

    const fontResName = resources.ensureFont(pdfDoc, page.index, fontEntry.ref);

    // Issue #5: Use real font metrics for cover rectangle
    const textHeight = getTextHeight(stdFontEnum, textItem.fontSize);
    const descentBelow = getDescentBelow(stdFontEnum, textItem.fontSize);
    const baselineY = textItem.transform
      ? textItem.transform[5]
      : (pageHeight - textItem.y - textHeight);

    // Cover rectangle with correct metrics
    const bgColor = textItem.backgroundColor || { r: 1, g: 1, b: 1 };
    builder.saveState();
    builder.setFillColor({
      space: 'DeviceRGB',
      values: [bgColor.r, bgColor.g, bgColor.b],
    });

    // Issue #9: For rotated text, transform cover rect through text matrix
    if (textItem.transform && (textItem.transform[1] !== 0 || textItem.transform[2] !== 0)) {
      // Rotated text — apply CTM to position the cover rectangle
      const t = textItem.transform;
      builder.setMatrix({
        a: t[0] / textItem.fontSize,
        b: t[1] / textItem.fontSize,
        c: t[2] / textItem.fontSize,
        d: t[3] / textItem.fontSize,
        e: t[4],
        f: t[5],
      });
      // In the rotated coordinate system, position relative to origin
      builder.rectangle(
        -1,
        -descentBelow,
        textItem.width + 2,
        textHeight
      );
    } else {
      builder.rectangle(
        textItem.x - 1,
        baselineY - descentBelow,
        textItem.width + 2,
        textHeight
      );
    }
    builder.fill();
    builder.restoreState();

    // Issue #12: Use original color space when available
    let fillColorSpec: { space: string; values: number[] };
    if (textItem.colorSpace && textItem.originalColorValues) {
      fillColorSpec = {
        space: textItem.colorSpace,
        values: textItem.originalColorValues,
      };
    } else {
      const txtColor = textItem.textColor || { r: 0, g: 0, b: 0 };
      fillColorSpec = {
        space: 'DeviceRGB',
        values: [txtColor.r, txtColor.g, txtColor.b],
      };
    }

    // Replacement text
    builder.saveState();
    builder.setFillColor(fillColorSpec as any);

    // Issue #9: For rotated pages, apply inverse rotation CTM
    const pageRotation = page.rotation || 0;
    if (pageRotation !== 0) {
      applyInversePageRotation(builder, pageRotation, pageWidth, pageHeight);
    }

    builder.beginText();
    builder.setFont(fontResName, textItem.fontSize);

    // Issue #1: Use actual transform matrix instead of identity
    if (textItem.transform && (textItem.transform[1] !== 0 || textItem.transform[2] !== 0)) {
      const t = textItem.transform;
      builder.setTextMatrix({
        a: t[0] / textItem.fontSize,
        b: t[1] / textItem.fontSize,
        c: t[2] / textItem.fontSize,
        d: t[3] / textItem.fontSize,
        e: textItem.x,
        f: t[5],
      });
    } else {
      builder.setTextMatrix({ a: 1, b: 0, c: 0, d: 1, e: textItem.x, f: baselineY });
    }

    // Issue #6: Calculate character spacing to match original width
    const tcValue = calculateCharacterSpacing(
      edit.newText,
      textItem.width,
      stdFontEnum,
      textItem.fontSize,
    );

    if (tcValue !== null) {
      builder.setCharacterSpacing(tcValue);
      builder.showText(edit.newText);
      builder.setCharacterSpacing(0);
    } else {
      builder.showText(edit.newText);
    }

    builder.endText();
    builder.restoreState();
  }

  if (builder.commandCount > 0) {
    appendContentStream(pdfDoc, page.index, builder.build());
  }
}

/**
 * Issue #9: Apply inverse rotation CTM for rotated pages.
 * Transforms coordinates so that overlay text appears correctly on rotated pages.
 */
function applyInversePageRotation(
  builder: ContentStreamBuilder,
  rotation: number,
  pageWidth: number,
  pageHeight: number
): void {
  switch (rotation % 360) {
    case 90:
      builder.setMatrix({ a: 0, b: -1, c: 1, d: 0, e: 0, f: pageWidth });
      break;
    case 180:
      builder.setMatrix({ a: -1, b: 0, c: 0, d: -1, e: pageWidth, f: pageHeight });
      break;
    case 270:
      builder.setMatrix({ a: 0, b: 1, c: -1, d: 0, e: pageHeight, f: 0 });
      break;
  }
}

/**
 * Map PDF font name to pdf-lib StandardFonts enum value.
 */
function mapToPdfLibStandardFont(fontName: string): typeof StandardFonts[keyof typeof StandardFonts] {
  const name = fontName.toLowerCase();

  if (name.includes('courier') || name.includes('mono') || name.includes('consolas') || name.includes('menlo') || name.includes('monaco')) {
    if (name.includes('bold') && (name.includes('oblique') || name.includes('italic'))) return StandardFonts.CourierBoldOblique;
    if (name.includes('bold')) return StandardFonts.CourierBold;
    if (name.includes('oblique') || name.includes('italic')) return StandardFonts.CourierOblique;
    return StandardFonts.Courier;
  }

  if (name.includes('times') || name.includes('georgia') || name.includes('garamond') || name.includes('palatino') || (name.includes('serif') && !name.includes('sans'))) {
    if (name.includes('bold') && name.includes('italic')) return StandardFonts.TimesRomanBoldItalic;
    if (name.includes('bold')) return StandardFonts.TimesRomanBold;
    if (name.includes('italic')) return StandardFonts.TimesRomanItalic;
    return StandardFonts.TimesRoman;
  }

  if (name.includes('bold') && (name.includes('oblique') || name.includes('italic'))) return StandardFonts.HelveticaBoldOblique;
  if (name.includes('bold')) return StandardFonts.HelveticaBold;
  if (name.includes('oblique') || name.includes('italic')) return StandardFonts.HelveticaOblique;
  return StandardFonts.Helvetica;
}

/**
 * Pending sticky note that needs a PDF /Text annotation dict after content stream injection.
 */
interface PendingStickyNote {
  content: string;
  rect: { x: number; y: number; width: number; height: number };
  color: { r: number; g: number; b: number };
}

/**
 * Process all annotations on a page.
 * Fix #3: Batches all annotation content into a single stream per page.
 * Fix #2: Creates PDF /Text annotation dicts for sticky notes.
 * Fix #4: Uses font metrics for accurate stamp text centering.
 */
async function processAnnotations(
  pdfDoc: PDFLib,
  resources: ResourceAllocator,
  page: PDFPage,
  pageHeight: number,
  helvetica: PDFFont,
  helveticaRef: PDFRef
): Promise<void> {
  if (page.annotations.length === 0) return;

  const batchedChunks: Uint8Array[] = [];
  const pendingStickyNotes: PendingStickyNote[] = [];

  for (const annotation of page.annotations) {
    if (annotation.type === 'image') {
      const imageChunk = await buildImageChunk(pdfDoc, resources, page.index, annotation, pageHeight);
      if (imageChunk) batchedChunks.push(imageChunk);
      continue;
    }

    let writeOptions: { measuredTextWidth?: number } | undefined;
    if (annotation.type === 'stamp') {
      const stamp = annotation as StampAnnotation;
      const fontSize = Math.min(16, stamp.size.height * 0.5);
      writeOptions = {
        measuredTextWidth: helvetica.widthOfTextAtSize(stamp.text, fontSize),
      };
    }

    const result = writeAnnotation(annotation, pageHeight, writeOptions);
    if (!result) continue;

    const patchedBytes = patchResourceNames(pdfDoc, resources, page.index, result, helveticaRef);
    batchedChunks.push(patchedBytes);

    if (result.needsPdfAnnotation && result.pdfAnnotationContent) {
      pendingStickyNotes.push({
        content: result.pdfAnnotationContent,
        rect: result.pdfAnnotationRect!,
        color: result.pdfAnnotationColor!,
      });
    }
  }

  if (batchedChunks.length > 0) {
    const totalLength = batchedChunks.reduce((sum, chunk) => sum + chunk.length + 1, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of batchedChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
      merged[offset] = 0x0A;
      offset += 1;
    }
    appendContentStream(pdfDoc, page.index, merged.subarray(0, offset));
  }

  for (const note of pendingStickyNotes) {
    addPdfTextAnnotation(pdfDoc, page.index, note);
  }
}

/**
 * Build content stream bytes for an image annotation (async: needs embed).
 */
async function buildImageChunk(
  pdfDoc: PDFLib,
  resources: ResourceAllocator,
  pageIndex: number,
  annotation: ImageAnnotation,
  pageHeight: number
): Promise<Uint8Array | null> {
  const imageBytes = Uint8Array.from(atob(annotation.data), c => c.charCodeAt(0));
  let image;
  if (annotation.imageType === 'png') {
    image = await pdfDoc.embedPng(imageBytes);
  } else {
    image = await pdfDoc.embedJpg(imageBytes);
  }

  const imageRef = getImageRef(image);
  const imName = resources.ensureXObject(pdfDoc, pageIndex, imageRef);

  const builder = new ContentStreamBuilder();
  const x = annotation.position.x;
  const y = pageHeight - annotation.position.y - annotation.size.height;
  const w = annotation.size.width;
  const h = annotation.size.height;

  builder.saveState();
  builder.setMatrix({ a: w, b: 0, c: 0, d: h, e: x, f: y });
  builder.drawXObject(imName);
  builder.restoreState();

  return builder.build();
}

/**
 * Patch placeholder resource names (__GS_0__, __F_0__, __Im_0__) with real registered names.
 */
function patchResourceNames(
  pdfDoc: PDFLib,
  resources: ResourceAllocator,
  pageIndex: number,
  result: AnnotationWriteResult,
  helveticaRef: PDFRef
): Uint8Array {
  let contentStr = new TextDecoder('latin1').decode(result.contentBytes);

  for (let i = 0; i < result.resources.extGStates.length; i++) {
    const gs = result.resources.extGStates[i];
    const gsName = resources.ensureExtGState(pdfDoc, pageIndex, {
      fillOpacity: gs.fillOpacity,
      strokeOpacity: gs.strokeOpacity,
    });
    contentStr = contentStr.replaceAll(`/__GS_${i}__`, `/${gsName}`);
  }

  for (let i = 0; i < result.resources.fonts.length; i++) {
    const fontResName = resources.ensureFont(pdfDoc, pageIndex, helveticaRef);
    contentStr = contentStr.replaceAll(`/__F_${i}__`, `/${fontResName}`);
  }

  const patchedBytes = new Uint8Array(contentStr.length);
  for (let i = 0; i < contentStr.length; i++) {
    patchedBytes[i] = contentStr.charCodeAt(i) & 0xFF;
  }

  return patchedBytes;
}

/**
 * Fix #2: Add a proper PDF /Text annotation dict to the page's /Annots array.
 */
function addPdfTextAnnotation(
  pdfDoc: PDFLib,
  pageIndex: number,
  note: PendingStickyNote
): void {
  const context = pdfDoc.context;
  const page = pdfDoc.getPages()[pageIndex];
  const pageDict = page.node;

  const annotDict = context.obj({});
  annotDict.set(PDFName.of('Type'), PDFName.of('Annot'));
  annotDict.set(PDFName.of('Subtype'), PDFName.of('Text'));

  const rect = context.obj([
    PDFNumber.of(note.rect.x),
    PDFNumber.of(note.rect.y),
    PDFNumber.of(note.rect.x + note.rect.width),
    PDFNumber.of(note.rect.y + note.rect.height),
  ]);
  annotDict.set(PDFName.of('Rect'), rect);

  annotDict.set(PDFName.of('Contents'), PDFHexString.fromText(note.content));

  const colorArray = context.obj([
    PDFNumber.of(note.color.r),
    PDFNumber.of(note.color.g),
    PDFNumber.of(note.color.b),
  ]);
  annotDict.set(PDFName.of('C'), colorArray);

  annotDict.set(PDFName.of('Name'), PDFName.of('Note'));
  annotDict.set(PDFName.of('Open'), context.obj(false));
  annotDict.set(PDFName.of('F'), PDFNumber.of(4));

  const annotRef = context.register(annotDict);

  const annotsRef = pageDict.get(PDFName.of('Annots'));
  if (annotsRef) {
    const annots = context.lookup(annotsRef);
    if (annots instanceof PDFArray) {
      annots.push(annotRef);
    } else {
      const newArray = context.obj([annotsRef as PDFRef, annotRef]);
      pageDict.set(PDFName.of('Annots'), newArray);
    }
  } else {
    const newArray = context.obj([annotRef]);
    pageDict.set(PDFName.of('Annots'), newArray);
  }
}

/**
 * Extract the indirect PDFRef for an embedded font.
 */
function getFontRef(pdfDoc: PDFLib, font: PDFFont): PDFRef {
  const ref = (font as any).ref;
  if (ref) return ref;
  throw new Error('Could not extract font reference from pdf-lib PDFFont');
}

/**
 * Extract the indirect PDFRef for an embedded image.
 */
function getImageRef(image: any): PDFRef {
  const ref = image.ref;
  if (ref) return ref;
  throw new Error('Could not extract image reference from pdf-lib PDFImage');
}
