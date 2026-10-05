/**
 * Copy-on-write view of a /Resources dictionary.
 *
 * Resource dictionaries (and their /XObject sub-dictionaries) are routinely
 * shared between pages and form XObjects. Redaction must never mutate a shared
 * object — that would silently alter pages that were not marked — so the first
 * write clones the dictionary and the /XObject sub-dictionary; the owner (page
 * or cloned form) is then pointed at the clone.
 */
import { PDFContext, PDFDict, PDFName, PDFObject, PDFRef } from 'pdf-lib';
import { getDict } from './pdfObjects';

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
