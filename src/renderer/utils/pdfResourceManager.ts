/**
 * PDF Resource Manager
 *
 * Creates and manages page-level PDF resources required by content stream operations.
 * Handles ExtGState (transparency), XObject (images), and Font registration
 * in the page's resource dictionary.
 *
 * Pattern follows blankText.ts: page.node -> PDFName.of('Resources') -> sub-dictionaries
 */

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFRef,
  PDFNumber,
  PDFArray,
} from 'pdf-lib';

let resourceCounter = 0;

function nextId(): number {
  return ++resourceCounter;
}

/**
 * Ensure the page has a Resources dictionary, creating one if needed.
 */
function getOrCreateResourcesDict(pdfDoc: PDFDocument, pageIndex: number): PDFDict {
  const page = pdfDoc.getPages()[pageIndex];
  const pageDict = page.node;
  const context = pdfDoc.context;

  let resourcesRef = pageDict.get(PDFName.of('Resources'));
  if (!resourcesRef) {
    const newDict = context.obj({});
    const ref = context.register(newDict);
    pageDict.set(PDFName.of('Resources'), ref);
    return newDict;
  }

  const resources = context.lookup(resourcesRef);
  if (resources instanceof PDFDict) {
    return resources;
  }

  // Shouldn't happen but handle gracefully
  const newDict = context.obj({});
  const ref = context.register(newDict);
  pageDict.set(PDFName.of('Resources'), ref);
  return newDict;
}

/**
 * Get or create a sub-dictionary within the Resources dict.
 */
function getOrCreateSubDict(
  context: any,
  resourcesDict: PDFDict,
  name: string
): PDFDict {
  const existing = resourcesDict.get(PDFName.of(name));
  if (existing) {
    const dict = context.lookup(existing);
    if (dict instanceof PDFDict) {
      return dict;
    }
  }

  const newDict = context.obj({});
  resourcesDict.set(PDFName.of(name), newDict);
  return newDict;
}

/**
 * Register an ExtGState resource on a page for transparency support.
 *
 * @param pdfDoc - The pdf-lib document
 * @param pageIndex - Zero-based page index
 * @param options - Graphics state parameters
 * @returns The resource name to use with the `gs` operator (e.g. "GS_ann_1")
 */
export function ensureExtGState(
  pdfDoc: PDFDocument,
  pageIndex: number,
  options: {
    fillOpacity?: number;
    strokeOpacity?: number;
  }
): string {
  const context = pdfDoc.context;
  const resourcesDict = getOrCreateResourcesDict(pdfDoc, pageIndex);
  const extGStateDict = getOrCreateSubDict(context, resourcesDict, 'ExtGState');

  const gsName = `GS_ann_${nextId()}`;

  // Build the graphics state dictionary
  const gsDict = context.obj({});
  gsDict.set(PDFName.of('Type'), PDFName.of('ExtGState'));

  if (options.fillOpacity !== undefined) {
    // /ca = non-stroking (fill) opacity
    gsDict.set(PDFName.of('ca'), PDFNumber.of(options.fillOpacity));
  }
  if (options.strokeOpacity !== undefined) {
    // /CA = stroking opacity
    gsDict.set(PDFName.of('CA'), PDFNumber.of(options.strokeOpacity));
  }

  extGStateDict.set(PDFName.of(gsName), gsDict);

  return gsName;
}

/**
 * Register an XObject (image) resource on a page.
 *
 * @param pdfDoc - The pdf-lib document
 * @param pageIndex - Zero-based page index
 * @param xObjectRef - A PDFRef pointing to the embedded image/XObject
 * @returns The resource name to use with the `Do` operator (e.g. "Im_ann_1")
 */
export function ensureXObject(
  pdfDoc: PDFDocument,
  pageIndex: number,
  xObjectRef: PDFRef
): string {
  const context = pdfDoc.context;
  const resourcesDict = getOrCreateResourcesDict(pdfDoc, pageIndex);
  const xObjectDict = getOrCreateSubDict(context, resourcesDict, 'XObject');

  const imName = `Im_ann_${nextId()}`;
  xObjectDict.set(PDFName.of(imName), xObjectRef);

  return imName;
}

/**
 * Register a Font resource on a page.
 *
 * @param pdfDoc - The pdf-lib document
 * @param pageIndex - Zero-based page index
 * @param fontRef - A PDFRef pointing to the embedded font
 * @returns The resource name to use with the `Tf` operator (e.g. "F_ann_1")
 */
export function ensureFont(
  pdfDoc: PDFDocument,
  pageIndex: number,
  fontRef: PDFRef
): string {
  const context = pdfDoc.context;
  const resourcesDict = getOrCreateResourcesDict(pdfDoc, pageIndex);
  const fontDict = getOrCreateSubDict(context, resourcesDict, 'Font');

  const fontName = `F_ann_${nextId()}`;
  fontDict.set(PDFName.of(fontName), fontRef);

  return fontName;
}

/**
 * Reset the resource counter. Useful between save operations to keep names predictable.
 */
export function resetResourceCounter(): void {
  resourceCounter = 0;
}
