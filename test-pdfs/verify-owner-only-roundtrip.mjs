// Verifies the v2.12.4 fix end-to-end:
//   1. Build owner-only-encrypted PDF (empty user pw, owner pw, print=none)
//   2. Simulate openFile path: hasEncryptDict + decryptPdf('') succeeds silently
//   3. Simulate save path: re-encrypt with empty user pw, owner pw, perms preserved
//   4. Confirm roundtripped output still has /Encrypt dict, still rejects print
//      via owner-pw gate, still opens silently in pdf.js

import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';
import { createRequire } from 'node:module';

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);
const wasmPath = require.resolve('@neslinesli93/qpdf-wasm/dist/qpdf.wasm');
const createModule = (await import('@neslinesli93/qpdf-wasm')).default;

// qpdf-wasm's Emscripten build does `var oa = console.log.bind(console)` at
// init — bind() snapshots whatever console.log is at that moment. Install our
// shim BEFORE createModule so the snapshot points at us; shim delegates to a
// mutable sink we can swap at runtime.
let printSink = () => {};
const origConsoleLog = console.log;
console.log = (...args) => {
  printSink(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
};
const qpdf = await createModule({
  locateFile: () => wasmPath,
  noInitialRun: true,
  print: () => {},
  printErr: () => {},
});
console.log = origConsoleLog;

function captureStdout(fn) {
  const lines = [];
  const prev = printSink;
  printSink = (t) => lines.push(t);
  try {
    return { value: fn(), lines };
  } finally {
    printSink = prev;
  }
}

function clearVfs() {
  for (const p of ['/in.pdf', '/out.pdf']) {
    try { qpdf.FS.unlink(p); } catch { /* not present */ }
  }
}

function fail(msg) { console.error(`FAIL: ${msg}`); process.exit(1); }

// ─── 1. Build owner-only-encrypted fixture ───
const plaintext = new Uint8Array(readFileSync(resolve(here, 'invoice.pdf')));
clearVfs();
qpdf.FS.writeFile('/in.pdf', plaintext);
let rc = qpdf.callMain([
  '--encrypt', '', 'ownersecret', '256', '--print=none', '--modify=none', '--',
  '/in.pdf', '/out.pdf',
]);
if (rc !== 0) fail(`build encrypt rc=${rc}`);
const ownerOnly = new Uint8Array(qpdf.FS.readFile('/out.pdf'));
console.log(`built owner-only PDF: ${ownerOnly.length} bytes`);

// ─── 2. Simulate openFile: try empty password, must succeed ───
const ENCRYPT_REF = /\/Encrypt\s+\d+\s+\d+\s+R/;
const headStr = new TextDecoder('latin1').decode(ownerOnly.subarray(0, Math.min(ownerOnly.length, 8192)));
const tailStr = new TextDecoder('latin1').decode(ownerOnly.subarray(Math.max(0, ownerOnly.length - 8192)));
if (!(ENCRYPT_REF.test(headStr) || ENCRYPT_REF.test(tailStr))) fail('hasEncryptDict should detect /Encrypt');
console.log('hasEncryptDict() detected /Encrypt dict ✓');

clearVfs();
qpdf.FS.writeFile('/in.pdf', ownerOnly);
const cap1 = captureStdout(() => qpdf.callMain(['--show-encryption', '--password=', '/in.pdf']));
rc = cap1.value;
if (rc !== 0) fail(`--show-encryption empty pw rc=${rc}`);
const showRaw = cap1.lines.join('\n');
console.log('captured show-encryption output (first 200 chars):', showRaw.slice(0, 200).replace(/\n/g, ' | '));
const notAllowed = (label) => {
  const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`${escaped}\\s*:\\s*not allowed`, 'i').test(showRaw);
};
const meta = {
  R: parseInt(showRaw.match(/R\s*=\s*(\d+)/)?.[1] ?? '6', 10),
  keyLength: 256,
  permissions: {
    print: !notAllowed('print') && !(notAllowed('print high resolution') && notAllowed('print low resolution')),
    modify: !notAllowed('modify') && !notAllowed('modify other'),
    copy: !notAllowed('extract') && !notAllowed('extract for any purpose') && !notAllowed('extract for accessibility'),
    annotate: !notAllowed('annotate') && !notAllowed('modify annotations'),
  },
};
if (meta.permissions.print !== false) fail(`expected print=false, got ${meta.permissions.print}`);
console.log(`captured meta on open: print=${meta.permissions.print} modify=${meta.permissions.modify} copy=${meta.permissions.copy} annotate=${meta.permissions.annotate} ✓`);

rc = qpdf.callMain(['--decrypt', '--password=', '/in.pdf', '/out.pdf']);
if (rc !== 0) fail(`decrypt with empty password rc=${rc}`);
const decryptedPlaintext = new Uint8Array(qpdf.FS.readFile('/out.pdf'));
console.log(`decrypt with empty user password ✓ (${decryptedPlaintext.length} plaintext bytes)`);

// ─── 3. Simulate save: re-encrypt with empty user pw + same perms ───
// Mimics applyOutputEncryption retain-branch with doc.password = '' and the
// captured meta. encryptPdf must accept the empty user password (qpdf does).
clearVfs();
qpdf.FS.writeFile('/in.pdf', decryptedPlaintext);
const encArgs = ['--encrypt', '' /* user pw */, 'ownersecret' /* owner pw, fallback when distinct unknown */, '256'];
if (!meta.permissions.print) encArgs.push('--print=none');
if (!meta.permissions.modify) encArgs.push('--modify=none');
if (!meta.permissions.copy) encArgs.push('--extract=n');
if (!meta.permissions.annotate) encArgs.push('--annotate=n');
encArgs.push('--', '/in.pdf', '/out.pdf');
rc = qpdf.callMain(encArgs);
if (rc !== 0) fail(`re-encrypt rc=${rc}`);
const roundtripped = new Uint8Array(qpdf.FS.readFile('/out.pdf'));
console.log(`re-encrypt with empty user pw ✓ (${roundtripped.length} bytes)`);

writeFileSync(resolve(here, 'owner-only-roundtrip.pdf'), roundtripped);

// ─── 4. Verify roundtripped output ───
//   (a) Still has /Encrypt dict
const rtHead = new TextDecoder('latin1').decode(roundtripped.subarray(0, Math.min(roundtripped.length, 8192)));
const rtTail = new TextDecoder('latin1').decode(roundtripped.subarray(Math.max(0, roundtripped.length - 8192)));
if (!(ENCRYPT_REF.test(rtHead) || ENCRYPT_REF.test(rtTail))) fail('roundtripped output missing /Encrypt — encryption was stripped on save!');
console.log('roundtripped output retains /Encrypt dict ✓');

//   (b) Empty user pw still opens it (silent open path)
clearVfs();
qpdf.FS.writeFile('/in.pdf', roundtripped);
const cap2 = captureStdout(() => qpdf.callMain(['--show-encryption', '--password=', '/in.pdf']));
rc = cap2.value;
if (rc !== 0) fail(`roundtripped --show-encryption empty pw rc=${rc}`);
const rtShow = cap2.lines.join('\n');
if (!/print high resolution\s*:\s*not allowed/i.test(rtShow)
    && !/print low resolution\s*:\s*not allowed/i.test(rtShow)
    && !/print\s*:\s*not allowed/i.test(rtShow)) {
  fail(`roundtripped output lost print=none restriction:\n${rtShow}`);
}
console.log('roundtripped output: empty user pw opens ✓, print restriction retained ✓');

//   (c) pdf.js opens roundtripped output silently with no password
const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
try {
  const doc = await pdfjs.getDocument({
    data: roundtripped.slice(),
    isEvalSupported: false,
    useSystemFonts: false,
  }).promise;
  const tc = await (await doc.getPage(1)).getTextContent();
  console.log(`pdf.js opens roundtripped silently ✓ (${doc.numPages} pages, ${tc.items.length} text items)`);
} catch (e) {
  fail(`pdf.js failed on roundtripped output: ${e?.name} ${e?.message}`);
}

console.log('\nALL OWNER-ONLY ROUND-TRIP CHECKS PASSED');
