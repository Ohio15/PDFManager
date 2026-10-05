/**
 * Document-level scrubbing for redaction:
 *  - deleting annotations (and their popups / form fields) under marks,
 *  - stripping metadata (Info, XMP, PieceInfo) on request,
 *  - removing page-level data that can carry an unredacted copy of the page
 *    (/Thumb thumbnails, /PieceInfo application data),
 *  - garbage-collecting unreachable objects.
 *
 * GC matters for correctness, not size: pdf-lib serializes EVERY indirect
 * object in its context on save, reachable or not. Without it, the original
 * content streams and images replaced during redaction would still be in the
 * output file.
 */
import { PDFArray, PDFContext, PDFDict, PDFDocument as PDFLib, PDFName, PDFObject, PDFRef, PDFStream } from 'pdf-lib';
import { Rect, intersectsAny, normalizeRect } from './geometry';
import { dictGet, getArray, getDict, getName, numberArray, resolve } from './pdfObjects';

/** Remove annotations whose /Rect overlaps a mark. Returns the number removed. */
export function removeAnnotationsUnderMarks(pdfDoc: PDFLib, pageIndex: number, marks: Rect[]): number {
  const context = pdfDoc.context;
  const pageDict = pdfDoc.getPage(pageIndex).node;
  const annots = getArray(context, pageDict.get(PDFName.of('Annots')));
  if (!annots) return 0;

  const toRemove = new Set<PDFObject>();
  for (let i = 0; i < annots.size(); i++) {
    const entry = annots.get(i);
    const annot = getDict(context, entry);
    if (!annot) continue;
    const r = numberArray(context, dictGet(annot, 'Rect'));
    if (!r || r.length !== 4) continue;
    if (!intersectsAny(normalizeRect(r[0], r[1], r[2], r[3]), marks)) continue;
    toRemove.add(entry);
    const popup = dictGet(annot, 'Popup');
    if (popup) toRemove.add(popup);
    if (getName(context, dictGet(annot, 'Subtype')) === 'Widget') detachWidget(pdfDoc, entry, annot);
  }
  if (toRemove.size === 0) return 0;

  const kept: PDFObject[] = [];
  let removed = 0;
  for (let i = 0; i < annots.size(); i++) {
    const entry = annots.get(i);
    if (toRemove.has(entry) || isPopupOf(context, entry, toRemove)) {
      if (!isPopupOnly(context, entry)) removed++;
      continue;
    }
    kept.push(entry);
  }
  pageDict.set(PDFName.of('Annots'), context.obj(kept));
  return removed;
}

function isPopupOnly(context: PDFContext, entry: PDFObject): boolean {
  return getName(context, dictGet(getDict(context, entry), 'Subtype')) === 'Popup';
}

function isPopupOf(context: PDFContext, entry: PDFObject, removed: Set<PDFObject>): boolean {
  const d = getDict(context, entry);
  const parent = dictGet(d, 'Parent');
  return getName(context, dictGet(d, 'Subtype')) === 'Popup' && !!parent && removed.has(parent);
}

/** Unlink a widget from the AcroForm field tree, pruning fields left with no widgets. */
function detachWidget(pdfDoc: PDFLib, widgetEntry: PDFObject, widget: PDFDict): void {
  const context = pdfDoc.context;
  const acroForm = getDict(context, pdfDoc.catalog.get(PDFName.of('AcroForm')));
  if (!acroForm) return;

  const removeFrom = (arr: PDFArray | undefined, target: PDFObject): boolean => {
    if (!arr) return false;
    for (let i = arr.size() - 1; i >= 0; i--) {
      const item = arr.get(i);
      if (item === target || (item instanceof PDFRef && target instanceof PDFRef && item.toString() === target.toString())) {
        arr.remove(i);
        return true;
      }
    }
    return false;
  };

  let node: PDFObject = widgetEntry;
  let nodeDict: PDFDict | undefined = widget;
  for (let depth = 0; depth < 32 && nodeDict; depth++) {
    const parentEntry = nodeDict.get(PDFName.of('Parent'));
    const parent = getDict(context, parentEntry);
    if (!parent || !parentEntry) {
      removeFrom(getArray(context, acroForm.get(PDFName.of('Fields'))), node);
      return;
    }
    const kids = getArray(context, parent.get(PDFName.of('Kids')));
    removeFrom(kids, node);
    if (kids && kids.size() > 0) return;
    node = parentEntry;
    nodeDict = parent;
  }
}

/** Delete data on a page that can hold an unredacted rendering or application copy of it. */
export function scrubPageExtras(pageDict: PDFDict): void {
  pageDict.delete(PDFName.of('Thumb'));
  pageDict.delete(PDFName.of('PieceInfo'));
}

/** Remove Info, XMP /Metadata and /PieceInfo from every object in the document. */
export function stripDocumentMetadata(pdfDoc: PDFLib): void {
  const context = pdfDoc.context;
  context.trailerInfo.Info = undefined;
  for (const [, obj] of context.enumerateIndirectObjects()) {
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    if (!dict) continue;
    dict.delete(PDFName.of('Metadata'));
    dict.delete(PDFName.of('PieceInfo'));
  }
  pdfDoc.catalog.delete(PDFName.of('Metadata'));
  pdfDoc.catalog.delete(PDFName.of('PieceInfo'));
}

/** Delete every indirect object not reachable from the trailer. Returns the count removed. */
export function collectGarbage(pdfDoc: PDFLib): number {
  const context = pdfDoc.context;
  const reachable = new Set<string>();
  const stack: PDFObject[] = [];
  const roots = [context.trailerInfo.Root, context.trailerInfo.Info, context.trailerInfo.Encrypt].filter(Boolean) as PDFObject[];
  stack.push(...roots);

  while (stack.length) {
    const obj = stack.pop()!;
    if (obj instanceof PDFRef) {
      const key = obj.toString();
      if (reachable.has(key)) continue;
      reachable.add(key);
      const target = context.lookup(obj);
      if (target) stack.push(target);
    } else if (obj instanceof PDFDict) {
      for (const [, v] of obj.entries()) stack.push(v);
    } else if (obj instanceof PDFStream) {
      for (const [, v] of obj.dict.entries()) stack.push(v);
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) stack.push(obj.get(i));
    }
  }

  let removed = 0;
  for (const [ref] of context.enumerateIndirectObjects()) {
    if (!reachable.has(ref.toString())) {
      context.delete(ref);
      removed++;
    }
  }
  return removed;
}

export { resolve };
