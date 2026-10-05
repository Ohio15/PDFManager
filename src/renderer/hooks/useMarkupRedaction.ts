/**
 * Markup + redaction operations for usePDFDocument.
 *
 * Kept in its own hook so the shared document hook only gains one call and a
 * few return-object entries. It uses the document hook's serialization
 * (runStructural), synchronous commit (commitDocument) and history.
 */
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import type {
  Annotation,
  PDFDocument,
  PDFPage,
  PDFTextItem,
  PdfRect,
  RedactionMarkAnnotation,
  TextMarkupAnnotation,
  TextMarkupType,
} from '../types';
import { PDFJS_DOCUMENT_OPTIONS } from '../utils/pdfjsConfig';
import { buildFormFieldMapping, FormFieldMapping } from '../utils/formFieldSaver';
import { buildFilledRectMap, buildTextColorMap, matchBackgroundColor, matchTextColor } from '../utils/textColorExtractor';
import { extractSourceAnnotations } from '../utils/annotationExtractor';
import { getTextHeight, mapToStandardFontName, measureTextWidth } from '../utils/standardFontMetrics';
import { applyRedactions, RedactionReport } from '../utils/redaction/redactionEngine';
import { PdfjsEnv, openPdfjs } from '../utils/redaction/pdfjsEnv';
import { findOccurrences, SearchOptions } from '../utils/redaction/textSearch';
import { intersects } from '../utils/redaction/geometry';

interface HistoryEntry {
  type: string;
  undo: () => void;
  redo: () => void;
}

interface Deps {
  stateRef: MutableRefObject<{ document: PDFDocument | null }>;
  runStructural: (op: () => Promise<void>) => Promise<void>;
  commitDocument: (doc: PDFDocument) => void;
  addToHistory: (entry: HistoryEntry) => void;
  setFormFieldMappings: (m: FormFieldMapping[]) => void;
}

export interface ApplyRedactionsRequest {
  fill: { r: number; g: number; b: number };
  stripMetadata: boolean;
}

export const pdfjsEnv: PdfjsEnv = {
  lib: pdfjsLib as unknown as PdfjsEnv['lib'],
  documentOptions: { ...PDFJS_DOCUMENT_OPTIONS },
};

/** JPEG re-encoding for redacted DCT images (keeps scans from ballooning into lossless Flate). */
const browserEncoder = {
  encodeJpeg: async (rgba: Uint8ClampedArray, width: number, height: number): Promise<Uint8Array> => {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');
    if (!ctx) throw new Error('2D canvas unavailable');
    ctx.putImageData(new ImageData(new Uint8ClampedArray(rgba), width, height), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    return new Uint8Array(await blob.arrayBuffer());
  },
};

let idCounter = 0;
const newId = (prefix: string) => `${prefix}-${Date.now()}-${idCounter++}`;

/** Approximate PDF-space bounds of an in-memory (unflattened) annotation; rotation-0 pages only. */
function annotationPdfBounds(a: Annotation, page: PDFPage): PdfRect | null {
  if (page.rotation % 360 !== 0) return null;
  const H = page.height;
  const fromTopLeft = (x: number, y: number, w: number, h: number): PdfRect => ({ x0: x, y0: H - y - h, x1: x + w, y1: H - y });
  switch (a.type) {
    case 'text':
      return fromTopLeft(a.position.x, a.position.y, a.size?.width ?? a.content.length * a.fontSize * 0.6, a.size?.height ?? a.fontSize * 1.4);
    case 'image':
    case 'shape':
    case 'stamp':
      return fromTopLeft(a.position.x, a.position.y, a.size.width, a.size.height);
    case 'note':
      return fromTopLeft(a.position.x, a.position.y, 24, 24);
    case 'highlight': {
      const xs = a.rects.flatMap((r) => [r.x, r.x + r.width]);
      const ys = a.rects.flatMap((r) => [r.y, r.y + r.height]);
      return xs.length ? fromTopLeft(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) : null;
    }
    case 'drawing': {
      const pts = a.paths.flatMap((p) => p.points);
      if (!pts.length) return null;
      const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
      return fromTopLeft(Math.min(...xs), Math.min(...ys), Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
    }
    case 'textMarkup': {
      const xs = a.quads.flatMap((q) => [q[0], q[2], q[4], q[6]]);
      const ys = a.quads.flatMap((q) => [q[1], q[3], q[5], q[7]]);
      return xs.length ? { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs), y1: Math.max(...ys) } : null;
    }
    default:
      return null;
  }
}

/**
 * Text items for one page, same algorithm as usePDFDocument.openFile.
 * DEBT: third copy of this extraction (openFile, reExtractTextAfterSave);
 * consolidating it means editing the shared hook, deferred to integration.
 */
async function extractTextItems(page: pdfjsLib.PDFPageProxy, i: number): Promise<PDFTextItem[]> {
  const viewport = page.getViewport({ scale: 1 });
  const [textContent, operatorList] = await Promise.all([
    page.getTextContent(),
    page.getOperatorList().catch(() => ({ fnArray: [], argsArray: [] })),
  ]);
  const textColorMap = buildTextColorMap(operatorList as never, viewport.height);
  const filledRectMap = buildFilledRectMap(operatorList as never, viewport.height);
  const items: PDFTextItem[] = [];
  let counter = 0;
  for (const raw of textContent.items as Array<{ str: string; transform: number[]; width: number; height: number; fontName: string }>) {
    if (!raw.str || !raw.str.trim()) continue;
    const t = raw.transform;
    const fontSize = Math.sqrt(t[0] * t[0] + t[1] * t[1]);
    const fontName = raw.fontName || 'default';
    const std = mapToStandardFontName(fontName);
    const height = raw.height || getTextHeight(std, fontSize);
    const y = viewport.height - t[5] - height;
    const full = measureTextWidth(raw.str, std, fontSize, false);
    const scale = full > 0 ? (raw.width || full) / full : 1;
    let x = t[4];
    for (const word of raw.str.split(/( +)/)) {
      if (!word) continue;
      const w = measureTextWidth(word, std, fontSize, false) * scale;
      if (word.trim()) {
        const c = matchTextColor(x, y, fontSize, textColorMap);
        const lower = fontName.toLowerCase();
        items.push({
          id: `text-item-${i}-${counter++}`,
          str: word,
          originalStr: word,
          x,
          y,
          width: w,
          height,
          fontName,
          fontSize,
          transform: [...t.slice(0, 4), x, t[5]],
          parentTransform: t,
          isEdited: false,
          backgroundColor: matchBackgroundColor(x, y, w, height, filledRectMap),
          textColor: { r: c.r, g: c.g, b: c.b },
          bold: lower.includes('bold'),
          italic: lower.includes('italic') || lower.includes('oblique'),
          colorSpace: c.originalSpace as PDFTextItem['colorSpace'],
          originalColorValues: c.originalValues,
        });
      }
      x += w;
    }
  }
  return items;
}

export function useMarkupRedaction({ stateRef, runStructural, commitDocument, addToHistory, setFormFieldMappings }: Deps) {
  const commitAnnotations = useCallback(
    (type: string, pageIndex1: number, mutate: (annotations: Annotation[]) => Annotation[]) => {
      const doc = stateRef.current.document;
      if (!doc) return;
      const zero = pageIndex1 - 1;
      if (zero < 0 || zero >= doc.pages.length) return;
      const prevDoc = doc;
      const pages = [...doc.pages];
      pages[zero] = { ...pages[zero], annotations: mutate(pages[zero].annotations) };
      const nextDoc: PDFDocument = { ...doc, pages };
      commitDocument(nextDoc);
      addToHistory({ type, undo: () => commitDocument(prevDoc), redo: () => commitDocument(nextDoc) });
    },
    [stateRef, commitDocument, addToHistory]
  );

  const addTextMarkup = useCallback(
    (pageIndex: number, markupType: TextMarkupType, quads: number[][], color: string, opacity: number, text?: string) => {
      if (quads.length === 0) return;
      const annotation: TextMarkupAnnotation = { id: newId('markup'), type: 'textMarkup', pageIndex, markupType, quads, color, opacity, text };
      commitAnnotations('addTextMarkup', pageIndex, (a) => [...a, annotation]);
    },
    [commitAnnotations]
  );

  const addRedactionMark = useCallback(
    (pageIndex: number, rects: PdfRect[], source: RedactionMarkAnnotation['source'], text?: string) => {
      const valid = rects.filter((r) => r.x1 - r.x0 > 0.5 && r.y1 - r.y0 > 0.5);
      if (!valid.length) return;
      const mark: RedactionMarkAnnotation = { id: newId('redact'), type: 'redaction', pageIndex, rects: valid, source, text };
      commitAnnotations('addRedactionMark', pageIndex, (a) => [...a, mark]);
    },
    [commitAnnotations]
  );

  /** Find every occurrence of `term` and mark them all (one undo step). Returns the count. */
  const markSearchResults = useCallback(
    async (term: string, options: SearchOptions): Promise<number> => {
      const doc = stateRef.current.document;
      if (!doc || !term.trim()) return 0;
      const proxy = await openPdfjs(pdfjsEnv, doc.pdfData);
      let found;
      try {
        found = await findOccurrences(proxy, pdfjsEnv, term, options);
      } finally {
        await proxy.destroy();
      }
      if (!found.length) return 0;
      const latest = stateRef.current.document;
      if (!latest) return 0;
      const group = { id: newId('search'), term, size: found.length };
      const pages = latest.pages.map((p) => ({ ...p }));
      for (const occ of found) {
        const page = pages[occ.pageIndex];
        if (!page) continue;
        const mark: RedactionMarkAnnotation = {
          id: newId('redact'),
          type: 'redaction',
          pageIndex: occ.pageIndex + 1,
          rects: occ.rects,
          source: 'search',
          text: occ.text,
          searchGroup: group,
        };
        page.annotations = [...page.annotations, mark];
      }
      const prevDoc = latest;
      const nextDoc: PDFDocument = { ...latest, pages };
      commitDocument(nextDoc);
      addToHistory({ type: 'markSearchResults', undo: () => commitDocument(prevDoc), redo: () => commitDocument(nextDoc) });
      return found.length;
    },
    [stateRef, commitDocument, addToHistory]
  );

  /**
   * Destructive: apply every pending redaction mark. Resolves with the report;
   * rejects (leaving the document untouched) when verification fails.
   */
  const applyRedactionMarks = useCallback(
    (request: ApplyRedactionsRequest): Promise<RedactionReport> =>
      new Promise<RedactionReport>((resolveReport, rejectReport) => {
        runStructural(async () => {
          try {
            const doc = stateRef.current.document;
            if (!doc) throw new Error('No document open');
            const marks: RedactionMarkAnnotation[] = doc.pages.flatMap((p) => p.annotations.filter((a): a is RedactionMarkAnnotation => a.type === 'redaction'));
            if (!marks.length) throw new Error('There are no redaction marks to apply');

            // A search term is asserted absent only when its whole group is applied unedited.
            const groups = new Map<string, { term: string; size: number; count: number; edited: boolean }>();
            for (const m of marks) {
              if (!m.searchGroup) continue;
              const g = groups.get(m.searchGroup.id) ?? { term: m.searchGroup.term, size: m.searchGroup.size, count: 0, edited: false };
              g.count++;
              g.edited ||= !!m.edited;
              groups.set(m.searchGroup.id, g);
            }
            const mustBeAbsent = [...groups.values()].filter((g) => g.count === g.size && !g.edited).map((g) => g.term);

            const { bytes, report } = await applyRedactions(
              doc.pdfData,
              marks.map((m) => ({ pageIndex: m.pageIndex - 1, rects: m.rects })),
              { fill: request.fill, stripMetadata: request.stripMetadata, mustBeAbsent, encoder: browserEncoder },
              pdfjsEnv
            );

            const marksByPage = new Map<number, PdfRect[]>();
            for (const m of marks) marksByPage.set(m.pageIndex - 1, [...(marksByPage.get(m.pageIndex - 1) ?? []), ...m.rects]);

            const proxy = await openPdfjs(pdfjsEnv, bytes);
            let mappings: FormFieldMapping[] = [];
            const pages: PDFPage[] = [];
            try {
              for (const page of doc.pages) {
                const pageMarks = marksByPage.get(page.index);
                const remaining = page.annotations.filter((a) => a.type !== 'redaction');
                if (!pageMarks) {
                  pages.push({ ...page, annotations: remaining });
                  continue;
                }
                const pdfPage = await proxy.getPage(page.index + 1);
                const viewport = pdfPage.getViewport({ scale: 1 });
                const freshItems = await extractTextItems(pdfPage, page.index);
                // Carry pending text edits over to the re-extracted items when the
                // edited word was not under a mark (matched by text + position).
                const textEdits = [];
                const underMark = (item: PDFTextItem) =>
                  pageMarks.some((m) => intersects({ x0: item.x, y0: viewport.height - item.y - item.height, x1: item.x + item.width, y1: viewport.height - item.y }, m));
                for (const old of page.textItems ?? []) {
                  if (!old.isEdited && !old.isDeleted) continue;
                  if (underMark(old)) continue;
                  const match = freshItems.find((n) => n.originalStr === old.originalStr && Math.abs(n.x - old.x) < 1 && Math.abs(n.y - old.y) < 1);
                  if (!match) continue;
                  Object.assign(match, { str: old.str, isEdited: old.isEdited, isDeleted: old.isDeleted });
                  const edit = page.textEdits?.find((e) => e.itemId === old.id);
                  if (edit) textEdits.push({ ...edit, itemId: match.id });
                }
                pages.push({
                  ...page,
                  annotations: remaining.filter((a) => {
                    const b = annotationPdfBounds(a, page);
                    return !b || !pageMarks.some((m) => intersects(b, m));
                  }),
                  textItems: freshItems,
                  textEdits,
                  sourceAnnotations: await extractSourceAnnotations(pdfPage, page.index, viewport.height),
                });
              }
              mappings = await buildFormFieldMapping(proxy as never);
            } finally {
              await proxy.destroy();
            }

            const prevDoc = doc;
            const nextDoc: PDFDocument = { ...doc, pages, pdfData: bytes };
            commitDocument(nextDoc);
            setFormFieldMappings(mappings);
            const restoreMappings = async (d: PDFDocument, set: (m: FormFieldMapping[]) => void) => {
              const p = await openPdfjs(pdfjsEnv, d.pdfData);
              try {
                set(await buildFormFieldMapping(p as never));
              } finally {
                await p.destroy();
              }
            };
            addToHistory({
              type: 'applyRedactions',
              undo: () => {
                commitDocument(prevDoc);
                void restoreMappings(prevDoc, setFormFieldMappings);
              },
              redo: () => {
                commitDocument(nextDoc);
                setFormFieldMappings(mappings);
              },
            });
            resolveReport(report);
          } catch (e) {
            rejectReport(e);
          }
        });
      }),
    [stateRef, runStructural, commitDocument, addToHistory, setFormFieldMappings]
  );

  return { addTextMarkup, addRedactionMark, markSearchResults, applyRedactionMarks };
}
