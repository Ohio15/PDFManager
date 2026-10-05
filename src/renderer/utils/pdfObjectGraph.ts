/**
 * pdfObjectGraph — reachability and reference rewriting over a pdf-lib context.
 *
 * Shared by flatten (drop the orphaned field tree after widgets are burned in)
 * and compress (drop unused objects, collapse duplicates). Both need the same
 * two primitives: "which indirect objects can a reader still reach from the
 * trailer?" and "point every reference to X at Y instead".
 */

import {
  PDFDocument,
  PDFRef,
  PDFDict,
  PDFArray,
  PDFStream,
  PDFObject,
} from 'pdf-lib';

/** Visit every PDFRef directly contained in `obj` (dict values, array items, stream dict). */
function forEachChildRef(obj: PDFObject | undefined, visit: (ref: PDFRef) => void): void {
  if (!obj) return;
  if (obj instanceof PDFRef) {
    visit(obj);
    return;
  }
  if (obj instanceof PDFStream) {
    forEachChildRef(obj.dict, visit);
    return;
  }
  if (obj instanceof PDFDict) {
    for (const [, value] of obj.entries()) forEachChildRef(value, visit);
    return;
  }
  if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) forEachChildRef(obj.get(i), visit);
  }
}

/** Collect the set of indirect objects reachable from the trailer (Root, Info, Encrypt). */
export function collectReachableRefs(pdfDoc: PDFDocument): Set<string> {
  const context = pdfDoc.context;
  const reachable = new Set<string>();
  const stack: PDFRef[] = [];
  const { Root, Info, Encrypt } = context.trailerInfo;
  for (const root of [Root, Info, Encrypt]) {
    if (root instanceof PDFRef) stack.push(root);
    else if (root) forEachChildRef(root, (r) => stack.push(r));
  }
  while (stack.length > 0) {
    const ref = stack.pop()!;
    const key = ref.toString();
    if (reachable.has(key)) continue;
    reachable.add(key);
    const target = context.lookup(ref);
    forEachChildRef(target, (child) => {
      if (!reachable.has(child.toString())) stack.push(child);
    });
  }
  return reachable;
}

/** Delete every indirect object no longer reachable from the trailer. Returns the count removed. */
export function removeUnreachableObjects(pdfDoc: PDFDocument): number {
  const reachable = collectReachableRefs(pdfDoc);
  let removed = 0;
  for (const [ref] of pdfDoc.context.enumerateIndirectObjects()) {
    if (!reachable.has(ref.toString())) {
      pdfDoc.context.delete(ref);
      removed++;
    }
  }
  return removed;
}

/**
 * Replace references in place across every indirect object and the trailer.
 * `mapping` is keyed by `ref.toString()` ("12 0 R") → replacement ref.
 */
export function rewriteReferences(pdfDoc: PDFDocument, mapping: Map<string, PDFRef>): void {
  if (mapping.size === 0) return;
  const rewrite = (obj: PDFObject | undefined): void => {
    if (!obj) return;
    if (obj instanceof PDFStream) {
      rewrite(obj.dict);
      return;
    }
    if (obj instanceof PDFDict) {
      for (const [key, value] of obj.entries()) {
        if (value instanceof PDFRef) {
          const replacement = mapping.get(value.toString());
          if (replacement) obj.set(key, replacement);
        } else {
          rewrite(value);
        }
      }
      return;
    }
    if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const value = obj.get(i);
        if (value instanceof PDFRef) {
          const replacement = mapping.get(value.toString());
          if (replacement) obj.set(i, replacement);
        } else {
          rewrite(value);
        }
      }
    }
  };
  for (const [, obj] of pdfDoc.context.enumerateIndirectObjects()) rewrite(obj);
  const trailer = pdfDoc.context.trailerInfo;
  for (const key of ['Root', 'Info'] as const) {
    const value = trailer[key];
    if (value instanceof PDFRef) {
      const replacement = mapping.get(value.toString());
      if (replacement) trailer[key] = replacement;
    }
  }
}
