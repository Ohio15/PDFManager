import React, { useMemo, useState } from 'react';
import { FormFieldMapping, getFormFieldStats, isFieldFilled } from '../utils/formFieldSaver';

interface FormDataPanelProps {
  visible: boolean;
  onClose: () => void;
  formFields: FormFieldMapping[];
  annotationStorage: any | null;
  onExportFormData: () => void;
  onImportFormData: () => void;
  onResetForm: () => void;
  onFlattenForm: () => void;
  onScrollToField: (pageIndex: number, rect: [number, number, number, number] | null) => void;
}

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
  onImportFormData,
  onResetForm,
  onFlattenForm,
  onScrollToField,
}) => {
  const [searchQuery, setSearchQuery] = useState('');

  // Sort fields by page, then by vertical position (y coordinate from rect)
  const sortedFields = useMemo(() => {
    return [...formFields].sort((a, b) => {
      if (a.pageIndex !== b.pageIndex) return a.pageIndex - b.pageIndex;
      // Sort by y position (rect[1] = y1 in PDF coords — higher y = higher on page)
      // We want top-to-bottom visual order, so sort descending by y
      const ay = a.rect ? a.rect[3] : 0; // use y2 (top edge in PDF coords)
      const by = b.rect ? b.rect[3] : 0;
      return by - ay;
    });
  }, [formFields]);

  // Filter by search query
  const filteredFields = useMemo(() => {
    if (!searchQuery.trim()) return sortedFields;
    const q = searchQuery.toLowerCase();
    return sortedFields.filter(f =>
      (f.fieldName || '').toLowerCase().includes(q)
    );
  }, [sortedFields, searchQuery]);

  // Compute stats
  const stats = useMemo(() => {
    return getFormFieldStats(formFields, annotationStorage);
  }, [formFields, annotationStorage]);

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

  const fillPct = stats.total > 0 ? Math.round((stats.filled / stats.total) * 100) : 0;
  const requiredRemaining = stats.required - stats.requiredFilled;
  const showSearch = formFields.length > 10;

  // Group filtered fields by page for display
  let currentPage = -1;

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

      {/* Progress bar */}
      {stats.total > 0 && (
        <div className="form-progress-container">
          <div className="form-progress-bar">
            <div className="form-progress-fill" style={{ width: `${fillPct}%` }} />
          </div>
          <div className="form-progress-text">
            {stats.filled} / {stats.total} fields filled
            {requiredRemaining > 0 && (
              <span className="required-remaining"> ({requiredRemaining} required remaining)</span>
            )}
          </div>
        </div>
      )}

      {/* Search input for large forms */}
      {showSearch && (
        <div className="form-field-search">
          <div className="form-field-search-wrapper">
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="11" cy="11" r="8" />
              <line x1="21" y1="21" x2="16.65" y2="16.65" />
            </svg>
            <input
              type="text"
              placeholder="Search fields..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
          </div>
        </div>
      )}

      <div className="form-data-panel-body">
        {filteredFields.map((field) => {
          const val = getFieldValue(field.annotationId);
          const filled = isFieldFilled(field, annotationStorage);
          const showPageHeader = field.pageIndex !== currentPage;
          if (showPageHeader) currentPage = field.pageIndex;

          return (
            <React.Fragment key={field.annotationId}>
              {showPageHeader && (
                <div className="form-field-group-header" style={{ marginTop: currentPage > 0 ? 12 : 0 }}>
                  {fieldTypeIcons[field.fieldType] || null}
                  Page {field.pageIndex + 1}
                </div>
              )}
              <div
                className={`form-field-item-clickable${field.readOnly ? ' readonly-field' : ''}`}
                onClick={() => onScrollToField(field.pageIndex, field.rect)}
                title={`Click to scroll to this field on page ${field.pageIndex + 1}`}
              >
                <div className="form-field-item-name" style={{ display: 'flex', alignItems: 'center' }}>
                  {fieldTypeIcons[field.fieldType] || null}
                  <span style={{ marginLeft: 4 }}>{field.fieldName || '(unnamed field)'}</span>
                  {/* Required badge */}
                  {field.required && !filled && (
                    <span className="form-field-badge-required">Required</span>
                  )}
                  {/* Filled checkmark for required fields */}
                  {field.required && filled && (
                    <span className="form-field-badge-filled">
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                      </svg>
                    </span>
                  )}
                  {/* Read-only lock icon */}
                  {field.readOnly && (
                    <span className="form-field-badge-readonly">
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                      </svg>
                    </span>
                  )}
                  <span className="form-field-page-label">p.{field.pageIndex + 1}</span>
                </div>
                <div className="form-field-item-value">
                  {val || '(empty)'}
                </div>
              </div>
            </React.Fragment>
          );
        })}
        {formFields.length === 0 && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 0', fontSize: '13px' }}>
            No form fields detected
          </div>
        )}
        {formFields.length > 0 && filteredFields.length === 0 && searchQuery && (
          <div style={{ textAlign: 'center', color: 'var(--text-muted)', padding: '24px 0', fontSize: '13px' }}>
            No fields matching "{searchQuery}"
          </div>
        )}
      </div>

      <div className="form-data-panel-actions">
        <button onClick={onImportFormData} title="Import form data from JSON file">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
            <polyline points="17 8 12 3 7 8" />
            <line x1="12" y1="3" x2="12" y2="15" />
          </svg>
          Import Form Data
        </button>
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
