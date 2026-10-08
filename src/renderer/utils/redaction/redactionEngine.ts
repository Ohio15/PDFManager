/**
 * True redaction: orchestrates the content rewrite, image redaction, region /
 * page rasterization, annotation and metadata scrubbing, garbage collection,
 * and verification with automatic escalation.
 *
 * Flow:
 *   pass 1  — glyph/path/image-level redaction on every marked page;
 *   verify  — redactionVerifier (pdf.js oracle + rescan + term scan);
 *   pass 2  — pages that failed verification are redone from the ORIGINAL
 *             bytes as full-page rasters;
 *   verify  — if anything still fails, throw RedactionVerificationError.
 * Success is never returned without a passing verification.
 */
import { PDFDocument as PDFLib, PDFName } from 'pdf-lib';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import { IDENTITY, Rect, expandRect, fmt, intersects, unionRect } from './geometry';
import { concat, emptyStats, latin1Bytes, redactContent, RedactionStats, RedactorContext, UncertainRegion, WholePageFallback } from './contentRedactor';
import { collectGarbage, cutRemovedObjects, RemovedObject, removeAnnotationsUnderMarks, removeXfa, scrubPageExtras, stripDocumentMetadata } from './documentScrub';
import { ImageEncoder, Rgb, registerRgbImage } from './imageRedactor';
import { PdfjsEnv, openPdfjs } from './pdfjsEnv';
import { rasterizeRegion } from './rasterizer';
import { pageContentBytes, verifyRedaction, VerificationResult } from './redactionVerifier';
import { ResourceScope } from './resourceScope';
import { ResourceUsageUnknown, collectResourceUse } from './resourceUsage';

export interface RedactionMarkInput {
  /** 0-based physical page index. */
  pageIndex: number;
  /** Rectangles in PDF user space (bottom-left origin). */
  rects: Rect[];
}

export interface ApplyRedactionOptions {
  fill?: Rgb;
  stripMetadata?: boolean;
  /** Terms whose every occurrence was marked (search-and-redact); verified absent. */
  mustBeAbsent?: string[];
  /** Raster scale (1 = 72 dpi). Default 3 (216 dpi). */
  rasterScale?: number;
  encoder?: ImageEncoder;
}

export interface RasterizedArea {
  pageIndex: number;
  scope: 'region' | 'page';
  reason: string;
}

export interface RedactionReport {
  pagesRedacted: number[];
  stats: RedactionStats;
  annotationsRemoved: number;
  rasterized: RasterizedArea[];
  metadataStripped: boolean;
  objectsCollected: number;
  residualLocations: string[];
  verification: VerificationResult;
}

export class RedactionVerificationError extends Error {
  constructor(public readonly verification: VerificationResult) {
    const first = [...verification.pageViolations.entries()].map(([p, v]) => `page ${p + 1}: ${v[0]}`)[0] ?? verification.globalViolations[0] ?? 'unknown';
    super(`Redaction could not be verified (${first}). The document was NOT changed.`);
    this.name = 'RedactionVerificationError';
  }
}

const BLACK: Rgb = { r: 0, g: 0, b: 0 };

function rgbOp(fill: Rgb): string {
  return `${fmt(fill.r)} ${fmt(fill.g)} ${fmt(fill.b)} rg`;
}

function boxesContent(marks: Rect[], fill: Rgb): string {
  let s = `q ${rgbOp(fill)}\n`;
  for (const m of marks) s += `${fmt(m.x0)} ${fmt(m.y0)} ${fmt(m.x1 - m.x0)} ${fmt(m.y1 - m.y0)} re f\n`;
  return s + 'Q\n';
}

/** Merge overlapping uncertain regions so each area is rasterized once. */
function mergeRegions(regions: UncertainRegion[]): UncertainRegion[] {
  const out: UncertainRegion[] = [];
  for (const r of regions) {
    let cur = { rect: expandRect(r.rect, 1), reason: r.reason };
    let merged = true;
    while (merged) {
      merged = false;
      for (let i = 0; i < out.length; i++) {
        if (intersects(out[i].rect, cur.rect)) {
          cur = { rect: unionRect(out[i].rect, cur.rect), reason: out[i].reason === cur.reason ? cur.reason : `${out[i].reason}; ${cur.reason}` };
          out.splice(i, 1);
          merged = true;
          break;
        }
      }
    }
    out.push(cur);
  }
  return out;
}

function groupMarks(marks: RedactionMarkInput[]): Map<number, Rect[]> {
  const byPage = new Map<number, Rect[]>();
  for (const m of marks) {
    const rects = m.rects.filter((r) => r.x1 - r.x0 > 0.01 && r.y1 - r.y0 > 0.01);
    if (!rects.length) continue;
    byPage.set(m.pageIndex, [...(byPage.get(m.pageIndex) ?? []), ...rects]);
  }
  return byPage;
}

async function runPass(
  original: Uint8Array,
  byPage: Map<number, Rect[]>,
  forceRaster: Set<number>,
  opts: Required<Pick<ApplyRedactionOptions, 'fill' | 'stripMetadata' | 'rasterScale'>> & ApplyRedactionOptions,
  env: PdfjsEnv,
  originalPdfjs: () => Promise<PDFDocumentProxy>
): Promise<{ bytes: Uint8Array; stats: RedactionStats; annotationsRemoved: number; rasterized: RasterizedArea[]; collected: number; removed: RemovedObject[] }> {
  const pdfDoc = await PDFLib.load(original, { ignoreEncryption: true, updateMetadata: !opts.stripMetadata });
  const context = pdfDoc.context;
  const stats = emptyStats();
  const rasterized: RasterizedArea[] = [];
  let annotationsRemoved = 0;
  const fontCache = new Map();
  const removed = new Map<string, RemovedObject>();

  for (const [pageIndex, marks] of byPage) {
    if (pageIndex < 0 || pageIndex >= pdfDoc.getPageCount()) throw new Error(`Redaction mark on missing page ${pageIndex + 1}`);
    const pageDict = pdfDoc.getPage(pageIndex).node;
    let wholePageReason: string | null = forceRaster.has(pageIndex) ? 'Glyph-level removal could not be verified on this page' : null;

    if (!wholePageReason) {
      const rc: RedactorContext = {
        pdfDoc, context, marks, fill: opts.fill, env, encoder: opts.encoder, fontCache,
        stats: emptyStats(), uncertain: [], dryRun: false, findings: [],
      };
      try {
        const data = pageContentBytes(pdfDoc, pageIndex);
        const scope = new ResourceScope(context, pageDict.Resources());
        const result = await redactContent(rc, data, scope, IDENTITY, []);
        const parts: Uint8Array[] = [latin1Bytes('q'), result.bytes ?? data, latin1Bytes('Q')];
        for (const region of mergeRegions(rc.uncertain)) {
          const raster = await rasterizeRegion(await originalPdfjs(), pageIndex, region.rect, marks, opts.fill, opts.rasterScale);
          if (!raster) continue;
          const name = scope.addXObject('RdxR', registerRgbImage(context, raster.width, raster.height, raster.rgb));
          const r = raster.rect;
          parts.push(latin1Bytes(`q ${fmt(r.x1 - r.x0)} 0 0 ${fmt(r.y1 - r.y0)} ${fmt(r.x0)} ${fmt(r.y0)} cm /${name} Do Q`));
          rasterized.push({ pageIndex, scope: 'region', reason: region.reason });
        }
        parts.push(latin1Bytes(boxesContent(marks, opts.fill)));
        const finalContent = concat(parts, 0x0a);
        // Replacing is add-a-new-binding + rewrite-the-Do; the original stays
        // bound (and therefore reachable and written) until the page's
        // resources are rebuilt from what the final content draws.
        try {
          scope.pruneTo(collectResourceUse(context, finalContent, scope.finalDict()));
        } catch (e) {
          if (e instanceof ResourceUsageUnknown) throw new WholePageFallback(`Page resources could not be pruned (${e.message})`);
          throw e;
        }
        pageDict.set(PDFName.of('Contents'), context.register(context.flateStream(finalContent)));
        pageDict.set(PDFName.of('Resources'), scope.finalDict() ?? context.obj({}));
        for (const k of Object.keys(stats) as Array<keyof RedactionStats>) stats[k] += rc.stats[k];
      } catch (e) {
        if (!(e instanceof WholePageFallback)) throw e;
        wholePageReason = e.reason;
      }
    }

    if (wholePageReason) {
      const raster = await rasterizeRegion(await originalPdfjs(), pageIndex, 'page', marks, opts.fill, opts.rasterScale);
      if (!raster) throw new Error(`Page ${pageIndex + 1} could not be rasterized`);
      const ref = registerRgbImage(context, raster.width, raster.height, raster.rgb);
      const r = raster.rect;
      const content = `q ${fmt(r.x1 - r.x0)} 0 0 ${fmt(r.y1 - r.y0)} ${fmt(r.x0)} ${fmt(r.y0)} cm /RdxPage1 Do Q\n${boxesContent(marks, opts.fill)}`;
      pageDict.set(PDFName.of('Contents'), context.register(context.flateStream(content)));
      pageDict.set(PDFName.of('Resources'), context.obj({ XObject: { RdxPage1: ref } }));
      rasterized.push({ pageIndex, scope: 'page', reason: wholePageReason });
    }

    annotationsRemoved += removeAnnotationsUnderMarks(pdfDoc, pageIndex, marks, removed);
    scrubPageExtras(pageDict);
  }

  // Removing an annotation from /Annots is one edge; cut every other inbound
  // reference (structure tree, /IRT, /CO, /Parent, ...) so GC can drop it.
  cutRemovedObjects(pdfDoc, removed);
  // XFA is a parallel copy of the form (template text and every field value)
  // that this engine does not rewrite; it cannot survive a redaction.
  removeXfa(pdfDoc);
  if (opts.stripMetadata) stripDocumentMetadata(pdfDoc);
  const collected = collectGarbage(pdfDoc);
  const bytes = await pdfDoc.save({ updateFieldAppearances: false });
  return { bytes, stats, annotationsRemoved, rasterized, collected, removed: [...removed.values()] };
}

export async function applyRedactions(
  pdfBytes: Uint8Array,
  marks: RedactionMarkInput[],
  options: ApplyRedactionOptions,
  env: PdfjsEnv
): Promise<{ bytes: Uint8Array; report: RedactionReport }> {
  const byPage = groupMarks(marks);
  if (byPage.size === 0) throw new Error('No redaction marks to apply');
  const opts = { fill: options.fill ?? BLACK, stripMetadata: !!options.stripMetadata, rasterScale: options.rasterScale ?? 3, ...options };
  opts.fill = options.fill ?? BLACK;

  let pdfjsDoc: PDFDocumentProxy | null = null;
  const originalPdfjs = async () => (pdfjsDoc ??= await openPdfjs(env, pdfBytes));

  try {
    const forced = new Set<number>();
    let pass = await runPass(pdfBytes, byPage, forced, opts, env, originalPdfjs);
    let verification = await verifyRedaction(pass.bytes, byPage, opts.fill, env, opts.mustBeAbsent ?? [], pass.removed);

    if (!verification.ok) {
      for (const p of verification.pageViolations.keys()) forced.add(p);
      if (forced.size > 0) {
        pass = await runPass(pdfBytes, byPage, forced, opts, env, originalPdfjs);
        verification = await verifyRedaction(pass.bytes, byPage, opts.fill, env, opts.mustBeAbsent ?? [], pass.removed);
      }
    }
    if (!verification.ok) throw new RedactionVerificationError(verification);

    return {
      bytes: pass.bytes,
      report: {
        pagesRedacted: [...byPage.keys()].sort((a, b) => a - b),
        stats: pass.stats,
        annotationsRemoved: pass.annotationsRemoved,
        rasterized: pass.rasterized,
        metadataStripped: opts.stripMetadata,
        objectsCollected: pass.collected,
        residualLocations: verification.residualLocations,
        verification,
      },
    };
  } finally {
    if (pdfjsDoc) await (pdfjsDoc as PDFDocumentProxy).destroy();
  }
}
