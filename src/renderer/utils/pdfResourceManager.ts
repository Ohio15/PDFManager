/**
 * PDF Resource Manager
 *
 * Creates and manages page-level PDF resources required by content stream operations.
 * Handles ExtGState (transparency), XObject (images), and Font registration
 * in the page's resource dictionary.
 *
 * Uses a class-based allocator so each save operation gets its own counter,
 * preventing name collisions from concurrent saves.
 *
 * Pattern follows blankText.ts: page.node -> PDFName.of('Resources') -> sub-dictionaries
 */

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFRef,
  PDFNumber,
} from 'pdf-lib';

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
 * Per-save resource allocator. Each instance maintains its own counter,
 * ensuring concurrent save operations cannot produce colliding resource names.
 */
export class ResourceAllocator {
  private counter = 0;

  private nextId(): number {
    return ++this.counter;
  }

  /**
   * Register an ExtGState resource on a page for transparency support.
   * @returns The resource name to use with the `gs` operator (e.g. "GS_ann_1")
   */
  ensureExtGState(
    pdfDoc: PDFDocument,
    pageIndex: number,
    options: { fillOpacity?: number; strokeOpacity?: number }
  ): string {
    const context = pdfDoc.context;
    const resourcesDict = getOrCreateResourcesDict(pdfDoc, pageIndex);
    const extGStateDict = getOrCreateSubDict(context, resourcesDict, 'ExtGState');

    const gsName = `GS_ann_${this.nextId()}`;

    const gsDict = context.obj({});
    gsDict.set(PDFName.of('Type'), PDFName.of('ExtGState'));

    if (options.fillOpacity !== undefined) {
      gsDict.set(PDFName.of('ca'), PDFNumber.of(options.fillOpacity));
    }
    if (options.strokeOpacity !== undefined) {
      gsDict.set(PDFName.of('CA'), PDFNumber.of(options.strokeOpacity));
    }

    extGStateDict.set(PDFName.of(gsName), gsDict);
    return gsName;
  }

  /**
   * Register an XObject (image) resource on a page.
   * @returns The resource name to use with the `Do` operator (e.g. "Im_ann_1")
   */
  ensureXObject(
    pdfDoc: PDFDocument,
    pageIndex: number,
    xObjectRef: PDFRef
  ): string {
    const context = pdfDoc.context;
    const resourcesDict = getOrCreateResourcesDict(pdfDoc, pageIndex);
    const xObjectDict = getOrCreateSubDict(context, resourcesDict, 'XObject');

    const imName = `Im_ann_${this.nextId()}`;
    xObjectDict.set(PDFName.of(imName), xObjectRef);
    return imName;
  }

  /**
   * Register a Font resource on a page.
   * @returns The resource name to use with the `Tf` operator (e.g. "F_ann_1")
   */
  ensureFont(
    pdfDoc: PDFDocument,
    pageIndex: number,
    fontRef: PDFRef
  ): string {
    const context = pdfDoc.context;
    const resourcesDict = getOrCreateResourcesDict(pdfDoc, pageIndex);
    const fontDict = getOrCreateSubDict(context, resourcesDict, 'Font');

    const fontName = `F_ann_${this.nextId()}`;
    fontDict.set(PDFName.of(fontName), fontRef);
    return fontName;
  }
}
