/**
 * formBuilder — AcroForm field authoring on raw PDF bytes (pdf-lib).
 *
 * Every operation is a pure bytes → bytes transform so the hook can commit it
 * like a structural op (runStructural + commitDocument + history) and the
 * viewer reloads, letting pdf.js rebuild the widget layer and the
 * FormFieldMapping list from the new bytes.
 *
 * Interop decisions (verified against pdf-lib 1.17.1 output):
 * - pdf-lib writes a field DA naming /Helvetica but never adds it to the
 *   AcroForm /DR, so Acrobat cannot resolve the font when the user types.
 *   ensureDefaultResources() registers the fonts every DA we write refers to.
 * - Appearance streams are generated per touched field (never form-wide), so a
 *   foreign field we did not edit keeps its original appearance. If pdf-lib
 *   cannot build an appearance (non-WinAnsi value), /NeedAppearances is set so
 *   conforming viewers regenerate it instead of showing a stale one.
 * - addToPage() grows the widget rect by borderWidth/2 on every side; we
 *   pre-shrink so the stored /Rect is exactly what the user drew.
 */

import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFRef,
  PDFString,
  PDFHexString,
  PDFBool,
  PDFPage,
  PDFForm,
  PDFField,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
  PDFSignature,
  PDFButton,
  PDFFont,
  StandardFonts,
  degrees,
} from 'pdf-lib';
import { removeUnreachableObjects } from './pdfObjectGraph';

export type FormFieldKind = 'text' | 'checkbox' | 'radio' | 'dropdown' | 'listbox' | 'signature' | 'button';
export type CreatableFieldKind = Exclude<FormFieldKind, 'button'>;

/** Rectangle in PDF user space (origin bottom-left, points). */
export interface FieldRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface FormWidgetInfo {
  pageIndex: number;
  rect: FieldRect;
  /** Radio groups only: the option this widget represents. */
  option?: string;
}

export interface FormFieldInfo {
  name: string;
  kind: FormFieldKind;
  widgets: FormWidgetInfo[];
  required: boolean;
  readOnly: boolean;
  multiline: boolean;
  /** Font size from the field DA; 0 means auto-size; null when not applicable. */
  fontSize: number | null;
  /** Text: the /DV string. Checkbox: 'checked' or ''. Choice/radio: the default option. */
  defaultValue: string;
  /** Dropdown/list: the choices. Radio: one entry per widget. */
  options: string[];
}

/** pdf.js-equivalent page geometry used to map PDF space onto the rendered page. */
export interface PageGeometry {
  /** Visible box [x0, y0, x1, y1] = CropBox ∩ MediaBox, normalized. */
  view: [number, number, number, number];
  rotation: number;
}

export interface FormModel {
  fields: FormFieldInfo[];
  pages: PageGeometry[];
}

export interface NewFieldSpec {
  kind: CreatableFieldKind;
  /** Omit to get the next free "Text1"/"Checkbox2"… name in the document. */
  name?: string;
  pageIndex: number;
  rect: FieldRect;
  required?: boolean;
  readOnly?: boolean;
  defaultValue?: string;
  fontSize?: number;
  multiline?: boolean;
  /** Dropdown/list choices, or radio option names (one widget each). */
  options?: string[];
}

export interface FieldPropertyUpdate {
  name?: string;
  required?: boolean;
  readOnly?: boolean;
  defaultValue?: string;
  fontSize?: number;
  multiline?: boolean;
  options?: string[];
}

export class FormBuilderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormBuilderError';
  }
}

const BORDER_WIDTH = 1;
const MIN_FIELD_SIZE = 4;
const MAX_NAME_LENGTH = 120;
const DEFAULT_FONT_SIZE = 12;
const LOAD_OPTIONS = { updateMetadata: false } as const;
const SAVE_OPTIONS = { updateFieldAppearances: false } as const;

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

const KIND_LABEL: Record<CreatableFieldKind, string> = {
  text: 'Text',
  checkbox: 'Checkbox',
  radio: 'Radio',
  dropdown: 'Dropdown',
  listbox: 'List',
  signature: 'Signature',
};

/**
 * Validate a (terminal, partial) field name. Returns an error message, or
 * null when valid. `existingNames` are fully-qualified names in the document.
 */
export function validateFieldName(
  name: string,
  existingNames: string[],
  currentName?: string
): string | null {
  const trimmed = name.trim();
  if (!trimmed) return 'A field name is required';
  if (trimmed !== name) return 'Field names cannot start or end with spaces';
  if (name.length > MAX_NAME_LENGTH) return `Field names are limited to ${MAX_NAME_LENGTH} characters`;
  if (name.includes('.')) return "Field names cannot contain '.' (it separates hierarchy levels)";
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(name)) return 'Field names cannot contain control characters';
  for (const existing of existingNames) {
    if (existing === currentName) continue;
    if (existing === name) return `A field named "${name}" already exists`;
    if (existing.startsWith(`${name}.`)) return `"${name}" is already used as a field group name`;
  }
  return null;
}

export function suggestFieldName(kind: CreatableFieldKind, existingNames: string[]): string {
  const taken = new Set(existingNames);
  const base = KIND_LABEL[kind];
  for (let n = 1; ; n++) {
    const candidate = `${base}${n}`;
    if (!taken.has(candidate) && validateFieldName(candidate, existingNames) === null) return candidate;
  }
}

function validateRect(rect: FieldRect): void {
  const values = [rect.x, rect.y, rect.width, rect.height];
  if (values.some((v) => !Number.isFinite(v))) throw new FormBuilderError('Field rectangle is not a finite number');
  if (rect.width < MIN_FIELD_SIZE || rect.height < MIN_FIELD_SIZE) {
    throw new FormBuilderError(`Fields must be at least ${MIN_FIELD_SIZE}pt wide and tall`);
  }
}

function normalizeOptions(options: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of options ?? []) {
    const value = raw.trim();
    if (value && !out.includes(value)) out.push(value);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

function hasAcroForm(doc: PDFDocument): boolean {
  return doc.catalog.has(PDFName.of('AcroForm'));
}

function fieldKind(field: PDFField): FormFieldKind {
  if (field instanceof PDFTextField) return 'text';
  if (field instanceof PDFCheckBox) return 'checkbox';
  if (field instanceof PDFRadioGroup) return 'radio';
  if (field instanceof PDFDropdown) return 'dropdown';
  if (field instanceof PDFOptionList) return 'listbox';
  if (field instanceof PDFSignature) return 'signature';
  return 'button';
}

/** Widget refs in the same order as acroField.getWidgets(). */
function widgetRefs(field: PDFField): PDFRef[] {
  const kids = field.acroField.dict.lookupMaybe(PDFName.of('Kids'), PDFArray);
  if (!kids) return [field.ref];
  const refs: PDFRef[] = [];
  for (let i = 0; i < kids.size(); i++) {
    const kid = kids.get(i);
    if (kid instanceof PDFRef) refs.push(kid);
  }
  return refs;
}

function buildAnnotPageMap(doc: PDFDocument): Map<string, number> {
  const map = new Map<string, number>();
  doc.getPages().forEach((page, index) => {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) return;
    for (let i = 0; i < annots.size(); i++) {
      const ref = annots.get(i);
      if (ref instanceof PDFRef && !map.has(ref.toString())) map.set(ref.toString(), index);
    }
  });
  return map;
}

function pageIndexForWidget(
  doc: PDFDocument,
  annotPageMap: Map<string, number>,
  widgetRef: PDFRef,
  widgetDict: PDFDict
): number {
  const fromAnnots = annotPageMap.get(widgetRef.toString());
  if (fromAnnots !== undefined) return fromAnnots;
  const pRef = widgetDict.get(PDFName.of('P'));
  if (pRef instanceof PDFRef) {
    const idx = doc.getPages().findIndex((p) => p.ref === pRef || p.ref.toString() === pRef.toString());
    if (idx >= 0) return idx;
  }
  return -1;
}

function decodePdfText(obj: unknown): string {
  if (obj instanceof PDFString || obj instanceof PDFHexString) return obj.decodeText();
  if (obj instanceof PDFName) return obj.decodeText();
  return '';
}

function parseFontSize(da: string | undefined): number | null {
  if (!da) return null;
  const match = da.match(/(-?\d+(?:\.\d+)?)\s+Tf/);
  return match ? Math.max(0, parseFloat(match[1])) : null;
}

/** Option label for each radio widget: /Opt entry when the on-state is an index, else the state name. */
function radioWidgetOptions(field: PDFRadioGroup): string[] {
  const opt = field.acroField.dict.lookupMaybe(PDFName.of('Opt'), PDFArray);
  return field.acroField.getWidgets().map((widget) => {
    const onValue = widget.getOnValue();
    const state = onValue ? onValue.decodeText() : '';
    if (opt && /^\d+$/.test(state)) {
      const idx = parseInt(state, 10);
      if (idx < opt.size()) {
        const label = decodePdfText(opt.lookup(idx));
        if (label) return label;
      }
    }
    return state;
  });
}

function radioStateForOption(field: PDFRadioGroup, option: string): PDFName | undefined {
  const labels = radioWidgetOptions(field);
  const widgets = field.acroField.getWidgets();
  const idx = labels.indexOf(option);
  return idx >= 0 ? widgets[idx].getOnValue() : undefined;
}

function readDefaultValue(field: PDFField, kind: FormFieldKind): string {
  const dv = field.acroField.dict.lookup(PDFName.of('DV'));
  if (!dv) return '';
  if (kind === 'checkbox') {
    return dv instanceof PDFName && dv.decodeText() !== 'Off' ? 'checked' : '';
  }
  if (kind === 'radio' && dv instanceof PDFName) {
    const state = dv.decodeText();
    const radio = field as PDFRadioGroup;
    const widgets = radio.acroField.getWidgets();
    const labels = radioWidgetOptions(radio);
    const idx = widgets.findIndex((w) => w.getOnValue()?.decodeText() === state);
    return idx >= 0 ? labels[idx] : '';
  }
  if (dv instanceof PDFArray) return dv.size() > 0 ? decodePdfText(dv.lookup(0)) : '';
  return decodePdfText(dv);
}

function pageGeometry(page: PDFPage): PageGeometry {
  const media = page.getMediaBox();
  const crop = page.getCropBox();
  const mx0 = Math.min(media.x, media.x + media.width);
  const mx1 = Math.max(media.x, media.x + media.width);
  const my0 = Math.min(media.y, media.y + media.height);
  const my1 = Math.max(media.y, media.y + media.height);
  const cx0 = Math.min(crop.x, crop.x + crop.width);
  const cx1 = Math.max(crop.x, crop.x + crop.width);
  const cy0 = Math.min(crop.y, crop.y + crop.height);
  const cy1 = Math.max(crop.y, crop.y + crop.height);
  // pdf.js: view = CropBox ∩ MediaBox, falling back to MediaBox when empty.
  const ix0 = Math.max(mx0, cx0);
  const iy0 = Math.max(my0, cy0);
  const ix1 = Math.min(mx1, cx1);
  const iy1 = Math.min(my1, cy1);
  const view: [number, number, number, number] =
    ix1 > ix0 && iy1 > iy0 ? [ix0, iy0, ix1, iy1] : [mx0, my0, mx1, my1];
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  return { view, rotation };
}

export async function readFormModel(bytes: Uint8Array): Promise<FormModel> {
  const doc = await PDFDocument.load(bytes, LOAD_OPTIONS);
  const pages = doc.getPages().map(pageGeometry);
  if (!hasAcroForm(doc)) return { fields: [], pages };

  const form = doc.getForm();
  const annotPageMap = buildAnnotPageMap(doc);
  const fields: FormFieldInfo[] = [];

  for (const field of form.getFields()) {
    const kind = fieldKind(field);
    const refs = widgetRefs(field);
    const widgetDicts = field.acroField.getWidgets();
    const radioOptions = field instanceof PDFRadioGroup ? radioWidgetOptions(field) : [];
    const widgets: FormWidgetInfo[] = [];
    widgetDicts.forEach((widget, i) => {
      const ref = refs[i] ?? field.ref;
      const pageIndex = pageIndexForWidget(doc, annotPageMap, ref, widget.dict);
      if (pageIndex < 0) return;
      const r = widget.getRectangle();
      widgets.push({
        pageIndex,
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
        ...(kind === 'radio' ? { option: radioOptions[i] } : {}),
      });
    });

    let options: string[] = [];
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) options = field.getOptions();
    else if (field instanceof PDFRadioGroup) options = radioOptions;

    const da = field.acroField.getDefaultAppearance();
    fields.push({
      name: field.getName(),
      kind,
      widgets,
      required: field.isRequired(),
      readOnly: field.isReadOnly(),
      multiline: field instanceof PDFTextField ? field.isMultiline() : false,
      fontSize: kind === 'text' || kind === 'dropdown' || kind === 'listbox' ? (parseFontSize(da) ?? 0) : null,
      defaultValue: readDefaultValue(field, kind),
      options,
    });
  }
  return { fields, pages };
}

// ---------------------------------------------------------------------------
// Resources and appearances
// ---------------------------------------------------------------------------

async function ensureDefaultResources(doc: PDFDocument, form: PDFForm, needZapf: boolean): Promise<PDFFont> {
  const context = doc.context;
  const acroDict = form.acroForm.dict;
  const helvetica = form.getDefaultFont();

  let dr = acroDict.lookupMaybe(PDFName.of('DR'), PDFDict);
  if (!dr) {
    dr = context.obj({});
    acroDict.set(PDFName.of('DR'), dr);
  }
  let fonts = dr.lookupMaybe(PDFName.of('Font'), PDFDict);
  if (!fonts) {
    fonts = context.obj({});
    dr.set(PDFName.of('Font'), fonts);
  }
  if (!fonts.has(PDFName.of(helvetica.name))) fonts.set(PDFName.of(helvetica.name), helvetica.ref);
  if (needZapf && !fonts.has(PDFName.of('ZaDb'))) {
    const zapf = await doc.embedFont(StandardFonts.ZapfDingbats);
    fonts.set(PDFName.of('ZaDb'), zapf.ref);
  }
  if (!acroDict.has(PDFName.of('DA'))) {
    acroDict.set(PDFName.of('DA'), PDFString.of(`/${helvetica.name} 0 Tf 0 g`));
  }
  return helvetica;
}

function setNeedAppearances(form: PDFForm): void {
  form.acroForm.dict.set(PDFName.of('NeedAppearances'), PDFBool.True);
}

/** Signature fields have no pdf-lib appearance provider: draw an outline and a signing line. */
function buildSignatureAppearance(doc: PDFDocument, width: number, height: number): PDFRef {
  const w = round(width);
  const h = round(height);
  const lineY = round(Math.max(3, h * 0.25));
  const content =
    `q 0.35 0.4 0.55 RG 1 w 0.5 0.5 ${round(w - 1)} ${round(h - 1)} re S ` +
    `0.5 w 4 ${lineY} m ${round(Math.max(5, w - 4))} ${lineY} l S Q`;
  const stream = doc.context.flateStream(content, {
    Type: 'XObject',
    Subtype: 'Form',
    BBox: [0, 0, w, h],
  });
  return doc.context.register(stream);
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Regenerate appearances for one field only. A failure (e.g. a value outside
 * WinAnsi) falls back to /NeedAppearances so viewers rebuild it themselves.
 */
function refreshAppearances(doc: PDFDocument, form: PDFForm, field: PDFField, font: PDFFont): void {
  try {
    if (field instanceof PDFTextField) field.updateAppearances(font);
    else if (field instanceof PDFDropdown) field.updateAppearances(font);
    else if (field instanceof PDFOptionList) field.updateAppearances(font);
    else if (field instanceof PDFButton) field.updateAppearances(font);
    else if (field instanceof PDFCheckBox) {
      field.updateAppearances();
      setCheckStyle(field, '4');
    } else if (field instanceof PDFRadioGroup) {
      field.updateAppearances();
      setCheckStyle(field, 'l');
    }
    else if (field instanceof PDFSignature) {
      for (const widget of field.acroField.getWidgets()) {
        const r = widget.getRectangle();
        widget.setNormalAppearance(buildSignatureAppearance(doc, r.width, r.height));
      }
    }
  } catch (e) {
    console.warn(`[formBuilder] Could not build appearance for "${field.getName()}"; deferring to NeedAppearances:`, e);
    setNeedAppearances(form);
  }
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

function appearanceOptions(rect: FieldRect, page: PDFPage) {
  const rotation = ((page.getRotation().angle % 360) + 360) % 360;
  return {
    // addToPage() expands the rect by borderWidth/2; pre-shrink so /Rect == rect.
    x: rect.x + BORDER_WIDTH / 2,
    y: rect.y + BORDER_WIDTH / 2,
    width: rect.width - BORDER_WIDTH,
    height: rect.height - BORDER_WIDTH,
    borderWidth: BORDER_WIDTH,
    rotate: degrees(rotation),
  };
}

/** Square radio buttons stacked top-to-bottom inside the drawn rectangle. */
export function layoutRadioOptions(rect: FieldRect, count: number): FieldRect[] {
  const n = Math.max(1, count);
  const rowHeight = rect.height / n;
  const size = Math.max(MIN_FIELD_SIZE, Math.min(rect.width, rowHeight * 0.8, 24));
  const rects: FieldRect[] = [];
  for (let i = 0; i < n; i++) {
    const rowTop = rect.y + rect.height - i * rowHeight;
    rects.push({ x: rect.x, y: rowTop - (rowHeight + size) / 2, width: size, height: size });
  }
  return rects;
}

/**
 * Check boxes and radios draw their mark with ZapfDingbats (/MK /CA). pdf-lib's
 * appearance provider rewrites /DA to a placeholder font ("dummy__noop") on
 * every refresh, so this must run after each appearance update.
 */
function setCheckStyle(field: PDFCheckBox | PDFRadioGroup, caption: string): void {
  const da = '0 g /ZaDb 0 Tf';
  field.acroField.setDefaultAppearance(da);
  for (const widget of field.acroField.getWidgets()) {
    if (widget.getDefaultAppearance() !== undefined) widget.setDefaultAppearance(da);
    widget.getOrCreateAppearanceCharacteristics().setCaptions({ normal: caption });
  }
}

function setTextDefault(field: PDFTextField, value: string): void {
  if (value) field.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText(value));
  else field.acroField.dict.delete(PDFName.of('DV'));
}

function setChoiceDefault(field: PDFDropdown | PDFOptionList, value: string, options: string[]): void {
  if (value && !options.includes(value)) {
    throw new FormBuilderError(`Default "${value}" is not one of the options`);
  }
  if (value) field.acroField.dict.set(PDFName.of('DV'), PDFHexString.fromText(value));
  else field.acroField.dict.delete(PDFName.of('DV'));
}

function setCheckboxDefault(field: PDFCheckBox, value: string): void {
  const onValue = field.acroField.getOnValue() ?? PDFName.of('Yes');
  field.acroField.dict.set(PDFName.of('DV'), value === 'checked' ? onValue : PDFName.of('Off'));
}

function setRadioDefault(field: PDFRadioGroup, value: string): void {
  if (!value) {
    field.acroField.dict.delete(PDFName.of('DV'));
    return;
  }
  const state = radioStateForOption(field, value);
  if (!state) throw new FormBuilderError(`Default "${value}" is not one of the options`);
  field.acroField.dict.set(PDFName.of('DV'), state);
}

function existingFieldNames(form: PDFForm): string[] {
  return form.getFields().map((f) => f.getName());
}

function addSignatureField(doc: PDFDocument, form: PDFForm, name: string, page: PDFPage, rect: FieldRect): PDFRef {
  const context = doc.context;
  const apRef = buildSignatureAppearance(doc, rect.width, rect.height);
  const fieldDict = context.obj({
    FT: 'Sig',
    T: PDFHexString.fromText(name),
    Type: 'Annot',
    Subtype: 'Widget',
    Rect: [round(rect.x), round(rect.y), round(rect.x + rect.width), round(rect.y + rect.height)],
    F: 4,
    P: page.ref,
    MK: { BC: [0.35, 0.4, 0.55] },
    AP: { N: apRef },
  });
  const ref = context.register(fieldDict);
  form.acroForm.addField(ref);
  page.node.addAnnot(ref);
  return ref;
}

async function createInDoc(doc: PDFDocument, spec: NewFieldSpec): Promise<string> {
  if (spec.pageIndex < 0 || spec.pageIndex >= doc.getPageCount()) {
    throw new FormBuilderError(`Page ${spec.pageIndex + 1} does not exist`);
  }
  validateRect(spec.rect);
  const form = doc.getForm();
  const names = existingFieldNames(form);
  const name = spec.name ?? suggestFieldName(spec.kind, names);
  const nameError = validateFieldName(name, names);
  if (nameError) throw new FormBuilderError(nameError);

  const page = doc.getPage(spec.pageIndex);
  const needZapf = spec.kind === 'checkbox' || spec.kind === 'radio';
  const font = await ensureDefaultResources(doc, form, needZapf);
  const defaultValue = spec.defaultValue?.trim() ?? '';
  let field: PDFField;

  switch (spec.kind) {
    case 'text': {
      const text = form.createTextField(name);
      if (spec.multiline) text.enableMultiline();
      text.addToPage(page, { ...appearanceOptions(spec.rect, page), font });
      text.setFontSize(spec.fontSize ?? DEFAULT_FONT_SIZE);
      setTextDefault(text, defaultValue);
      if (defaultValue) text.setText(defaultValue);
      field = text;
      break;
    }
    case 'checkbox': {
      const box = form.createCheckBox(name);
      box.addToPage(page, appearanceOptions(spec.rect, page));
      setCheckStyle(box, '4');
      setCheckboxDefault(box, defaultValue);
      if (defaultValue === 'checked') box.check();
      field = box;
      break;
    }
    case 'radio': {
      const options = normalizeOptions(spec.options);
      if (options.length < 2) throw new FormBuilderError('A radio group needs at least two options');
      const radio = form.createRadioGroup(name);
      layoutRadioOptions(spec.rect, options.length).forEach((r, i) => {
        radio.addOptionToPage(options[i], page, appearanceOptions(r, page));
      });
      setCheckStyle(radio, 'l');
      setRadioDefault(radio, defaultValue);
      if (defaultValue) radio.select(defaultValue);
      field = radio;
      break;
    }
    case 'dropdown':
    case 'listbox': {
      const options = normalizeOptions(spec.options);
      if (options.length === 0) throw new FormBuilderError('Add at least one option');
      const choice = spec.kind === 'dropdown' ? form.createDropdown(name) : form.createOptionList(name);
      choice.setOptions(options);
      choice.addToPage(page, { ...appearanceOptions(spec.rect, page), font });
      choice.setFontSize(spec.fontSize ?? DEFAULT_FONT_SIZE);
      setChoiceDefault(choice, defaultValue, options);
      if (defaultValue) choice.select(defaultValue);
      field = choice;
      break;
    }
    case 'signature': {
      addSignatureField(doc, form, name, page, spec.rect);
      field = form.getField(name);
      break;
    }
    default:
      throw new FormBuilderError(`Unsupported field type: ${String((spec as NewFieldSpec).kind)}`);
  }

  if (spec.required) field.enableRequired();
  if (spec.readOnly) field.enableReadOnly();
  if (spec.kind !== 'signature') refreshAppearances(doc, form, field, font);
  return name;
}

async function finish(doc: PDFDocument): Promise<Uint8Array> {
  // Each load embeds a fresh default font; superseded copies become orphans.
  removeUnreachableObjects(doc);
  return new Uint8Array(await doc.save(SAVE_OPTIONS));
}

export async function createFormField(
  bytes: Uint8Array,
  spec: NewFieldSpec
): Promise<{ bytes: Uint8Array; name: string }> {
  const doc = await PDFDocument.load(bytes, LOAD_OPTIONS);
  const name = await createInDoc(doc, spec);
  return { bytes: await finish(doc), name };
}

// ---------------------------------------------------------------------------
// Editing
// ---------------------------------------------------------------------------

function getFieldOrThrow(form: PDFForm, name: string): PDFField {
  const field = form.getFieldMaybe(name);
  if (!field) throw new FormBuilderError(`Field "${name}" no longer exists`);
  return field;
}

function removeWidgetsFromPages(doc: PDFDocument, refs: PDFRef[]): void {
  const keys = new Set(refs.map((r) => r.toString()));
  for (const page of doc.getPages()) {
    const annots = page.node.lookupMaybe(PDFName.of('Annots'), PDFArray);
    if (!annots) continue;
    for (let i = annots.size() - 1; i >= 0; i--) {
      const entry = annots.get(i);
      if (entry instanceof PDFRef && keys.has(entry.toString())) annots.remove(i);
    }
  }
}

function removeFieldFromDoc(doc: PDFDocument, form: PDFForm, field: PDFField): void {
  removeWidgetsFromPages(doc, widgetRefs(field));
  form.acroForm.removeField(field.acroField);
}

/** Rebuild a radio group with a new option list, reusing existing widget positions by index. */
async function rebuildRadioGroup(doc: PDFDocument, form: PDFForm, field: PDFRadioGroup, options: string[]): Promise<PDFRadioGroup> {
  if (options.length < 2) throw new FormBuilderError('A radio group needs at least two options');
  const annotPageMap = buildAnnotPageMap(doc);
  const refs = widgetRefs(field);
  const existing = field.acroField.getWidgets().map((w, i) => ({
    rect: w.getRectangle(),
    pageIndex: pageIndexForWidget(doc, annotPageMap, refs[i] ?? field.ref, w.dict),
  })).filter((w) => w.pageIndex >= 0);
  if (existing.length === 0) throw new FormBuilderError('Radio group has no placed buttons');

  const name = field.getName();
  const required = field.isRequired();
  const readOnly = field.isReadOnly();
  const previousDefault = readDefaultValue(field, 'radio');
  const previousSelection = field.getSelected();

  removeFieldFromDoc(doc, form, field);
  const radio = form.createRadioGroup(name);
  let last = existing[existing.length - 1];
  options.forEach((option, i) => {
    let placement = existing[i];
    if (!placement) {
      const r = last.rect;
      placement = { pageIndex: last.pageIndex, rect: { x: r.x, y: r.y - r.height * 1.5, width: r.width, height: r.height } };
      last = placement;
    }
    const page = doc.getPage(placement.pageIndex);
    radio.addOptionToPage(option, page, appearanceOptions(placement.rect, page));
  });
  setCheckStyle(radio, 'l');
  if (required) radio.enableRequired();
  if (readOnly) radio.enableReadOnly();
  if (previousDefault && options.includes(previousDefault)) setRadioDefault(radio, previousDefault);
  if (previousSelection && options.includes(previousSelection)) radio.select(previousSelection);
  return radio;
}

export async function updateFormFieldProperties(
  bytes: Uint8Array,
  fieldName: string,
  update: FieldPropertyUpdate
): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, LOAD_OPTIONS);
  const form = doc.getForm();
  let field = getFieldOrThrow(form, fieldName);
  const kind = fieldKind(field);
  const font = await ensureDefaultResources(doc, form, kind === 'checkbox' || kind === 'radio');

  if (update.name !== undefined && update.name !== field.acroField.getPartialName()) {
    // Only the terminal (partial) name is editable; a hierarchical parent
    // prefix ("Address.") is kept, and uniqueness is checked on the full name.
    const fullName = field.getName();
    const prefix = fullName.includes('.') ? fullName.slice(0, fullName.lastIndexOf('.') + 1) : '';
    const syntaxError = validateFieldName(update.name, []);
    if (syntaxError) throw new FormBuilderError(syntaxError);
    const newFullName = `${prefix}${update.name}`;
    for (const existing of existingFieldNames(form)) {
      if (existing === fullName) continue;
      if (existing === newFullName || existing.startsWith(`${newFullName}.`)) {
        throw new FormBuilderError(`A field named "${newFullName}" already exists`);
      }
    }
    field.acroField.setPartialName(update.name);
  }

  if (field instanceof PDFRadioGroup && update.options !== undefined) {
    const options = normalizeOptions(update.options);
    const current = radioWidgetOptions(field);
    if (options.length !== current.length || options.some((o, i) => o !== current[i])) {
      field = await rebuildRadioGroup(doc, form, field, options);
    }
  }

  if (update.required !== undefined) {
    if (update.required) field.enableRequired();
    else field.disableRequired();
  }
  if (update.readOnly !== undefined) {
    if (update.readOnly) field.enableReadOnly();
    else field.disableReadOnly();
  }

  if (field instanceof PDFTextField) {
    if (update.multiline !== undefined) {
      if (update.multiline) field.enableMultiline();
      else field.disableMultiline();
    }
    if (update.fontSize !== undefined) field.setFontSize(update.fontSize);
    if (update.defaultValue !== undefined) {
      const previousDefault = readDefaultValue(field, 'text');
      const current = field.getText() ?? '';
      setTextDefault(field, update.defaultValue);
      // Follow the default only while the user has not typed their own value.
      if (current === '' || current === previousDefault) field.setText(update.defaultValue || undefined);
    }
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    if (update.options !== undefined) {
      const options = normalizeOptions(update.options);
      if (options.length === 0) throw new FormBuilderError('Add at least one option');
      const selected = field.getSelected().filter((s) => options.includes(s));
      field.setOptions(options);
      if (selected.length > 0) field.select(selected[0]);
      else field.clear();
    }
    if (update.fontSize !== undefined) field.setFontSize(update.fontSize);
    if (update.defaultValue !== undefined) {
      setChoiceDefault(field, update.defaultValue, field.getOptions());
      if (update.defaultValue && field.getSelected().length === 0) field.select(update.defaultValue);
    }
  } else if (field instanceof PDFCheckBox) {
    if (update.defaultValue !== undefined) setCheckboxDefault(field, update.defaultValue);
  } else if (field instanceof PDFRadioGroup) {
    if (update.defaultValue !== undefined) setRadioDefault(field, update.defaultValue);
  }

  form.markFieldAsDirty(field.ref);
  refreshAppearances(doc, form, field, font);
  return finish(doc);
}

export async function setFormWidgetRect(
  bytes: Uint8Array,
  fieldName: string,
  widgetIndex: number,
  rect: FieldRect
): Promise<Uint8Array> {
  validateRect(rect);
  const doc = await PDFDocument.load(bytes, LOAD_OPTIONS);
  const form = doc.getForm();
  const field = getFieldOrThrow(form, fieldName);
  const widgets = field.acroField.getWidgets();
  const widget = widgets[widgetIndex];
  if (!widget) throw new FormBuilderError(`Field "${fieldName}" has no widget ${widgetIndex + 1}`);
  const before = widget.getRectangle();
  widget.setRectangle({ x: round(rect.x), y: round(rect.y), width: round(rect.width), height: round(rect.height) });
  const resized = Math.abs(before.width - rect.width) > 0.01 || Math.abs(before.height - rect.height) > 0.01;
  // A pure move keeps the original appearance; a resize needs one that fits the new box.
  if (resized) {
    const kind = fieldKind(field);
    const font = await ensureDefaultResources(doc, form, kind === 'checkbox' || kind === 'radio');
    form.markFieldAsDirty(field.ref);
    refreshAppearances(doc, form, field, font);
  }
  return finish(doc);
}

export async function deleteFormField(bytes: Uint8Array, fieldName: string): Promise<Uint8Array> {
  const doc = await PDFDocument.load(bytes, LOAD_OPTIONS);
  const form = doc.getForm();
  const field = getFieldOrThrow(form, fieldName);
  removeFieldFromDoc(doc, form, field);
  return finish(doc);
}
