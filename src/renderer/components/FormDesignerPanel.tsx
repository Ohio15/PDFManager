import React, { useEffect, useMemo, useState } from 'react';
import {
  X,
  Type,
  CheckSquare,
  CircleDot,
  ChevronDownSquare,
  List,
  PenLine,
  Trash2,
  Check,
  Loader2,
  MousePointerSquareDashed,
} from 'lucide-react';
import type { FormDesigner } from '../hooks/useFormDesigner';
import { validateFieldName, CreatableFieldKind, FormFieldInfo, FieldPropertyUpdate } from '../utils/formBuilder';
import '../styles/forms-finalize.css';

interface FormDesignerPanelProps {
  visible: boolean;
  designer: FormDesigner;
  onClose: () => void;
}

const KINDS: Array<{ kind: CreatableFieldKind; label: string; icon: React.ReactNode }> = [
  { kind: 'text', label: 'Text', icon: <Type size={16} /> },
  { kind: 'checkbox', label: 'Checkbox', icon: <CheckSquare size={16} /> },
  { kind: 'radio', label: 'Radio', icon: <CircleDot size={16} /> },
  { kind: 'dropdown', label: 'Dropdown', icon: <ChevronDownSquare size={16} /> },
  { kind: 'listbox', label: 'List', icon: <List size={16} /> },
  { kind: 'signature', label: 'Signature', icon: <PenLine size={16} /> },
];

const KIND_NAMES: Record<string, string> = {
  text: 'Text field',
  checkbox: 'Checkbox',
  radio: 'Radio group',
  dropdown: 'Dropdown',
  listbox: 'List box',
  signature: 'Signature',
  button: 'Push button',
};

interface Draft {
  name: string;
  required: boolean;
  readOnly: boolean;
  multiline: boolean;
  fontSize: string;
  defaultValue: string;
  options: string;
}

function draftFor(field: FormFieldInfo): Draft {
  const partial = field.name.includes('.') ? field.name.slice(field.name.lastIndexOf('.') + 1) : field.name;
  return {
    name: partial,
    required: field.required,
    readOnly: field.readOnly,
    multiline: field.multiline,
    fontSize: field.fontSize === null ? '' : String(field.fontSize),
    defaultValue: field.defaultValue,
    options: field.options.join('\n'),
  };
}

function parseOptions(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split('\n')) {
    const v = line.trim();
    if (v && !out.includes(v)) out.push(v);
  }
  return out;
}

const FormDesignerPanel: React.FC<FormDesignerPanelProps> = ({ visible, designer, onClose }) => {
  const field = designer.selectedField;
  const [draft, setDraft] = useState<Draft | null>(null);

  // Reset the draft whenever the selection or the committed field changes.
  const fieldKey = field ? JSON.stringify(field) : '';
  useEffect(() => {
    setDraft(field ? draftFor(field) : null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fieldKey]);

  // Delete removes the selected field unless the user is typing somewhere.
  useEffect(() => {
    if (!visible || !field) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Delete') return;
      const target = e.target as HTMLElement | null;
      if (target && (target.closest('input, textarea, select, [contenteditable="true"]'))) return;
      e.preventDefault();
      void designer.deleteField(field.name);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [visible, field, designer]);

  const otherNames = useMemo(
    () => (designer.model?.fields ?? []).map((f) => f.name).filter((n) => n !== field?.name),
    [designer.model, field]
  );

  if (!visible) return null;

  const kind = field?.kind;
  const editable = !!field && kind !== 'button';
  const hasFont = kind === 'text' || kind === 'dropdown' || kind === 'listbox';
  const hasOptions = kind === 'dropdown' || kind === 'listbox' || kind === 'radio';
  const options = draft ? parseOptions(draft.options) : [];

  let nameError: string | null = null;
  if (field && draft) {
    const prefix = field.name.includes('.') ? field.name.slice(0, field.name.lastIndexOf('.') + 1) : '';
    const fullName = `${prefix}${draft.name}`;
    nameError =
      validateFieldName(draft.name, []) ??
      (otherNames.some((n) => n === fullName || n.startsWith(`${fullName}.`)) ? `A field named "${fullName}" already exists` : null);
  }
  let fontError: string | null = null;
  if (draft && hasFont) {
    const size = Number(draft.fontSize);
    if (draft.fontSize.trim() === '' || !Number.isFinite(size) || size < 0 || size > 144) fontError = 'Font size must be 0 (auto) to 144';
  }
  let optionsError: string | null = null;
  if (draft && hasOptions) {
    if (kind === 'radio' && options.length < 2) optionsError = 'A radio group needs at least two options';
    if (kind !== 'radio' && options.length < 1) optionsError = 'Add at least one option';
  }
  let defaultError: string | null = null;
  if (draft && hasOptions && draft.defaultValue && !options.includes(draft.defaultValue)) {
    defaultError = 'The default must be one of the options';
  }
  const invalid = !!(nameError || fontError || optionsError || defaultError);

  const buildUpdate = (): FieldPropertyUpdate => {
    if (!field || !draft) return {};
    const base = draftFor(field);
    const update: FieldPropertyUpdate = {};
    if (draft.name !== base.name) update.name = draft.name;
    if (draft.required !== base.required) update.required = draft.required;
    if (draft.readOnly !== base.readOnly) update.readOnly = draft.readOnly;
    if (kind === 'text' && draft.multiline !== base.multiline) update.multiline = draft.multiline;
    if (hasFont && draft.fontSize !== base.fontSize) update.fontSize = Number(draft.fontSize);
    if (hasOptions && draft.options !== base.options) update.options = options;
    if (draft.defaultValue !== base.defaultValue) update.defaultValue = draft.defaultValue;
    return update;
  };
  const pendingUpdate = buildUpdate();
  const dirty = Object.keys(pendingUpdate).length > 0;

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => setDraft((d) => (d ? { ...d, [key]: value } : d));

  return (
    <aside className="form-designer-panel" data-testid="form-designer-panel">
      <div className="form-designer-header">
        <h3>Form Fields</h3>
        <button className="form-designer-close" onClick={onClose} title="Close form tool" aria-label="Close form tool">
          <X size={16} />
        </button>
      </div>

      <div className="form-designer-body">
        <section className="form-designer-section">
          <h4>New field</h4>
          <div className="form-kind-grid" role="radiogroup" aria-label="New field type">
            {KINDS.map((k) => (
              <button
                key={k.kind}
                role="radio"
                aria-checked={designer.newFieldKind === k.kind}
                className={`form-kind-btn ${designer.newFieldKind === k.kind ? 'active' : ''}`}
                onClick={() => designer.setNewFieldKind(k.kind)}
                data-kind={k.kind}
              >
                {k.icon}
                <span>{k.label}</span>
              </button>
            ))}
          </div>
          <p className="form-designer-hint">
            <MousePointerSquareDashed size={14} /> Drag on the page to place a field. Drag a field to move it, or a corner to resize it.
          </p>
        </section>

        {designer.loadError && <p className="dialog-error">Could not read form fields: {designer.loadError}</p>}

        {field && draft ? (
          <section className="form-designer-section" data-testid="form-field-properties">
            <h4>
              {KIND_NAMES[field.kind]}
              {designer.busy && <Loader2 size={14} className="spinning" />}
            </h4>
            <div className="form-group">
              <label htmlFor="ffd-name">Name</label>
              <input id="ffd-name" type="text" value={draft.name} disabled={!editable} onChange={(e) => set('name', e.target.value)} />
              {nameError && <span className="form-field-error">{nameError}</span>}
            </div>
            <div className="form-designer-checks">
              <label><input type="checkbox" checked={draft.required} disabled={!editable} onChange={(e) => set('required', e.target.checked)} /> Required</label>
              <label><input type="checkbox" checked={draft.readOnly} disabled={!editable} onChange={(e) => set('readOnly', e.target.checked)} /> Read-only</label>
              {kind === 'text' && (
                <label><input type="checkbox" checked={draft.multiline} onChange={(e) => set('multiline', e.target.checked)} /> Multiline</label>
              )}
            </div>
            {hasFont && (
              <div className="form-group">
                <label htmlFor="ffd-font">Font size (0 = auto)</label>
                <input id="ffd-font" type="number" min={0} max={144} value={draft.fontSize} onChange={(e) => set('fontSize', e.target.value)} />
                {fontError && <span className="form-field-error">{fontError}</span>}
              </div>
            )}
            {hasOptions && (
              <div className="form-group">
                <label htmlFor="ffd-options">Options (one per line)</label>
                <textarea id="ffd-options" rows={4} value={draft.options} onChange={(e) => set('options', e.target.value)} />
                {optionsError && <span className="form-field-error">{optionsError}</span>}
              </div>
            )}
            {kind !== 'signature' && kind !== 'button' && (
              <div className="form-group">
                <label htmlFor="ffd-default">Default value</label>
                {kind === 'checkbox' ? (
                  <select id="ffd-default" value={draft.defaultValue} onChange={(e) => set('defaultValue', e.target.value)}>
                    <option value="">Unchecked</option>
                    <option value="checked">Checked</option>
                  </select>
                ) : hasOptions ? (
                  <select id="ffd-default" value={draft.defaultValue} onChange={(e) => set('defaultValue', e.target.value)}>
                    <option value="">(none)</option>
                    {options.map((o) => <option key={o} value={o}>{o}</option>)}
                  </select>
                ) : (
                  <input id="ffd-default" type="text" value={draft.defaultValue} onChange={(e) => set('defaultValue', e.target.value)} />
                )}
                {defaultError && <span className="form-field-error">{defaultError}</span>}
              </div>
            )}
            <div className="dialog-actions form-designer-actions">
              <button className="btn btn-ghost danger" onClick={() => void designer.deleteField(field.name)} disabled={designer.busy} title="Delete field (Del)">
                <Trash2 size={16} /> Delete
              </button>
              <button
                className="btn btn-primary"
                disabled={!dirty || invalid || designer.busy || !editable}
                onClick={() => void designer.updateField(field.name, pendingUpdate)}
              >
                <Check size={16} /> Apply
              </button>
            </div>
          </section>
        ) : (
          <p className="form-designer-empty">Select a field on the page to edit its properties.</p>
        )}

        <section className="form-designer-section">
          <h4>All fields ({designer.model?.fields.length ?? 0})</h4>
          <ul className="form-designer-list">
            {(designer.model?.fields ?? []).map((f) => (
              <li key={f.name}>
                <button
                  className={`form-designer-list-item ${f.name === designer.selectedName ? 'active' : ''}`}
                  onClick={() => designer.select(f.name)}
                >
                  <span className="name">{f.name}</span>
                  <span className="kind">{KIND_NAMES[f.kind]}{f.widgets[0] ? ` · p${f.widgets[0].pageIndex + 1}` : ''}</span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </aside>
  );
};

export default FormDesignerPanel;
