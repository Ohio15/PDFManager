import createQpdfModule from '@neslinesli93/qpdf-wasm';
import qpdfWasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';
import type { PDFEncryptionMeta, PDFEncryptionPermissions } from '../types';

const IN_PATH = '/in.pdf';
const OUT_PATH = '/out.pdf';

let qpdfInstancePromise: Promise<any> | null = null;

// qpdf-wasm's Emscripten build caches `console.log.bind(console)` at module-
// init time and uses that cached reference for all stdout. The user-supplied
// `print` option is ignored. The only reliable capture is to install a
// console.log shim *before* createQpdfModule runs, so the bind() snapshot
// captures *our* shim — and the shim delegates to a mutable sink we can swap
// at runtime. Safe under withQpdfLock serialization.
let printSink: (text: string) => void = () => {};

function getQpdf(): Promise<any> {
  if (!qpdfInstancePromise) {
    const origConsoleLog = console.log;
    console.log = (...args: unknown[]) => {
      printSink(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '));
    };
    qpdfInstancePromise = createQpdfModule({
      locateFile: () => qpdfWasmUrl,
      noInitialRun: true,
      print: () => {},
      printErr: () => {},
    } as any).finally(() => {
      // Restore console.log for the rest of the app — qpdf already captured
      // our shim via bind() and will keep calling it for its own stdout.
      console.log = origConsoleLog;
    });
  }
  return qpdfInstancePromise;
}

function captureStdout<T>(fn: () => T): { value: T; lines: string[] } {
  const lines: string[] = [];
  const prev = printSink;
  printSink = (text: string) => lines.push(text);
  try {
    return { value: fn(), lines };
  } finally {
    printSink = prev;
  }
}

// Serialize all qpdf operations. The Emscripten module has a single VFS and
// a single `print` handler, so concurrent operations would corrupt each other.
let qpdfQueue: Promise<unknown> = Promise.resolve();
function withQpdfLock<T>(fn: (qpdf: any) => Promise<T>): Promise<T> {
  const next = qpdfQueue.then(async () => {
    const qpdf = await getQpdf();
    clearVfs(qpdf);
    try {
      return await fn(qpdf);
    } finally {
      clearVfs(qpdf);
    }
  });
  // Don't propagate failures into the queue — keep the chain healthy.
  qpdfQueue = next.then(() => undefined, () => undefined);
  return next;
}

function clearVfs(qpdf: any) {
  for (const p of [IN_PATH, OUT_PATH]) {
    try {
      qpdf.FS.unlink(p);
    } catch {
      /* not present */
    }
  }
}

export function hasEncryptDict(bytes: Uint8Array): boolean {
  // Scan for "/Encrypt" followed by an indirect reference (pdf trailer or
  // catalog dict) to avoid false-positives from content streams that contain
  // the literal string. Pattern: `/Encrypt N M R` where N,M are integers.
  const head = new TextDecoder('latin1').decode(bytes.subarray(0, Math.min(bytes.length, 8192)));
  const ENCRYPT_REF = /\/Encrypt\s+\d+\s+\d+\s+R/;
  if (ENCRYPT_REF.test(head)) return true;
  if (bytes.length > 8192) {
    const tail = new TextDecoder('latin1').decode(bytes.subarray(bytes.length - 8192));
    if (ENCRYPT_REF.test(tail)) return true;
  }
  return false;
}

/** Decrypt encrypted PDF bytes using the supplied user password. Returns plaintext bytes + meta. */
export async function decryptPdf(
  pdfBytes: Uint8Array,
  password: string
): Promise<{ plaintextBytes: Uint8Array; meta: PDFEncryptionMeta }> {
  return withQpdfLock(async (qpdf) => {
    qpdf.FS.writeFile(IN_PATH, pdfBytes);

    const { value: showRc, lines: encInfoLines } = captureStdout(() =>
      qpdf.callMain(['--show-encryption', `--password=${password}`, IN_PATH]) as number
    );

    if (showRc !== 0) {
      const err: any = new Error('DECRYPT_FAILED');
      err.code = 'DECRYPT_FAILED';
      throw err;
    }

    const meta = parseEncryptionInfo(encInfoLines.join('\n'));

    const decryptRc = qpdf.callMain(['--decrypt', `--password=${password}`, IN_PATH, OUT_PATH]);
    if (decryptRc !== 0) {
      const err: any = new Error('DECRYPT_FAILED');
      err.code = 'DECRYPT_FAILED';
      throw err;
    }

    const plaintextBytes = new Uint8Array(qpdf.FS.readFile(OUT_PATH));
    return { plaintextBytes, meta };
  });
}

/** Encrypt plaintext PDF bytes with AES-256 (R=6) using the supplied passwords + permissions. */
export async function encryptPdf(
  pdfBytes: Uint8Array,
  userPassword: string,
  options: {
    ownerPassword?: string;
    permissions: PDFEncryptionPermissions;
  }
): Promise<Uint8Array> {
  // An empty userPassword is valid: owner-only / permissions-only encryption.
  // qpdf accepts `--encrypt '' OWNER 256`; a distinct owner password gates
  // permission changes while anyone can open the document.
  return withQpdfLock(async (qpdf) => {
    qpdf.FS.writeFile(IN_PATH, pdfBytes);

    const ownerPw = options.ownerPassword && options.ownerPassword.length > 0
      ? options.ownerPassword
      : userPassword;

    const args: string[] = ['--encrypt', userPassword, ownerPw, '256'];
    const { print, modify, copy, annotate } = options.permissions;
    if (!print) args.push('--print=none');
    if (!modify) args.push('--modify=none');
    if (!copy) args.push('--extract=n');
    if (!annotate) args.push('--annotate=n');
    args.push('--', IN_PATH, OUT_PATH);

    const rc = qpdf.callMain(args);
    if (rc !== 0) {
      throw new Error('ENCRYPT_FAILED');
    }
    return new Uint8Array(qpdf.FS.readFile(OUT_PATH));
  });
}

/**
 * If `source` was opened from an encrypted PDF (has password+meta), re-encrypt
 * the supplied plaintext bytes with the same password and permissions.
 * Otherwise return the bytes unchanged. Use this before writing a derived
 * PDF (split, extract, flatten) to disk so derived files inherit protection.
 */
export async function reEncryptIfProtected(
  plaintextBytes: Uint8Array,
  source: { password?: string; encryptionMeta?: PDFEncryptionMeta }
): Promise<Uint8Array> {
  // Gate on encryptionMeta presence, not password truthiness — owner-only
  // encryption uses an empty user password but still requires re-encryption.
  if (!source.encryptionMeta) return plaintextBytes;
  return encryptPdf(plaintextBytes, source.password ?? '', {
    permissions: source.encryptionMeta.permissions,
  });
}

function parseEncryptionInfo(raw: string): PDFEncryptionMeta {
  const rMatch = raw.match(/R\s*=\s*(\d+)/);
  const lengthMatch = raw.match(/key length\s*=\s*(\d+)/i) || raw.match(/Length:\s*(\d+)/);
  // Per PDF spec, every encrypted PDF has both user and owner passwords —
  // when only a user pw is set, qpdf auto-derives the owner from a random
  // key. The semantically interesting flag is "owner pw differs from user".
  const distinctOwner = /owner password is different/i.test(raw);

  // qpdf 12.x emits granular permission lines like "print high resolution:
  // not allowed" — never a bare "print: not allowed". Match each granular
  // bit; map to our 4 high-level booleans. Older qpdf wording is kept as a
  // fallback so we degrade gracefully.
  const notAllowed = (label: string) =>
    new RegExp(`${label.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\$&')}\\s*:\\s*not allowed`, 'i').test(raw);

  const printHighBlocked = notAllowed('print high resolution');
  const printLowBlocked = notAllowed('print low resolution');
  const printBareBlocked = notAllowed('print'); // pre-12 fallback

  const modifyOtherBlocked = notAllowed('modify other');
  const modifyBareBlocked = notAllowed('modify'); // pre-12 fallback (only matches bare "modify:")

  const extractAnyBlocked = notAllowed('extract for any purpose');
  const extractAccessBlocked = notAllowed('extract for accessibility');
  const extractBareBlocked = notAllowed('extract'); // pre-12 fallback

  const annotationsBlocked = notAllowed('modify annotations');
  const annotateBareBlocked = notAllowed('annotate'); // pre-12 fallback

  return {
    R: rMatch ? parseInt(rMatch[1], 10) : 6,
    keyLength: lengthMatch ? parseInt(lengthMatch[1], 10) : 256,
    permissions: {
      // Print is allowed if any quality level is allowed.
      print: !printBareBlocked && !(printHighBlocked && printLowBlocked),
      // Modify maps to PDF bit 4 (modify contents) ≈ qpdf "modify other".
      modify: !modifyBareBlocked && !modifyOtherBlocked,
      // Copy maps to PDF bit 5 (extract for any purpose).
      copy: !extractBareBlocked && !extractAnyBlocked && !extractAccessBlocked,
      // Annotate maps to PDF bit 6 (modify annotations).
      annotate: !annotateBareBlocked && !annotationsBlocked,
    },
    hasOwnerPassword: distinctOwner,
  };
}
