import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, 'encrypted-sample.pdf');
const PASSWORD = 'testpass123';

const require = createRequire(import.meta.url);
const wasmPath = require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm');
const createModule = (await import('@neslinesli93/qpdf-wasm')).default;

const qpdf = await createModule({
  locateFile: () => wasmPath,
  noInitialRun: true,
  print: () => {},
  printErr: () => {},
});

const encryptedBytes = new Uint8Array(readFileSync(fixture));
console.log(`fixture bytes: ${encryptedBytes.length}`);

// ─── DECRYPT ───
qpdf.FS.writeFile('/in_enc.pdf', encryptedBytes);
const decryptRC = qpdf.callMain(['--decrypt', `--password=${PASSWORD}`, '/in_enc.pdf', '/out_plain.pdf']);
if (decryptRC !== 0) {
  console.error(`FAIL: qpdf decrypt returned ${decryptRC}`);
  process.exit(1);
}
const plaintextBytes = qpdf.FS.readFile('/out_plain.pdf');
console.log(`decrypt OK: ${plaintextBytes.length} bytes plaintext`);

// Sanity: plaintext must NOT contain the /Encrypt marker that defines an encryption dict
const plainStr = new TextDecoder('latin1').decode(plaintextBytes);
if (/\/Encrypt\b/.test(plainStr)) {
  console.error('FAIL: plaintext output still has /Encrypt entry');
  process.exit(1);
}
console.log('decrypt OK: no /Encrypt marker in output');

// Sanity: pdf.js can open plaintext without password
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
const doc = await pdfjs.getDocument({ data: plaintextBytes.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
const tc = await (await doc.getPage(1)).getTextContent();
console.log(`decrypt OK: pdf.js loaded plaintext, ${doc.numPages} pages, ${tc.items.length} text items`);

// ─── RE-ENCRYPT WITH NEW PASSWORD ───
const NEW_PASSWORD = 'newpass456';
qpdf.FS.writeFile('/in_plain.pdf', plaintextBytes);
const encryptRC = qpdf.callMain([
  '--encrypt', NEW_PASSWORD, NEW_PASSWORD, '256', '--',
  '/in_plain.pdf', '/out_enc.pdf'
]);
if (encryptRC !== 0) {
  console.error(`FAIL: qpdf encrypt returned ${encryptRC}`);
  process.exit(1);
}
const reencryptedBytes = qpdf.FS.readFile('/out_enc.pdf');
console.log(`encrypt OK: ${reencryptedBytes.length} bytes ciphertext`);

// Sanity: ciphertext MUST contain /Encrypt
const cipherStr = new TextDecoder('latin1').decode(reencryptedBytes);
if (!/\/Encrypt\b/.test(cipherStr)) {
  console.error('FAIL: ciphertext output missing /Encrypt entry');
  process.exit(1);
}
console.log('encrypt OK: /Encrypt marker present');

// Sanity: pdf.js rejects without password
try {
  await pdfjs.getDocument({ data: reencryptedBytes.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
  console.error('FAIL: re-encrypted PDF opened without password');
  process.exit(1);
} catch (e) {
  if (e?.name !== 'PasswordException') {
    console.error('FAIL: expected PasswordException, got', e?.name);
    process.exit(1);
  }
  console.log('encrypt OK: pdf.js rejects without password');
}

// Sanity: pdf.js accepts NEW password, rejects OLD
const reopened = await pdfjs.getDocument({ data: reencryptedBytes.slice(), password: NEW_PASSWORD, isEvalSupported: false, useSystemFonts: false }).promise;
console.log(`encrypt OK: pdf.js opened with new password, ${reopened.numPages} pages`);

try {
  await pdfjs.getDocument({ data: reencryptedBytes.slice(), password: PASSWORD, isEvalSupported: false, useSystemFonts: false }).promise;
  console.error('FAIL: re-encrypted PDF accepted OLD password');
  process.exit(1);
} catch (e) {
  if (e?.name !== 'PasswordException') throw e;
  console.log('encrypt OK: pdf.js rejects OLD password');
}

writeFileSync(resolve(here, 'roundtrip-output.pdf'), reencryptedBytes);
console.log('\nALL ROUND-TRIP VERIFICATIONS PASSED');
