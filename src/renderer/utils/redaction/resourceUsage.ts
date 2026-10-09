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
 * "Used" is computed for the categories that can carry page content or a
 * copy of it and are pruned by the engine: /XObject (bound by `Do`),
 * /Pattern (bound by `scn`/`SCN`, used only when a painting operator runs
 * while it is the current colour), /Font (used when a show operator with
 * glyph bytes runs while it is the current font: a font only SELECTED by a
 * `Tf` whose text was all removed still carries the glyph program and
 * ToUnicode of that text, so it is rebound to a data-free standard-14 stub
 * that keeps the `Tf` and its size valid),
 * /ExtGState (bound by `gs`: soft-mask groups are content) and /Properties
 * (bound by `BDC`/`DP`: property lists carry /ActualText, /Alt and /E).
 * Content that resolves names against the SAME dictionary
 * is followed: Form XObjects without their own /Resources and Type3 fonts
 * without their own /Resources inherit the enclosing resources. Content with
 * its own resources is returned as a child scope for the verifier to audit.
 *
 * Anything that cannot be examined (undecodable or unparseable inherited
 * content, excessive nesting) throws ResourceUsageUnknown: callers fail
 * closed (the engine rasterizes the page, the verifier reports a violation).
 */
import { PDFContext, PDFDict, PDFName, PDFObject, PDFRef, PDFStream } from 'pdf-lib';
import { ContentOp, Operand, parseContent } from './contentTokenizer';
import { decodeStreamStrict, dictGet, getArray, getDict, getName, getNumber, getStream, resolve } from './pdfObjects';

export type PrunableCategory = 'XObject' | 'Pattern' | 'Font' | 'ExtGState' | 'Properties';
export const PRUNABLE_CATEGORIES: readonly PrunableCategory[] = ['XObject', 'Pattern', 'Font', 'ExtGState', 'Properties'];

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
  /** Patterns selected by `scn`/`SCN` (whether or not anything paints with them). */
  PatternSelected: Set<string>;
  /** Fonts that show at least one glyph. */
  Font: Set<string>;
  /** Fonts selected by `Tf` (whether or not they show anything). */
  FontSelected: Set<string>;
  ExtGState: Set<string>;
  Properties: Set<string>;
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
  const use: ResourceUse = { XObject: new Set(), Pattern: new Set(), PatternSelected: new Set(), Font: new Set(), FontSelected: new Set(), ExtGState: new Set(), Properties: new Set(), children: [] };
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
    for (const s of streams) walk(decodeOrThrow(s, 'Type3 glyph procedure'), depth + 1, undefined);
  };

  // `inheritedFont`: the font current where inherited content (a form with no
  // own /Resources) is drawn; text in it may show glyphs without its own Tf.
  const walk = (data: Uint8Array, depth: number, inheritedFont: string | undefined): void => {
    if (depth > MAX_DEPTH) throw new ResourceUsageUnknown('Content nesting is too deep to determine which resources it draws');
    let ops: ContentOp[];
    try {
      ops = parseContent(data);
    } catch (e) {
      throw new ResourceUsageUnknown(`Content could not be parsed (${(e as Error).message})`);
    }
    let fill: string | undefined;
    let stroke: string | undefined;
    let font: string | undefined = inheritedFont;
    const stack: Array<[string | undefined, string | undefined, string | undefined]> = [];
    const paintWithCurrentColours = () => {
      if (fill) use.Pattern.add(fill);
      if (stroke) use.Pattern.add(stroke);
    };

    for (const op of ops) {
      switch (op.op) {
        case 'q': stack.push([fill, stroke, font]); break;
        case 'Q': if (stack.length) [fill, stroke, font] = stack.pop()!; break;
        case 'cs': case 'g': case 'rg': case 'k': case 'sc': fill = undefined; break;
        case 'CS': case 'G': case 'RG': case 'K': case 'SC': stroke = undefined; break;
        case 'scn': fill = lastName(op); if (fill) use.PatternSelected.add(fill); break;
        case 'SCN': stroke = lastName(op); if (stroke) use.PatternSelected.add(stroke); break;
        case 'BI': paintWithCurrentColours(); break; // stencil masks paint with the fill colour
        case 'Tf': {
          const name = op.operands[0]?.type === 'name' ? op.operands[0].value : undefined;
          if (name) {
            use.FontSelected.add(name);
            font = name;
            type3(subDict(context, resources, 'Font')?.get(PDFName.of(name)), depth);
          }
          break;
        }
        case 'BDC': case 'DP': {
          // Named property list: `/Tag /Name BDC` (an inline dict binds nothing).
          const props = op.operands[1];
          if (props?.type === 'name') use.Properties.add(props.value);
          break;
        }
        case 'gs': {
          const name = op.operands[0]?.type === 'name' ? op.operands[0].value : undefined;
          if (name) use.ExtGState.add(name);
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
            walk(decodeOrThrow(stream, `Form XObject /${name}`), depth + 1, font);
          }
          break;
        }
        default:
          if (PAINT_OPS.has(op.op) || TEXT_SHOW_OPS.has(op.op)) paintWithCurrentColours();
          if (TEXT_SHOW_OPS.has(op.op) && font && showsGlyphs(op)) use.Font.add(font);
          break;
      }
    }
  };

  walk(content, 0, undefined);

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

/** True when a show operator carries at least one byte of string data. */
function showsGlyphs(op: ContentOp): boolean {
  const hasBytes = (o: Operand | undefined): boolean =>
    !!o && ((o.type === 'str' && o.bytes.length > 0) || (o.type === 'arr' && o.items.some((it) => it.type === 'str' && it.bytes.length > 0)));
  return op.operands.some(hasBytes);
}

const STANDARD_14 = new Set([
  'Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique', 'Helvetica-BoldOblique',
  'Times-Roman', 'Times-Bold', 'Times-Italic', 'Times-BoldItalic',
  'Courier', 'Courier-Bold', 'Courier-Oblique', 'Courier-BoldOblique', 'Symbol', 'ZapfDingbats',
]);
const NEUTRAL_FONT_KEYS = new Set(['Type', 'Subtype', 'BaseFont', 'Encoding']);

/**
 * A font dictionary that carries no data of its own: a standard-14 Type1
 * font with no descriptor, widths, ToUnicode or font program. Structural, so
 * it cannot be forged into carrying anything.
 */
export function isNeutralFont(context: PDFContext, value: PDFObject | undefined): boolean {
  const d = getDict(context, value);
  if (!d) return false;
  for (const [k] of d.entries()) if (!NEUTRAL_FONT_KEYS.has(k.decodeText())) return false;
  const enc = d.get(PDFName.of('Encoding'));
  return (
    getName(context, dictGet(d, 'Subtype')) === 'Type1' &&
    STANDARD_14.has(getName(context, dictGet(d, 'BaseFont')) ?? '') &&
    (enc === undefined || enc instanceof PDFName)
  );
}

/**
 * A tiling pattern that paints nothing and carries nothing: empty content,
 * no (or empty) resources. Structural, so it cannot be forged into carrying data.
 */
export function isNeutralPattern(context: PDFContext, value: PDFObject | undefined): boolean {
  const s = getStream(context, value);
  if (!s || getNumber(context, dictGet(s.dict, 'PatternType')) !== 1) return false;
  const res = getDict(context, dictGet(s.dict, 'Resources'));
  if (res && res.entries().length > 0) return false;
  try {
    return decodeStreamStrict(s).every((b) => b === 0x20 || b === 0x0a || b === 0x0d || b === 0x09);
  } catch {
    return false;
  }
}

/** The data-free stand-in for a pattern that is selected but paints nothing. */
export function neutralPattern(context: PDFContext): PDFRef {
  return context.register(
    context.stream('', { Type: 'Pattern', PatternType: 1, PaintType: 1, TilingType: 1, BBox: [0, 0, 1, 1], XStep: 1, YStep: 1, Resources: {} })
  );
}

/** The data-free stand-in for a font that is selected but shows nothing. */
export function neutralFont(context: PDFContext): PDFDict {
  return context.obj({ Type: 'Font', Subtype: 'Type1', BaseFont: 'Helvetica' });
}

/**
 * Whether binding `name` -> `value` in `category` is justified by `use`:
 * used names are kept; a font only selected (its text all removed) is
 * acceptable only as a neutral stub.
 */
export function bindingUse(context: PDFContext, category: PrunableCategory, name: string, value: PDFObject | undefined, use: ResourceUse): 'keep' | 'neutralise' | 'drop' {
  if (use[category].has(name)) return 'keep';
  if (category === 'Font' && use.FontSelected.has(name)) return isNeutralFont(context, value) ? 'keep' : 'neutralise';
  // A pattern still selected by scn/SCN whose painting was all removed: the
  // name must stay bound (an unbound name is an invalid page) but not to data.
  if (category === 'Pattern' && use.PatternSelected.has(name)) return isNeutralPattern(context, value) ? 'keep' : 'neutralise';
  return 'drop';
}

/** Entries of a prunable sub-dictionary that `use` does not justify. */
export function undrawnNames(context: PDFContext, resources: PDFDict | undefined, use: ResourceUse): Array<{ category: PrunableCategory; name: string }> {
  const out: Array<{ category: PrunableCategory; name: string }> = [];
  for (const category of PRUNABLE_CATEGORIES) {
    const sub = subDict(context, resources, category);
    if (!sub) continue;
    for (const [key, value] of sub.entries()) {
      const name = key.decodeText();
      if (bindingUse(context, category, name, value, use) !== 'keep') out.push({ category, name });
    }
  }
  return out;
}

/**
 * Verifier check: every prunable binding (/XObject, /Pattern, /Font,
 * /ExtGState, /Properties) reachable from
 * `resources` (and, recursively, from the resources of every form, tiling
 * pattern and Type3 font the content draws) must be used by some content op.
 * Returns findings; an empty list means the check ran and found nothing.
 * Content that cannot be examined is returned as `not-examined`, never
 * dropped.
 */
export interface ResourceAuditFinding {
  kind: 'unused-binding' | 'not-examined';
  message: string;
}

export function auditResourceUse(context: PDFContext, content: Uint8Array, resources: PDFDict | undefined, where: string): ResourceAuditFinding[] {
  const violations: ResourceAuditFinding[] = [];
  const unknown = (message: string) => violations.push({ kind: 'not-examined', message });
  const visited = new Set<PDFObject>();

  const audit = (data: Uint8Array, res: PDFDict | undefined, label: string, depth: number) => {
    if (violations.length >= 20) return;
    if (depth > MAX_DEPTH) {
      unknown(`${label}: nesting too deep to verify which resources are drawn`);
      return;
    }
    let use: ResourceUse;
    try {
      use = collectResourceUse(context, data, res);
    } catch (e) {
      unknown(`${label}: could not determine which resources are drawn (${(e as Error).message})`);
      return;
    }
    for (const { category, name } of undrawnNames(context, res, use)) {
      violations.push({ kind: 'unused-binding', message: `${label}: /${category} /${name} is in the resources but nothing draws it` });
    }
    for (const child of use.children) {
      if (visited.has(child.identity)) continue;
      visited.add(child.identity);
      const parts: Uint8Array[] = [];
      try {
        for (const s of child.streams) parts.push(decodeStreamStrict(s));
      } catch (e) {
        unknown(`${label} > ${child.label}: could not be decoded (${(e as Error).message})`);
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
