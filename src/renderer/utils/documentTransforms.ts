/**
 * documentTransforms — byte-level document transforms (form authoring,
 * flatten, compress) and how they treat in-session state.
 *
 * Two kinds of state live outside pdfData until save:
 *
 * 1. Typed form values live in pdf.js AnnotationStorage. Every transform
 *    reloads the viewer from new bytes, which creates a fresh, empty storage,
 *    so values are baked into the bytes first (bakeFormValues). The baked bytes
 *    are also the undo target, so undoing a transform does not lose values the
 *    user typed before it.
 *
 * 2. Annotations, text edits and text deletions live in the page model
 *    (pages[i].annotations / textEdits / textItems) and are only written by the
 *    save pipeline. Decision: PRESERVE them across form authoring, compress and
 *    forms-only flatten. None of those transforms moves pages or changes page
 *    geometry, and none rewrites existing text-showing operators, so every
 *    model coordinate and every pending text edit still applies to the new
 *    bytes and is written at save exactly as before — the user keeps them as
 *    editable, undoable objects. An annotation-scope flatten is the exception:
 *    "burn annotations into the page" must include the pending ones, so those
 *    are written through the real save pipeline first (annotations only; text
 *    edits stay pending) and then cleared from the model.
 */

import { PDFDocument as PDFLib, PDFName, PDFArray, PDFRef } from 'pdf-lib';
import type { PDFPage, PDFSourceAnnotation } from '../types';
import { saveFormFieldValues, FormFieldMapping } from './formFieldSaver';
import { applyEditsAndAnnotations } from './pdfSavePipeline';
import { flattenPdf, FlattenScope, FlattenReport } from './flatten';
import { extractSourceAnnotations } from './annotationExtractor';

/** Minimal AnnotationStorage surface the bake step reads. */
export interface FormValueStorage {
  getAll(): Record<string, unknown> | null;
}

/**
 * Write the values typed into pdf.js form widgets into the bytes. Returns the
 * input array unchanged (same reference) when there is nothing to write.
 */
export async function bakeFormValues(
  pdfData: Uint8Array,
  storage: FormValueStorage | null | undefined,
  mappings: FormFieldMapping[]
): Promise<Uint8Array> {
  if (!storage || mappings.length === 0) return pdfData;
  const values = storage.getAll();
  if (!values || Object.keys(values).length === 0) return pdfData;

  const doc = await PDFLib.load(pdfData, { updateMetadata: false });
  const wrote = await saveFormFieldValues(doc, storage, mappings);
  if (!wrote) return pdfData;
  return new Uint8Array(await doc.save({ updateFieldAppearances: false }));
}

function annotationRefs(doc: PDFLib): Set<string> {
  const refs = new Set<string>();
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      if (entry instanceof PDFRef) refs.add(entry.toString());
    }
  }
  return refs;
}

export interface FlattenDocumentInput {
  /** Bytes with live form values already baked in. */
  pdfData: Uint8Array;
  pages: PDFPage[];
  scope: FlattenScope;
}

export interface FlattenDocumentResult {
  pdfData: Uint8Array;
  pages: PDFPage[];
  report: FlattenReport;
  /** Pending in-session annotations written into the page before flattening. */
  pendingAnnotationsBurned: number;
}

export async function flattenDocument(input: FlattenDocumentInput): Promise<FlattenDocumentResult> {
  const { scope } = input;
  let bytes = input.pdfData;
  let pages = input.pages;
  const removeWithoutDrawing = new Set<string>();
  let pendingAnnotationsBurned = 0;

  const pending = pages.reduce((n, p) => n + p.annotations.length, 0);
  if (scope !== 'forms' && pending > 0) {
    const before = annotationRefs(await PDFLib.load(bytes, { updateMetadata: false }));
    // Annotations only: text edits/deletions stay pending in the model and are
    // applied by the next save against the same content streams.
    bytes = await applyEditsAndAnnotations({
      pdfData: bytes,
      pages: pages.map((p) => ({ ...p, textItems: [], textEdits: [] })),
      annotationStorage: null,
      formFieldMappings: [],
    });
    // The pipeline draws sticky-note markers into content and adds an
    // appearance-less /Text annotation only to carry the note text; those new
    // annotations are already "burned", so they are removed, not skipped.
    for (const ref of annotationRefs(await PDFLib.load(bytes, { updateMetadata: false }))) {
      if (!before.has(ref)) removeWithoutDrawing.add(ref);
    }
    pages = pages.map((p) => ({ ...p, annotations: [] }));
    pendingAnnotationsBurned = pending;
  }

  const { bytes: flattened, report } = await flattenPdf(bytes, { scope, removeWithoutDrawing });
  return { pdfData: flattened, pages, report, pendingAnnotationsBurned };
}

/** Minimal pdf.js document surface used to refresh page-model annotation lists. */
export interface PdfJsLikeDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<{
    getViewport(params: { scale: number }): { height: number };
    getAnnotations(params?: { intent?: string }): Promise<unknown[]>;
  }>;
}

/**
 * Re-read each page's source (non-widget) annotations from new bytes, so the
 * sidebar's "PDF Annotations" list matches what a flatten left behind.
 */
export async function refreshSourceAnnotations(pdfjsDoc: PdfJsLikeDocument, pages: PDFPage[]): Promise<PDFPage[]> {
  const refreshed: PDFPage[] = [];
  for (const page of pages) {
    if (page.index >= pdfjsDoc.numPages) {
      refreshed.push(page);
      continue;
    }
    const pdfPage = await pdfjsDoc.getPage(page.index + 1);
    const viewport = pdfPage.getViewport({ scale: 1 });
    const sourceAnnotations: PDFSourceAnnotation[] = await extractSourceAnnotations(pdfPage, page.index, viewport.height);
    refreshed.push({ ...page, sourceAnnotations });
  }
  return refreshed;
}
