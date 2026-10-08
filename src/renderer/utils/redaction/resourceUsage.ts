/**
 * Which named resources a content stream actually DRAWS.
 *
 * Redaction replaces a drawn object (image, form) by registering a new object
 * under a new name and rewriting the `Do`. Persistence is reachability-based
 * (garbage collection keeps everything reachable from the trailer and pdf-lib
 * writes every object it holds), so an original left bound under its old name
 * in /Resources is written to the output byte for byte even though nothing
 * draws it any more. The fix is to rebuild the bindings from what the
 * rewritten content uses (ResourceScope.pruneTo) and to have the verifier fail
 * on any binding no content op uses (auditResourceUse).
 *
 * "Used" is computed for the categories that can carry page content and are
 * pruned by the engine: /XObject (bound by `Do`) and /Pattern (bound by
 * `scn`/`SCN`, used only when a painting operator runs while it is the
 * current colour). Content that resolves names against the SAME dictionary
 * is followed: Form XObjects without their own /Resources and Type3 fonts
 * without their own /Resources inherit the enclosing resources. Content with
 * its own resources is returned as a child scope for the verifier to audit.
 *
 * Anything that cannot be examined (undecodable or unparseable inherited
 * content, excessive nesting) throws ResourceUsageUnknown: callers fail
 * closed (the engine rasterizes the page, the verifier reports a violation).
 */
import { PDFContext, PDFDict, PDFName, PDFObject, PDFRef, PDFStream } from 'pdf-lib';
import { ContentOp, parseContent } from './contentTokenizer';
import { decodeStreamStrict, dictGet, getArray, getDict, getName, getNumber, getStream, resolve } from './pdfObjects';

export type PrunableCategory = 'XObject' | 'Pattern';
export const PRUNABLE_CATEGORIES: readonly PrunableCategory[] = ['XObject', 'Pattern'];

/** Same bound as the redactor's form recursion. */
const MAX_DEPTH = 12;

export class ResourceUsageUnknown extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ResourceUsageUnknown';
  }
}

/** Content that resolves names against its OWN resources (audited separately). */
export interface ChildScope {
  label: string;
  /** Identity for de-duplication (the form/pattern stream or the Type3 font dict). */
  identity: PDFObject;
  streams: PDFStream[];
  resources: PDFDict | undefined;
}

export interface ResourceUse {
  XObject: Set<string>;
  Pattern: Set<string>;
  children: ChildScope[];
}

const PAINT_OPS = new Set(['S', 's', 'f', 'F', 'f*', 'B', 'B*', 'b', 'b*']);
const TEXT_SHOW_OPS = new Set(['Tj', 'TJ', "'", '"']);

function lastName(op: ContentOp): string | undefined {
  const last = op.operands[op.operands.length - 1];
  return last && last.type === 'name' ? last.value : undefined;
}

function subDict(context: PDFContext, resources: PDFDict | undefined, category: string): PDFDict | undefined {
  return resources ? getDict(context, resources.get(PDFName.of(category))) : undefined;
}

function decodeOrThrow(stream: PDFStream, what: string): Uint8Array {
  try {
    return decodeStreamStrict(stream);
  } catch (e) {
    throw new ResourceUsageUnknown(`${what} could not be decoded (${(e as Error).message})`);
  }
}

/**
 * Names in `resources` that `content` (and any content inheriting `resources`)
 * draws, plus the child scopes it reaches that carry their own resources.
 */
export function collectResourceUse(context: PDFContext, content: Uint8Array, resources: PDFDict | undefined): ResourceUse {
  const use: ResourceUse = { XObject: new Set(), Pattern: new Set(), children: [] };
  const visitedInherited = new Set<PDFObject>();
  const childIds = new Set<PDFObject>();

  const addChild = (child: ChildScope) => {
    if (childIds.has(child.identity)) return;
    childIds.add(child.identity);
    use.children.push(child);
  };

  const type3 = (fontObj: PDFObject | undefined, depth: number) => {
    const font = getDict(context, fontObj);
    if (!font || getName(context, dictGet(font, 'Subtype')) !== 'Type3') return;
    const identity = resolve(context, fontObj) ?? font;
    const procs = getDict(context, dictGet(font, 'CharProcs'));
    const streams: PDFStream[] = [];
    if (procs) {
      for (const [, v] of procs.entries()) {
        const s = getStream(context, v);
        if (s) streams.push(s);
      }
    }
    const own = getDict(context, dictGet(font, 'Resources'));
    if (own) {
      addChild({ label: 'Type3 font glyph procedures', identity, streams, resources: own });
      return;
    }
    if (visitedInherited.has(identity)) return;
    visitedInherited.add(identity);
    for (const s of streams) walk(decodeOrThrow(s, 'Type3 glyph procedure'), depth + 1);
  };

  const walk = (data: Uint8Array, depth: number): void => {
    if (depth > MAX_DEPTH) throw new ResourceUsageUnknown('Content nesting is too deep to determine which resources it draws');
    let ops: ContentOp[];
    try {
      ops = parseContent(data);
    } catch (e) {
      throw new ResourceUsageUnknown(`Content could not be parsed (${(e as Error).message})`);
    }
    let fill: string | undefined;
    let stroke: string | undefined;
    const stack: Array<[string | undefined, string | undefined]> = [];
    const paintWithCurrentColours = () => {
      if (fill) use.Pattern.add(fill);
      if (stroke) use.Pattern.add(stroke);
    };

    for (const op of ops) {
      switch (op.op) {
        case 'q': stack.push([fill, stroke]); break;
        case 'Q': if (stack.length) [fill, stroke] = stack.pop()!; break;
        case 'cs': case 'g': case 'rg': case 'k': case 'sc': fill = undefined; break;
        case 'CS': case 'G': case 'RG': case 'K': case 'SC': stroke = undefined; break;
        case 'scn': fill = lastName(op); break;
        case 'SCN': stroke = lastName(op); break;
        case 'BI': paintWithCurrentColours(); break; // stencil masks paint with the fill colour
        case 'Tf': {
          const name = op.operands[0]?.type === 'name' ? op.operands[0].value : undefined;
          if (name) type3(subDict(context, resources, 'Font')?.get(PDFName.of(name)), depth);
          break;
        }
        case 'gs': {
          const name = op.operands[0]?.type === 'name' ? op.operands[0].value : undefined;
          const egs = name ? getDict(context, subDict(context, resources, 'ExtGState')?.get(PDFName.of(name))) : undefined;
          const fontArr = getArray(context, dictGet(egs, 'Font'));
          if (fontArr && fontArr.size() >= 1) type3(fontArr.get(0), depth);
          break;
        }
        case 'Do': {
          paintWithCurrentColours(); // forms and stencil-mask images paint with the inherited fill
          const name = op.operands[0]?.type === 'name' ? op.operands[0].value : undefined;
          if (!name) break;
          use.XObject.add(name);
          const entry = subDict(context, resources, 'XObject')?.get(PDFName.of(name));
          const stream = getStream(context, entry);
          if (!stream || getName(context, dictGet(stream.dict, 'Subtype')) !== 'Form') break;
          const identity = entry instanceof PDFRef ? entry : stream;
          const own = getDict(context, dictGet(stream.dict, 'Resources'));
          if (own) {
            addChild({ label: `Form XObject /${name}`, identity, streams: [stream], resources: own });
          } else if (!visitedInherited.has(identity)) {
            visitedInherited.add(identity);
            walk(decodeOrThrow(stream, `Form XObject /${name}`), depth + 1);
          }
          break;
        }
        default:
          if (PAINT_OPS.has(op.op) || TEXT_SHOW_OPS.has(op.op)) paintWithCurrentColours();
          break;
      }
    }
  };

  walk(content, 0);

  // Tiling patterns carry their own content and resources.
  const patterns = subDict(context, resources, 'Pattern');
  for (const name of use.Pattern) {
    const entry = patterns?.get(PDFName.of(name));
    const stream = getStream(context, entry);
    if (!stream || getNumber(context, dictGet(stream.dict, 'PatternType')) !== 1) continue;
    addChild({
      label: `Tiling pattern /${name}`,
      identity: entry instanceof PDFRef ? entry : stream,
      streams: [stream],
      resources: getDict(context, dictGet(stream.dict, 'Resources')),
    });
  }
  return use;
}

/** Entries of a prunable sub-dictionary that `use` does not draw. */
export function undrawnNames(context: PDFContext, resources: PDFDict | undefined, use: ResourceUse): Array<{ category: PrunableCategory; name: string }> {
  const out: Array<{ category: PrunableCategory; name: string }> = [];
  for (const category of PRUNABLE_CATEGORIES) {
    const sub = subDict(context, resources, category);
    if (!sub) continue;
    for (const [key] of sub.entries()) {
      const name = key.decodeText();
      if (!use[category].has(name)) out.push({ category, name });
    }
  }
  return out;
}

/**
 * Verifier check: every /XObject and /Pattern binding reachable from
 * `resources` (and, recursively, from the resources of every form, tiling
 * pattern and Type3 font the content draws) must be drawn by some content op.
 * Returns violation messages; an empty list means the check ran and found
 * nothing. Content that cannot be examined is itself a violation.
 */
export function auditResourceUse(context: PDFContext, content: Uint8Array, resources: PDFDict | undefined, where: string): string[] {
  const violations: string[] = [];
  const visited = new Set<PDFObject>();

  const audit = (data: Uint8Array, res: PDFDict | undefined, label: string, depth: number) => {
    if (violations.length >= 20) return;
    if (depth > MAX_DEPTH) {
      violations.push(`${label}: nesting too deep to verify which resources are drawn`);
      return;
    }
    let use: ResourceUse;
    try {
      use = collectResourceUse(context, data, res);
    } catch (e) {
      violations.push(`${label}: could not determine which resources are drawn (${(e as Error).message})`);
      return;
    }
    for (const { category, name } of undrawnNames(context, res, use)) {
      violations.push(`${label}: /${category} /${name} is in the resources but nothing draws it`);
    }
    for (const child of use.children) {
      if (visited.has(child.identity)) continue;
      visited.add(child.identity);
      const parts: Uint8Array[] = [];
      try {
        for (const s of child.streams) parts.push(decodeStreamStrict(s));
      } catch (e) {
        violations.push(`${label} > ${child.label}: could not be decoded (${(e as Error).message})`);
        continue;
      }
      // Each glyph procedure / form is a separate stream; join with newlines.
      const total = parts.reduce((n, p) => n + p.length + 1, 0);
      const joined = new Uint8Array(total);
      let off = 0;
      for (const p of parts) {
        joined.set(p, off);
        off += p.length;
        joined[off++] = 0x0a;
      }
      audit(joined, child.resources, `${label} > ${child.label}`, depth + 1);
    }
  };

  audit(content, resources, where, 0);
  return violations;
}
