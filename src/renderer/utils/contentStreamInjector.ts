/**
 * Content Stream Injector
 *
 * Appends new content streams to PDF pages. New streams are wrapped in q/Q
 * (save/restore graphics state) to isolate them from existing content,
 * compressed with pako, and appended AFTER existing content so annotations
 * render on top.
 *
 * Pattern follows blankText.ts for stream creation and page dict access.
 */

import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFStream,
  PDFRawStream,
  PDFRef,
} from 'pdf-lib';
import * as pako from 'pako';

/**
 * Append a new content stream to a page.
 *
 * The provided bytes are wrapped in `q` / `Q` (graphics state save/restore),
 * compressed with FlateDecode, and appended to the page's /Contents array.
 * If /Contents is a single stream, it's first converted to an array.
 *
 * @param pdfDoc - The pdf-lib document
 * @param pageIndex - Zero-based page index
 * @param contentBytes - Raw content stream bytes (e.g. from ContentStreamBuilder.build())
 */
export function appendContentStream(
  pdfDoc: PDFDocument,
  pageIndex: number,
  contentBytes: Uint8Array
): void {
  const context = pdfDoc.context;
  const page = pdfDoc.getPages()[pageIndex];
  const pageDict = page.node;

  // Wrap in q/Q for graphics state isolation
  const prefix = new Uint8Array([0x71, 0x0A]); // "q\n"
  const suffix = new Uint8Array([0x0A, 0x51, 0x0A]); // "\nQ\n"
  const wrapped = new Uint8Array(prefix.length + contentBytes.length + suffix.length);
  wrapped.set(prefix, 0);
  wrapped.set(contentBytes, prefix.length);
  wrapped.set(suffix, prefix.length + contentBytes.length);

  // Compress with pako
  const compressed = pako.deflate(wrapped);

  // Create the new stream object
  const streamDict = context.obj({
    Length: compressed.length,
    Filter: 'FlateDecode',
  });
  const newStream = context.stream(compressed, streamDict);
  const newStreamRef = context.register(newStream);

  // Get existing Contents
  const contentsRef = pageDict.get(PDFName.of('Contents'));
  if (!contentsRef) {
    // No existing contents - set directly
    pageDict.set(PDFName.of('Contents'), newStreamRef);
    return;
  }

  const contentsObj = context.lookup(contentsRef);

  if (contentsObj instanceof PDFArray) {
    // Already an array - append our new stream
    contentsObj.push(newStreamRef);
  } else if (contentsObj instanceof PDFStream || contentsObj instanceof PDFRawStream) {
    // Single stream - convert to array with existing + new
    const newArray = context.obj([contentsRef as PDFRef, newStreamRef]);
    pageDict.set(PDFName.of('Contents'), newArray);
  } else {
    // Unknown type - replace with just our stream
    pageDict.set(PDFName.of('Contents'), newStreamRef);
  }
}
