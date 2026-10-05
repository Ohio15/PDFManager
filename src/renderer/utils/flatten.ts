/**
 * flatten — burn annotation and form-widget appearances into page content.
 *
 * Why not pdf-lib's PDFForm.flatten(): it translates the appearance to the
 * widget origin but ignores the appearance /Matrix and a /BBox that does not
 * start at 0,0 (both common for rotated fields and Acrobat-authored forms), it
 * draws hidden widgets, and it only handles fields. This module follows
 * PDF 32000-1 §12.5.5 (Algorithm "appearance streams"): transform the BBox by
 * the form Matrix, then map that box onto the annotation /Rect.
 *
 * Page content is isolated first (pdf-lib normalize() wraps the existing
 * streams in q…Q), so an unbalanced CTM in the original content cannot skew
 * the burned-in appearances.
 */

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFNumber,
  PDFStream,
  PDFObject,
  PDFPage,
} from 'pdf-lib';
import { removeUnreachableObjects } from './pdfObjectGraph';

export type FlattenScope = 'annotations' | 'forms' | 'both';

export interface FlattenOptions {
  scope: FlattenScope;
  /**
   * Annotation refs ("12 0 R") to remove even though they have no appearance
   * stream, because their visual is already part of the page content (the
   * save pipeline draws sticky-note markers into content and adds an
   * appearance-less /Text annotation only to carry the note text).
   */
  removeWithoutDrawing?: Set<string>;
}

export interface FlattenReport {
  /** Form widgets whose appearance was drawn into page content. */
  widgetsFlattened: number;
  /** Terminal + non-terminal fields removed with the AcroForm. */
  fieldsRemoved: number;
  /** Non-widget annotations drawn into page content. */
  annotationsFlattened: number;
  /** Hidden / NoView annotations or widgets removed without drawing. */
  hiddenRemoved: number;
  /** Annotations left in place because they have no appearance stream to burn. */
  annotationsWithoutAppearance: number;
  /** Interactive annotations (links, media, attachments, redaction marks) intentionally kept. */
  interactiveKept: number;
  /** Fields whose appearance could not be regenerated (drawn with their stored appearance). */
  appearanceFailures: number;
}

/** Annotation types that are not markup: flattening would destroy behaviour, not "finalize" a look. */
const KEEP_SUBTYPES = new Set([
  'Link', 'Screen', 'Movie', 'Sound', 'RichMedia', '3D', 'FileAttachment', 'Redact', 'Projection',
]);

const FLAG_HIDDEN = 2;
const FLAG_NO_VIEW = 32;

interface DrawCommand {
  apRef: PDFRef;
  matrix: [number, number, number, number, number, number];
  ocRef?: PDFObject;
}

function emptyReport(): FlattenReport {
  return {
    widgetsFlattened: 0,
    fieldsRemoved: 0,
    annotationsFlattened: 0,
    hiddenRemoved: 0,
    annotationsWithoutAppearance: 0,
    interactiveKept: 0,
    appearanceFailures: 0,
  };
}

function nums(arr: PDFArray | undefined, expected: number): number[] | null {
  if (!arr || arr.size() < expected) return null;
  const out: number[] = [];
  for (let i = 0; i < expected; i++) {
    const v = arr.lookup(i);
    if (!(v instanceof PDFNumber)) return null;
    out.push(v.asNumber());
  }
  return out;
}

function fmt(n: number): string {
  if (!Number.isFinite(n)) return '0';
  const rounded = Math.round(n * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

function subtypeOf(dict: PDFDict): string {
  const st = dict.lookup(PDFName.of('Subtype'));
  return st instanceof PDFName ? st.decodeText() : '';
}

/** Resolve the normal appearance stream ref for the annotation's current state. */
function resolveNormalAppearance(doc: PDFDocument, annot: PDFDict): { ref: PDFRef; stream: PDFStream } | null {
  const context = doc.context;
  const ap = annot.lookupMaybe(PDFName.of('AP'), PDFDict);
  if (!ap) return null;
  let entry: PDFObject | undefined = ap.get(PDFName.of('N'));
  let resolved = entry instanceof PDFRef ? context.lookup(entry) : entry;

  if (resolved instanceof PDFDict && !(resolved instanceof PDFStream)) {
    // State dictionary (check boxes, radio buttons): pick /AS.
    const states = resolved;
    const as = annot.lookup(PDFName.of('AS'));
    let stateName: PDFName | undefined = as instanceof PDFName ? as : undefined;
    if (!stateName) {
      const keys = states.keys();
      if (keys.length === 1) stateName = keys[0];
    }
    if (!stateName) return null;
    entry = states.get(stateName);
    resolved = entry instanceof PDFRef ? context.lookup(entry) : entry;
  }

  if (!(resolved instanceof PDFStream)) return null;
  const ref = entry instanceof PDFRef ? entry : context.register(resolved);
  return { ref, stream: resolved };
}

/**
 * Matrix mapping the appearance form space onto the annotation rectangle
 * (the "A" of §12.5.5; the form's own /Matrix is applied by Do).
 */
function appearanceToRectMatrix(
  annot: PDFDict,
  stream: PDFStream
): [number, number, number, number, number, number] | null {
  const rect = nums(annot.lookupMaybe(PDFName.of('Rect'), PDFArray), 4);
  if (!rect) return null;
  const x1 = Math.min(rect[0], rect[2]);
  const y1 = Math.min(rect[1], rect[3]);
  const x2 = Math.max(rect[0], rect[2]);
  const y2 = Math.max(rect[1], rect[3]);
  if (x2 - x1 <= 0 || y2 - y1 <= 0) return null;

  const dict = stream.dict;
  let bbox = nums(dict.lookupMaybe(PDFName.of('BBox'), PDFArray), 4);
  if (!bbox) {
    bbox = [0, 0, x2 - x1, y2 - y1];
    dict.set(PDFName.of('BBox'), dict.context.obj(bbox));
  }
  const m = nums(dict.lookupMaybe(PDFName.of('Matrix'), PDFArray), 6) ?? [1, 0, 0, 1, 0, 0];

  const corners = [
    [bbox[0], bbox[1]], [bbox[2], bbox[1]], [bbox[0], bbox[3]], [bbox[2], bbox[3]],
  ].map(([x, y]) => [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]);
  const minX = Math.min(...corners.map((c) => c[0]));
  const maxX = Math.max(...corners.map((c) => c[0]));
  const minY = Math.min(...corners.map((c) => c[1]));
  const maxY = Math.max(...corners.map((c) => c[1]));
  if (maxX - minX <= 0 || maxY - minY <= 0) return null;

  const sx = (x2 - x1) / (maxX - minX);
  const sy = (y2 - y1) / (maxY - minY);
  return [sx, 0, 0, sy, x1 - minX * sx, y1 - minY * sy];
}

/** Ensure the appearance stream is usable as a Form XObject operand of Do. */
function asFormXObject(stream: PDFStream): void {
  const dict = stream.dict;
  if (!dict.has(PDFName.of('Type'))) dict.set(PDFName.of('Type'), PDFName.of('XObject'));
  if (!dict.has(PDFName.of('Subtype'))) dict.set(PDFName.of('Subtype'), PDFName.of('Form'));
}

/**
 * Regenerate stale or missing field appearances so the burned-in content shows
 * the current values. Per-field: one exotic field must not abort the flatten.
 */
function prepareFieldAppearances(doc: PDFDocument, report: FlattenReport): number {
  const form = doc.getForm();
  const needAll = form.acroForm.dict.lookup(PDFName.of('NeedAppearances'))?.toString() === 'true';
  const fields = form.getFields();
  let font;
  try {
    font = form.getDefaultFont();
  } catch (e) {
    console.warn('[flatten] Could not embed default font for appearances:', e);
  }
  for (const field of fields) {
    try {
      if (font && (needAll || field.needsAppearancesUpdate())) field.defaultUpdateAppearances(font);
    } catch (e) {
      report.appearanceFailures++;
      console.warn(`[flatten] Appearance regeneration failed for "${field.getName()}":`, e);
    }
  }
  return fields.length;
}

function uniqueResourceName(dict: PDFDict, prefix: string): PDFName {
  for (let i = 1; ; i++) {
    const name = PDFName.of(`${prefix}${i}`);
    if (!dict.has(name)) return name;
  }
}

function emitDraws(doc: PDFDocument, page: PDFPage, draws: DrawCommand[]): void {
  if (draws.length === 0) return;
  const context = doc.context;
  // normalize(): Contents → array wrapped in q…Q, Resources/XObject materialized.
  page.node.normalize();
  const resources = page.node.Resources()!;
  let properties: PDFDict | undefined;

  let ops = 'q\n';
  for (const draw of draws) {
    const xName = page.node.newXObject('FlatAnnot', draw.apRef);
    const cm = draw.matrix.map(fmt).join(' ');
    if (draw.ocRef) {
      if (!properties) {
        properties = resources.lookupMaybe(PDFName.of('Properties'), PDFDict);
        if (!properties) {
          properties = context.obj({});
          resources.set(PDFName.of('Properties'), properties);
        }
      }
      const ocName = uniqueResourceName(properties, 'FlatOC');
      properties.set(ocName, draw.ocRef);
      ops += `/OC ${ocName.toString()} BDC q ${cm} cm ${xName.toString()} Do Q EMC\n`;
    } else {
      ops += `q ${cm} cm ${xName.toString()} Do Q\n`;
    }
  }
  ops += 'Q\n';
  const streamRef = context.register(context.flateStream(ops));
  page.node.addContentStream(streamRef);
}

export async function flattenPdf(
  bytes: Uint8Array,
  options: FlattenOptions
): Promise<{ bytes: Uint8Array; report: FlattenReport }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const report = emptyReport();
  const includeForms = options.scope !== 'annotations';
  const includeAnnots = options.scope !== 'forms';
  const removeWithoutDrawing = options.removeWithoutDrawing ?? new Set<string>();
  const hasAcroForm = doc.catalog.has(PDFName.of('AcroForm'));

  if (includeForms && hasAcroForm) {
    report.fieldsRemoved = prepareFieldAppearances(doc, report);
  }

  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots || annots.size() === 0) continue;

    const draws: DrawCommand[] = [];
    const kept: PDFObject[] = [];
    const removed = new Set<string>();
    const popups: Array<{ entry: PDFObject; dict: PDFDict }> = [];

    for (let i = 0; i < annots.size(); i++) {
      const entry = annots.get(i);
      const dict = entry instanceof PDFRef ? doc.context.lookup(entry) : entry;
      if (!(dict instanceof PDFDict)) {
        kept.push(entry);
        continue;
      }
      const refKey = entry instanceof PDFRef ? entry.toString() : '';
      const subtype = subtypeOf(dict);
      const isWidget = subtype === 'Widget';

      if (subtype === 'Popup') {
        popups.push({ entry, dict });
        continue;
      }
      if (isWidget ? !includeForms : !includeAnnots) {
        kept.push(entry);
        continue;
      }
      if (!isWidget && KEEP_SUBTYPES.has(subtype)) {
        report.interactiveKept++;
        kept.push(entry);
        continue;
      }

      const markRemoved = () => {
        if (refKey) removed.add(refKey);
      };
      const flags = dict.lookup(PDFName.of('F'));
      const flagValue = flags instanceof PDFNumber ? flags.asNumber() : 0;
      if (flagValue & (FLAG_HIDDEN | FLAG_NO_VIEW)) {
        report.hiddenRemoved++;
        markRemoved();
        continue;
      }

      const appearance = resolveNormalAppearance(doc, dict);
      const matrix = appearance ? appearanceToRectMatrix(dict, appearance.stream) : null;
      if (!appearance || !matrix) {
        if (isWidget || (refKey && removeWithoutDrawing.has(refKey))) {
          // A widget with no appearance (e.g. an "Off" state with no Off
          // stream) renders nothing; the field itself is being removed.
          markRemoved();
        } else {
          report.annotationsWithoutAppearance++;
          kept.push(entry);
        }
        continue;
      }

      asFormXObject(appearance.stream);
      draws.push({ apRef: appearance.ref, matrix, ocRef: dict.get(PDFName.of('OC')) });
      if (isWidget) report.widgetsFlattened++;
      else report.annotationsFlattened++;
      markRemoved();
    }

    // A popup is only meaningful with its parent markup annotation.
    for (const popup of popups) {
      const parent = popup.dict.get(PDFName.of('Parent'));
      const parentGone = parent instanceof PDFRef && removed.has(parent.toString());
      if (!parentGone) kept.push(popup.entry);
    }

    emitDraws(doc, page, draws);

    if (kept.length === 0) {
      page.node.delete(PDFName.of('Annots'));
    } else if (kept.length !== annots.size()) {
      page.node.set(PDFName.of('Annots'), doc.context.obj(kept));
    }
  }

  if (includeForms && hasAcroForm) {
    // Every widget is gone, so the field tree (and any XFA) no longer
    // describes anything on the page.
    doc.catalog.delete(PDFName.of('AcroForm'));
  }

  removeUnreachableObjects(doc);
  const out = await doc.save({ updateFieldAppearances: false });
  return { bytes: new Uint8Array(out), report };
}

/** Count what a flatten would touch, for the confirmation dialog. */
export async function countFlattenTargets(bytes: Uint8Array): Promise<{ widgets: number; annotations: number }> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  let widgets = 0;
  let annotations = 0;
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = 0; i < annots.size(); i++) {
      const dict = annots.lookup(i);
      if (!(dict instanceof PDFDict)) continue;
      const subtype = subtypeOf(dict);
      if (subtype === 'Widget') widgets++;
      else if (subtype !== 'Popup' && !KEEP_SUBTYPES.has(subtype)) annotations++;
    }
  }
  return { widgets, annotations };
}
