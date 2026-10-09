/**
 * Markup + redaction operations for usePDFDocument.
 *
 * Kept in its own hook so the shared document hook only gains one call and a
 * few return-object entries. It uses the document hook's serialization
 * byte-transform path (applyDocumentTransform), synchronous commit
 * (commitDocument) and history.
 */
import { useCallback } from 'react';
import type { MutableRefObject } from 'react';
import * as pdfjsLib from 'pdfjs-dist';
import { PDFDocument as PDFLib } from 'pdf-lib';
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
import type { DocumentTransformInput, DocumentTransformOutput } from './usePDFDocument';
import { buildFilledRectMap, buildTextColorMap, matchBackgroundColor, matchTextColor } from '../utils/textColorExtractor';
import { extractSourceAnnotations } from '../utils/annotationExtractor';
import { getTextHeight, mapToStandardFontName, measureTextWidth } from '../utils/standardFontMetrics';
import { applyRedactions, RedactionReport } from '../utils/redaction/redactionEngine';
import { PdfjsEnv, openPdfjs } from '../utils/redaction/pdfjsEnv';
import { findOccurrences, SearchOptions } from '../utils/redaction/textSearch';
import { intersects, markTooSmall, padToMinSize } from '../utils/redaction/geometry';
import { snapshotDocument, isSameSourceBytes, StaleDocumentError } from '../utils/documentGuard';
import { pageGeometry } from '../utils/pageStructure';
import { AnnotationPageFrame, isUnderAnyMark } from '../utils/annotationBounds';

interface HistoryEntry {
  type: string;
  undo: () => void;
  redo: () => void;
}

interface Deps {
  stateRef: MutableRefObject<{ document: PDFDocument | null; activeTabId?: string | null }>;
  commitDocument: (doc: PDFDocument) => void;
  addToHistory: (entry: HistoryEntry) => void;
  applyDocumentTransform: <T extends DocumentTransformOutput>(
    type: string,
    transform: (input: DocumentTransformInput) => Promise<T | null>
  ) => Promise<T | null>;
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

export function useMarkupRedaction({ stateRef, commitDocument, addToHistory, applyDocumentTransform }: Deps) {
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

  /**
   * Add a redaction mark. The engine refuses marks below MIN_MARK_SIZE (they
   * cannot be verified). Boxes from a TEXT selection cover glyphs, so a tiny
   * one is grown (never shrunk) to the minimum; an AREA box that small is
   * refused. Returns the number of refused boxes so the caller can tell the
   * user — a box is never dropped silently.
   */
  const addRedactionMark = useCallback(
    (pageIndex: number, rects: PdfRect[], source: RedactionMarkAnnotation['source'], text?: string): { refused: number } => {
      const sized = source === 'area' ? rects : rects.map((r) => padToMinSize(r));
      const valid = sized.filter((r) => !markTooSmall(r));
      const refused = rects.length - valid.length;
      if (!valid.length) return { refused };
      const mark: RedactionMarkAnnotation = { id: newId('redact'), type: 'redaction', pageIndex, rects: valid, source, text };
      commitAnnotations('addRedactionMark', pageIndex, (a) => [...a, mark]);
      return { refused };
    },
    [commitAnnotations]
  );

  /** Find every occurrence of `term` and mark them all (one undo step). Returns the count. */
  const markSearchResults = useCallback(
    async (term: string, options: SearchOptions): Promise<number> => {
      const snap = snapshotDocument(stateRef);
      if (!snap || !term.trim()) return 0;
      const doc = snap.doc;
      const proxy = await openPdfjs(pdfjsEnv, doc.pdfData);
      let found;
      try {
        found = await findOccurrences(proxy, pdfjsEnv, term, options);
      } finally {
        await proxy.destroy();
      }
      if (!found.length) return 0;
      // Hits are positions in THESE bytes on THIS tab. Annotations added while
      // searching are fine; a tab switch or byte change is not (the marks
      // would land on another document).
      if (!isSameSourceBytes(stateRef, snap)) throw new StaleDocumentError();
      const latest = stateRef.current.document!;
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
    async (request: ApplyRedactionsRequest): Promise<RedactionReport> => {
      interface RedactionTransformOutput extends DocumentTransformOutput {
        report: RedactionReport;
      }
      // Committed through the shared byte-transform path: serialized with page
      // ops, live form values baked in first, one undo step back to the
      // pre-redaction bytes. Errors (including failed verification) reject and
      // leave the document untouched.
      const output = await applyDocumentTransform<RedactionTransformOutput>('applyRedactions', async ({ doc, bakedBytes }) => {
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
          bakedBytes,
          marks.map((m) => ({ pageIndex: m.pageIndex - 1, rects: m.rects })),
          { fill: request.fill, stripMetadata: request.stripMetadata, mustBeAbsent, encoder: browserEncoder },
          pdfjsEnv
        );

        const marksByPage = new Map<number, PdfRect[]>();
        for (const m of marks) marksByPage.set(m.pageIndex - 1, [...(marksByPage.get(m.pageIndex - 1) ?? []), ...m.rects]);

        // Page frames (visible box + /Rotate) read from the redacted bytes with
        // the same helper the save pipeline uses, so pending-annotation
        // footprints are computed where they will actually be written.
        const geometryDoc = await PDFLib.load(bytes);
        const proxy = await openPdfjs(pdfjsEnv, bytes);
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
            // Fail closed: an annotation under a mark, or one whose footprint
            // cannot be computed, is dropped; it may carry the redacted text.
            const geo = pageGeometry(geometryDoc.getPage(page.index));
            const frames: AnnotationPageFrame[] = [{ box: geo.box, rotation: geo.rotation }];
            const modelRotation = ((page.rotation % 360) + 360) % 360;
            // The viewer displays with the model's rotation; if it disagrees
            // with the file, test the displayed placement under both.
            if (modelRotation !== geo.rotation) frames.push({ box: geo.box, rotation: modelRotation });
            pages.push({
              ...page,
              annotations: remaining.filter((a) => !frames.some((frame) => isUnderAnyMark(a, frame, pageMarks))),
              textItems: freshItems,
              textEdits,
              sourceAnnotations: await extractSourceAnnotations(pdfPage, page.index, viewport.height),
            });
          }
        } finally {
          await proxy.destroy();
        }
        return { pdfData: bytes, pages, report };
      });
      if (!output) throw new Error('No document open');
      return output.report;
    },
    [applyDocumentTransform]
  );

  return { addTextMarkup, addRedactionMark, markSearchResults, applyRedactionMarks };
}
