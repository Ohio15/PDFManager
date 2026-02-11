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
      }

      mappings.push({
        annotationId: annot.id,
        fieldName: annot.fieldName || '',
        fieldType,
        pageIndex: i - 1,
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
            if (field && typeof value === 'string' && value) {
              field.select(value);
              didWrite = true;
            }
          } catch {
            // Radio group might not exist
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
