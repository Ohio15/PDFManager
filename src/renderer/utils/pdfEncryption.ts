import createQpdfModule from '@neslinesli93/qpdf-wasm';
import qpdfWasmUrl from '@neslinesli93/qpdf-wasm/dist/qpdf.wasm?url';
import type { PDFEncryptionMeta, PDFEncryptionPermissions } from '../types';

const IN_PATH = '/in.pdf';
const OUT_PATH = '/out.pdf';

let qpdfInstancePromise: Promise<any> | null = null;

function getQpdf(): Promise<any> {
  if (!qpdfInstancePromise) {
    qpdfInstancePromise = createQpdfModule({
      locateFile: () => qpdfWasmUrl,
      noInitialRun: true,
      print: () => {},
      printErr: () => {},
    } as any);
  }
  return qpdfInstancePromise;
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
    const encInfoLines: string[] = [];
    const origPrint = qpdf.print;
    qpdf.print = (text: string) => encInfoLines.push(text);

    qpdf.FS.writeFile(IN_PATH, pdfBytes);

    let showRc: number;
    try {
      showRc = qpdf.callMain(['--show-encryption', `--password=${password}`, IN_PATH]);
    } finally {
      qpdf.print = origPrint;
    }

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
  if (!userPassword) {
    throw new Error('encryptPdf: userPassword is required');
  }
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
  if (!source.password) return plaintextBytes;
  const perms = source.encryptionMeta?.permissions ?? {
    print: true, modify: true, copy: true, annotate: true,
  };
  return encryptPdf(plaintextBytes, source.password, { permissions: perms });
}

function parseEncryptionInfo(raw: string): PDFEncryptionMeta {
  const rMatch = raw.match(/R\s*=\s*(\d+)/);
  const lengthMatch = raw.match(/key length\s*=\s*(\d+)/i) || raw.match(/Length:\s*(\d+)/);
  // Per PDF spec, every encrypted PDF has both user and owner passwords —
  // when only a user pw is set, qpdf auto-derives the owner from a random
  // key. The semantically interesting flag is "owner pw differs from user".
  const distinctOwner = /owner password is different/i.test(raw);

  return {
    R: rMatch ? parseInt(rMatch[1], 10) : 6,
    keyLength: lengthMatch ? parseInt(lengthMatch[1], 10) : 256,
    permissions: {
      print: !/print:\s*not allowed/i.test(raw),
      modify: !/modify:\s*not allowed/i.test(raw),
      copy: !/extract for accessibility:\s*not allowed/i.test(raw)
        && !/extract:\s*not allowed/i.test(raw),
      annotate: !/modify annotations:\s*not allowed/i.test(raw)
        && !/annotate:\s*not allowed/i.test(raw),
    },
    hasOwnerPassword: distinctOwner,
  };
}
