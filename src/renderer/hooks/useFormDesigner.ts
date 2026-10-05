/**
 * useFormDesigner — state and actions for the "Form" authoring tool.
 *
 * The field list is read from the committed bytes (readFormModel) rather than
 * the pdf.js mappings, because authoring needs options, flags, defaults and
 * exact widget rects. Every edit is one applyDocumentTransform step, so it is
 * serialized with page ops, undoable, and followed by a viewer reload that
 * makes the new widget fillable in the pdf.js form layer.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  readFormModel,
  createFormField,
  updateFormFieldProperties,
  setFormWidgetRect,
  deleteFormField,
  FormBuilderError,
  FormModel,
  FormFieldInfo,
  CreatableFieldKind,
  FieldRect,
  FieldPropertyUpdate,
} from '../utils/formBuilder';
import type { DocumentTransformInput, DocumentTransformOutput } from './usePDFDocument';

type ApplyTransform = <T extends DocumentTransformOutput>(
  type: string,
  transform: (input: DocumentTransformInput) => Promise<T | null>
) => Promise<T | null>;

interface UseFormDesignerArgs {
  pdfData: Uint8Array | undefined;
  active: boolean;
  applyDocumentTransform: ApplyTransform;
  onError: (message: string) => void;
}

const DEFAULT_OPTIONS: Partial<Record<CreatableFieldKind, string[]>> = {
  radio: ['Option 1', 'Option 2'],
  dropdown: ['Option 1', 'Option 2', 'Option 3'],
  listbox: ['Option 1', 'Option 2', 'Option 3'],
};

export interface FormDesigner {
  model: FormModel | null;
  loadError: string | null;
  busy: boolean;
  newFieldKind: CreatableFieldKind;
  setNewFieldKind: (kind: CreatableFieldKind) => void;
  selectedName: string | null;
  selectedField: FormFieldInfo | null;
  select: (name: string | null) => void;
  createField: (pageIndex: number, rect: FieldRect) => Promise<void>;
  updateField: (name: string, update: FieldPropertyUpdate) => Promise<boolean>;
  moveWidget: (name: string, widgetIndex: number, rect: FieldRect) => Promise<void>;
  deleteField: (name: string) => Promise<void>;
}

function describeError(e: unknown): string {
  if (e instanceof FormBuilderError) return e.message;
  return `Form edit failed: ${e instanceof Error ? e.message : String(e)}`;
}

export function useFormDesigner({ pdfData, active, applyDocumentTransform, onError }: UseFormDesignerArgs): FormDesigner {
  const [modelState, setModelState] = useState<{ bytes: Uint8Array; model: FormModel } | null>(null);
  const model = modelState?.model ?? null;
  const [loadError, setLoadError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newFieldKind, setNewFieldKind] = useState<CreatableFieldKind>('text');
  const [selectedName, setSelectedName] = useState<string | null>(null);

  useEffect(() => {
    if (!active || !pdfData || pdfData.length === 0) return;
    let cancelled = false;
    readFormModel(pdfData)
      .then((m) => {
        if (cancelled) return;
        setModelState({ bytes: pdfData, model: m });
        setLoadError(null);
      })
      .catch((e) => {
        if (cancelled) return;
        console.error('Failed to read form fields:', e);
        setModelState(null);
        setLoadError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [active, pdfData]);

  // Undo/redo or a delete can remove the selected field. Only judge against a
  // model read from the CURRENT bytes: right after a create, the previous
  // model (without the new field) is still in state until the re-read lands.
  useEffect(() => {
    if (!selectedName || !modelState || modelState.bytes !== pdfData) return;
    if (!modelState.model.fields.some((f) => f.name === selectedName)) setSelectedName(null);
  }, [modelState, pdfData, selectedName]);

  useEffect(() => {
    if (!active) setSelectedName(null);
  }, [active]);

  const run = useCallback(
    async (type: string, edit: (bytes: Uint8Array) => Promise<Uint8Array>): Promise<boolean> => {
      setBusy(true);
      try {
        const out = await applyDocumentTransform(type, async ({ bakedBytes }) => ({ pdfData: await edit(bakedBytes) }));
        return out !== null;
      } catch (e) {
        console.error(`[FormDesigner] ${type} failed:`, e);
        onError(describeError(e));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [applyDocumentTransform, onError]
  );

  const createField = useCallback(
    async (pageIndex: number, rect: FieldRect) => {
      let createdName: string | null = null;
      const ok = await run('createFormField', async (bytes) => {
        const result = await createFormField(bytes, {
          kind: newFieldKind,
          pageIndex,
          rect,
          options: DEFAULT_OPTIONS[newFieldKind],
        });
        createdName = result.name;
        return result.bytes;
      });
      if (ok && createdName) setSelectedName(createdName);
    },
    [run, newFieldKind]
  );

  const updateField = useCallback(
    async (name: string, update: FieldPropertyUpdate) => {
      const ok = await run('updateFormField', (bytes) => updateFormFieldProperties(bytes, name, update));
      if (ok && update.name && update.name !== name) {
        const prefix = name.includes('.') ? name.slice(0, name.lastIndexOf('.') + 1) : '';
        setSelectedName(`${prefix}${update.name}`);
      }
      return ok;
    },
    [run]
  );

  const moveWidget = useCallback(
    async (name: string, widgetIndex: number, rect: FieldRect) => {
      await run('moveFormField', (bytes) => setFormWidgetRect(bytes, name, widgetIndex, rect));
    },
    [run]
  );

  const deleteField = useCallback(
    async (name: string) => {
      const ok = await run('deleteFormField', (bytes) => deleteFormField(bytes, name));
      if (ok) setSelectedName(null);
    },
    [run]
  );

  const selectedField = (selectedName && model?.fields.find((f) => f.name === selectedName)) || null;

  return {
    model,
    loadError,
    busy,
    newFieldKind,
    setNewFieldKind,
    selectedName,
    selectedField,
    select: setSelectedName,
    createField,
    updateField,
    moveWidget,
    deleteField,
  };
}
