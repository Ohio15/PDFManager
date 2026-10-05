/**
 * Page-model counterparts of the byte-level ops in pageStructure.ts.
 *
 * The renderer's PDFPage[] must change in lockstep with pdfData (model page
 * index === physical page index). Every function here is pure: given the old
 * model and the same plan the bytes were rebuilt from, it returns the new
 * model, reindexed so `pages[i].index === i`.
 */
import type { Annotation, PDFPage, PDFSourceAnnotation, PDFTextItem, TextEdit } from '../types';
import type { PageGeometry, PdfBox } from './pageStructure';

let copySerial = 0;

/** Unique suffix for ids of copied model objects (annotations, text items). */
function nextCopySuffix(): string {
  copySerial += 1;
  return `copy${Date.now().toString(36)}${copySerial}`;
}

/**
 * Deep-enough copy of a page model for a duplicated page. Ids are re-minted so
 * that selection, editing state and React keys never alias the original, and
 * text edits are re-pointed at the copied text items.
 */
export function clonePageModel(page: PDFPage, suffix: string = nextCopySuffix()): PDFPage {
  const itemId = (id: string) => `${id}-${suffix}`;
  const textItems: PDFTextItem[] | undefined = page.textItems?.map((t) => ({
    ...t,
    id: itemId(t.id),
    transform: [...t.transform],
    parentTransform: t.parentTransform ? [...t.parentTransform] : undefined,
  }));
  const textEdits: TextEdit[] | undefined = page.textEdits?.map((e) => ({ ...e, itemId: itemId(e.itemId) }));
  const annotations: Annotation[] = page.annotations.map(
    (a) => ({ ...structuredClone(a), id: `${a.id}-${suffix}` }) as Annotation
  );
  const sourceAnnotations: PDFSourceAnnotation[] | undefined = page.sourceAnnotations?.map((s) => ({
    ...s,
    id: `${s.id}-${suffix}`,
    rect: { ...s.rect },
  }));
  return { ...page, annotations, textItems, textEdits, sourceAnnotations };
}

/**
 * Apply a source-index order to the model (see applyPdfPageOrder): the first
 * occurrence of a source keeps the page, later occurrences become copies, and
 * omitted sources are dropped.
 */
export function reorderPageModel(pages: PDFPage[], order: number[]): PDFPage[] {
  const seen = new Set<number>();
  return order.map((src, i) => {
    const page = pages[src];
    if (!page) throw new Error(`reorderPageModel: no page at ${src}`);
    const out = seen.has(src) ? clonePageModel(page) : page;
    seen.add(src);
    return { ...out, index: i };
  });
}

/** Model for a page whose content the app has not extracted (inserted/replaced). */
export function pageModelFromGeometry(geo: PageGeometry, index: number): PDFPage {
  return {
    index,
    width: geo.width,
    height: geo.height,
    rotation: geo.rotation,
    annotations: [],
    textItems: [],
    textEdits: [],
    sourceAnnotations: [],
  };
}

/** Model after rotating by `delta` (multiple of 90): odd quarter turns swap the displayed size. */
export function rotatePageModel(page: PDFPage, delta: number): PDFPage {
  const rotation = (((page.rotation + delta) % 360) + 360) % 360;
  const swap = Math.abs(delta) % 180 === 90;
  return {
    ...page,
    rotation,
    width: swap ? page.height : page.width,
    height: swap ? page.width : page.height,
  };
}

function shiftPoint<T extends { x: number; y: number }>(p: T, dx: number, dy: number): T {
  return { ...p, x: p.x - dx, y: p.y + dy };
}

function shiftAnnotation(a: Annotation, dx: number, dy: number): Annotation {
  switch (a.type) {
    case 'highlight':
      return { ...a, rects: a.rects.map((r) => shiftPoint(r, dx, dy)) };
    case 'drawing':
      return { ...a, paths: a.paths.map((path) => ({ ...path, points: path.points.map((pt) => shiftPoint(pt, dx, dy)) })) };
    default:
      return { ...a, position: shiftPoint(a.position, dx, dy) } as Annotation;
  }
}

/**
 * Model after the visible box changed from `before` to `after` (user space).
 * Model coordinates are measured from the visible box's top-left, so
 * everything the user placed is translated to stay over the same content,
 * and the page takes the new displayed size.
 */
export function cropPageModel(page: PDFPage, before: PdfBox, after: PageGeometry): PDFPage {
  const dx = after.box.x - before.x;
  const dy = (after.box.y + after.box.height) - (before.y + before.height);
  return {
    ...page,
    width: after.width,
    height: after.height,
    rotation: after.rotation,
    annotations: page.annotations.map((a) => shiftAnnotation(a, dx, dy)),
    textItems: page.textItems?.map((t) => shiftPoint(t, dx, dy)),
    sourceAnnotations: page.sourceAnnotations?.map((s) => ({ ...s, rect: shiftPoint(s.rect, dx, dy) })),
  };
}

/** Distinct, in-range, ascending page indices. */
export function normalizeIndices(indices: number[], count: number): number[] {
  return [...new Set(indices)]
    .filter((i) => Number.isInteger(i) && i >= 0 && i < count)
    .sort((a, b) => a - b);
}

/** Indices in a source-index order that are copies (a repeat of the previous slot). */
export function copyPositions(order: number[]): number[] {
  const seen = new Set<number>();
  const out: number[] = [];
  order.forEach((src, i) => {
    if (seen.has(src)) out.push(i);
    seen.add(src);
  });
  return out;
}

/** Where the listed sources ended up in a source-index order (first occurrence). */
export function positionsOf(order: number[], sources: number[]): number[] {
  const want = new Set(sources);
  const out: number[] = [];
  const seen = new Set<number>();
  order.forEach((src, i) => {
    if (want.has(src) && !seen.has(src)) out.push(i);
    seen.add(src);
  });
  return out;
}
