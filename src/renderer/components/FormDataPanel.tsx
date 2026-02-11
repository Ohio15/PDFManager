import React, { useMemo } from 'react';
import { FormFieldMapping } from '../utils/formFieldSaver';

interface FormDataPanelProps {
  visible: boolean;
  onClose: () => void;
  formFields: FormFieldMapping[];
  annotationStorage: any | null;
  onExportFormData: () => void;
  onResetForm: () => void;
  onFlattenForm: () => void;
}

const fieldTypeLabels: Record<string, string> = {
  text: 'Text Fields',
  checkbox: 'Checkboxes',
  radio: 'Radio Buttons',
  dropdown: 'Dropdowns',
  listbox: 'List Boxes',
  button: 'Buttons',
  signature: 'Signatures',
};

const fieldTypeIcons: Record<string, React.ReactNode> = {
  text: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  ),
  checkbox: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 11 12 14 22 4" />
      <path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11" />
    </svg>
  ),
  radio: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="10" />
      <circle cx="12" cy="12" r="4" fill="currentColor" />
    </svg>
  ),
  dropdown: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="6 9 12 15 18 9" />
    </svg>
  ),
  listbox: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="8" y1="6" x2="21" y2="6" />
      <line x1="8" y1="12" x2="21" y2="12" />
      <line x1="8" y1="18" x2="21" y2="18" />
      <line x1="3" y1="6" x2="3.01" y2="6" />
      <line x1="3" y1="12" x2="3.01" y2="12" />
      <line x1="3" y1="18" x2="3.01" y2="18" />
    </svg>
  ),
  button: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="8" width="18" height="8" rx="2" />
    </svg>
  ),
  signature: (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z" />
    </svg>
  ),
};

const FormDataPanel: React.FC<FormDataPanelProps> = ({
  visible,
  onClose,
  formFields,
  annotationStorage,
  onExportFormData,
  onResetForm,
  onFlattenForm,
}) => {
  const groupedFields = useMemo(() => {
    const groups: Record<string, FormFieldMapping[]> = {};
    for (const field of formFields) {
      if (!groups[field.fieldType]) {
        groups[field.fieldType] = [];
      }
      groups[field.fieldType].push(field);
    }
    return groups;
  }, [formFields]);

  const getFieldValue = (annotationId: string): string => {
    if (!annotationStorage) return '';
    try {
      const raw = annotationStorage.getRawValue(annotationId);
      if (!raw) return '';
      const val = (raw as any).value;
      if (val === true) return 'Checked';
      if (val === false) return 'Unchecked';
      if (typeof val === 'string') return val;
      return String(val ?? '');
    } catch {
      return '';
    }
  };

  if (!visible) return null;

  return (
    <div className="form-data-panel">
      <div className="form-data-panel-header">
        <h3>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
          Form Fields
          <span className="form-count-badge">{formFields.length}</span>
        </h3>
        <button className="form-data-panel-close" onClick={onClose} title="Close panel">
          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <line x1="18" y1="6" x2="6" y2="18" />
            <line x1="6" y1="6" x2="18" y2="18" />
          </svg>
        </button>
      </div>

      <div className="form-data-panel-body">
        {Object.entries(groupedFields).map(([type, fields]) => (
          <div className="form-field-group" key={type}>
            <div className="form-field-group-header">
              {fieldTypeIcons[type] || null}
              {fieldTypeLabels[type] || type} ({fields.length})
            </div>
            {fields.map((field) => {
              const val = getFieldValue(field.annotationId);
              return (
                <div className="form-field-item" key={field.annotationId}>
                  <div className="form-field-item-name">
                    {field.fieldName || `(unnamed field)`}
                  </div>
                  <div className="form-field-item-value">
                    {val || '(empty)'}
                  </div>
                </div>
              );
            })}
          </div>
        ))}
        {formFields.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 0', fontSize: '13px' }}>
            No form fields detected
          </div>
        )}
      </div>

      <div className="form-data-panel-actions">
        <button onClick={onExportFormData} title="Export form data as JSON">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="7 10 12 15 17 10" />
            <line x1="12" y1="15" x2="12" y2="3" />
          </svg>
          Export Form Data
        </button>
        <button onClick={onResetForm} title="Reset all form fields to default values">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="1 4 1 10 7 10" />
            <path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10" />
          </svg>
          Reset Form
        </button>
        <button className="flatten-btn" onClick={onFlattenForm} title="Convert form fields to static text (irreversible)">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
            <line x1="3" y1="9" x2="21" y2="9" />
            <line x1="9" y1="21" x2="9" y2="9" />
          </svg>
          Flatten Form
        </button>
      </div>
    </div>
  );
};

export default FormDataPanel;
