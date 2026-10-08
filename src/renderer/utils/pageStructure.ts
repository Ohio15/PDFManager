/**
 * Structural page operations on raw PDF bytes.
 *
 * These rebuild `pdfData` through pdf-lib so that the renderer's page model and
 * the underlying bytes never diverge. The entire save pipeline assumes
 * `model page index === physical page index in pdfData` (see pdfSavePipeline.ts,
 * which resolves `pdfDoc.getPage(page.index)`); delete/insert/reorder/rotate must
 * therefore mutate the bytes, not just the model. Mutations are done in place on
 * the loaded document (never via copy-into-a-new-doc) so the AcroForm, outlines,
 * and catalog metadata survive.
 *
 * Page rotation is baked into each page's /Rotate entry as an absolute angle,
 * matching how the model initialises `page.rotation` from `page.rotate` at load
 * and how the viewer passes it to pdf.js `getViewport({ rotation })`.
 */
import {
  PDFDocument as PDFLib,
  PDFPage,
  PDFPageLeaf,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFNumber,
  PDFStream,
  PDFString,
  PDFHexString,
  PDFObject,
  PDFContext,
  PDFObjectCopier,
  degrees,
} from 'pdf-lib';
import { removeUnreachableObjects } from './pdfObjectGraph';

// pdfData held in memory is always decrypted plaintext (decrypt-at-open), but load
// with ignoreEncryption for parity with replacePage and robustness against any
// residual encryption dict.
async function load(pdfData: Uint8Array): Promise<PDFLib> {
  return PDFLib.load(pdfData, { ignoreEncryption: true });
}

/**
 * The ONLY way this module serialises a document. pdf-lib's writer emits every
 * object in the context whether reachable or not, so a page dropped with
 * removePage (delete, replace, the order rebuild) would otherwise ship its page
 * dictionary, content streams and images in the saved file, recoverable by any
 * repair tool. Pending embeds are flushed first so nothing reserved-but-unwritten
 * is judged before it exists; then everything the trailer cannot reach is
 * deleted. Every page op routes through here so a new one cannot forget the GC;
 * pageStructureGc.test.ts fails if a bare `.save(` call appears in this file.
 */
async function saveWithoutOrphans(doc: PDFLib): Promise<Uint8Array> {
  await doc.flush();
  removeUnreachableObjects(doc);
  return new Uint8Array(await doc.save());
}

/** Remove the page at `zeroIndex`. Throws if it is the only page or out of range. */
export async function deletePdfPage(
  pdfData: Uint8Array,
  zeroIndex: number
): Promise<Uint8Array> {
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  if (count <= 1) throw new Error('Cannot delete the only page of a document');
  if (zeroIndex < 0 || zeroIndex >= count) {
    throw new Error(`deletePdfPage: index ${zeroIndex} out of range (0..${count - 1})`);
  }
  // Route through the order primitive so the page's form widgets leave the
  // field tree with it (a bare removePage left orphaned AcroForm fields).
  return applyPdfPageOrder(pdfData, orderWithout(count, [zeroIndex]));
}

/**
 * Insert a blank page of `width` x `height` (PDF points) immediately AFTER
 * `afterZeroIndex`. Pass `afterZeroIndex = -1` to insert at the very front.
 */
export async function insertBlankPdfPage(
  pdfData: Uint8Array,
  afterZeroIndex: number,
  width: number,
  height: number
): Promise<Uint8Array> {
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  const insertAt = Math.min(Math.max(afterZeroIndex + 1, 0), count);
  doc.insertPage(insertAt, [width, height]);
  return saveWithoutOrphans(doc);
}

/**
 * Move the page at `from` to `to`, using post-removal index semantics
 * identical to `array.splice(from, 1)` then `array.splice(to, 0, page)`.
 * The page (and its /Rotate, content, and widgets) travels with the move.
 */
export async function reorderPdfPage(
  pdfData: Uint8Array,
  from: number,
  to: number
): Promise<Uint8Array> {
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  if (from < 0 || from >= count) {
    throw new Error(`reorderPdfPage: from ${from} out of range (0..${count - 1})`);
  }
  if (to < 0 || to >= count) {
    throw new Error(`reorderPdfPage: to ${to} out of range (0..${count - 1})`);
  }
  if (from === to) return new Uint8Array(pdfData);
  const page = doc.getPage(from);
  pinInheritedAttributes(page);
  // The same page object is re-inserted, so this pair orphans nothing; the
  // save still goes through saveWithoutOrphans like every other op.
  doc.removePage(from);
  doc.insertPage(to, page);
  return saveWithoutOrphans(doc);
}

/**
 * Set the ABSOLUTE rotation of the page at `zeroIndex` (baked into /Rotate).
 * `absoluteAngle` is normalised to [0, 360); it must resolve to a multiple of 90.
 */
export async function setPdfPageRotation(
  pdfData: Uint8Array,
  zeroIndex: number,
  absoluteAngle: number
): Promise<Uint8Array> {
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  if (zeroIndex < 0 || zeroIndex >= count) {
    throw new Error(`setPdfPageRotation: index ${zeroIndex} out of range (0..${count - 1})`);
  }
  const norm = (((absoluteAngle % 360) + 360) % 360);
  if (norm % 90 !== 0) {
    throw new Error(`setPdfPageRotation: angle ${absoluteAngle} is not a multiple of 90`);
  }
  doc.getPage(zeroIndex).setRotation(degrees(norm));
  return saveWithoutOrphans(doc);
}

// ---------------------------------------------------------------------------
// Page tools (v2.14.11): order/duplicate/delete-many, crop, insert-from-PDF,
// replace. Same in-place contract as above: the loaded document is mutated and
// re-saved, so the catalog (AcroForm, outlines, metadata) survives.
// ---------------------------------------------------------------------------

/** A rectangle in PDF user space (origin bottom-left, points). */
export interface PdfBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * The page geometry the renderer's page model is built from. It matches what
 * pdf.js reports for `page.getViewport({ scale: 1 })`: the visible box is
 * CropBox ∩ MediaBox, and width/height are swapped for 90/270° pages.
 */
export interface PageGeometry {
  width: number;
  height: number;
  rotation: number;
  /** Visible box (CropBox ∩ MediaBox) in user space. */
  box: PdfBox;
  /** MediaBox in user space. */
  mediaBox: PdfBox;
}

/**
 * Crop margins in points, measured inward from the MediaBox edges as the page
 * is DISPLAYED (after its /Rotate is applied), so "top" is always the top edge
 * the user sees.
 */
export interface CropMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Smallest visible box (points per side) a crop may produce. */
export const MIN_CROP_SIZE = 10;

/** Thrown when a page source cannot be used because it is encrypted. */
export class EncryptedSourceError extends Error {
  constructor(message = 'The selected PDF is password-protected. Open it, remove its password, save it, then try again.') {
    super(message);
    this.name = 'EncryptedSourceError';
  }
}

const N = {
  Annots: PDFName.of('Annots'),
  AcroForm: PDFName.of('AcroForm'),
  Contents: PDFName.of('Contents'),
  DA: PDFName.of('DA'),
  DR: PDFName.of('DR'),
  Fields: PDFName.of('Fields'),
  Font: PDFName.of('Font'),
  FT: PDFName.of('FT'),
  IRT: PDFName.of('IRT'),
  Kids: PDFName.of('Kids'),
  NM: PDFName.of('NM'),
  P: PDFName.of('P'),
  Parent: PDFName.of('Parent'),
  Popup: PDFName.of('Popup'),
  Subtype: PDFName.of('Subtype'),
  T: PDFName.of('T'),
  Widget: PDFName.of('Widget'),
  Sig: PDFName.of('Sig'),
};

// Keys that belong to the FIELD (not the widget annotation) of a merged
// field/widget dictionary (ISO 32000-1 §12.7.3.1, §12.7.3.3, §12.7.4).
const FIELD_ONLY_KEYS = ['FT', 'T', 'TU', 'TM', 'Ff', 'V', 'DV', 'Opt', 'TI', 'I', 'MaxLen', 'Lock', 'SV', 'RV', 'DS'];

type Rect = [number, number, number, number];

function rectFromArray(arr: PDFArray | undefined): Rect | null {
  if (!arr || arr.size() < 4) return null;
  const nums: number[] = [];
  for (let i = 0; i < 4; i++) {
    const v = arr.lookup(i);
    if (!(v instanceof PDFNumber)) return null;
    nums.push(v.asNumber());
  }
  const [a, b, c, d] = nums;
  const x1 = Math.min(a, c);
  const x2 = Math.max(a, c);
  const y1 = Math.min(b, d);
  const y2 = Math.max(b, d);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;
  return [x1, y1, x2, y2];
}

function toBox([x1, y1, x2, y2]: Rect): PdfBox {
  return { x: x1, y: y1, width: x2 - x1, height: y2 - y1 };
}

function inheritedRect(page: PDFPage, key: 'MediaBox' | 'CropBox'): Rect | null {
  const raw = page.node.getInheritableAttribute(PDFName.of(key));
  const arr = raw instanceof PDFRef ? page.doc.context.lookup(raw) : raw;
  return arr instanceof PDFArray ? rectFromArray(arr) : null;
}

/** MediaBox, normalised. Falls back to US Letter exactly as pdf.js does. */
function mediaRect(page: PDFPage): Rect {
  return inheritedRect(page, 'MediaBox') ?? [0, 0, 612, 792];
}

/** Visible box with pdf.js semantics: CropBox ∩ MediaBox, else MediaBox. */
function visibleRect(page: PDFPage): Rect {
  const media = mediaRect(page);
  const crop = inheritedRect(page, 'CropBox');
  if (crop) {
    const x1 = Math.max(crop[0], media[0]);
    const y1 = Math.max(crop[1], media[1]);
    const x2 = Math.min(crop[2], media[2]);
    const y2 = Math.min(crop[3], media[3]);
    if (x2 - x1 > 0 && y2 - y1 > 0) return [x1, y1, x2, y2];
  }
  return media;
}

/** Visible box (CropBox ∩ MediaBox) of a pdf-lib page, in user space. */
export function visiblePageBox(page: PDFPage): PdfBox {
  return toBox(visibleRect(page));
}

/** Geometry for the renderer's page model (see PageGeometry). */
export function pageGeometry(page: PDFPage): PageGeometry {
  const rotation = (((page.getRotation().angle % 360) + 360) % 360);
  const box = visiblePageBox(page);
  const swap = rotation % 180 === 90;
  return {
    width: swap ? box.height : box.width,
    height: swap ? box.width : box.height,
    rotation,
    box,
    mediaBox: toBox(mediaRect(page)),
  };
}

function normAngle(rotation: number): number {
  return (((rotation % 360) + 360) % 360);
}

/**
 * Convert displayed-page margins into a user-space box inside `media`.
 * Display orientation follows pdf.js: a 90° page shows the user-space left
 * edge at the top, 180° shows the bottom edge at the top, 270° the right edge.
 */
export function marginsToUserBox(media: PdfBox, rotation: number, m: CropMargins): PdfBox {
  const x1 = media.x;
  const y1 = media.y;
  const x2 = media.x + media.width;
  const y2 = media.y + media.height;
  let left: number;
  let right: number;
  let bottom: number;
  let top: number;
  switch (normAngle(rotation)) {
    case 90:
      left = x1 + m.top; right = x2 - m.bottom; bottom = y1 + m.left; top = y2 - m.right;
      break;
    case 180:
      left = x1 + m.right; right = x2 - m.left; bottom = y1 + m.top; top = y2 - m.bottom;
      break;
    case 270:
      left = x1 + m.bottom; right = x2 - m.top; bottom = y1 + m.right; top = y2 - m.left;
      break;
    default:
      left = x1 + m.left; right = x2 - m.right; bottom = y1 + m.bottom; top = y2 - m.top;
  }
  return { x: left, y: bottom, width: right - left, height: top - bottom };
}

/** Inverse of marginsToUserBox: the displayed margins of `box` inside `media`. */
export function userBoxToMargins(media: PdfBox, rotation: number, box: PdfBox): CropMargins {
  const dl = box.x - media.x;
  const db = box.y - media.y;
  const dr = media.x + media.width - (box.x + box.width);
  const dt = media.y + media.height - (box.y + box.height);
  switch (normAngle(rotation)) {
    case 90:
      return { top: dl, bottom: dr, left: db, right: dt };
    case 180:
      return { right: dl, left: dr, top: db, bottom: dt };
    case 270:
      return { bottom: dl, top: dr, right: db, left: dt };
    default:
      return { left: dl, right: dr, bottom: db, top: dt };
  }
}

/**
 * Push inherited /Resources /MediaBox /CropBox /Rotate onto the leaf. pdf-lib's
 * remove/insert re-parents a page, and a page that relied on an intermediate
 * /Pages node for those attributes would otherwise change size or lose its
 * fonts when moved (pdf-lib's own copyPages does the same pinning).
 */
function pinInheritedAttributes(page: PDFPage): void {
  for (const key of PDFPageLeaf.InheritableEntries) {
    const name = PDFName.of(key);
    if (page.node.get(name)) continue;
    const value = page.node.getInheritableAttribute(name);
    if (value) page.node.set(name, value);
  }
}

function lookupDict(context: PDFContext, obj: PDFObject | undefined): PDFDict | undefined {
  if (!obj) return undefined;
  const resolved = obj instanceof PDFRef ? context.lookup(obj) : obj;
  return resolved instanceof PDFDict ? resolved : undefined;
}

function lookupArray(context: PDFContext, obj: PDFObject | undefined): PDFArray | undefined {
  if (!obj) return undefined;
  const resolved = obj instanceof PDFRef ? context.lookup(obj) : obj;
  return resolved instanceof PDFArray ? resolved : undefined;
}

function acroFormFields(doc: PDFLib, create: boolean): PDFArray | undefined {
  const { context, catalog } = doc;
  let acroForm = lookupDict(context, catalog.get(N.AcroForm));
  if (!acroForm) {
    if (!create) return undefined;
    acroForm = context.obj({});
    catalog.set(N.AcroForm, context.register(acroForm));
  }
  let fields = lookupArray(context, acroForm.get(N.Fields));
  if (!fields) {
    if (!create) return undefined;
    fields = context.obj([]);
    acroForm.set(N.Fields, fields);
  }
  return fields;
}

function indexOfRef(arr: PDFArray, ref: PDFRef): number {
  for (let i = 0; i < arr.size(); i++) {
    const v = arr.get(i);
    if (v instanceof PDFRef && v.tag === ref.tag) return i;
  }
  return -1;
}

function isWidget(dict: PDFDict): boolean {
  return dict.get(N.Subtype) === N.Widget;
}

/** Resolve the (possibly inherited) /FT of a field or widget. */
function fieldType(context: PDFContext, dict: PDFDict): PDFName | undefined {
  let node: PDFDict | undefined = dict;
  for (let depth = 0; node && depth < 32; depth++) {
    const ft = node.get(N.FT);
    if (ft instanceof PDFName) return ft;
    node = lookupDict(context, node.get(N.Parent));
  }
  return undefined;
}

/**
 * Give a duplicated page its own copy of `widget`, LINKED to the same field
 * (same name, same value), which is how one field appears on several pages.
 * A merged field/widget dictionary is first split into a field with /Kids.
 * Signature widgets are not duplicated: a signature covers one location.
 */
function duplicateWidget(
  doc: PDFLib,
  widget: PDFDict,
  widgetRef: PDFRef,
  newPageRef: PDFRef
): PDFRef | undefined {
  const { context } = doc;
  if (fieldType(context, widget) === N.Sig) return undefined;

  const clone = widget.clone(context);
  clone.set(N.P, newPageRef);
  clone.delete(N.NM);

  if (widget.get(N.T)) {
    // Merged terminal field + widget: split into a field node with two kids.
    const field = context.obj({});
    for (const key of FIELD_ONLY_KEYS) {
      const name = PDFName.of(key);
      const value = widget.get(name);
      if (value !== undefined) {
        field.set(name, value);
        widget.delete(name);
        clone.delete(name);
      }
    }
    // Variable-text defaults stay readable from the field and its widgets.
    for (const key of ['DA', 'Q']) {
      const value = widget.get(PDFName.of(key));
      if (value !== undefined) field.set(PDFName.of(key), value);
    }
    const oldParent = widget.get(N.Parent);
    const fieldRef = context.register(field);
    const cloneRef = context.register(clone);
    field.set(N.Kids, context.obj([widgetRef, cloneRef]));
    widget.set(N.Parent, fieldRef);
    clone.set(N.Parent, fieldRef);

    // Put the new field node where the merged dictionary used to be.
    let container: PDFArray | undefined;
    if (oldParent instanceof PDFRef) {
      field.set(N.Parent, oldParent);
      container = lookupArray(context, lookupDict(context, oldParent)?.get(N.Kids));
    } else {
      container = acroFormFields(doc, false);
    }
    if (container) {
      const at = indexOfRef(container, widgetRef);
      if (at >= 0) container.set(at, fieldRef);
    }
    return cloneRef;
  }

  const parentRef = widget.get(N.Parent);
  const cloneRef = context.register(clone);
  if (parentRef instanceof PDFRef) {
    const kids = lookupArray(context, lookupDict(context, parentRef)?.get(N.Kids));
    if (kids) kids.push(cloneRef);
  }
  return cloneRef;
}

function cloneContents(context: PDFContext, contents: PDFObject): PDFObject {
  const resolved = contents instanceof PDFRef ? context.lookup(contents) : contents;
  if (resolved instanceof PDFStream) return context.register(resolved.clone(context));
  if (resolved instanceof PDFArray) {
    const out = context.obj([]);
    for (let i = 0; i < resolved.size(); i++) {
      const s = resolved.lookup(i);
      if (s instanceof PDFStream) out.push(context.register(s.clone(context)));
    }
    return out;
  }
  return contents;
}

/**
 * Clone a page inside its own document. Content streams are deep-copied so the
 * save pipeline's per-page content edits (text replace/blank, appended
 * annotations) cannot leak between the original and the copy; resources are
 * shared by reference (the pipeline only ever adds entries to them).
 * Annotations are copied with /P re-pointed, popup/reply links between copied
 * annotations are remapped, and form widgets are linked to their field.
 */
function clonePageWithinDocument(doc: PDFLib, source: PDFPage): PDFPage {
  const { context } = doc;
  pinInheritedAttributes(source);
  const leaf = source.node.clone(context);
  const contents = source.node.get(N.Contents);
  if (contents) leaf.set(N.Contents, cloneContents(context, contents));
  leaf.delete(N.Annots);
  const ref = context.register(leaf);

  const annots = lookupArray(context, source.node.get(N.Annots));
  if (annots) {
    const newRefs: PDFRef[] = [];
    const remap = new Map<string, PDFRef>();
    const markupClones: PDFDict[] = [];
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = lookupDict(context, raw);
      if (!dict) continue;
      if (isWidget(dict)) {
        if (raw instanceof PDFRef) {
          const w = duplicateWidget(doc, dict, raw, ref);
          if (w) newRefs.push(w);
        }
        continue;
      }
      const clone = dict.clone(context);
      clone.set(N.P, ref);
      clone.delete(N.NM);
      const cloneRef = context.register(clone);
      if (raw instanceof PDFRef) remap.set(raw.tag, cloneRef);
      markupClones.push(clone);
      newRefs.push(cloneRef);
    }
    for (const clone of markupClones) {
      for (const key of [N.Popup, N.Parent, N.IRT]) {
        const v = clone.get(key);
        const mapped = v instanceof PDFRef ? remap.get(v.tag) : undefined;
        if (mapped) clone.set(key, mapped);
      }
    }
    if (newRefs.length > 0) leaf.set(N.Annots, context.obj(newRefs));
  }
  return PDFPage.of(leaf, ref, doc);
}

/** Remove a field node from its parent's /Kids (or /AcroForm /Fields), pruning emptied parents. */
function detachFieldNode(doc: PDFLib, nodeRef: PDFRef, node: PDFDict, depth = 0): void {
  if (depth > 32) return;
  const { context } = doc;
  const parentRef = node.get(N.Parent);
  const parent = parentRef instanceof PDFRef ? lookupDict(context, parentRef) : undefined;
  const container = parent ? lookupArray(context, parent.get(N.Kids)) : acroFormFields(doc, false);
  if (!container) return;
  const at = indexOfRef(container, nodeRef);
  if (at >= 0) container.remove(at);
  if (parent && parentRef instanceof PDFRef && container.size() === 0) {
    detachFieldNode(doc, parentRef, parent, depth + 1);
  }
}

/**
 * Deleting a page must also take its form widgets out of the field tree,
 * otherwise the AcroForm keeps fields that no page shows (other readers list
 * them, flatten them, or fail validation on them).
 */
function detachWidgetsOfPage(doc: PDFLib, page: PDFPage): void {
  const { context } = doc;
  const annots = lookupArray(context, page.node.get(N.Annots));
  if (!annots) return;
  for (let i = 0; i < annots.size(); i++) {
    const raw = annots.get(i);
    const dict = lookupDict(context, raw);
    if (!dict || !isWidget(dict) || !(raw instanceof PDFRef)) continue;
    if (dict.get(N.T)) {
      detachFieldNode(doc, raw, dict);
      continue;
    }
    const parentRef = dict.get(N.Parent);
    if (!(parentRef instanceof PDFRef)) continue;
    const parent = lookupDict(context, parentRef);
    const kids = parent ? lookupArray(context, parent.get(N.Kids)) : undefined;
    if (!parent || !kids) continue;
    const at = indexOfRef(kids, raw);
    if (at >= 0) kids.remove(at);
    if (kids.size() === 0) detachFieldNode(doc, parentRef, parent);
  }
}

/**
 * Validate a page order: every entry an integer source index in range, and at
 * least one page in the result. Repeats are duplicates; omissions are deletions.
 */
export function assertValidPageOrder(order: number[], count: number): void {
  if (order.length === 0) throw new Error('A document must keep at least one page');
  for (const src of order) {
    if (!Number.isInteger(src) || src < 0 || src >= count) {
      throw new Error(`Page order entry ${src} out of range (0..${count - 1})`);
    }
  }
}

/**
 * Rebuild the page sequence as `order` (source indices). The first occurrence
 * of a source index moves the original page; later occurrences are clones.
 * Pages absent from `order` are deleted, together with their form widgets.
 */
export async function applyPdfPageOrder(pdfData: Uint8Array, order: number[]): Promise<Uint8Array> {
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  assertValidPageOrder(order, count);
  const pages = doc.getPages();
  pages.forEach(pinInheritedAttributes);

  const kept = new Set(order);
  pages.forEach((p, i) => { if (!kept.has(i)) detachWidgetsOfPage(doc, p); });

  const used = new Set<number>();
  const sequence = order.map((src) => {
    if (!used.has(src)) {
      used.add(src);
      return pages[src];
    }
    return clonePageWithinDocument(doc, pages[src]);
  });

  for (let i = count - 1; i >= 0; i--) doc.removePage(i);
  sequence.forEach((p, i) => doc.insertPage(i, p));
  return saveWithoutOrphans(doc);
}

/** Order that removes `zeroIndices`. Throws if that would remove every page. */
export function orderWithout(count: number, zeroIndices: number[]): number[] {
  const drop = new Set(zeroIndices);
  const order = Array.from({ length: count }, (_, i) => i).filter((i) => !drop.has(i));
  if (order.length === 0) throw new Error('Cannot delete every page of a document');
  return order;
}

/** Order that places a copy of each listed page directly after its original. */
export function orderWithDuplicates(count: number, zeroIndices: number[]): number[] {
  const dup = new Set(zeroIndices);
  const order: number[] = [];
  for (let i = 0; i < count; i++) {
    order.push(i);
    if (dup.has(i)) order.push(i);
  }
  return order;
}

/**
 * Order that moves the listed pages (kept in document order) into the gap
 * `beforeIndex`, measured in the ORIGINAL numbering: 0 is the front, `count`
 * is the end, and k is the gap just before page k.
 */
export function orderWithMove(count: number, zeroIndices: number[], beforeIndex: number): number[] {
  const moving = [...new Set(zeroIndices)].filter((i) => i >= 0 && i < count).sort((a, b) => a - b);
  const set = new Set(moving);
  const gap = Math.min(Math.max(beforeIndex, 0), count);
  const rest = Array.from({ length: count }, (_, i) => i).filter((i) => !set.has(i));
  const insertAt = rest.filter((i) => i < gap).length;
  return [...rest.slice(0, insertAt), ...moving, ...rest.slice(insertAt)];
}

async function pageCountOf(pdfData: Uint8Array): Promise<number> {
  return (await load(pdfData)).getPageCount();
}

/** Delete several pages at once (and their form widgets). */
export async function deletePdfPages(pdfData: Uint8Array, zeroIndices: number[]): Promise<Uint8Array> {
  return applyPdfPageOrder(pdfData, orderWithout(await pageCountOf(pdfData), zeroIndices));
}

/** Duplicate pages; each copy lands directly after its original. */
export async function duplicatePdfPages(pdfData: Uint8Array, zeroIndices: number[]): Promise<Uint8Array> {
  return applyPdfPageOrder(pdfData, orderWithDuplicates(await pageCountOf(pdfData), zeroIndices));
}

/** Move a set of pages into a gap (see orderWithMove). */
export async function movePdfPages(
  pdfData: Uint8Array,
  zeroIndices: number[],
  beforeIndex: number
): Promise<Uint8Array> {
  return applyPdfPageOrder(pdfData, orderWithMove(await pageCountOf(pdfData), zeroIndices, beforeIndex));
}

/** Rotate several pages by `delta` (a multiple of 90) relative to their current /Rotate. */
export async function rotatePdfPages(
  pdfData: Uint8Array,
  zeroIndices: number[],
  delta: number
): Promise<Uint8Array> {
  if (!Number.isFinite(delta) || delta % 90 !== 0) {
    throw new Error(`rotatePdfPages: delta ${delta} is not a multiple of 90`);
  }
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  const targets = [...new Set(zeroIndices)];
  for (const i of targets) {
    if (!Number.isInteger(i) || i < 0 || i >= count) {
      throw new Error(`rotatePdfPages: index ${i} out of range (0..${count - 1})`);
    }
  }
  for (const i of targets) {
    const page = doc.getPage(i);
    page.setRotation(degrees(normAngle(page.getRotation().angle + delta)));
  }
  return saveWithoutOrphans(doc);
}

/** Read the geometry of every page (the renderer page model's source of truth). */
export async function readPageGeometries(pdfData: Uint8Array): Promise<PageGeometry[]> {
  const doc = await load(pdfData);
  return doc.getPages().map(pageGeometry);
}

/**
 * Set the CropBox of each listed page from displayed-page margins measured off
 * its MediaBox (the MediaBox is never changed). `margins === null` resets the
 * crop to the full MediaBox. Throws, changing nothing, if any page would be
 * left smaller than MIN_CROP_SIZE on a side.
 */
export async function setPdfPageCrop(
  pdfData: Uint8Array,
  zeroIndices: number[],
  margins: CropMargins | null
): Promise<Uint8Array> {
  if (margins) {
    for (const [k, v] of Object.entries(margins)) {
      if (!Number.isFinite(v) || v < 0) throw new Error(`Crop margin "${k}" must be a number of points ≥ 0`);
    }
  }
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  const targets = [...new Set(zeroIndices)];
  if (targets.length === 0) throw new Error('No pages selected to crop');
  const boxes: Array<[PDFPage, PdfBox]> = [];
  for (const i of targets) {
    if (!Number.isInteger(i) || i < 0 || i >= count) {
      throw new Error(`setPdfPageCrop: index ${i} out of range (0..${count - 1})`);
    }
    const page = doc.getPage(i);
    const geo = pageGeometry(page);
    const box = margins ? marginsToUserBox(geo.mediaBox, geo.rotation, margins) : geo.mediaBox;
    if (box.width < MIN_CROP_SIZE || box.height < MIN_CROP_SIZE) {
      throw new Error(
        `Crop would leave page ${i + 1} only ${Math.max(0, Math.round(box.width))} × ${Math.max(0, Math.round(box.height))} pt; ` +
        `each side must be at least ${MIN_CROP_SIZE} pt`
      );
    }
    boxes.push([page, box]);
  }
  for (const [page, box] of boxes) page.setCropBox(box.x, box.y, box.width, box.height);
  return saveWithoutOrphans(doc);
}

/** Load a page source (another PDF) for copying, refusing encrypted input. */
async function loadSource(sourceBytes: Uint8Array): Promise<PDFLib> {
  let source: PDFLib;
  try {
    source = await PDFLib.load(sourceBytes, { ignoreEncryption: true });
  } catch (e) {
    throw new Error(`The selected file is not a readable PDF (${(e as Error).message})`);
  }
  if (source.isEncrypted) throw new EncryptedSourceError();
  if (source.getPageCount() === 0) throw new Error('The selected PDF has no pages');
  return source;
}

function decodeName(obj: PDFObject | undefined): string | undefined {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  return undefined;
}

/**
 * Register the form fields carried by freshly copied pages in the target's
 * AcroForm. copyPages copies widgets and their /Parent chains but not the
 * source AcroForm, so without this the fields render but are invisible to the
 * form model (values never save, other readers ignore them). Top-level names
 * that collide with existing fields get a numeric suffix so the two forms stay
 * independent; the source /DR fonts and default /DA come along so the copied
 * widgets can still regenerate their appearances.
 */
function adoptCopiedFields(target: PDFLib, source: PDFLib, copied: PDFPage[]): void {
  const { context } = target;
  const tops = new Map<string, PDFRef>();
  for (const page of copied) {
    const annots = lookupArray(context, page.node.get(N.Annots));
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const raw = annots.get(i);
      const dict = lookupDict(context, raw);
      if (!dict || !isWidget(dict) || !(raw instanceof PDFRef)) continue;
      let ref: PDFRef = raw;
      let node: PDFDict = dict;
      for (let depth = 0; depth < 32; depth++) {
        const parentRef = node.get(N.Parent);
        if (!(parentRef instanceof PDFRef)) break;
        const parent = lookupDict(context, parentRef);
        if (!parent) break;
        ref = parentRef;
        node = parent;
      }
      // A widget with no field anywhere up its chain is not a form field.
      if (!node.get(N.T) && !node.get(N.FT)) continue;
      tops.set(ref.tag, ref);
    }
  }
  if (tops.size === 0) return;

  const fields = acroFormFields(target, true)!;
  const targetAcro = lookupDict(context, target.catalog.get(N.AcroForm))!;
  const taken = new Set<string>();
  for (let i = 0; i < fields.size(); i++) {
    const name = decodeName(lookupDict(context, fields.get(i))?.get(N.T));
    if (name !== undefined) taken.add(name);
  }

  const srcAcro = lookupDict(source.context, source.catalog.get(N.AcroForm));
  const srcDA = srcAcro?.get(N.DA);

  for (const ref of tops.values()) {
    if (indexOfRef(fields, ref) >= 0) continue;
    const node = lookupDict(context, ref)!;
    const name = decodeName(node.get(N.T));
    if (name !== undefined && taken.has(name)) {
      let n = 2;
      while (taken.has(`${name}_${n}`)) n++;
      node.set(N.T, PDFHexString.fromText(`${name}_${n}`));
      taken.add(`${name}_${n}`);
    } else if (name !== undefined) {
      taken.add(name);
    }
    if (srcDA && !node.get(N.DA)) node.set(N.DA, srcDA.clone(context));
    fields.push(ref);
  }

  // Merge default-resource fonts that the copied widgets' /DA strings may name.
  const srcDR = lookupDict(source.context, srcAcro?.get(N.DR));
  const srcFonts = lookupDict(source.context, srcDR?.get(N.Font));
  if (srcFonts) {
    let dr = lookupDict(context, targetAcro.get(N.DR));
    if (!dr) {
      dr = context.obj({});
      targetAcro.set(N.DR, dr);
    }
    let fonts = lookupDict(context, dr.get(N.Font));
    if (!fonts) {
      fonts = context.obj({});
      dr.set(N.Font, fonts);
    }
    const copier = PDFObjectCopier.for(source.context, context);
    for (const [key, value] of srcFonts.entries()) {
      if (!fonts.get(key)) fonts.set(key, copier.copy(value));
    }
  }
}

/**
 * Insert every page of `sourceBytes` (a plaintext PDF) at `atIndex` (0..count).
 * Returns the new bytes and the geometry of the inserted pages, in order.
 * Throws EncryptedSourceError for an encrypted source.
 */
export async function insertPdfPages(
  pdfData: Uint8Array,
  atIndex: number,
  sourceBytes: Uint8Array
): Promise<{ bytes: Uint8Array; inserted: PageGeometry[] }> {
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  if (!Number.isInteger(atIndex) || atIndex < 0 || atIndex > count) {
    throw new Error(`insertPdfPages: index ${atIndex} out of range (0..${count})`);
  }
  const source = await loadSource(sourceBytes);
  const copied = await doc.copyPages(source, source.getPageIndices());
  copied.forEach((p, k) => doc.insertPage(atIndex + k, p));
  adoptCopiedFields(doc, source, copied);
  const inserted = copied.map(pageGeometry);
  return { bytes: await saveWithoutOrphans(doc), inserted };
}

/**
 * Replace the page at `zeroIndex` with the first page of `sourceBytes`, scaled
 * to the original page's MediaBox (scans rarely match the original size).
 * Returns the new bytes and the replacement page's geometry.
 */
export async function replacePdfPage(
  pdfData: Uint8Array,
  zeroIndex: number,
  sourceBytes: Uint8Array
): Promise<{ bytes: Uint8Array; geometry: PageGeometry }> {
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  if (!Number.isInteger(zeroIndex) || zeroIndex < 0 || zeroIndex >= count) {
    throw new Error(`replacePdfPage: index ${zeroIndex} out of range (0..${count - 1})`);
  }
  const source = await loadSource(sourceBytes);
  const original = doc.getPage(zeroIndex);
  const originalSize = original.getSize();
  const [copiedPage] = await doc.copyPages(source, [0]);
  const replacementSize = copiedPage.getSize();
  const scaleX = originalSize.width / replacementSize.width;
  const scaleY = originalSize.height / replacementSize.height;
  if (Math.abs(scaleX - 1) > 0.01 || Math.abs(scaleY - 1) > 0.01) {
    copiedPage.setSize(originalSize.width, originalSize.height);
    copiedPage.scaleContent(scaleX, scaleY);
    // A source CropBox is in the old coordinate space; show the whole
    // rescaled page instead of a stale window into it.
    copiedPage.setCropBox(0, 0, originalSize.width, originalSize.height);
  }
  detachWidgetsOfPage(doc, original);
  doc.removePage(zeroIndex);
  doc.insertPage(zeroIndex, copiedPage);
  adoptCopiedFields(doc, source, [copiedPage]);
  return { bytes: await saveWithoutOrphans(doc), geometry: pageGeometry(copiedPage) };
}
