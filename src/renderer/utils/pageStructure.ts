/**
 * Structural page operations on raw PDF bytes.
 *
 * These rebuild `pdfData` through pdf-lib so that the renderer's page model and
 * the underlying bytes never diverge. The entire save pipeline assumes
 * `model page index === physical page index in pdfData` (see pdfSavePipeline.ts,
 * which resolves `pdfDoc.getPage(page.index)`); delete/insert/reorder/rotate must
 * therefore mutate the bytes, not just the model. Mutations are done in place on
 * the loaded document (never via copy-into-a-new-doc) so the AcroForm, outlines,
 * and catalog metadata survive.
 *
 * Page rotation is baked into each page's /Rotate entry as an absolute angle,
 * matching how the model initialises `page.rotation` from `page.rotate` at load
 * and how the viewer passes it to pdf.js `getViewport({ rotation })`.
 */
import { PDFDocument as PDFLib, degrees } from 'pdf-lib';

// pdfData held in memory is always decrypted plaintext (decrypt-at-open), but load
// with ignoreEncryption for parity with replacePage and robustness against any
// residual encryption dict.
async function load(pdfData: Uint8Array): Promise<PDFLib> {
  return PDFLib.load(pdfData, { ignoreEncryption: true });
}

/** Remove the page at `zeroIndex`. Throws if it is the only page or out of range. */
export async function deletePdfPage(
  pdfData: Uint8Array,
  zeroIndex: number
): Promise<Uint8Array> {
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  if (count <= 1) throw new Error('Cannot delete the only page of a document');
  if (zeroIndex < 0 || zeroIndex >= count) {
    throw new Error(`deletePdfPage: index ${zeroIndex} out of range (0..${count - 1})`);
  }
  doc.removePage(zeroIndex);
  return new Uint8Array(await doc.save());
}

/**
 * Insert a blank page of `width` x `height` (PDF points) immediately AFTER
 * `afterZeroIndex`. Pass `afterZeroIndex = -1` to insert at the very front.
 */
export async function insertBlankPdfPage(
  pdfData: Uint8Array,
  afterZeroIndex: number,
  width: number,
  height: number
): Promise<Uint8Array> {
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  const insertAt = Math.min(Math.max(afterZeroIndex + 1, 0), count);
  doc.insertPage(insertAt, [width, height]);
  return new Uint8Array(await doc.save());
}

/**
 * Move the page at `from` to `to`, using post-removal index semantics
 * identical to `array.splice(from, 1)` then `array.splice(to, 0, page)`.
 * The page (and its /Rotate, content, and widgets) travels with the move.
 */
export async function reorderPdfPage(
  pdfData: Uint8Array,
  from: number,
  to: number
): Promise<Uint8Array> {
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  if (from < 0 || from >= count) {
    throw new Error(`reorderPdfPage: from ${from} out of range (0..${count - 1})`);
  }
  if (to < 0 || to >= count) {
    throw new Error(`reorderPdfPage: to ${to} out of range (0..${count - 1})`);
  }
  if (from === to) return new Uint8Array(pdfData);
  const page = doc.getPage(from);
  doc.removePage(from);
  doc.insertPage(to, page);
  return new Uint8Array(await doc.save());
}

/**
 * Set the ABSOLUTE rotation of the page at `zeroIndex` (baked into /Rotate).
 * `absoluteAngle` is normalised to [0, 360); it must resolve to a multiple of 90.
 */
export async function setPdfPageRotation(
  pdfData: Uint8Array,
  zeroIndex: number,
  absoluteAngle: number
): Promise<Uint8Array> {
  const doc = await load(pdfData);
  const count = doc.getPageCount();
  if (zeroIndex < 0 || zeroIndex >= count) {
    throw new Error(`setPdfPageRotation: index ${zeroIndex} out of range (0..${count - 1})`);
  }
  const norm = (((absoluteAngle % 360) + 360) % 360);
  if (norm % 90 !== 0) {
    throw new Error(`setPdfPageRotation: angle ${absoluteAngle} is not a multiple of 90`);
  }
  doc.getPage(zeroIndex).setRotation(degrees(norm));
  return new Uint8Array(await doc.save());
}
