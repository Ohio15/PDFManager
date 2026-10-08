/**
 * formFieldSaver.ts — Writes pdfjs-dist AnnotationStorage values into pdf-lib form fields
 *
 * The flow:
 * 1. User fills form fields rendered by pdfjs AnnotationLayer
 * 2. AnnotationStorage tracks all value changes (keyed by annotation ID)
 * 3. Before pdf-lib saves the document, this module maps those values to pdf-lib fields
 * 4. pdf-lib regenerates appearance streams and writes the PDF
 */

import {
  PDFDocument,
  PDFTextField,
  PDFCheckBox,
  PDFRadioGroup,
  PDFDropdown,
  PDFOptionList,
} from 'pdf-lib';

export interface FormFieldMapping {
  annotationId: string;
  fieldName: string;
  fieldType: 'text' | 'checkbox' | 'radio' | 'dropdown' | 'listbox' | 'button' | 'signature';
  pageIndex: number;
  required: boolean;
  readOnly: boolean;
  noExport: boolean;
  maxLen: number | null;
  defaultValue: string;
  rect: [number, number, number, number] | null;
  /**
   * Radio buttons: the on-state name of this widget. pdf.js stores a radio
   * selection as a per-widget boolean, so this is what identifies the option.
   */
  buttonValue?: string;
}

export interface FormFieldStats {
  total: number;
  filled: number;
  required: number;
  requiredFilled: number;
}

/**
 * Build a mapping from pdfjs annotation IDs to AcroForm field names.
 * Called once during document load when form fields are detected.
 */
export async function buildFormFieldMapping(
  pdfJsDoc: any /* PDFDocumentProxy */
): Promise<FormFieldMapping[]> {
  const mappings: FormFieldMapping[] = [];

  for (let i = 1; i <= pdfJsDoc.numPages; i++) {
    const page = await pdfJsDoc.getPage(i);
    const annotations = await page.getAnnotations();

    for (const annot of annotations) {
      // Widget annotations are form fields
      if (annot.subtype !== 'Widget') continue;

      let fieldType: FormFieldMapping['fieldType'] = 'text';

      if (annot.checkBox) {
        fieldType = 'checkbox';
      } else if (annot.radioButton) {
        fieldType = 'radio';
      } else if (annot.combo || annot.listBox) {
        fieldType = annot.listBox ? 'listbox' : 'dropdown';
      } else if (annot.pushButton) {
        fieldType = 'button';
      } else if (annot.fieldType === 'Sig') {
        fieldType = 'signature';
      }

      // Parse fieldFlags bitmask: bit 1=ReadOnly, bit 2=Required, bit 3=NoExport
      const flags = typeof annot.fieldFlags === 'number' ? annot.fieldFlags : 0;
      const readOnly = !!(flags & 1);
      const required = !!(flags & 2);
      const noExport = !!(flags & 4);

      const maxLen = fieldType === 'text' && typeof annot.maxLen === 'number' ? annot.maxLen : null;
      const defaultValue = annot.defaultFieldValue ?? annot.defaultAppearance ?? '';

      // Position rect for scroll-to-field
      let rect: [number, number, number, number] | null = null;
      if (Array.isArray(annot.rect) && annot.rect.length === 4) {
        rect = [annot.rect[0], annot.rect[1], annot.rect[2], annot.rect[3]];
      }

      mappings.push({
        annotationId: annot.id,
        fieldName: annot.fieldName || '',
        fieldType,
        pageIndex: i - 1,
        required,
        readOnly,
        noExport,
        maxLen,
        defaultValue: typeof defaultValue === 'string' ? defaultValue : '',
        rect,
        ...(fieldType === 'radio' && typeof annot.buttonValue === 'string' ? { buttonValue: annot.buttonValue } : {}),
      });
    }
  }

  return mappings;
}

/**
 * Write form field values from pdfjs AnnotationStorage into pdf-lib's form model.
 * Returns true if any form data was written, false if storage was empty.
 */
export async function saveFormFieldValues(
  pdfDoc: PDFDocument,
  annotationStorage: any /* AnnotationStorage */,
  fieldMappings: FormFieldMapping[]
): Promise<boolean> {
  const allValues = annotationStorage.getAll();
  if (!allValues || Object.keys(allValues).length === 0) {
    return false;
  }

  // Build annotation ID -> field mapping lookup
  const mappingById = new Map<string, FormFieldMapping>();
  for (const mapping of fieldMappings) {
    mappingById.set(mapping.annotationId, mapping);
  }

  let form;
  try {
    form = pdfDoc.getForm();
  } catch {
    // PDF has no AcroForm
    return false;
  }

  let didWrite = false;
  // Radio groups the user touched → whether any widget ended up selected.
  const radioTouched = new Map<string, boolean>();

  for (const [annotId, storedData] of Object.entries(allValues)) {
    const mapping = mappingById.get(annotId);
    if (!mapping || !mapping.fieldName) continue;

    const data = storedData as any;
    // pdfjs stores values in different shapes depending on field type:
    // text fields: { value: "string" }
    // checkboxes: { value: true/false }  or  { exportValue: "Yes" }
    // radio buttons: { value: "optionName" }
    // dropdowns: { value: "selected option" }
    const value = data.value;

    try {
      switch (mapping.fieldType) {
        case 'text': {
          const field = form.getTextField(mapping.fieldName);
          if (field) {
            field.setText(typeof value === 'string' ? value : String(value ?? ''));
            didWrite = true;
          }
          break;
        }

        case 'checkbox': {
          const field = form.getCheckBox(mapping.fieldName);
          if (field) {
            if (value === true || value === 'Yes' || value === 'On') {
              field.check();
            } else {
              field.uncheck();
            }
            didWrite = true;
          }
          break;
        }

        case 'radio': {
          try {
            const field = form.getRadioGroup(mapping.fieldName);
            if (!field) break;
            if (typeof value === 'boolean') {
              radioTouched.set(mapping.fieldName, (radioTouched.get(mapping.fieldName) ?? false) || value);
            }
            if (value === true && mapping.buttonValue) {
              // pdf.js: { value: true } on the selected widget. Select by the
              // widget's on-state, which is what /V must name.
              const onValue = field.acroField
                .getOnValues()
                .find((name) => name.decodeText() === mapping.buttonValue);
              if (onValue) {
                field.acroField.setValue(onValue);
                form.markFieldAsDirty(field.ref);
                didWrite = true;
              }
            } else if (typeof value === 'string' && value) {
              // Imported form data carries the option label.
              field.select(value);
              didWrite = true;
            }
          } catch (e) {
            console.warn(`[FormFieldSaver] Failed to set radio "${mapping.fieldName}":`, e);
          }
          break;
        }

        case 'dropdown': {
          try {
            const field = form.getDropdown(mapping.fieldName);
            if (field && typeof value === 'string') {
              field.select(value);
              didWrite = true;
            }
          } catch {
            // Might be an option list instead
            try {
              const field = form.getOptionList(mapping.fieldName);
              if (field && typeof value === 'string') {
                field.select(value);
                didWrite = true;
              }
            } catch {
              // ignore
            }
          }
          break;
        }

        case 'listbox': {
          try {
            const field = form.getOptionList(mapping.fieldName);
            if (field) {
              if (Array.isArray(value)) {
                field.select(value);
              } else if (typeof value === 'string') {
                field.select(value);
              }
              didWrite = true;
            }
          } catch {
            // ignore
          }
          break;
        }

        // 'button' and 'signature' - no value to save
        default:
          break;
      }
    } catch (e) {
      console.warn(`[FormFieldSaver] Failed to set field "${mapping.fieldName}":`, e);
    }
  }

  // Every widget of a touched group false → the user cleared the selection.
  for (const [fieldName, anySelected] of radioTouched) {
    if (anySelected) continue;
    try {
      const field = form.getRadioGroup(fieldName);
      if (field.getSelected() !== undefined) {
        field.clear();
        didWrite = true;
      }
    } catch (e) {
      console.warn(`[FormFieldSaver] Failed to clear radio "${fieldName}":`, e);
    }
  }

  if (didWrite) {
    try {
      form.updateFieldAppearances();
    } catch (e) {
      console.warn('[FormFieldSaver] Failed to update field appearances:', e);
    }
  }

  return didWrite;
}

/**
 * Count Widget annotations (form fields) across all pages.
 */
export async function countFormFields(pdfJsDoc: any): Promise<number> {
  let count = 0;
  for (let i = 1; i <= pdfJsDoc.numPages; i++) {
    const page = await pdfJsDoc.getPage(i);
    const annotations = await page.getAnnotations();
    count += annotations.filter((a: any) => a.subtype === 'Widget').length;
  }
  return count;
}

/**
 * Compute fill stats for form fields using annotationStorage values.
 */
export function getFormFieldStats(
  fields: FormFieldMapping[],
  annotationStorage: any
): FormFieldStats {
  let total = 0;
  let filled = 0;
  let required = 0;
  let requiredFilled = 0;

  for (const field of fields) {
    // Skip non-fillable types
    if (field.fieldType === 'button') continue;
    total++;

    const isFilled = isFieldFilled(field, annotationStorage);
    if (isFilled) filled++;

    if (field.required) {
      required++;
      if (isFilled) requiredFilled++;
    }
  }

  return { total, filled, required, requiredFilled };
}

/**
 * Check if a single field has a meaningful value in annotationStorage.
 */
export function isFieldFilled(field: FormFieldMapping, annotationStorage: any): boolean {
  if (!annotationStorage) return false;
  try {
    const raw = annotationStorage.getRawValue(field.annotationId);
    if (!raw) return false;
    const val = (raw as any).value;
    if (val === undefined || val === null || val === '') return false;
    if (typeof val === 'string' && val.trim() === '') return false;
    // Unchecked checkboxes count as empty
    if (field.fieldType === 'checkbox' && (val === false || val === 'Off')) return false;
    return true;
  } catch {
    return false;
  }
}

/**
 * Import form data from a JSON object keyed by field name.
 * Writes values into annotationStorage. Returns the count of fields populated.
 */
export async function importFormData(
  annotationStorage: any,
  fieldMappings: FormFieldMapping[],
  data: Record<string, any>
): Promise<number> {
  let count = 0;

  // Build fieldName -> mapping lookup (use first match for duplicate names)
  const byName = new Map<string, FormFieldMapping>();
  for (const m of fieldMappings) {
    if (m.fieldName && !byName.has(m.fieldName)) {
      byName.set(m.fieldName, m);
    }
  }

  for (const [fieldName, value] of Object.entries(data)) {
    const mapping = byName.get(fieldName);
    if (!mapping) continue;

    try {
      annotationStorage.setValue(mapping.annotationId, { value });
      count++;
    } catch {
      // Field may not accept the value type — skip
    }
  }

  return count;
}

/**
 * Get the list of required field names that are currently empty.
 */
export function getEmptyRequiredFieldNames(
  fields: FormFieldMapping[],
  annotationStorage: any
): string[] {
  const names: string[] = [];
  for (const field of fields) {
    if (!field.required) continue;
    if (field.fieldType === 'button') continue;
    if (!isFieldFilled(field, annotationStorage)) {
      names.push(field.fieldName || `(unnamed ${field.annotationId})`);
    }
  }
  return names;
}
