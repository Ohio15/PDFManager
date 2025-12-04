/**
 * PDF Parser Module
 *
 * A comprehensive PDF parsing and editing library providing:
 * - Content stream parsing and building
 * - Layout analysis (words, lines, paragraphs, columns, tables)
 * - Font subsetting and embedding
 * - Form field management
 */

// Types
export * from './types';

// Content Stream Parser
export {
  ContentStreamLexer,
  ContentStreamParser,
  ContentStreamInterpreter
} from './ContentStreamParser';

// Content Stream Builder
export {
  ContentStreamBuilder,
  TextEditCompiler,
  ContentStreamMerger
} from './ContentStreamBuilder';

// Layout Analyzer
export {
  LayoutAnalyzer,
  ReadingOrderDetector
} from './LayoutAnalyzer';

// Font Manager
export {
  TrueTypeFontParser,
  FontSubsetter,
  ToUnicodeCMapGenerator,
  FontManager
} from './FontManager';

// Form Field Manager
export {
  FieldFlags,
  Quadding,
  AppearanceStreamGenerator,
  FormFieldParser,
  FormFieldManager
} from './FormFieldManager';
export type {
  TextField,
  CheckboxField,
  RadioField,
  ButtonField,
  ChoiceField,
  SignatureField,
  ChoiceOption,
  FormFieldAction,
  SignatureInfo,
  FieldAppearance,
  ValidationResult
} from './FormFieldManager';

// PDF Document Editor (integration layer)
export { PDFDocumentEditor } from './PDFDocumentEditor';
export type { TextEdit, ImageEdit, DocumentState } from './PDFDocumentEditor';

// Re-export default classes
export { default as FontManagerDefault } from './FontManager';
export { default as FormFieldManagerDefault } from './FormFieldManager';
export { default as PDFDocumentEditorDefault } from './PDFDocumentEditor';
