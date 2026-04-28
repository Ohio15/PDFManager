import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const fixture = resolve(here, 'encrypted-sample.pdf');
const PASSWORD = 'testpass123';

// Use pdfjs-dist legacy build for Node (no DOM canvas required)
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');

const bytes = new Uint8Array(readFileSync(fixture));
console.log(`fixture: ${fixture} (${bytes.length} bytes)`);

// Case 1: no password → must throw PasswordException
try {
  await pdfjs.getDocument({ data: bytes.slice(), isEvalSupported: false, useSystemFonts: false }).promise;
  console.error('FAIL: opened encrypted PDF without password');
  process.exit(1);
} catch (e) {
  if (e?.name !== 'PasswordException') {
    console.error('FAIL: expected PasswordException, got', e?.name, e?.message);
    process.exit(1);
  }
  console.log('OK case 1: rejected without password (PasswordException)');
}

// Case 2: wrong password → PasswordException with INCORRECT_PASSWORD code
try {
  await pdfjs.getDocument({ data: bytes.slice(), password: 'wrong', isEvalSupported: false, useSystemFonts: false }).promise;
  console.error('FAIL: opened encrypted PDF with wrong password');
  process.exit(1);
} catch (e) {
  if (e?.name !== 'PasswordException') {
    console.error('FAIL: expected PasswordException for wrong password, got', e?.name, e?.message);
    process.exit(1);
  }
  console.log('OK case 2: rejected wrong password');
}

// Case 3: correct password → loads, can enumerate pages
const doc = await pdfjs.getDocument({ data: bytes.slice(), password: PASSWORD, isEvalSupported: false, useSystemFonts: false }).promise;
console.log(`OK case 3: opened with correct password, ${doc.numPages} pages`);

const page1 = await doc.getPage(1);
const tc = await page1.getTextContent();
console.log(`OK case 3: page 1 text items = ${tc.items.length}`);

if (tc.items.length === 0) {
  console.error('FAIL: page 1 had zero text items — content stream not decrypting');
  process.exit(1);
}

console.log('\nALL VERIFICATIONS PASSED');
