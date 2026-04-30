// Reproduce the user's bug: a PDF that has *no* user password but is encrypted
// for owner-permissions only. Standard PDF viewers open these silently
// (empty user password works). PDFManager v2.12.0+ throws PASSWORD_REQUIRED
// on the *initial* open before ever attempting an empty password, so the user
// is prompted for a password the document does not actually require.

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const plaintextFixture = resolve(here, 'invoice.pdf');

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm');
const createModule = (await import('@neslinesli93/qpdf-wasm')).default;

const qpdf = await createModule({
  locateFile: () => wasmPath,
  noInitialRun: true,
  print: () => {},
  printErr: () => {},
});

// Build owner-only encrypted PDF: user password '' (empty), owner password
// 'ownersecret', restrict printing — i.e. anyone can OPEN, but only the owner
// can change permissions / print.
const plaintext = new Uint8Array(readFileSync(plaintextFixture));
qpdf.FS.writeFile('/in.pdf', plaintext);
const rc = qpdf.callMain([
  '--encrypt', '', 'ownersecret', '256', '--print=none', '--',
  '/in.pdf', '/out.pdf',
]);
if (rc !== 0) {
  console.error(`FAIL: qpdf encrypt rc=${rc}`);
  process.exit(1);
}
const ownerOnlyBytes = qpdf.FS.readFile('/out.pdf');
console.log(`built owner-only PDF: ${ownerOnlyBytes.length} bytes`);

const outPath = resolve(here, 'owner-only-encrypted.pdf');
writeFileSync(outPath, ownerOnlyBytes);
console.log(`wrote: ${outPath}`);

// 1) Confirm hasEncryptDict() returns true on this file (the prompt trigger).
const head = new TextDecoder('latin1').decode(ownerOnlyBytes.subarray(0, Math.min(ownerOnlyBytes.length, 8192)));
const tail = new TextDecoder('latin1').decode(ownerOnlyBytes.subarray(Math.max(0, ownerOnlyBytes.length - 8192)));
const ENCRYPT_REF = /\/Encrypt\s+\d+\s+\d+\s+R/;
const dictDetected = ENCRYPT_REF.test(head) || ENCRYPT_REF.test(tail);
console.log(`hasEncryptDict() detects /Encrypt ref: ${dictDetected}`);

// 2) Confirm qpdf decrypts it with empty password (zero user-prompt path).
qpdf.FS.unlink('/in.pdf');
qpdf.FS.unlink('/out.pdf');
qpdf.FS.writeFile('/in.pdf', ownerOnlyBytes);
const showRc = qpdf.callMain(['--show-encryption', '--password=', '/in.pdf']);
console.log(`qpdf --show-encryption --password='' rc=${showRc}`);
const decRc = qpdf.callMain(['--decrypt', '--password=', '/in.pdf', '/out.pdf']);
console.log(`qpdf --decrypt --password='' rc=${decRc}`);

// 3) Confirm pdf.js opens it without a password (this is what every other PDF
//    viewer does — empty user pw is auto-tried; no prompt fires).
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
try {
  const doc = await pdfjs.getDocument({
    data: ownerOnlyBytes.slice(),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  console.log(`pdf.js opens with NO password: ${doc.numPages} pages`);
} catch (e) {
  console.log(`pdf.js threw: ${e?.name} ${e?.message}`);
}

console.log('\nDIAGNOSIS:');
console.log('  /Encrypt-dict detected =>', dictDetected, '(triggers PASSWORD_REQUIRED in openFile)');
console.log('  qpdf decrypts with empty password =>', decRc === 0);
console.log('  pdf.js opens silently with no password => see above');
console.log('  ==> hasEncryptDict() is necessary but NOT sufficient to demand a password.');
