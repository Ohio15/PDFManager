/**
 * pdfjsReload — open bytes in a short-lived pdf.js document, run a read, and
 * always release the worker-side document afterwards.
 */

import * as pdfjsLib from 'pdfjs-dist';
import { PDFJS_DOCUMENT_OPTIONS } from './pdfjsConfig';

export async function withPdfJsDocument<T>(
  bytes: Uint8Array,
  read: (doc: pdfjsLib.PDFDocumentProxy) => Promise<T>
): Promise<T> {
  // pdf.js transfers (detaches) the buffer it is given; never hand it pdfData itself.
  const loadingTask = pdfjsLib.getDocument({ ...PDFJS_DOCUMENT_OPTIONS, data: new Uint8Array(bytes) });
  const doc = await loadingTask.promise;
  try {
    return await read(doc);
  } finally {
    await loadingTask.destroy();
  }
}
