/**
 * Post-redaction verification. A redaction is only reported successful when
 * every check below ran and found nothing:
 *
 *  1. pdf.js oracle (independent font decoding): no glyph centre, no vector
 *     path coordinate inside a mark; every image touching a mark is decoded
 *     and its pixels under the mark are the fill colour; no annotation
 *     overlaps a mark. Unverifiable images count as violations.
 *  2. Own-engine rescan (dry run): the redactor itself finds nothing left to
 *     remove — catches rewrite bugs the oracle could miss.
 *  3. Must-be-absent terms (search-and-redact): the term is absent from pdf.js
 *     text extraction of every page and from every decoded content stream.
 *     Occurrences in metadata / bookmarks / form values are reported as
 *     residual locations (not page content) so the user can strip them.
 *  4. Presence, not just drawing (checks 1-3 only see what is DRAWN or
 *     LISTED; the file can still CONTAIN the original):
 *     - every /XObject and /Pattern binding reachable from a marked page's
 *       resources is drawn by some remaining content op (a replaced original
 *       left bound under its old name is a violation);
 *     - no object the engine removed (annotation, widget, field, structure
 *       node) is still present in the output;
 *     - no annotation anywhere in the file that belongs to a marked page
 *       (/P) overlaps a mark, whether or not the page /Annots lists it;
 *     - no AcroForm /XFA (an unredacted parallel copy of the form) remains.
 */
import { PDFArray, PDFDict, PDFDocument as PDFLib, PDFHexString, PDFName, PDFRef, PDFStream, PDFString } from 'pdf-lib';
import { IDENTITY, Rect, applyToPoint, insetRect, intersects, pointInAny } from './geometry';
import { emptyStats, redactContent, RedactorContext, WholePageFallback } from './contentRedactor';
import { Rgb } from './imageRedactor';
import { PdfjsEnv, imageDataToRgba, openPdfjs } from './pdfjsEnv';
import { scanPdfjsPage } from './pdfjsScan';
import { decodeStreamStrict, dictGet, getDict, getName, numberArray } from './pdfObjects';
import { auditResourceUse } from './resourceUsage';
import type { RemovedObject } from './documentScrub';
import { ResourceScope } from './resourceScope';
import { concat } from './contentRedactor';

export interface VerificationResult {
  ok: boolean;
  pageViolations: Map<number, string[]>;
  globalViolations: string[];
  /** Places outside page content where a must-be-absent term still appears. */
  residualLocations: string[];
  checks: { glyphs: number; paths: number; images: number; annotations: number; pages: number };
}

const PIXEL_TOLERANCE = 24;

export function normalizeForSearch(s: string): string {
  return s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();
}

export async function verifyRedaction(
  bytes: Uint8Array,
  marksByPage: Map<number, Rect[]>,
  fill: Rgb,
  env: PdfjsEnv,
  mustBeAbsent: string[] = [],
  /** Objects the engine removed; each must be absent from the output. */
  removedObjects: RemovedObject[] = []
): Promise<VerificationResult> {
  const pageViolations = new Map<number, string[]>();
  const globalViolations: string[] = [];
  const residualLocations: string[] = [];
  const checks = { glyphs: 0, paths: 0, images: 0, annotations: 0, pages: 0 };
  const add = (p: number, msg: string) => {
    const list = pageViolations.get(p) ?? [];
    if (list.length < 20) list.push(msg);
    pageViolations.set(p, list);
  };
  const fr = Math.round(fill.r * 255), fg = Math.round(fill.g * 255), fb = Math.round(fill.b * 255);

  const doc = await openPdfjs(env, bytes);
  try {
    for (const [pageIndex, rawMarks] of marksByPage) {
      if (pageIndex >= doc.numPages) {
        add(pageIndex, 'Page missing from output');
        continue;
      }
      const marks = rawMarks.map((m) => insetRect(m, 0.5));
      const page = await doc.getPage(pageIndex + 1);
      const scan = await scanPdfjsPage(page, env.lib.OPS, { marks });
      checks.pages++;

      // Fail closed: content the oracle could not examine is never "clean".
      for (const reason of new Set(scan.unexamined)) {
        add(pageIndex, `Could not be verified: ${reason}`);
      }

      for (const g of scan.glyphs) {
        checks.glyphs++;
        if (pointInAny(g.center, marks)) add(pageIndex, `Text glyph "${g.unicode}" remains under a mark`);
      }
      for (const path of scan.paths) {
        checks.paths++;
        if (path.points.some((p) => pointInAny(p, marks))) {
          add(pageIndex, 'Vector path coordinates remain under a mark');
        }
      }
      for (const img of scan.images) {
        if (!marks.some((m) => intersects(img.bounds, m))) continue;
        checks.images++;
        const data = img.kind === 'mask' || img.kind === 'group' ? null : await img.load();
        if (!data || !data.data) {
          add(pageIndex, `Image (${img.kind}) under a mark could not be verified`);
          continue;
        }
        const rgba = imageDataToRgba(data);
        const { width, height } = data;
        let bad = 0;
        for (let y = 0; y < height && bad === 0; y++) {
          for (let x = 0; x < width; x++) {
            const p = applyToPoint(img.ctm, (x + 0.5) / width, 1 - (y + 0.5) / height);
            if (!pointInAny(p, marks, 0.5)) continue;
            const o = (y * width + x) * 4;
            if (
              Math.abs(rgba[o] - fr) > PIXEL_TOLERANCE ||
              Math.abs(rgba[o + 1] - fg) > PIXEL_TOLERANCE ||
              Math.abs(rgba[o + 2] - fb) > PIXEL_TOLERANCE ||
              rgba[o + 3] !== 255
            ) {
              bad++;
              break;
            }
          }
        }
        if (bad) add(pageIndex, 'Image pixels under a mark are not redacted');
      }
      const annots = (await page.getAnnotations()) as Array<{ rect?: number[]; subtype?: string }>;
      for (const a of annots) {
        if (!a.rect || a.rect.length !== 4) continue;
        checks.annotations++;
        const r: Rect = { x0: Math.min(a.rect[0], a.rect[2]), y0: Math.min(a.rect[1], a.rect[3]), x1: Math.max(a.rect[0], a.rect[2]), y1: Math.max(a.rect[1], a.rect[3]) };
        if (marks.some((m) => intersects(r, m))) add(pageIndex, `Annotation (${a.subtype ?? 'unknown'}) overlaps a mark`);
      }
      page.cleanup();
    }

    if (mustBeAbsent.length) {
      const terms = mustBeAbsent.map(normalizeForSearch).filter((t) => t.length > 0);
      for (let i = 1; i <= doc.numPages; i++) {
        const page = await doc.getPage(i);
        const tc = await page.getTextContent();
        const text = normalizeForSearch(tc.items.map((it) => ('str' in it ? it.str : '')).join(''));
        for (const t of terms) if (text.includes(t)) add(i - 1, `Search term still extractable from page ${i}`);
      }
    }
  } finally {
    await doc.destroy();
  }

  // Own-engine rescan.
  const lib = await PDFLib.load(bytes, { ignoreEncryption: true, updateMetadata: false });
  for (const [pageIndex, marks] of marksByPage) {
    if (pageIndex >= lib.getPageCount()) continue;
    const rc: RedactorContext = {
      pdfDoc: lib, context: lib.context, marks, fill, env, fontCache: new Map(),
      stats: emptyStats(), uncertain: [], dryRun: true, findings: [],
    };
    try {
      const data = pageContentBytes(lib, pageIndex);
      await redactContent(rc, data, new ResourceScope(lib.context, lib.getPage(pageIndex).node.Resources()), IDENTITY, []);
      for (const f of rc.findings) add(pageIndex, `Rescan: ${f}`);
    } catch (e) {
      if (e instanceof WholePageFallback) add(pageIndex, `Rescan: ${e.reason}`);
      else add(pageIndex, `Rescan failed: ${(e as Error).message}`);
    }
    // Bound but not drawn: the redacted-away original of a replaced image or form.
    try {
      const resources = lib.getPage(pageIndex).node.Resources();
      for (const v of auditResourceUse(lib.context, pageContentBytes(lib, pageIndex), resources, 'Page resources')) add(pageIndex, v);
    } catch (e) {
      add(pageIndex, `Resource check failed: ${(e as Error).message}`);
    }
  }

  // Removed objects must be gone from the file, not merely unlisted.
  for (const r of removedObjects) {
    if (lib.context.lookup(r.ref) !== undefined) globalViolations.push(`Removed ${r.kind} ${r.ref.toString()} is still present in the output`);
  }
  // Annotations of a marked page under a mark, however they are reached.
  const markedPageRefs = new Map<string, Rect[]>();
  for (const [pageIndex, rawMarks] of marksByPage) {
    if (pageIndex < lib.getPageCount()) markedPageRefs.set(lib.getPage(pageIndex).ref.toString(), rawMarks.map((m) => insetRect(m, 0.5)));
  }
  for (const [ref, obj] of lib.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFDict)) continue;
    const p = obj.get(PDFName.of('P'));
    const marks = p instanceof PDFRef ? markedPageRefs.get(p.toString()) : undefined;
    if (!marks || !getName(lib.context, dictGet(obj, 'Subtype'))) continue;
    const r = numberArray(lib.context, dictGet(obj, 'Rect'));
    if (!r || r.length !== 4) continue;
    const rect: Rect = { x0: Math.min(r[0], r[2]), y0: Math.min(r[1], r[3]), x1: Math.max(r[0], r[2]), y1: Math.max(r[1], r[3]) };
    if (marks.some((m) => intersects(rect, m))) globalViolations.push(`Annotation ${ref.toString()} of a marked page overlaps a mark`);
  }
  if (getDict(lib.context, lib.catalog.get(PDFName.of('AcroForm')))?.has(PDFName.of('XFA'))) {
    globalViolations.push('AcroForm /XFA (an unredacted copy of the form and its values) is still present');
  }

  if (mustBeAbsent.length) {
    const needles = mustBeAbsent.filter((t) => t.trim().length > 0);
    for (const [ref, obj] of lib.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFStream) {
        const subtype = getName(lib.context, obj.dict.get(PDFName.of('Subtype')));
        if (subtype === 'Image') continue;
        let text: string;
        try {
          text = new TextDecoder('latin1').decode(decodeStreamStrict(obj));
        } catch {
          const msg = `Stream ${ref.toString()} could not be decoded to check for the term`;
          if (!subtype || subtype === 'Form') globalViolations.push(msg);
          else residualLocations.push(msg);
          continue;
        }
        const lower = text.toLowerCase();
        for (const n of needles) {
          if (lower.includes(n.toLowerCase())) {
            const isContent = !subtype || subtype === 'Form';
            const msg = `Term "${n}" found in stream ${ref.toString()}`;
            if (isContent) globalViolations.push(msg);
            else residualLocations.push(msg);
          }
        }
      }
      scanStrings(obj, needles, ref.toString(), residualLocations);
    }
  }

  const ok = pageViolations.size === 0 && globalViolations.length === 0;
  return { ok, pageViolations, globalViolations, residualLocations, checks };
}

function scanStrings(obj: unknown, needles: string[], where: string, out: string[], depth = 0): void {
  if (depth > 8) return;
  if (obj instanceof PDFString || obj instanceof PDFHexString) {
    const text = obj.decodeText().toLowerCase();
    for (const n of needles) if (text.includes(n.toLowerCase())) out.push(`Term "${n}" in a string value of object ${where}`);
  } else if (obj instanceof PDFDict) {
    for (const [, v] of obj.entries()) scanStrings(v, needles, where, out, depth + 1);
  } else if (obj instanceof PDFStream) {
    scanStrings(obj.dict, needles, where, out, depth + 1);
  } else if (obj instanceof PDFArray) {
    for (let i = 0; i < obj.size(); i++) scanStrings(obj.get(i), needles, where, out, depth + 1);
  }
}

/** Concatenate a page's decoded content streams. Throws on undecodable content. */
export function pageContentBytes(lib: PDFLib, pageIndex: number): Uint8Array {
  const node = lib.getPage(pageIndex).node;
  const contents = lib.context.lookup(node.get(PDFName.of('Contents')));
  const streams: PDFStream[] = [];
  if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const s = lib.context.lookup(contents.get(i));
      if (s instanceof PDFStream) streams.push(s);
    }
  } else if (contents instanceof PDFStream) {
    streams.push(contents);
  }
  return concat(streams.map((s) => decodeStreamStrict(s)), 0x0a);
}
