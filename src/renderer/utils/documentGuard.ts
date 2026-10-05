/**
 * Guard for async work that commits a document it read earlier.
 *
 * Race class: an async op (page op, byte transform, search-and-mark, save
 * write-back) reads the active document, awaits, then commits. If the user
 * switched tabs, undid, or edited in between, committing would overwrite the
 * NEWER state — or, after a tab switch, write tab A's pages into tab B.
 *
 * Every such op takes a snapshot before its first await and checks it again
 * right before committing. The hook keeps stateRef.document/activeTabId
 * updated synchronously on every commit and every tab activation, so the check
 * sees a switch the moment it happens, not after React re-renders.
 */
import type { PDFDocument } from '../types';

export interface DocStateRef {
  current: { document: PDFDocument | null; activeTabId?: string | null };
}

export interface DocSnapshot {
  doc: PDFDocument;
  tabId: string | null;
}

export class StaleDocumentError extends Error {
  constructor(message = 'The document changed (tab switch, undo or another edit) while this operation was running, so nothing was applied. Please try again.') {
    super(message);
    this.name = 'StaleDocumentError';
  }
}

/** Snapshot of the active document, or null when nothing is open. */
export function snapshotDocument(ref: DocStateRef): DocSnapshot | null {
  const doc = ref.current.document;
  return doc ? { doc, tabId: ref.current.activeTabId ?? null } : null;
}

/** True only if the very same document object is still active in the same tab. */
export function isSnapshotCurrent(ref: DocStateRef, snap: DocSnapshot): boolean {
  return ref.current.document === snap.doc && (ref.current.activeTabId ?? null) === snap.tabId;
}

/**
 * Weaker check for results derived from the BYTES only (e.g. text search hits):
 * same tab and same pdfData, while model-only edits (new annotations) are fine.
 */
export function isSameSourceBytes(ref: DocStateRef, snap: DocSnapshot): boolean {
  return ref.current.document?.pdfData === snap.doc.pdfData && (ref.current.activeTabId ?? null) === snap.tabId;
}

/**
 * Queued ops run later than they were requested (runStructural chains them),
 * so the tab that REQUESTED the op is captured synchronously at call time and
 * checked when the op starts: an op asked for on tab A must never run against
 * tab B just because B became active while it waited.
 */
export function assertRequestedTabActive(ref: DocStateRef, requestedTabId: string | null): void {
  if ((ref.current.activeTabId ?? null) !== requestedTabId) throw new StaleDocumentError();
}

export function assertSnapshotCurrent(ref: DocStateRef, snap: DocSnapshot): void {
  if (!isSnapshotCurrent(ref, snap)) throw new StaleDocumentError();
}
