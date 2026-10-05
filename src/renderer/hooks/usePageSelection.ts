import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { PDFDocument } from '../types';
import { nextSelection, PageClickModifiers } from '../utils/pageSelectionModel';

/**
 * Multi-page selection for the thumbnail sidebar (0-based indices).
 *
 * The current page (1-based, owned by App) is always the focus; the selection
 * is what bulk page tools act on. `effective` falls back to the current page so
 * every page tool has a target even when nothing is explicitly selected.
 */
export function usePageSelection(
  document: PDFDocument | null,
  activeTabId: string | null,
  currentPage: number,
  setCurrentPage: (page: number) => void
) {
  const [selected, setSelected] = useState<number[]>([]);
  const anchorRef = useRef<number | null>(null);
  const pageCount = document?.pages.length ?? 0;

  // A different tab is a different document: drop the selection.
  useEffect(() => {
    setSelected([]);
    anchorRef.current = null;
  }, [activeTabId]);

  // Keep the selection and the current page inside the document after a page
  // op (or undo) changes the page count.
  useEffect(() => {
    if (pageCount === 0) return;
    setSelected((prev) => {
      const next = prev.filter((i) => i < pageCount);
      return next.length === prev.length ? prev : next;
    });
    if (currentPage > pageCount) setCurrentPage(pageCount);
  }, [pageCount, currentPage, setCurrentPage]);

  const click = useCallback(
    (index: number, mods: PageClickModifiers) => {
      const result = nextSelection(selected, anchorRef.current, index, mods, pageCount);
      anchorRef.current = result.anchor;
      setSelected(result.selected);
      setCurrentPage(index + 1);
    },
    [selected, pageCount, setCurrentPage]
  );

  const selectAll = useCallback(() => {
    setSelected(Array.from({ length: pageCount }, (_, i) => i));
  }, [pageCount]);

  /** Replace the selection (e.g. with the pages a tool just produced) and focus the first. */
  const select = useCallback(
    (indices: number[]) => {
      const next = [...new Set(indices)].filter((i) => i >= 0 && i < pageCount).sort((a, b) => a - b);
      setSelected(next);
      anchorRef.current = next[0] ?? null;
      if (next.length > 0) setCurrentPage(next[0] + 1);
    },
    [pageCount, setCurrentPage]
  );

  const clear = useCallback(() => {
    setSelected([]);
    anchorRef.current = null;
  }, []);

  const effective = useMemo(() => {
    const inRange = selected.filter((i) => i < pageCount);
    if (inRange.length > 0) return inRange;
    return pageCount > 0 ? [Math.min(Math.max(currentPage, 1), pageCount) - 1] : [];
  }, [selected, pageCount, currentPage]);

  return { selected, effective, click, selectAll, select, clear };
}

export type PageSelection = ReturnType<typeof usePageSelection>;
