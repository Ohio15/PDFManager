/**
 * Copy-on-write view of a /Resources dictionary.
 *
 * Resource dictionaries (and their /XObject sub-dictionaries) are routinely
 * shared between pages and form XObjects. Redaction must never mutate a shared
 * object — that would silently alter pages that were not marked — so the first
 * write clones the dictionary and the /XObject sub-dictionary; the owner (page
 * or cloned form) is then pointed at the clone.
 *
 * Adding is not enough to REPLACE: an original left bound under its old name
 * stays reachable and is written to the output. After the owner's content is
 * rewritten, pruneTo() rebuilds the prunable sub-dictionaries (/XObject,
 * /Pattern, /Font, /ExtGState, /Properties) from the names that content
 * actually uses.
 */
import { PDFContext, PDFDict, PDFName, PDFObject, PDFRef } from 'pdf-lib';
import { getDict } from './pdfObjects';
import { PRUNABLE_CATEGORIES, PrunableCategory, ResourceUse, bindingUse, neutralFont, neutralPattern } from './resourceUsage';

export type ResourceCategory = 'Font' | 'XObject' | 'ColorSpace' | 'Properties' | 'ExtGState' | 'Pattern' | 'Shading';

export class ResourceScope {
  private clone: PDFDict | null = null;
  private xobjectClone: PDFDict | null = null;

  constructor(private readonly context: PDFContext, private readonly original: PDFDict | undefined) {}

  get modified(): boolean {
    return this.clone !== null;
  }

  /** The dictionary the owner should reference after redaction. */
  finalDict(): PDFDict | undefined {
    return this.clone ?? this.original;
  }

  lookup(category: ResourceCategory, name: string): PDFObject | undefined {
    const source = this.clone ?? this.original;
    if (!source) return undefined;
    const sub = category === 'XObject' && this.xobjectClone ? this.xobjectClone : getDict(this.context, source.get(PDFName.of(category)));
    return sub?.get(PDFName.of(name));
  }

  /** Register `ref` under a fresh name in /XObject and return the name. */
  addXObject(prefix: string, ref: PDFRef): string {
    const xobjects = this.writableXObjects();
    let n = 1;
    let name = `${prefix}${n}`;
    while (xobjects.has(PDFName.of(name))) name = `${prefix}${++n}`;
    xobjects.set(PDFName.of(name), ref);
    return name;
  }

  /**
   * Keep only the prunable bindings named in `used` (copy-on-write:
   * the original dictionaries are never mutated). Does nothing when every
   * binding is used.
   */
  pruneTo(use: ResourceUse): void {
    const source = this.clone ?? this.original;
    if (!source) return;
    const subOf = (category: PrunableCategory): PDFDict | undefined =>
      category === 'XObject' && this.xobjectClone ? this.xobjectClone : getDict(this.context, source.get(PDFName.of(category)));
    const needsPrune = PRUNABLE_CATEGORIES.some((category) => {
      const sub = subOf(category);
      return !!sub && sub.entries().some(([key, value]) => bindingUse(this.context, category, key.decodeText(), value, use) !== 'keep');
    });
    if (!needsPrune) return;
    if (!this.clone) this.clone = source.clone(this.context);
    for (const category of PRUNABLE_CATEGORIES) {
      const sub = subOf(category);
      if (!sub) continue;
      const kept = this.context.obj({});
      for (const [key, value] of sub.entries()) {
        const verdict = bindingUse(this.context, category, key.decodeText(), value, use);
        // A font only selected by a `Tf` whose text was all removed: keep the
        // name (the Tf and its size stay valid), drop the font's data.
        if (verdict === 'keep') kept.set(key, value);
        else if (verdict === 'neutralise') kept.set(key, category === 'Pattern' ? neutralPattern(this.context) : neutralFont(this.context));
      }
      if (kept.entries().length === 0) {
        this.clone.delete(PDFName.of(category));
        if (category === 'XObject') this.xobjectClone = null;
      } else {
        this.clone.set(PDFName.of(category), kept);
        if (category === 'XObject') this.xobjectClone = kept;
      }
    }
  }

  private writableXObjects(): PDFDict {
    if (this.xobjectClone) return this.xobjectClone;
    if (!this.clone) {
      this.clone = this.original ? this.original.clone(this.context) : this.context.obj({});
    }
    const existing = getDict(this.context, this.clone.get(PDFName.of('XObject')));
    this.xobjectClone = existing ? existing.clone(this.context) : this.context.obj({});
    this.clone.set(PDFName.of('XObject'), this.xobjectClone);
    return this.xobjectClone;
  }
}
