import { describe, it, expect } from 'vitest';
import {
  snapshotDocument,
  isSnapshotCurrent,
  isSameSourceBytes,
  assertSnapshotCurrent,
  assertRequestedTabActive,
  StaleDocumentError,
  DocStateRef,
} from './documentGuard';
import type { PDFDocument } from '../types';

const doc = (bytes = new Uint8Array([1])): PDFDocument =>
  ({ filePath: 'a.pdf', fileName: 'a.pdf', pageCount: 1, pages: [], pdfData: bytes }) as unknown as PDFDocument;

describe('documentGuard', () => {
  it('passes while the same document stays active in the same tab', () => {
    const a = doc();
    const ref: DocStateRef = { current: { document: a, activeTabId: 'tab-a' } };
    const snap = snapshotDocument(ref)!;
    expect(isSnapshotCurrent(ref, snap)).toBe(true);
    expect(() => assertSnapshotCurrent(ref, snap)).not.toThrow();
  });

  it('fails after a tab switch, even back to an identical-looking document', () => {
    const a = doc();
    const ref: DocStateRef = { current: { document: a, activeTabId: 'tab-a' } };
    const snap = snapshotDocument(ref)!;
    ref.current = { document: doc(), activeTabId: 'tab-b' };
    expect(isSnapshotCurrent(ref, snap)).toBe(false);
    expect(isSameSourceBytes(ref, snap)).toBe(false);
    expect(() => assertSnapshotCurrent(ref, snap)).toThrow(StaleDocumentError);
    // Same doc object but a different tab id still counts as stale.
    ref.current = { document: a, activeTabId: 'tab-b' };
    expect(isSnapshotCurrent(ref, snap)).toBe(false);
  });

  it('fails after undo/edit replaced the document object', () => {
    const a = doc();
    const ref: DocStateRef = { current: { document: a, activeTabId: 'tab-a' } };
    const snap = snapshotDocument(ref)!;
    ref.current.document = { ...a };
    expect(isSnapshotCurrent(ref, snap)).toBe(false);
    // Model-only edit (same bytes): byte-derived results are still valid.
    expect(isSameSourceBytes(ref, snap)).toBe(true);
    ref.current.document = { ...a, pdfData: new Uint8Array([1]) };
    expect(isSameSourceBytes(ref, snap)).toBe(false);
  });

  it('no snapshot when nothing is open; closing the doc invalidates', () => {
    const ref: DocStateRef = { current: { document: null, activeTabId: null } };
    expect(snapshotDocument(ref)).toBeNull();
    const a = doc();
    ref.current = { document: a, activeTabId: 't' };
    const snap = snapshotDocument(ref)!;
    ref.current = { document: null, activeTabId: null };
    expect(isSnapshotCurrent(ref, snap)).toBe(false);
  });

  it('an op requested on one tab is refused once another tab is active', () => {
    const ref: DocStateRef = { current: { document: doc(), activeTabId: 'tab-a' } };
    const requested = ref.current.activeTabId ?? null;
    expect(() => assertRequestedTabActive(ref, requested)).not.toThrow();
    ref.current = { document: doc(), activeTabId: 'tab-b' };
    expect(() => assertRequestedTabActive(ref, requested)).toThrow(StaleDocumentError);
  });
});
