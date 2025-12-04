/**
 * FormFieldManager - PDF form field parsing and manipulation
 *
 * Handles:
 * - Parsing form fields from PDF documents
 * - Creating new form fields
 * - Modifying form field values
 * - Form field validation
 * - Form field appearance streams
 */

import type {
  FormField,
  BoundingBox,
  Color,
  TextMatrix,
  PDFValue,
  PDFDict,
  PDFArray,
  PDFName,
  PDFString,
  PDFNumber
} from './types';

// Form field flags
export const FieldFlags = {
  // Common flags
  ReadOnly: 1 << 0,
  Required: 1 << 1,
  NoExport: 1 << 2,

  // Text field flags
  Multiline: 1 << 12,
  Password: 1 << 13,
  FileSelect: 1 << 20,
  DoNotSpellCheck: 1 << 22,
  DoNotScroll: 1 << 23,
  Comb: 1 << 24,
  RichText: 1 << 25,

  // Button flags
  NoToggleToOff: 1 << 14,
  Radio: 1 << 15,
  Pushbutton: 1 << 16,
  RadiosInUnison: 1 << 25,

  // Choice flags
  Combo: 1 << 17,
  Edit: 1 << 18,
  Sort: 1 << 19,
  MultiSelect: 1 << 21,
  CommitOnSelChange: 1 << 26
} as const;

// Form field quadding (text alignment)
export const Quadding = {
  Left: 0,
  Center: 1,
  Right: 2
} as const;

// Extended form field types
export interface TextField extends FormField {
  type: 'text';
  maxLength?: number;
  defaultValue?: string;
  quadding: number;
  isMultiline: boolean;
  isPassword: boolean;
  isRichText: boolean;
  isComb: boolean;
  fontName?: string;
  fontSize?: number;
}

export interface CheckboxField extends FormField {
  type: 'checkbox';
  isChecked: boolean;
  exportValue: string;
  onState: string;
  offState: string;
}

export interface RadioField extends FormField {
  type: 'radio';
  isSelected: boolean;
  exportValue: string;
  groupName: string;
}

export interface ButtonField extends FormField {
  type: 'button';
  caption?: string;
  action?: FormFieldAction;
}

export interface ChoiceField extends FormField {
  type: 'choice';
  options: ChoiceOption[];
  selectedIndices: number[];
  isCombo: boolean;
  isEditable: boolean;
  isMultiSelect: boolean;
  topIndex: number;
}

export interface SignatureField extends FormField {
  type: 'signature';
  signatureInfo?: SignatureInfo;
  isSigned: boolean;
}

export interface ChoiceOption {
  displayValue: string;
  exportValue: string;
}

export interface FormFieldAction {
  type: 'submit' | 'reset' | 'javascript' | 'uri' | 'goto';
  data: any;
}

export interface SignatureInfo {
  signerName?: string;
  signDate?: Date;
  reason?: string;
  location?: string;
  contactInfo?: string;
}

// Form field widget appearance
export interface FieldAppearance {
  normalAppearance?: Uint8Array;
  rolloverAppearance?: Uint8Array;
  downAppearance?: Uint8Array;
  borderColor?: Color;
  backgroundColor?: Color;
  borderWidth: number;
  borderStyle: 'solid' | 'dashed' | 'beveled' | 'inset' | 'underline';
  rotation: number;
}

// Form validation result
export interface ValidationResult {
  isValid: boolean;
  errors: { fieldId: string; message: string }[];
}

/**
 * Appearance stream generator for form fields
 */
export class AppearanceStreamGenerator {
  /**
   * Generate appearance stream for a text field
   */
  generateTextFieldAppearance(
    field: TextField,
    value: string,
    bbox: BoundingBox,
    appearance: FieldAppearance
  ): Uint8Array {
    const lines: string[] = [];

    // Background
    if (appearance.backgroundColor) {
      const bg = appearance.backgroundColor;
      lines.push(`${bg.values.join(' ')} ${bg.space === 'DeviceRGB' ? 'rg' : 'g'}`);
      lines.push(`${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height} re f`);
    }

    // Border
    if (appearance.borderWidth > 0 && appearance.borderColor) {
      const bc = appearance.borderColor;
      lines.push(`${bc.values.join(' ')} ${bc.space === 'DeviceRGB' ? 'RG' : 'G'}`);
      lines.push(`${appearance.borderWidth} w`);

      if (appearance.borderStyle === 'dashed') {
        lines.push('[3 3] 0 d');
      }

      const bw = appearance.borderWidth / 2;
      lines.push(`${bbox.x + bw} ${bbox.y + bw} ${bbox.width - appearance.borderWidth} ${bbox.height - appearance.borderWidth} re S`);
    }

    // Text content
    if (value && value.length > 0) {
      const fontSize = field.fontSize || 12;
      const fontName = field.fontName || 'Helvetica';

      lines.push('BT');
      lines.push(`/${fontName} ${fontSize} Tf`);
      lines.push('0 g'); // Black text

      // Calculate text position based on quadding
      const textWidth = this.estimateTextWidth(value, fontSize);
      const padding = 2;
      let x = bbox.x + padding;

      if (field.quadding === Quadding.Center) {
        x = bbox.x + (bbox.width - textWidth) / 2;
      } else if (field.quadding === Quadding.Right) {
        x = bbox.x + bbox.width - textWidth - padding;
      }

      const y = bbox.y + (bbox.height - fontSize) / 2 + fontSize * 0.2;

      lines.push(`${x} ${y} Td`);

      // Handle multiline
      if (field.isMultiline) {
        const lineHeight = fontSize * 1.2;
        const textLines = this.wrapText(value, bbox.width - padding * 2, fontSize);
        let currentY = bbox.y + bbox.height - padding - fontSize;

        for (const line of textLines) {
          if (currentY < bbox.y + padding) break;
          lines.push(`${padding} ${currentY - bbox.y} Td`);
          lines.push(`(${this.escapeString(line)}) Tj`);
          currentY -= lineHeight;
        }
      } else {
        // Password field
        if (field.isPassword) {
          lines.push(`(${this.escapeString('•'.repeat(value.length))}) Tj`);
        } else {
          lines.push(`(${this.escapeString(value)}) Tj`);
        }
      }

      lines.push('ET');
    }

    return new TextEncoder().encode(lines.join('\n'));
  }

  /**
   * Generate appearance stream for a checkbox
   */
  generateCheckboxAppearance(
    field: CheckboxField,
    isChecked: boolean,
    bbox: BoundingBox,
    appearance: FieldAppearance
  ): Uint8Array {
    const lines: string[] = [];

    // Background
    if (appearance.backgroundColor) {
      const bg = appearance.backgroundColor;
      lines.push(`${bg.values.join(' ')} ${bg.space === 'DeviceRGB' ? 'rg' : 'g'}`);
      lines.push(`${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height} re f`);
    }

    // Border
    if (appearance.borderWidth > 0 && appearance.borderColor) {
      const bc = appearance.borderColor;
      lines.push(`${bc.values.join(' ')} ${bc.space === 'DeviceRGB' ? 'RG' : 'G'}`);
      lines.push(`${appearance.borderWidth} w`);
      const bw = appearance.borderWidth / 2;
      lines.push(`${bbox.x + bw} ${bbox.y + bw} ${bbox.width - appearance.borderWidth} ${bbox.height - appearance.borderWidth} re S`);
    }

    // Checkmark
    if (isChecked) {
      lines.push('0 g'); // Black
      lines.push('2 w');
      lines.push('1 J'); // Round cap

      const cx = bbox.x + bbox.width / 2;
      const cy = bbox.y + bbox.height / 2;
      const size = Math.min(bbox.width, bbox.height) * 0.6;

      // Draw checkmark
      lines.push(`${cx - size * 0.4} ${cy} m`);
      lines.push(`${cx - size * 0.1} ${cy - size * 0.3} l`);
      lines.push(`${cx + size * 0.4} ${cy + size * 0.3} l`);
      lines.push('S');
    }

    return new TextEncoder().encode(lines.join('\n'));
  }

  /**
   * Generate appearance stream for a radio button
   */
  generateRadioAppearance(
    field: RadioField,
    isSelected: boolean,
    bbox: BoundingBox,
    appearance: FieldAppearance
  ): Uint8Array {
    const lines: string[] = [];

    const cx = bbox.x + bbox.width / 2;
    const cy = bbox.y + bbox.height / 2;
    const r = Math.min(bbox.width, bbox.height) / 2 - (appearance.borderWidth || 1);

    // Draw circle (using bezier curves)
    const k = 0.5522847498; // Magic number for circle approximation

    // Background circle
    if (appearance.backgroundColor) {
      const bg = appearance.backgroundColor;
      lines.push(`${bg.values.join(' ')} ${bg.space === 'DeviceRGB' ? 'rg' : 'g'}`);
      this.addCirclePath(lines, cx, cy, r);
      lines.push('f');
    }

    // Border
    if (appearance.borderWidth > 0 && appearance.borderColor) {
      const bc = appearance.borderColor;
      lines.push(`${bc.values.join(' ')} ${bc.space === 'DeviceRGB' ? 'RG' : 'G'}`);
      lines.push(`${appearance.borderWidth} w`);
      this.addCirclePath(lines, cx, cy, r);
      lines.push('S');
    }

    // Selected indicator (filled circle in center)
    if (isSelected) {
      lines.push('0 g'); // Black
      this.addCirclePath(lines, cx, cy, r * 0.5);
      lines.push('f');
    }

    return new TextEncoder().encode(lines.join('\n'));
  }

  /**
   * Generate appearance stream for a combo box
   */
  generateComboBoxAppearance(
    field: ChoiceField,
    bbox: BoundingBox,
    appearance: FieldAppearance
  ): Uint8Array {
    const lines: string[] = [];

    // Background
    if (appearance.backgroundColor) {
      const bg = appearance.backgroundColor;
      lines.push(`${bg.values.join(' ')} ${bg.space === 'DeviceRGB' ? 'rg' : 'g'}`);
      lines.push(`${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height} re f`);
    }

    // Border
    if (appearance.borderWidth > 0 && appearance.borderColor) {
      const bc = appearance.borderColor;
      lines.push(`${bc.values.join(' ')} ${bc.space === 'DeviceRGB' ? 'RG' : 'G'}`);
      lines.push(`${appearance.borderWidth} w`);
      const bw = appearance.borderWidth / 2;
      lines.push(`${bbox.x + bw} ${bbox.y + bw} ${bbox.width - appearance.borderWidth} ${bbox.height - appearance.borderWidth} re S`);
    }

    // Dropdown arrow
    const arrowSize = 10;
    const arrowX = bbox.x + bbox.width - arrowSize - 2;
    const arrowY = bbox.y + bbox.height / 2;

    lines.push('0.5 g'); // Gray arrow
    lines.push(`${arrowX} ${arrowY + 3} m`);
    lines.push(`${arrowX + arrowSize} ${arrowY + 3} l`);
    lines.push(`${arrowX + arrowSize / 2} ${arrowY - 3} l`);
    lines.push('f');

    // Selected value text
    if (field.selectedIndices.length > 0) {
      const selectedOption = field.options[field.selectedIndices[0]];
      if (selectedOption) {
        const fontSize = 10;
        lines.push('BT');
        lines.push(`/Helvetica ${fontSize} Tf`);
        lines.push('0 g');
        lines.push(`${bbox.x + 2} ${bbox.y + (bbox.height - fontSize) / 2 + 2} Td`);
        lines.push(`(${this.escapeString(selectedOption.displayValue)}) Tj`);
        lines.push('ET');
      }
    }

    return new TextEncoder().encode(lines.join('\n'));
  }

  private addCirclePath(lines: string[], cx: number, cy: number, r: number): void {
    const k = 0.5522847498;

    lines.push(`${cx + r} ${cy} m`);
    lines.push(`${cx + r} ${cy + r * k} ${cx + r * k} ${cy + r} ${cx} ${cy + r} c`);
    lines.push(`${cx - r * k} ${cy + r} ${cx - r} ${cy + r * k} ${cx - r} ${cy} c`);
    lines.push(`${cx - r} ${cy - r * k} ${cx - r * k} ${cy - r} ${cx} ${cy - r} c`);
    lines.push(`${cx + r * k} ${cy - r} ${cx + r} ${cy - r * k} ${cx + r} ${cy} c`);
    lines.push('h');
  }

  private escapeString(str: string): string {
    return str
      .replace(/\\/g, '\\\\')
      .replace(/\(/g, '\\(')
      .replace(/\)/g, '\\)')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n');
  }

  private estimateTextWidth(text: string, fontSize: number): number {
    // Rough estimate: average character width is about 0.5 * fontSize
    return text.length * fontSize * 0.5;
  }

  private wrapText(text: string, maxWidth: number, fontSize: number): string[] {
    const words = text.split(/\s+/);
    const lines: string[] = [];
    let currentLine = '';

    for (const word of words) {
      const testLine = currentLine ? `${currentLine} ${word}` : word;
      const testWidth = this.estimateTextWidth(testLine, fontSize);

      if (testWidth <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) {
          lines.push(currentLine);
        }
        currentLine = word;
      }
    }

    if (currentLine) {
      lines.push(currentLine);
    }

    return lines;
  }
}

/**
 * Form field parser - extracts form fields from PDF
 */
export class FormFieldParser {
  /**
   * Parse form fields from a PDF's AcroForm dictionary
   */
  parseAcroForm(acroFormDict: any, pages: any[]): FormField[] {
    const fields: FormField[] = [];
    const fieldsArray = acroFormDict?.Fields || [];

    for (const fieldRef of fieldsArray) {
      const field = this.parseField(fieldRef, null, pages);
      if (field) {
        fields.push(field);
      }
    }

    return fields;
  }

  private parseField(fieldDict: any, parent: any, pages: any[]): FormField | null {
    if (!fieldDict) return null;

    const fieldType = fieldDict.FT || parent?.FT;
    const name = this.buildFieldName(fieldDict, parent);
    const value = fieldDict.V;
    const flags = fieldDict.Ff || 0;

    // Get widget annotation info
    const rect = fieldDict.Rect || [0, 0, 100, 20];
    const pageIndex = this.findPageIndex(fieldDict, pages);

    const baseField: FormField = {
      id: `field_${Math.random().toString(36).substr(2, 9)}`,
      type: 'text',
      name,
      value,
      boundingBox: {
        x: rect[0],
        y: rect[1],
        width: rect[2] - rect[0],
        height: rect[3] - rect[1]
      },
      pageIndex,
      flags,
      options: []
    };

    switch (fieldType) {
      case 'Tx':
        return this.parseTextField(fieldDict, baseField, flags);
      case 'Btn':
        return this.parseButtonField(fieldDict, baseField, flags);
      case 'Ch':
        return this.parseChoiceField(fieldDict, baseField, flags);
      case 'Sig':
        return this.parseSignatureField(fieldDict, baseField);
      default:
        return baseField;
    }
  }

  private parseTextField(dict: any, base: FormField, flags: number): TextField {
    return {
      ...base,
      type: 'text',
      maxLength: dict.MaxLen,
      defaultValue: dict.DV,
      quadding: dict.Q || Quadding.Left,
      isMultiline: (flags & FieldFlags.Multiline) !== 0,
      isPassword: (flags & FieldFlags.Password) !== 0,
      isRichText: (flags & FieldFlags.RichText) !== 0,
      isComb: (flags & FieldFlags.Comb) !== 0,
      fontName: this.extractFontName(dict.DA),
      fontSize: this.extractFontSize(dict.DA)
    };
  }

  private parseButtonField(dict: any, base: FormField, flags: number): CheckboxField | RadioField | ButtonField {
    if (flags & FieldFlags.Pushbutton) {
      return {
        ...base,
        type: 'button',
        caption: dict.CA,
        action: this.parseAction(dict.A)
      };
    }

    if (flags & FieldFlags.Radio) {
      return {
        ...base,
        type: 'radio',
        isSelected: base.value !== 'Off' && base.value !== null,
        exportValue: this.getExportValue(dict),
        groupName: base.name
      };
    }

    // Checkbox
    return {
      ...base,
      type: 'checkbox',
      isChecked: base.value !== 'Off' && base.value !== null,
      exportValue: this.getExportValue(dict),
      onState: this.getOnState(dict),
      offState: 'Off'
    };
  }

  private parseChoiceField(dict: any, base: FormField, flags: number): ChoiceField {
    const options = this.parseOptions(dict.Opt);
    const selectedIndices = this.parseSelectedIndices(dict.I, dict.V, options);

    return {
      ...base,
      type: 'choice',
      options,
      selectedIndices,
      isCombo: (flags & FieldFlags.Combo) !== 0,
      isEditable: (flags & FieldFlags.Edit) !== 0,
      isMultiSelect: (flags & FieldFlags.MultiSelect) !== 0,
      topIndex: dict.TI || 0
    };
  }

  private parseSignatureField(dict: any, base: FormField): SignatureField {
    return {
      ...base,
      type: 'signature',
      isSigned: dict.V !== undefined,
      signatureInfo: dict.V ? this.parseSignatureInfo(dict.V) : undefined
    };
  }

  private buildFieldName(field: any, parent: any): string {
    const parts: string[] = [];
    if (parent?.T) {
      parts.push(parent.T);
    }
    if (field.T) {
      parts.push(field.T);
    }
    return parts.join('.');
  }

  private findPageIndex(field: any, pages: any[]): number {
    // Search for the field's widget in page annotations
    for (let i = 0; i < pages.length; i++) {
      const annots = pages[i].Annots || [];
      for (const annot of annots) {
        if (annot === field || annot.Subtype === 'Widget') {
          return i;
        }
      }
    }
    return 0;
  }

  private parseOptions(opt: any): ChoiceOption[] {
    if (!opt) return [];

    const options: ChoiceOption[] = [];
    for (const item of opt) {
      if (Array.isArray(item)) {
        options.push({
          exportValue: item[0],
          displayValue: item[1] || item[0]
        });
      } else {
        options.push({
          exportValue: item,
          displayValue: item
        });
      }
    }
    return options;
  }

  private parseSelectedIndices(indices: any, value: any, options: ChoiceOption[]): number[] {
    if (Array.isArray(indices)) {
      return indices;
    }

    if (value !== undefined) {
      const idx = options.findIndex(opt => opt.exportValue === value);
      return idx >= 0 ? [idx] : [];
    }

    return [];
  }

  private getExportValue(dict: any): string {
    // Get the export value from the appearance dictionary
    const ap = dict.AP?.N;
    if (ap && typeof ap === 'object') {
      const keys = Object.keys(ap).filter(k => k !== 'Off');
      return keys[0] || 'Yes';
    }
    return 'Yes';
  }

  private getOnState(dict: any): string {
    return this.getExportValue(dict);
  }

  private extractFontName(da: string): string | undefined {
    if (!da) return undefined;
    const match = da.match(/\/([A-Za-z0-9]+)\s+\d+/);
    return match ? match[1] : undefined;
  }

  private extractFontSize(da: string): number | undefined {
    if (!da) return undefined;
    const match = da.match(/\/[A-Za-z0-9]+\s+(\d+(?:\.\d+)?)/);
    return match ? parseFloat(match[1]) : undefined;
  }

  private parseAction(action: any): FormFieldAction | undefined {
    if (!action) return undefined;

    switch (action.S) {
      case 'SubmitForm':
        return {
          type: 'submit',
          data: { url: action.F?.F, flags: action.Flags }
        };
      case 'ResetForm':
        return {
          type: 'reset',
          data: { fields: action.Fields }
        };
      case 'JavaScript':
        return {
          type: 'javascript',
          data: { script: action.JS }
        };
      case 'URI':
        return {
          type: 'uri',
          data: { uri: action.URI }
        };
      case 'GoTo':
        return {
          type: 'goto',
          data: { destination: action.D }
        };
      default:
        return undefined;
    }
  }

  private parseSignatureInfo(sigDict: any): SignatureInfo | undefined {
    if (!sigDict) return undefined;

    return {
      signerName: sigDict.Name,
      signDate: sigDict.M ? this.parsePdfDate(sigDict.M) : undefined,
      reason: sigDict.Reason,
      location: sigDict.Location,
      contactInfo: sigDict.ContactInfo
    };
  }

  private parsePdfDate(dateStr: string): Date | undefined {
    // PDF date format: D:YYYYMMDDHHmmSS+HH'mm'
    const match = dateStr.match(/D:(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})/);
    if (!match) return undefined;

    return new Date(
      parseInt(match[1]),
      parseInt(match[2]) - 1,
      parseInt(match[3]),
      parseInt(match[4]),
      parseInt(match[5]),
      parseInt(match[6])
    );
  }
}

/**
 * Main FormFieldManager class
 */
export class FormFieldManager {
  private fields: Map<string, FormField> = new Map();
  private parser: FormFieldParser;
  private appearanceGenerator: AppearanceStreamGenerator;

  constructor() {
    this.parser = new FormFieldParser();
    this.appearanceGenerator = new AppearanceStreamGenerator();
  }

  /**
   * Load form fields from a PDF document
   */
  loadFromDocument(acroFormDict: any, pages: any[]): void {
    const fields = this.parser.parseAcroForm(acroFormDict, pages);
    for (const field of fields) {
      this.fields.set(field.id, field);
    }
  }

  /**
   * Get all form fields
   */
  getAllFields(): FormField[] {
    return Array.from(this.fields.values());
  }

  /**
   * Get fields by page index
   */
  getFieldsByPage(pageIndex: number): FormField[] {
    return Array.from(this.fields.values()).filter(f => f.pageIndex === pageIndex);
  }

  /**
   * Get a specific field by ID
   */
  getField(fieldId: string): FormField | undefined {
    return this.fields.get(fieldId);
  }

  /**
   * Get a field by name
   */
  getFieldByName(name: string): FormField | undefined {
    return Array.from(this.fields.values()).find(f => f.name === name);
  }

  /**
   * Set field value
   */
  setFieldValue(fieldId: string, value: any): boolean {
    const field = this.fields.get(fieldId);
    if (!field) return false;

    field.value = value;

    // Update type-specific properties
    if (field.type === 'checkbox') {
      (field as CheckboxField).isChecked = value !== 'Off' && value !== false;
    } else if (field.type === 'radio') {
      (field as RadioField).isSelected = value !== 'Off' && value !== false;
    } else if (field.type === 'choice') {
      const choiceField = field as ChoiceField;
      if (Array.isArray(value)) {
        choiceField.selectedIndices = value;
      } else {
        const idx = choiceField.options.findIndex(opt => opt.exportValue === value);
        choiceField.selectedIndices = idx >= 0 ? [idx] : [];
      }
    }

    return true;
  }

  /**
   * Get field value
   */
  getFieldValue(fieldId: string): any {
    const field = this.fields.get(fieldId);
    return field?.value;
  }

  /**
   * Create a new text field
   */
  createTextField(
    name: string,
    pageIndex: number,
    bbox: BoundingBox,
    options?: Partial<TextField>
  ): TextField {
    const field: TextField = {
      id: `field_${Math.random().toString(36).substr(2, 9)}`,
      type: 'text',
      name,
      value: options?.defaultValue || '',
      boundingBox: bbox,
      pageIndex,
      flags: 0,
      maxLength: options?.maxLength,
      defaultValue: options?.defaultValue,
      quadding: options?.quadding || Quadding.Left,
      isMultiline: options?.isMultiline || false,
      isPassword: options?.isPassword || false,
      isRichText: options?.isRichText || false,
      isComb: options?.isComb || false,
      fontName: options?.fontName || 'Helvetica',
      fontSize: options?.fontSize || 12
    };

    this.fields.set(field.id, field);
    return field;
  }

  /**
   * Create a new checkbox
   */
  createCheckbox(
    name: string,
    pageIndex: number,
    bbox: BoundingBox,
    options?: { exportValue?: string; isChecked?: boolean }
  ): CheckboxField {
    const field: CheckboxField = {
      id: `field_${Math.random().toString(36).substr(2, 9)}`,
      type: 'checkbox',
      name,
      value: options?.isChecked ? (options?.exportValue || 'Yes') : 'Off',
      boundingBox: bbox,
      pageIndex,
      flags: 0,
      isChecked: options?.isChecked || false,
      exportValue: options?.exportValue || 'Yes',
      onState: options?.exportValue || 'Yes',
      offState: 'Off'
    };

    this.fields.set(field.id, field);
    return field;
  }

  /**
   * Create a new radio button group
   */
  createRadioGroup(
    groupName: string,
    pageIndex: number,
    buttons: { bbox: BoundingBox; exportValue: string }[]
  ): RadioField[] {
    const fields: RadioField[] = [];

    for (let i = 0; i < buttons.length; i++) {
      const { bbox, exportValue } = buttons[i];
      const field: RadioField = {
        id: `field_${Math.random().toString(36).substr(2, 9)}`,
        type: 'radio',
        name: `${groupName}.${i}`,
        value: 'Off',
        boundingBox: bbox,
        pageIndex,
        flags: FieldFlags.Radio,
        isSelected: false,
        exportValue,
        groupName
      };

      this.fields.set(field.id, field);
      fields.push(field);
    }

    return fields;
  }

  /**
   * Create a new dropdown/combo box
   */
  createDropdown(
    name: string,
    pageIndex: number,
    bbox: BoundingBox,
    options: ChoiceOption[],
    config?: { isEditable?: boolean }
  ): ChoiceField {
    const field: ChoiceField = {
      id: `field_${Math.random().toString(36).substr(2, 9)}`,
      type: 'choice',
      name,
      value: null,
      boundingBox: bbox,
      pageIndex,
      flags: FieldFlags.Combo,
      options,
      selectedIndices: [],
      isCombo: true,
      isEditable: config?.isEditable || false,
      isMultiSelect: false,
      topIndex: 0
    };

    this.fields.set(field.id, field);
    return field;
  }

  /**
   * Delete a field
   */
  deleteField(fieldId: string): boolean {
    return this.fields.delete(fieldId);
  }

  /**
   * Validate all form fields
   */
  validate(): ValidationResult {
    const errors: { fieldId: string; message: string }[] = [];

    for (const [fieldId, field] of this.fields) {
      // Check required fields
      if ((field.flags & FieldFlags.Required) !== 0) {
        if (field.value === null || field.value === undefined || field.value === '') {
          errors.push({ fieldId, message: `${field.name} is required` });
        }
      }

      // Check text field max length
      if (field.type === 'text') {
        const textField = field as TextField;
        if (textField.maxLength && typeof field.value === 'string' && field.value.length > textField.maxLength) {
          errors.push({ fieldId, message: `${field.name} exceeds maximum length of ${textField.maxLength}` });
        }
      }
    }

    return {
      isValid: errors.length === 0,
      errors
    };
  }

  /**
   * Get form data as a dictionary
   */
  getFormData(): Record<string, any> {
    const data: Record<string, any> = {};

    for (const field of this.fields.values()) {
      data[field.name] = field.value;
    }

    return data;
  }

  /**
   * Set form data from a dictionary
   */
  setFormData(data: Record<string, any>): void {
    for (const [name, value] of Object.entries(data)) {
      const field = this.getFieldByName(name);
      if (field) {
        this.setFieldValue(field.id, value);
      }
    }
  }

  /**
   * Generate appearance stream for a field
   */
  generateAppearance(fieldId: string): Uint8Array | null {
    const field = this.fields.get(fieldId);
    if (!field) return null;

    const appearance: FieldAppearance = {
      borderColor: { space: 'DeviceGray', values: [0] },
      backgroundColor: { space: 'DeviceGray', values: [1] },
      borderWidth: 1,
      borderStyle: 'solid',
      rotation: 0
    };

    switch (field.type) {
      case 'text':
        return this.appearanceGenerator.generateTextFieldAppearance(
          field as TextField,
          String(field.value || ''),
          field.boundingBox,
          appearance
        );
      case 'checkbox':
        return this.appearanceGenerator.generateCheckboxAppearance(
          field as CheckboxField,
          (field as CheckboxField).isChecked,
          field.boundingBox,
          appearance
        );
      case 'radio':
        return this.appearanceGenerator.generateRadioAppearance(
          field as RadioField,
          (field as RadioField).isSelected,
          field.boundingBox,
          appearance
        );
      case 'choice':
        return this.appearanceGenerator.generateComboBoxAppearance(
          field as ChoiceField,
          field.boundingBox,
          appearance
        );
      default:
        return null;
    }
  }

  /**
   * Flatten form fields (convert to static content)
   */
  flattenFields(): { pageIndex: number; content: Uint8Array }[] {
    const result: { pageIndex: number; content: Uint8Array }[] = [];

    const byPage = new Map<number, Uint8Array[]>();

    for (const field of this.fields.values()) {
      const appearance = this.generateAppearance(field.id);
      if (appearance) {
        if (!byPage.has(field.pageIndex)) {
          byPage.set(field.pageIndex, []);
        }
        byPage.get(field.pageIndex)!.push(appearance);
      }
    }

    for (const [pageIndex, contents] of byPage) {
      // Combine all appearances for the page
      const totalLength = contents.reduce((sum, c) => sum + c.length + 1, 0);
      const combined = new Uint8Array(totalLength);
      let offset = 0;

      for (const content of contents) {
        combined.set(content, offset);
        offset += content.length;
        combined[offset++] = 10; // newline
      }

      result.push({ pageIndex, content: combined });
    }

    return result;
  }
}

export default FormFieldManager;
