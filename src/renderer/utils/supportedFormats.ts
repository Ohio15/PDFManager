// Single source of truth for which file types PDF Manager can open and convert.
//
// - PDFs open directly in the viewer.
// - Every other supported type is "staged": held as a conversion source until
//   the user converts it to PDF (via LibreOffice at convert time).

/** Document formats LibreOffice can convert to PDF. */
export const DOC_TO_PDF_EXTENSIONS = [
  'doc', 'docx', 'odt', 'rtf', 'txt',
  'ppt', 'pptx', 'odp',
  'xls', 'xlsx', 'ods',
  'html', 'htm',
] as const;

/** Everything the generic "Open File" action accepts. */
export const OPENABLE_EXTENSIONS = ['pdf', ...DOC_TO_PDF_EXTENSIONS] as const;

/** Human-readable list for hints (e.g. "PDF, Word, Excel, PowerPoint"). */
export const SUPPORTED_FORMATS_LABEL = 'PDF, Word, Excel, PowerPoint, and more';

export function getExtension(filePath: string): string {
  const name = filePath.replace(/\\/g, '/').split('/').pop() || '';
  const dot = name.lastIndexOf('.');
  return dot >= 0 ? name.slice(dot + 1).toLowerCase() : '';
}

export function isPdf(filePath: string): boolean {
  return getExtension(filePath) === 'pdf';
}

/** A non-PDF document we can convert to PDF. */
export function isConvertibleToPdf(filePath: string): boolean {
  return (DOC_TO_PDF_EXTENSIONS as readonly string[]).includes(getExtension(filePath));
}

/** Anything the generic Open action will accept (PDF or convertible doc). */
export function isOpenable(filePath: string): boolean {
  return (OPENABLE_EXTENSIONS as readonly string[]).includes(getExtension(filePath));
}

/** Short, friendly label for a staged document's type. */
export function describeFormat(filePath: string): string {
  const ext = getExtension(filePath);
  const map: Record<string, string> = {
    doc: 'Word Document', docx: 'Word Document', odt: 'OpenDocument Text', rtf: 'Rich Text', txt: 'Text File',
    ppt: 'PowerPoint', pptx: 'PowerPoint', odp: 'OpenDocument Presentation',
    xls: 'Excel Spreadsheet', xlsx: 'Excel Spreadsheet', ods: 'OpenDocument Spreadsheet',
    html: 'HTML Document', htm: 'HTML Document',
  };
  return map[ext] || (ext ? `${ext.toUpperCase()} File` : 'Document');
}
