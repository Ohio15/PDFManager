/**
 * Document-level scrubbing for redaction:
 *  - deleting annotations (and their popups / form fields) under marks, by
 *    object identity across EVERY inbound reference (page /Annots, field
 *    /Kids and /Fields, AcroForm /CO, reply /IRT, /Parent, structure-tree
 *    OBJR entries and ParentTree leaves, and any other reference in the file),
 *  - deleting the AcroForm /XFA stream (a parallel, unredacted copy of the
 *    form template and every field value),
 *  - stripping metadata (Info, XMP, PieceInfo) on request,
 *  - removing page-level data that can carry an unredacted copy of the page
 *    (/Thumb thumbnails, /PieceInfo application data),
 *  - garbage-collecting unreachable objects.
 *
 * GC matters for correctness, not size: pdf-lib serializes EVERY indirect
 * object in its context on save, reachable or not. GC is reachability-based,
 * so it only drops an object once NOTHING references it: a replaced image or
 * form must first be unbound from the page resources (ResourceScope.pruneTo)
 * and a removed annotation must first be cut from every inbound reference
 * (cutRemovedObjects). Without those steps GC keeps the original and the save
 * writes it.
 */
import { PDFArray, PDFContext, PDFDict, PDFDocument as PDFLib, PDFName, PDFNull, PDFNumber, PDFObject, PDFRef, PDFStream } from 'pdf-lib';
import { Rect, intersectsAny, normalizeRect } from './geometry';
import { dictGet, getArray, getDict, getName, getNumber, numberArray, resolve } from './pdfObjects';

export interface RemovedObject {
  ref: PDFRef;
  kind: 'annotation' | 'widget' | 'field' | 'structure';
}

function annotRect(context: PDFContext, annot: PDFDict): Rect | undefined {
  const r = numberArray(context, dictGet(annot, 'Rect'));
  return r && r.length === 4 ? normalizeRect(r[0], r[1], r[2], r[3]) : undefined;
}

function sameRef(a: PDFObject | undefined, b: PDFRef): boolean {
  return a instanceof PDFRef && a.toString() === b.toString();
}

/**
 * Remove annotations whose /Rect overlaps a mark: those listed in the page
 * /Annots and any annotation dictionary elsewhere in the file whose /P names
 * this page (orphans reachable only through the structure tree, a reply
 * chain, etc.). Every removed indirect object is recorded in `removed` so
 * cutRemovedObjects can sever its remaining inbound references. Returns the
 * number of annotations removed (popups not counted).
 */
export function removeAnnotationsUnderMarks(pdfDoc: PDFLib, pageIndex: number, marks: Rect[], removed: Map<string, RemovedObject>): number {
  const context = pdfDoc.context;
  const page = pdfDoc.getPage(pageIndex);
  const pageDict = page.node;
  const record = (entry: PDFObject | undefined, kind: RemovedObject['kind']) => {
    if (entry instanceof PDFRef && !removed.has(entry.toString())) removed.set(entry.toString(), { ref: entry, kind });
  };
  const removeOne = (entry: PDFObject, annot: PDFDict) => {
    const isWidget = getName(context, dictGet(annot, 'Subtype')) === 'Widget';
    record(entry, isWidget ? 'widget' : 'annotation');
    const popup = dictGet(annot, 'Popup');
    if (popup) record(popup, 'annotation');
    if (isWidget) for (const field of detachWidget(pdfDoc, entry, annot)) record(field, 'field');
  };

  let count = 0;
  const annots = getArray(context, pageDict.get(PDFName.of('Annots')));
  if (annots) {
    const toRemove = new Set<PDFObject>();
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      const annot = getDict(context, entry);
      if (!annot) continue;
      const r = annotRect(context, annot);
      if (!r || !intersectsAny(r, marks)) continue;
      toRemove.add(entry);
      const popup = dictGet(annot, 'Popup');
      if (popup) toRemove.add(popup);
      removeOne(entry, annot);
    }
    if (toRemove.size > 0) {
      const kept: PDFObject[] = [];
      for (let i = 0; i < annots.size(); i++) {
        const entry = annots.get(i);
        if (toRemove.has(entry) || isPopupOf(context, entry, toRemove)) {
          if (!isPopupOnly(context, entry)) count++;
          if (isPopupOf(context, entry, toRemove)) record(entry, 'annotation');
          continue;
        }
        kept.push(entry);
      }
      pageDict.set(PDFName.of('Annots'), context.obj(kept));
    }
  }

  // Annotations of this page that are not (or no longer) in its /Annots but
  // are still reachable through some other reference (structure tree, reply
  // chain, AcroForm field tree).
  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (removed.has(ref.toString())) continue;
    const dict = obj instanceof PDFDict ? obj : undefined;
    if (!dict || !sameRef(dict.get(PDFName.of('P')), page.ref)) continue;
    if (!getName(context, dictGet(dict, 'Subtype'))) continue;
    const r = annotRect(context, dict);
    if (!r || !intersectsAny(r, marks)) continue;
    removeOne(ref, dict);
    if (!isPopupOnly(context, ref)) count++;
  }
  return count;
}

function isPopupOnly(context: PDFContext, entry: PDFObject): boolean {
  return getName(context, dictGet(getDict(context, entry), 'Subtype')) === 'Popup';
}

function isPopupOf(context: PDFContext, entry: PDFObject, removed: Set<PDFObject>): boolean {
  const d = getDict(context, entry);
  const parent = dictGet(d, 'Parent');
  return getName(context, dictGet(d, 'Subtype')) === 'Popup' && !!parent && removed.has(parent);
}

/**
 * Unlink a widget from the AcroForm field tree, pruning fields left with no
 * widgets. Returns the field nodes that were pruned: they carry /V and must
 * be cut from every other inbound reference too.
 */
function detachWidget(pdfDoc: PDFLib, widgetEntry: PDFObject, widget: PDFDict): PDFObject[] {
  const context = pdfDoc.context;
  const pruned: PDFObject[] = [];
  const acroForm = getDict(context, pdfDoc.catalog.get(PDFName.of('AcroForm')));

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
      if (acroForm) removeFrom(getArray(context, acroForm.get(PDFName.of('Fields'))), node);
      return pruned;
    }
    const kids = getArray(context, parent.get(PDFName.of('Kids')));
    removeFrom(kids, node);
    if (kids && kids.size() > 0) return pruned;
    node = parentEntry;
    nodeDict = parent;
    pruned.push(parentEntry);
  }
  return pruned;
}

function isObjrTo(context: PDFContext, obj: PDFObject | undefined, removed: Map<string, RemovedObject>): boolean {
  const d = obj instanceof PDFDict ? obj : undefined;
  if (!d || getName(context, dictGet(d, 'Type')) !== 'OBJR') return false;
  const target = d.get(PDFName.of('Obj'));
  return target instanceof PDFRef && removed.has(target.toString());
}

function isRemovedValue(context: PDFContext, v: PDFObject | undefined, removed: Map<string, RemovedObject>): boolean {
  if (v instanceof PDFRef) return removed.has(v.toString());
  return isObjrTo(context, v, removed);
}

function isStructElem(context: PDFContext, d: PDFDict): boolean {
  if (getName(context, dictGet(d, 'Type')) === 'StructElem') return true;
  return !!getName(context, dictGet(d, 'S')) && d.has(PDFName.of('P')) && d.has(PDFName.of('K'));
}

/** Structure-element kids (/K) as a flat list. */
function structKids(d: PDFDict): PDFObject[] {
  const k = d.get(PDFName.of('K'));
  if (k === undefined) return [];
  if (k instanceof PDFArray) {
    const out: PDFObject[] = [];
    for (let i = 0; i < k.size(); i++) out.push(k.get(i));
    return out;
  }
  return [k];
}

/** Arrays of key/value pairs (number trees, name trees). */
const PAIR_ARRAY_KEYS = new Set(['Nums', 'Names']);
const MAX_CUT_DEPTH = 64;

/**
 * Sever every reference to a removed object anywhere in the document, so the
 * object is unreachable and garbage collection drops it:
 *  - indirect OBJR dictionaries pointing at a removed object, and structure
 *    elements whose every kid is removed, are removed too (cascading);
 *  - array members are deleted (/Annots, /Kids, /Fields, /CO, /K, ...);
 *    number/name-tree pairs (/Nums, /Names) lose the whole pair, and the
 *    positional MCID arrays that ParentTree values hold get null in place so
 *    the remaining MCIDs keep their index;
 *  - dictionary keys whose value is removed are deleted (/IRT, /Parent,
 *    /Popup, ...);
 *  - ParentTree entries keyed by a removed annotation's /StructParent go.
 * `removed` is extended with the cascaded structure objects.
 */
export function cutRemovedObjects(pdfDoc: PDFLib, removed: Map<string, RemovedObject>): void {
  if (removed.size === 0) return;
  const context = pdfDoc.context;

  // StructParent keys of removed annotations, read before anything is cut.
  const structParents = new Set<number>();
  for (const { ref } of removed.values()) {
    const sp = getNumber(context, dictGet(getDict(context, ref), 'StructParent'));
    if (sp !== undefined) structParents.add(sp);
  }

  // Cascade to structure-tree nodes that exist only to point at removed objects.
  for (let round = 0; round < MAX_CUT_DEPTH; round++) {
    let grew = false;
    for (const [ref, obj] of context.enumerateIndirectObjects()) {
      if (removed.has(ref.toString()) || !(obj instanceof PDFDict)) continue;
      let dead = isObjrTo(context, obj, removed);
      if (!dead && isStructElem(context, obj)) {
        const kids = structKids(obj);
        dead = kids.length > 0 && kids.every((k) => isRemovedValue(context, k, removed));
      }
      if (dead) {
        removed.set(ref.toString(), { ref, kind: 'structure' });
        grew = true;
      }
    }
    if (!grew) break;
  }

  const cutArray = (arr: PDFArray, key: string | undefined, depth: number): void => {
    if (depth > MAX_CUT_DEPTH) return;
    if (key && PAIR_ARRAY_KEYS.has(key)) {
      for (let i = arr.size() - 2; i >= 0; i -= 2) {
        const value = arr.get(i + 1);
        if (isRemovedValue(context, value, removed)) {
          arr.remove(i + 1);
          arr.remove(i);
        } else if (value instanceof PDFArray && key === 'Nums') {
          // ParentTree page entry: index = MCID; keep positions stable.
          for (let j = 0; j < value.size(); j++) {
            if (isRemovedValue(context, value.get(j), removed)) value.set(j, PDFNull);
          }
        } else if (value instanceof PDFArray) {
          cutArray(value, undefined, depth + 1);
        } else {
          cutIn(value, depth + 1);
        }
      }
      return;
    }
    for (let i = arr.size() - 1; i >= 0; i--) {
      const item = arr.get(i);
      if (isRemovedValue(context, item, removed)) arr.remove(i);
      else if (item instanceof PDFArray) cutArray(item, undefined, depth + 1);
      else cutIn(item, depth + 1);
    }
  };

  const cutIn = (obj: PDFObject | undefined, depth: number): void => {
    if (depth > MAX_CUT_DEPTH) return;
    const dict = obj instanceof PDFStream ? obj.dict : obj instanceof PDFDict ? obj : undefined;
    if (!dict) return;
    for (const [k, v] of dict.entries()) {
      if (isRemovedValue(context, v, removed)) dict.delete(k);
      else if (v instanceof PDFArray) cutArray(v, k.decodeText(), depth + 1);
      else if (v instanceof PDFDict) cutIn(v, depth + 1);
    }
  };

  for (const [ref, obj] of context.enumerateIndirectObjects()) {
    if (removed.has(ref.toString())) continue;
    if (obj instanceof PDFArray) cutArray(obj, undefined, 0);
    else cutIn(obj, 0);
  }

  if (structParents.size) removeParentTreeKeys(pdfDoc, structParents);
}

/** Delete ParentTree number-tree entries whose key is in `keys`. */
function removeParentTreeKeys(pdfDoc: PDFLib, keys: Set<number>): void {
  const context = pdfDoc.context;
  const root = getDict(context, pdfDoc.catalog.get(PDFName.of('StructTreeRoot')));
  const tree = getDict(context, dictGet(root, 'ParentTree'));
  if (!tree) return;
  const visited = new Set<PDFDict>();
  const walk = (node: PDFDict | undefined, depth: number) => {
    if (!node || depth > 32 || visited.has(node)) return;
    visited.add(node);
    const nums = getArray(context, dictGet(node, 'Nums'));
    if (nums) {
      for (let i = nums.size() - 2; i >= 0; i -= 2) {
        const key = resolve(context, nums.get(i));
        if (key instanceof PDFNumber && keys.has(key.asNumber())) {
          nums.remove(i + 1);
          nums.remove(i);
        }
      }
    }
    const kids = getArray(context, dictGet(node, 'Kids'));
    if (kids) for (let i = 0; i < kids.size(); i++) walk(getDict(context, kids.get(i)), depth + 1);
  };
  walk(tree, 0);
}

/**
 * Delete /AcroForm /XFA (and the catalog /NeedsRendering, meaningless without
 * XFA). XFA holds the form template and every field value as a separate
 * stream the redactor never rewrites, so it cannot survive a redaction.
 * Returns true when XFA was present.
 */
export function removeXfa(pdfDoc: PDFLib): boolean {
  const context = pdfDoc.context;
  const acroForm = getDict(context, pdfDoc.catalog.get(PDFName.of('AcroForm')));
  const had = !!acroForm?.has(PDFName.of('XFA'));
  acroForm?.delete(PDFName.of('XFA'));
  pdfDoc.catalog.delete(PDFName.of('NeedsRendering'));
  return had;
}

/** Structure-element keys that repeat or describe the content the element tags. */
const STRUCT_TEXT_KEYS = ['ActualText', 'Alt', 'E'] as const;
const MAX_STRUCT_DEPTH = 256;

/**
 * Structure elements (and their ancestors) that tag page-level marked content
 * of `pageRef` whose MCID satisfies `matches`, and that carry /ActualText,
 * /Alt or /E. Those strings are a document-level copy of the tagged content:
 * when the content is under a mark they must go even though the MCID (and the
 * element) stay. With `apply` the keys are deleted; either way the affected
 * elements are returned (as "ref" or "direct" descriptions) so the verifier
 * can fail on any that remain.
 *
 * Scope: page content only. Marked-content references into a form XObject
 * (MCR /Stm) are not followed; form content is rewritten as a new object and
 * its own marked-content properties are scrubbed in the stream.
 */
export function structTextForMcids(pdfDoc: PDFLib, pageRef: PDFRef, matches: (mcid: number) => boolean, apply: boolean): string[] {
  const context = pdfDoc.context;
  const root = getDict(context, pdfDoc.catalog.get(PDFName.of('StructTreeRoot')));
  if (!root) return [];
  const hits: string[] = [];
  const done = new Set<PDFDict>();
  const visited = new Set<PDFDict>();
  const pageKey = pageRef.toString();

  const isPage = (v: PDFObject | undefined) => v instanceof PDFRef && v.toString() === pageKey;

  const scrub = (chain: Array<{ dict: PDFDict; where: string }>) => {
    for (const { dict, where } of chain) {
      if (done.has(dict)) continue;
      done.add(dict);
      const present = STRUCT_TEXT_KEYS.filter((k) => dict.has(PDFName.of(k)));
      if (!present.length) continue;
      hits.push(`Structure element ${where} carries /${present.join(', /')} for content under a mark`);
      if (apply) for (const k of present) dict.delete(PDFName.of(k));
    }
  };

  const walk = (entry: PDFObject | undefined, inheritedPage: PDFObject | undefined, chain: Array<{ dict: PDFDict; where: string }>, depth: number) => {
    if (depth > MAX_STRUCT_DEPTH || entry === undefined) return;
    const dict = getDict(context, entry);
    if (!dict) return;
    if (getName(context, dictGet(dict, 'Type')) === 'MCR') {
      // Marked-content reference: its own /Pg overrides the element's.
      if (dict.has(PDFName.of('Stm'))) return;
      const mcid = getNumber(context, dictGet(dict, 'MCID'));
      const pg = dict.get(PDFName.of('Pg')) ?? inheritedPage;
      if (mcid !== undefined && isPage(pg) && matches(mcid)) scrub(chain);
      return;
    }
    if (getName(context, dictGet(dict, 'Type')) === 'OBJR') return;
    if (visited.has(dict)) return;
    visited.add(dict);
    const pg = dict.get(PDFName.of('Pg')) ?? inheritedPage;
    const here = [...chain, { dict, where: entry instanceof PDFRef ? entry.toString() : '(direct)' }];
    const k = dict.get(PDFName.of('K'));
    const kids: PDFObject[] = [];
    const resolvedK = resolve(context, k);
    if (resolvedK instanceof PDFArray) for (let i = 0; i < resolvedK.size(); i++) kids.push(resolvedK.get(i));
    else if (k !== undefined) kids.push(k);
    for (const kid of kids) {
      const n = resolve(context, kid);
      if (n instanceof PDFNumber) {
        if (isPage(pg) && matches(n.asNumber())) scrub(here);
      } else {
        walk(kid, pg, here, depth + 1);
      }
    }
  };

  // The root itself is not an element; walk its kids with an empty chain.
  const rootK = root.get(PDFName.of('K'));
  const rootKids = resolve(context, rootK);
  if (rootKids instanceof PDFArray) for (let i = 0; i < rootKids.size(); i++) walk(rootKids.get(i), undefined, [], 0);
  else walk(rootK, undefined, [], 0);
  return hits;
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
