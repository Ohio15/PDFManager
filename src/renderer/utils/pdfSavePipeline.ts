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

  // Per-save resource allocator (Fix #6: no global counter)
  const resources = new ResourceAllocator();

  for (const page of pages) {
    const pdfPage = pdfDoc.getPage(page.index);
    const { height } = pdfPage.getSize();

    // --- (a) Blank deleted text items ---
    await processDeletedTextItems(pdfDoc, resources, page, height);

    // --- (b) Apply text edits ---
    await processTextEdits(pdfDoc, resources, page, height);

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
 * Process text edits: content stream modification first, fallback to overlay.
 */
async function processTextEdits(
  pdfDoc: PDFLib,
  resources: ResourceAllocator,
  page: PDFPage,
  pageHeight: number
): Promise<void> {
  if (!page.textEdits || page.textEdits.length === 0) return;

  const fontCache = new Map<string, { font: PDFFont; ref: PDFRef }>();
  const builder = new ContentStreamBuilder();

  for (const edit of page.textEdits) {
    const textItem = page.textItems?.find(t => t.id === edit.itemId);
    if (!textItem) continue;

    const contentStreamModified = await replaceTextInPage(
      pdfDoc,
      page.index,
      edit.originalText,
      edit.newText
    );

    if (contentStreamModified) {
      continue;
    }

    await blankTextInContentStream(pdfDoc, page.index, edit.originalText);

    const standardFontName = mapToStandardFont(textItem.fontName);
    let fontEntry = fontCache.get(standardFontName);
    if (!fontEntry) {
      const font = await pdfDoc.embedFont(standardFontName);
      const ref = getFontRef(pdfDoc, font);
      fontEntry = { font, ref };
      fontCache.set(standardFontName, fontEntry);
    }

    const fontResName = resources.ensureFont(pdfDoc, page.index, fontEntry.ref);

    const textHeight = textItem.fontSize;
    const baselineY = textItem.transform
      ? textItem.transform[5]
      : (pageHeight - textItem.y - textHeight);

    // Cover rectangle
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

    // Replacement text
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

  // Collect all annotation content bytes into one batch
  const batchedChunks: Uint8Array[] = [];
  const pendingStickyNotes: PendingStickyNote[] = [];

  for (const annotation of page.annotations) {
    // Handle image embedding specially (needs async embed)
    if (annotation.type === 'image') {
      const imageChunk = await buildImageChunk(pdfDoc, resources, page.index, annotation, pageHeight);
      if (imageChunk) batchedChunks.push(imageChunk);
      continue;
    }

    // Fix #4: Measure stamp text width from font metrics
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

    // Patch placeholder resource names with real registered names
    const patchedBytes = patchResourceNames(pdfDoc, resources, page.index, result, helveticaRef);
    batchedChunks.push(patchedBytes);

    // Fix #2: Collect sticky notes that need PDF annotation objects
    if (result.needsPdfAnnotation && result.pdfAnnotationContent) {
      pendingStickyNotes.push({
        content: result.pdfAnnotationContent,
        rect: result.pdfAnnotationRect!,
        color: result.pdfAnnotationColor!,
      });
    }
  }

  // Fix #3: Inject all annotation content as a single stream per page
  if (batchedChunks.length > 0) {
    const totalLength = batchedChunks.reduce((sum, chunk) => sum + chunk.length + 1, 0);
    const merged = new Uint8Array(totalLength);
    let offset = 0;
    for (const chunk of batchedChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
      merged[offset] = 0x0A; // newline separator between annotation chunks
      offset += 1;
    }
    appendContentStream(pdfDoc, page.index, merged.subarray(0, offset));
  }

  // Fix #2: Add PDF /Text annotation dicts for sticky notes
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

  // Register ExtGStates
  for (let i = 0; i < result.resources.extGStates.length; i++) {
    const gs = result.resources.extGStates[i];
    const gsName = resources.ensureExtGState(pdfDoc, pageIndex, {
      fillOpacity: gs.fillOpacity,
      strokeOpacity: gs.strokeOpacity,
    });
    contentStr = contentStr.replaceAll(`/__GS_${i}__`, `/${gsName}`);
  }

  // Register Fonts
  for (let i = 0; i < result.resources.fonts.length; i++) {
    const fontResName = resources.ensureFont(pdfDoc, pageIndex, helveticaRef);
    contentStr = contentStr.replaceAll(`/__F_${i}__`, `/${fontResName}`);
  }

  // Convert patched string back to latin1 bytes
  const patchedBytes = new Uint8Array(contentStr.length);
  for (let i = 0; i < contentStr.length; i++) {
    patchedBytes[i] = contentStr.charCodeAt(i) & 0xFF;
  }

  return patchedBytes;
}

/**
 * Fix #2: Add a proper PDF /Text annotation dict to the page's /Annots array.
 * This creates a standard popup note that works in Adobe Reader and other viewers.
 */
function addPdfTextAnnotation(
  pdfDoc: PDFLib,
  pageIndex: number,
  note: PendingStickyNote
): void {
  const context = pdfDoc.context;
  const page = pdfDoc.getPages()[pageIndex];
  const pageDict = page.node;

  // Build the annotation dictionary
  const annotDict = context.obj({});
  annotDict.set(PDFName.of('Type'), PDFName.of('Annot'));
  annotDict.set(PDFName.of('Subtype'), PDFName.of('Text'));

  // Rect: [x, y, x+width, y+height]
  const rect = context.obj([
    PDFNumber.of(note.rect.x),
    PDFNumber.of(note.rect.y),
    PDFNumber.of(note.rect.x + note.rect.width),
    PDFNumber.of(note.rect.y + note.rect.height),
  ]);
  annotDict.set(PDFName.of('Rect'), rect);

  // Contents - the actual note text
  annotDict.set(PDFName.of('Contents'), PDFHexString.fromText(note.content));

  // Color array [r, g, b]
  const colorArray = context.obj([
    PDFNumber.of(note.color.r),
    PDFNumber.of(note.color.g),
    PDFNumber.of(note.color.b),
  ]);
  annotDict.set(PDFName.of('C'), colorArray);

  // Name: icon type
  annotDict.set(PDFName.of('Name'), PDFName.of('Note'));

  // Open: false (collapsed by default)
  annotDict.set(PDFName.of('Open'), context.obj(false));

  // F: print flag (bit 3 = print)
  annotDict.set(PDFName.of('F'), PDFNumber.of(4));

  const annotRef = context.register(annotDict);

  // Get or create the page's /Annots array
  const annotsRef = pageDict.get(PDFName.of('Annots'));
  if (annotsRef) {
    const annots = context.lookup(annotsRef);
    if (annots instanceof PDFArray) {
      annots.push(annotRef);
    } else {
      // Replace with new array containing existing + new
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
