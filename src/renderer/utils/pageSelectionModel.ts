/**
 * Pure helpers for thumbnail multi-selection and page-range strings.
 * All page indices here are 0-based; range strings are 1-based ("1,3,5-7").
 */

export interface PageClickModifiers {
  /** Ctrl (or Cmd) held: toggle this page. */
  ctrl: boolean;
  /** Shift held: select the range from the anchor to this page. */
  shift: boolean;
}

/**
 * Explorer-style selection: plain click selects one page; Ctrl toggles; Shift
 * selects anchor..index (Ctrl+Shift adds that range to the selection).
 */
export function nextSelection(
  current: number[],
  anchor: number | null,
  index: number,
  mods: PageClickModifiers,
  count: number
): { selected: number[]; anchor: number } {
  const clamp = (i: number) => Math.min(Math.max(i, 0), Math.max(count - 1, 0));
  const target = clamp(index);
  if (mods.shift && anchor !== null) {
    const a = clamp(anchor);
    const lo = Math.min(a, target);
    const hi = Math.max(a, target);
    const range = Array.from({ length: hi - lo + 1 }, (_, k) => lo + k);
    const base = mods.ctrl ? current : [];
    return { selected: [...new Set([...base, ...range])].sort((x, y) => x - y), anchor: a };
  }
  if (mods.ctrl) {
    const set = new Set(current);
    if (set.has(target)) set.delete(target);
    else set.add(target);
    return { selected: [...set].sort((x, y) => x - y), anchor: target };
  }
  return { selected: [target], anchor: target };
}

/** "1,3,5-7" (1-based) → sorted unique 0-based indices, or null if invalid. */
export function parsePageRange(input: string, count: number): number[] | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  const out = new Set<number>();
  for (const part of trimmed.split(',')) {
    const p = part.trim();
    if (!p) return null;
    const m = /^(\d+)\s*(?:-\s*(\d+))?$/.exec(p);
    if (!m) return null;
    const start = parseInt(m[1], 10);
    const end = m[2] !== undefined ? parseInt(m[2], 10) : start;
    if (start < 1 || end > count || start > end) return null;
    for (let i = start; i <= end; i++) out.add(i - 1);
  }
  return [...out].sort((a, b) => a - b);
}

/** Sorted 0-based indices → compact 1-based range string ("1,3,5-7"). */
export function formatPageRange(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(i === j ? `${sorted[i] + 1}` : `${sorted[i] + 1}-${sorted[j] + 1}`);
    i = j + 1;
  }
  return parts.join(',');
}

/**
 * Gap index (0..count) for a drop on thumbnail `overIndex`: the upper half
 * means "before this page", the lower half "after it".
 */
export function dropGap(overIndex: number, upperHalf: boolean): number {
  return upperHalf ? overIndex : overIndex + 1;
}
