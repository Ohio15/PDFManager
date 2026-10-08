/**
 * Prepare another PDF's bytes for use as a page source (insert / replace).
 *
 * pdf-lib cannot read encrypted object streams, so an encrypted source must be
 * decrypted first. Owner-only protection (empty user password) is opened the
 * same way openFile opens it; a source that needs a real password is refused
 * with EncryptedSourceError rather than silently producing garbage pages.
 */
import { decryptPdf, hasEncryptDict } from './pdfEncryption';
import { EncryptedSourceError } from './pageStructure';

export async function preparePageSource(bytes: Uint8Array): Promise<Uint8Array> {
  if (bytes.length === 0) throw new Error('The selected file is empty');
  if (!hasEncryptDict(bytes)) return bytes;
  try {
    const { plaintextBytes } = await decryptPdf(bytes, '');
    return new Uint8Array(plaintextBytes);
  } catch (e) {
    if ((e as { code?: string })?.code === 'DECRYPT_FAILED') throw new EncryptedSourceError();
    throw e;
  }
}
