import { describe, it, expect } from 'vitest';
import {
  PDFDocument,
  PDFName,
  PDFDict,
  PDFArray,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
  PDFSignature,
  PDFStream,
} from 'pdf-lib';
import {
  createFormField,
  updateFormFieldProperties,
  setFormWidgetRect,
  deleteFormField,
  readFormModel,
  validateFieldName,
  suggestFieldName,
  layoutRadioOptions,
  NewFieldSpec,
} from '../formBuilder';
import { buildFormFieldMapping } from '../formFieldSaver';
import { fixture, openPdfJs } from './formsFinalizeHelpers';

const RECTS = {
  text: { x: 60, y: 600, width: 200, height: 22 },
  checkbox: { x: 60, y: 560, width: 14, height: 14 },
  radio: { x: 60, y: 480, width: 16, height: 60 },
  dropdown: { x: 300, y: 600, width: 150, height: 22 },
  listbox: { x: 300, y: 520, width: 150, height: 60 },
  signature: { x: 300, y: 420, width: 180, height: 40 },
};

async function buildAllKinds(): Promise<Uint8Array> {
  let bytes = fixture('invoice.pdf');
  const specs: NewFieldSpec[] = [
    { kind: 'text', name: 'CustomerName', pageIndex: 0, rect: RECTS.text, required: true, defaultValue: 'Jane Roe', fontSize: 11 },
    { kind: 'checkbox', name: 'Agree', pageIndex: 0, rect: RECTS.checkbox, defaultValue: 'checked' },
    { kind: 'radio', name: 'Size', pageIndex: 0, rect: RECTS.radio, options: ['Small', 'Medium', 'Large'], defaultValue: 'Medium' },
    { kind: 'dropdown', name: 'Country', pageIndex: 0, rect: RECTS.dropdown, options: ['US', 'CA', 'MX'], defaultValue: 'CA' },
    { kind: 'listbox', name: 'Colors', pageIndex: 0, rect: RECTS.listbox, options: ['Red', 'Green'], readOnly: true },
    { kind: 'signature', name: 'SignHere', pageIndex: 0, rect: RECTS.signature },
  ];
  for (const spec of specs) bytes = (await createFormField(bytes, spec)).bytes;
  return bytes;
}

function rectOf(widgetDict: PDFDict): number[] {
  const arr = widgetDict.lookup(PDFName.of('Rect'), PDFArray);
  return arr.asArray().map((n) => Number(n.toString()));
}

describe('formBuilder: creation output', () => {
  it('creates every field kind with the right types, names, options, flags and exact rects', async () => {
    const bytes = await buildAllKinds();
    const doc = await PDFDocument.load(bytes);
    const form = doc.getForm();

    const text = form.getField('CustomerName');
    expect(text).toBeInstanceOf(PDFTextField);
    expect((text as PDFTextField).getText()).toBe('Jane Roe');
    expect(text.isRequired()).toBe(true);
    expect(text.acroField.getDefaultAppearance()).toMatch(/\/Helvetica 11 Tf/);
    expect(rectOf(text.acroField.getWidgets()[0].dict)).toEqual([60, 600, 260, 622]);

    const agree = form.getField('Agree') as PDFCheckBox;
    expect(agree).toBeInstanceOf(PDFCheckBox);
    expect(agree.isChecked()).toBe(true);
    expect(rectOf(agree.acroField.getWidgets()[0].dict)).toEqual([60, 560, 74, 574]);

    const size = form.getField('Size') as PDFRadioGroup;
    expect(size).toBeInstanceOf(PDFRadioGroup);
    expect(size.getOptions()).toEqual(['Small', 'Medium', 'Large']);
    expect(size.getSelected()).toBe('Medium');
    expect(size.acroField.getWidgets()).toHaveLength(3);
    const expectedRadio = layoutRadioOptions(RECTS.radio, 3);
    size.acroField.getWidgets().forEach((w, i) => {
      const r = rectOf(w.dict);
      expect(r[0]).toBeCloseTo(expectedRadio[i].x, 3);
      expect(r[1]).toBeCloseTo(expectedRadio[i].y, 3);
      expect(r[2] - r[0]).toBeCloseTo(expectedRadio[i].width, 3);
    });

    const country = form.getField('Country') as PDFDropdown;
    expect(country).toBeInstanceOf(PDFDropdown);
    expect(country.getOptions()).toEqual(['US', 'CA', 'MX']);
    expect(country.getSelected()).toEqual(['CA']);

    const colors = form.getField('Colors') as PDFOptionList;
    expect(colors).toBeInstanceOf(PDFOptionList);
    expect(colors.getOptions()).toEqual(['Red', 'Green']);
    expect(colors.isReadOnly()).toBe(true);

    const sig = form.getField('SignHere');
    expect(sig).toBeInstanceOf(PDFSignature);
    expect(rectOf(sig.acroField.getWidgets()[0].dict)).toEqual([300, 420, 480, 460]);
  });

  it('writes appearance streams for every widget and resolves every DA font in /DR (Acrobat fillability)', async () => {
    const doc = await PDFDocument.load(await buildAllKinds());
    const acroForm = doc.catalog.lookup(PDFName.of('AcroForm'), PDFDict);
    const drFonts = acroForm.lookup(PDFName.of('DR'), PDFDict).lookup(PDFName.of('Font'), PDFDict);
    for (const field of doc.getForm().getFields()) {
      const da = field.acroField.getDefaultAppearance();
      if (da) {
        const fontName = da.match(/\/([^\s/]+)\s+[\d.]+\s+Tf/)?.[1];
        expect(fontName, `${field.getName()} DA font`).toBeTruthy();
        expect(drFonts.has(PDFName.of(fontName!)), `${fontName} in /DR for ${field.getName()}`).toBe(true);
      }
      for (const widget of field.acroField.getWidgets()) {
        const normal = widget.getAppearances()?.normal;
        expect(normal, `${field.getName()} /AP /N`).toBeTruthy();
        if (normal instanceof PDFDict && !(normal instanceof PDFStream)) {
          expect(normal.keys().length).toBeGreaterThanOrEqual(2); // on + Off states
        }
      }
    }
  });

  it('is visible to pdf.js: getFieldObjects and the widget mapping see each created field', async () => {
    const bytes = await buildAllKinds();
    const pdf = await openPdfJs(bytes);
    try {
      const objects = await pdf.getFieldObjects();
      const typeOf = (name: string) =>
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (objects[name] as any[]).find((o) => o.type)?.type;
      expect(typeOf('CustomerName')).toBe('text');
      expect(typeOf('Agree')).toBe('checkbox');
      expect(typeOf('Size')).toBe('radiobutton');
      expect(typeOf('Country')).toBe('combobox');
      expect(typeOf('Colors')).toBe('listbox');
      expect(typeOf('SignHere')).toBe('signature');
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((objects.CustomerName as any[]).find((o) => o.type).value).toBe('Jane Roe');

      const mappings = await buildFormFieldMapping(pdf);
      const names = mappings.map((m) => m.fieldName);
      expect(names).toEqual(expect.arrayContaining(['CustomerName', 'Agree', 'Size', 'Country', 'Colors', 'SignHere']));
      const radios = mappings.filter((m) => m.fieldName === 'Size');
      expect(radios).toHaveLength(3);
      expect(radios.every((m) => typeof m.buttonValue === 'string' && m.buttonValue.length > 0)).toBe(true);
    } finally {
      await pdf.destroy();
    }
  });

  it('adds fields to an existing form without disturbing its 47 fields', async () => {
    const original = fixture('repair-calibration-form.pdf');
    const { bytes, name } = await createFormField(original, { kind: 'text', pageIndex: 0, rect: { x: 40, y: 40, width: 120, height: 20 } });
    expect(name).toBe('Text1');
    const model = await readFormModel(bytes);
    expect(model.fields).toHaveLength(48);
    const before = await readFormModel(original);
    for (const f of before.fields) {
      const after = model.fields.find((g) => g.name === f.name);
      expect(after, f.name).toBeTruthy();
      expect(after!.widgets.map((w) => w.rect)).toEqual(f.widgets.map((w) => w.rect));
    }
  });
});

describe('formBuilder: validation', () => {
  it('rejects empty, dotted, padded and duplicate names; suggests a free name', async () => {
    expect(validateFieldName('', [])).toMatch(/required/);
    expect(validateFieldName('a.b', [])).toMatch(/'\.'/);
    expect(validateFieldName(' a', [])).toMatch(/spaces/);
    expect(validateFieldName('Name', ['Name'])).toMatch(/already exists/);
    expect(validateFieldName('Addr', ['Addr.Street'])).toMatch(/group/);
    expect(validateFieldName('Name', ['Name'], 'Name')).toBeNull();
    expect(suggestFieldName('text', ['Text1', 'Text2'])).toBe('Text3');

    const repair = fixture('repair-calibration-form.pdf');
    await expect(createFormField(repair, { kind: 'text', name: 'Email', pageIndex: 0, rect: RECTS.text })).rejects.toThrow(/already exists/);
    await expect(createFormField(repair, { kind: 'radio', name: 'R', pageIndex: 0, rect: RECTS.radio, options: ['only'] })).rejects.toThrow(/two options/);
    await expect(createFormField(repair, { kind: 'text', name: 'Tiny', pageIndex: 0, rect: { x: 1, y: 1, width: 2, height: 2 } })).rejects.toThrow(/at least/);
    await expect(createFormField(repair, { kind: 'text', name: 'Far', pageIndex: 9, rect: RECTS.text })).rejects.toThrow(/does not exist/);
  });
});

describe('formBuilder: editing output', () => {
  it('updates name, flags, multiline, font size, default and options', async () => {
    let bytes = await buildAllKinds();
    bytes = await updateFormFieldProperties(bytes, 'CustomerName', {
      name: 'ClientName', required: false, readOnly: true, multiline: true, fontSize: 9, defaultValue: 'Acme',
    });
    bytes = await updateFormFieldProperties(bytes, 'Country', { options: ['US', 'MX', 'BR'], defaultValue: 'BR' });
    bytes = await updateFormFieldProperties(bytes, 'Size', { options: ['Small', 'Medium', 'Large', 'XL'] });

    const doc = await PDFDocument.load(bytes);
    const form = doc.getForm();
    expect(form.getFieldMaybe('CustomerName')).toBeUndefined();
    const client = form.getTextField('ClientName');
    expect(client.isRequired()).toBe(false);
    expect(client.isReadOnly()).toBe(true);
    expect(client.isMultiline()).toBe(true);
    expect(client.acroField.getDefaultAppearance()).toMatch(/ 9 Tf/);
    // The value followed the default because the user had not changed it.
    expect(client.getText()).toBe('Acme');

    const country = form.getDropdown('Country');
    expect(country.getOptions()).toEqual(['US', 'MX', 'BR']);
    // 'CA' was removed from the options, so the selection fell to the new default.
    expect(country.getSelected()).toEqual(['BR']);

    const size = form.getRadioGroup('Size');
    expect(size.getOptions()).toEqual(['Small', 'Medium', 'Large', 'XL']);
    expect(size.acroField.getWidgets()).toHaveLength(4);
    expect(size.getSelected()).toBe('Medium');

    const model = await readFormModel(bytes);
    const sizeInfo = model.fields.find((f) => f.name === 'Size')!;
    expect(sizeInfo.defaultValue).toBe('Medium');
    expect(sizeInfo.widgets.map((w) => w.option)).toEqual(['Small', 'Medium', 'Large', 'XL']);
  });

  it('rejects a rename onto an existing field', async () => {
    const bytes = await buildAllKinds();
    await expect(updateFormFieldProperties(bytes, 'Agree', { name: 'Country' })).rejects.toThrow(/already exists/);
  });

  it('moves and resizes a widget, and deletes a field with its widget annotations', async () => {
    let bytes = await buildAllKinds();
    bytes = await setFormWidgetRect(bytes, 'CustomerName', 0, { x: 70, y: 610, width: 200, height: 22 });
    bytes = await setFormWidgetRect(bytes, 'SignHere', 0, { x: 300, y: 400, width: 220, height: 60 });
    let doc = await PDFDocument.load(bytes);
    expect(rectOf(doc.getForm().getField('CustomerName').acroField.getWidgets()[0].dict)).toEqual([70, 610, 270, 632]);
    const sigWidget = doc.getForm().getField('SignHere').acroField.getWidgets()[0];
    expect(rectOf(sigWidget.dict)).toEqual([300, 400, 520, 460]);
    const sigAp = sigWidget.getAppearances()!.normal as PDFStream;
    expect(sigAp.dict.lookup(PDFName.of('BBox'), PDFArray).asArray().map(String)).toEqual(['0', '0', '220', '60']);

    const annotCount = () => doc.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size() ?? 0;
    const before = annotCount();
    bytes = await deleteFormField(bytes, 'Size');
    doc = await PDFDocument.load(bytes);
    expect(doc.getForm().getFieldMaybe('Size')).toBeUndefined();
    expect(annotCount()).toBe(before - 3);

    const pdf = await openPdfJs(bytes);
    try {
      const objects = await pdf.getFieldObjects();
      expect(objects.Size).toBeUndefined();
      expect(objects.CustomerName).toBeTruthy();
    } finally {
      await pdf.destroy();
    }
  });

  it('reports page geometry matching pdf.js (view box and rotation)', async () => {
    const model = await readFormModel(fixture('repair-calibration-form.pdf'));
    const pdf = await openPdfJs(fixture('repair-calibration-form.pdf'));
    try {
      const page = await pdf.getPage(1);
      expect(model.pages[0].view).toEqual(page.view);
      expect(model.pages[0].rotation).toBe(page.rotate);
    } finally {
      await pdf.destroy();
    }
  });
});
