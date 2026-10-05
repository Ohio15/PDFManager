/**
 * Main-process input validation for IPC handlers.
 *
 * The renderer is a security boundary: a compromised renderer (e.g. via a
 * malicious PDF hitting a Chromium/pdf.js bug) can call any ipcMain handler with
 * arbitrary arguments. These pure validators gate the handlers that would
 * otherwise hand the renderer code-execution or store-poisoning primitives.
 * They import only `path`/`fs` (Node builtins, no electron) so they can be
 * unit-tested without an Electron runtime.
 */
import * as path from 'path';
import * as fs from 'fs';

export type StoreValidator = (value: unknown) => boolean;

const isBool: StoreValidator = (v) => typeof v === 'boolean';
const isTheme: StoreValidator = (v) => v === 'light' || v === 'dark' || v === 'system';
const isZoom: StoreValidator = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 25 && v <= 500;

/**
 * Keys the renderer is permitted to write through `set-store`, each with a type
 * guard. Everything else — libreOfficePath (feeds execFile), recentFiles,
 * lastOpen/SaveDirectory, windowBounds — is written only by the main process and
 * must NOT be settable from the renderer.
 */
export const RENDERER_WRITABLE_STORE_KEYS: Record<string, StoreValidator> = {
  sidebarVisible: isBool,
  toolsPanelVisible: isBool,
  openFolderAfterConversion: isBool,
  autoConvertOnDrop: isBool,
  hasSeenOnboarding: isBool,
  theme: isTheme,
  defaultZoom: isZoom,
};

/** True only for a whitelisted key whose value passes that key's type guard. */
export function isAllowedStoreWrite(key: unknown, value: unknown): key is string {
  if (typeof key !== 'string') return false;
  const validator = Object.prototype.hasOwnProperty.call(RENDERER_WRITABLE_STORE_KEYS, key)
    ? RENDERER_WRITABLE_STORE_KEYS[key]
    : undefined;
  return validator ? validator(value) : false;
}

/**
 * Keys the renderer may READ through `get-store`. The renderer only needs its
 * own UI preferences (the same set it may write). Main-owned keys —
 * libreOfficePath, recentFiles (served by its own get-recent-files IPC),
 * lastOpen/SaveDirectory, windowBounds — must NOT be readable, as together they
 * enumerate the blessed-directory set and installed-software paths (round-3
 * M-2 reconnaissance oracle).
 */
export function isAllowedStoreRead(key: unknown): key is string {
  return (
    typeof key === 'string' &&
    Object.prototype.hasOwnProperty.call(RENDERER_WRITABLE_STORE_KEYS, key)
  );
}

/**
 * Renderer-supplied output filenames are confined to a directory by guardPath,
 * but that is directory-granular only: within a blessed dir the renderer could
 * otherwise write any extension (.exe/.dll/.lnk plant → DLL side-loading). Each
 * path-based save handler additionally restricts the target extension to what
 * that handler is designed to emit (round-3 M-3). Dialog-based saves are NOT
 * gated here — the user chose the path and name explicitly.
 */
export const SAVE_TARGET_EXTENSIONS: Record<string, readonly string[]> = {
  pdf: ['pdf'],
  pdfOrSvg: ['pdf', 'svg'],
  docx: ['docx'],
  image: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'],
};

export function isAllowedSaveTarget(
  filePath: unknown,
  kind: keyof typeof SAVE_TARGET_EXTENSIONS
): filePath is string {
  if (typeof filePath !== 'string' || filePath.length === 0) return false;
  const base = path.basename(filePath);
  if (base.includes(':')) return false; // NTFS alternate-data-stream syntax
  const ext = path.extname(filePath).toLowerCase().replace(/^\./, '');
  return SAVE_TARGET_EXTENSIONS[kind].includes(ext);
}

/**
 * UNC (`\\host\share`) and Win32 device paths (`\\?\`, `\\.\`) — reject these
 * for conversion I/O: a UNC input/output makes LibreOffice reach out over SMB
 * (forced NTLM auth / data egress / SSRF), and device paths dodge containment.
 */
export function isUncOrDevicePath(p: string): boolean {
  return /^[\\/]{2}/.test(p);
}

/** Document extensions LibreOffice is invoked to convert to PDF. */
export const CONVERTIBLE_DOC_EXTENSIONS = [
  'doc', 'docx', 'odt', 'rtf', 'txt', 'ppt', 'pptx', 'odp',
  'xls', 'xlsx', 'ods', 'html', 'htm',
];

/**
 * Gate for `convert-to-pdf` input. Must be an absolute path to a file with a
 * known convertible extension. Absolute-only both prevents a leading-`-` value
 * from being parsed as a LibreOffice option (argument injection) and keeps the
 * conversion off relative/working-directory surprises.
 */
export function isSafeConvertInput(inputPath: unknown): inputPath is string {
  if (typeof inputPath !== 'string' || inputPath.length === 0) return false;
  if (!path.isAbsolute(inputPath)) return false;
  if (inputPath.startsWith('-')) return false; // defense in depth
  if (isUncOrDevicePath(inputPath)) return false; // no SMB/device I/O
  // Reject NTFS alternate-data-stream syntax (file.docx:stream) — the extension
  // check is a string op and would otherwise pass `id_rsa:x.docx` (round-3 L-2).
  if (path.basename(inputPath).includes(':')) return false;
  const ext = path.extname(inputPath).toLowerCase().replace(/^\./, '');
  return CONVERTIBLE_DOC_EXTENSIONS.includes(ext);
}

/** Output directory for conversions must be a local absolute path (no UNC/device). */
export function isSafeOutputDir(outputDir: unknown): outputDir is string {
  return (
    typeof outputDir === 'string' &&
    outputDir.length > 0 &&
    path.isAbsolute(outputDir) &&
    !isUncOrDevicePath(outputDir)
  );
}

/** Schemes `open-external` may hand to the OS. No file:, no custom protocols. */
export const ALLOWED_EXTERNAL_SCHEMES = ['http:', 'https:', 'mailto:'];

export function isAllowedExternalUrl(url: unknown): url is string {
  if (typeof url !== 'string') return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  return ALLOWED_EXTERNAL_SCHEMES.includes(parsed.protocol);
}

/** Case-fold a resolved path for comparison (Windows/macOS paths are case-insensitive). */
function foldCase(p: string): string {
  return process.platform === 'win32' || process.platform === 'darwin' ? p.toLowerCase() : p;
}

/**
 * True if `targetPath` is inside (or equal to) any directory in `dirs`.
 * Used to confine renderer-supplied write/read paths to directories the user
 * has chosen through a native dialog. Comparison is done on resolved,
 * case-folded paths and rejects `..` escapes.
 */
export function isWithinAnyDir(targetPath: unknown, dirs: Iterable<string>): boolean {
  if (typeof targetPath !== 'string' || targetPath.length === 0) return false;
  if (!path.isAbsolute(targetPath)) return false;
  const target = foldCase(path.resolve(targetPath));
  for (const dir of dirs) {
    if (!dir) continue;
    const base = foldCase(path.resolve(dir));
    if (target === base) return true;
    const rel = path.relative(base, target);
    if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return true;
  }
  return false;
}

/**
 * Canonicalize a path (resolving symlinks/junctions/8.3-short-names) so a
 * containment check can't be escaped by a link inside a blessed dir. realpath
 * only resolves existing paths, so for a not-yet-created target we realpath its
 * deepest EXISTING ancestor and re-append the missing tail.
 *
 * Returns null (FAIL CLOSED) when the path cannot be safely canonicalized:
 *  - any realpath error other than "missing" (EACCES/EPERM/ELOOP/ENAMETOOLONG),
 *    which would otherwise downgrade to a lexical, link-preserving path;
 *  - the filesystem root itself failing to resolve.
 *
 * The ancestor walk needs NO iteration cap — it strips exactly one component
 * per step and always terminates at the root. A cap that fell through to the
 * lexical path (the previous implementation's 64-iteration limit) failed OPEN:
 * a tail of >=64 non-existent components skipped canonicalization entirely,
 * letting a junction in the tail escape confinement (round-3 H-1). Callers MUST
 * treat null as "deny", never as "allow".
 */
export function resolveRealPath(p: unknown): string | null {
  if (typeof p !== 'string' || p.length === 0) return null;
  let resolved = path.resolve(p);
  // Reject UNC (\\host\share) and device paths BEFORE any syscall: realpath on a
  // UNC path makes the SMB redirector connect out and negotiate NTLM with the
  // logged-on user's credentials (hash exfil / relay) and, being synchronous,
  // can stall the whole main process on an unresponsive host. Confinement itself
  // would deny the path anyway, but the canonicalization side effect must never
  // fire (round-4 H4-1).
  if (isUncOrDevicePath(resolved)) return null;
  let tail = '';
  for (;;) {
    try {
      const real = fs.realpathSync.native(resolved);
      return tail ? path.join(real, tail) : real;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      // Only "does not exist" justifies walking up. Any other error (permission,
      // symlink loop, name-too-long) means we cannot trust the canonical form.
      if (code !== 'ENOENT' && code !== 'ENOTDIR') return null; // fail closed
      const parent = path.dirname(resolved);
      if (parent === resolved) return null; // reached root and even it failed
      tail = tail ? path.join(path.basename(resolved), tail) : path.basename(resolved);
      resolved = parent;
    }
  }
}

/**
 * True iff `targetPath` canonicalizes (fail-closed) to a location inside one of
 * `blessedDirs` (which are themselves stored canonicalized). This is the single
 * membership test behind guardPath — see main.ts.
 */
export function isPathWithinBlessed(targetPath: unknown, blessedDirs: Iterable<string>): boolean {
  const real = resolveRealPath(targetPath);
  if (real === null) return false; // unresolvable → deny
  return isWithinAnyDir(real, blessedDirs);
}

// --- Exact-file blessing (trusted drag-and-drop) -----------------------------
//
// A file the user drags from the OS onto the window is blessed as that EXACT
// file — never its directory. The blessing grants exactly what the user's
// gesture implies: open (read) the dropped document, save it back in place,
// and use it as a conversion input. It must not widen into its siblings.
//
// Entries are stored canonicalized (resolveRealPath) and case-folded on the
// same platforms foldCase() folds, so membership is a plain string-equality
// test on the canonical form of the requested path.

/** Extensions a dropped file may carry to be blessed: PDF plus convertible docs. */
export const DROP_ALLOWED_EXTENSIONS: readonly string[] = ['pdf', ...CONVERTIBLE_DOC_EXTENSIONS];

/** Upper bound on files blessed from a single drop (bounds main-process work). */
export const MAX_DROP_FILES = 64;

/** Longest path accepted from the drop channel (Windows long-path ceiling). */
const MAX_DROP_PATH_LENGTH = 32767;

/** Canonical membership key for the exact-file sets. */
export function blessedFileKey(canonicalPath: string): string {
  return foldCase(canonicalPath);
}

/**
 * True iff `targetPath` canonicalizes (fail-closed) to EXACTLY one of the
 * blessed file keys. A directory, a sibling, a child path, or a path that
 * cannot be canonicalized is never a match.
 */
export function isFileBlessed(targetPath: unknown, blessedFileKeys: ReadonlySet<string>): boolean {
  if (blessedFileKeys.size === 0) return false;
  const real = resolveRealPath(targetPath);
  if (real === null) return false; // unresolvable → deny
  return blessedFileKeys.has(blessedFileKey(real));
}

export interface ValidatedDropFile {
  /** Canonical (realpath) location of the dropped file. */
  path: string;
  /** Display name (basename of the canonical path). */
  name: string;
  /** Lower-case extension without the dot. */
  ext: string;
}

/** Lower-case extension of a path without the leading dot. */
function extOf(p: string): string {
  return path.extname(p).toLowerCase().replace(/^\./, '');
}

/**
 * Validate one path received on the private trusted-drop channel and return its
 * canonical form, or null (deny). The path came from webUtils.getPathForFile()
 * on a trusted drop in the preload, but the IPC message itself crosses the
 * renderer boundary, so it is re-validated here as untrusted input:
 *  - a non-empty absolute string within the path-length ceiling;
 *  - not UNC/device (checked before any syscall — see resolveRealPath);
 *  - no NTFS alternate-data-stream syntax in the name;
 *  - canonicalizes (fail-closed) AND exists — no "missing tail" acceptance,
 *    a drop is always an existing file;
 *  - the canonical target is a REGULAR FILE (never a directory, device, FIFO);
 *  - both the supplied and the canonical name carry an allowed extension, so a
 *    `report.pdf` symlink pointing at `payload.exe` is refused.
 */
export function validateDroppedFilePath(candidate: unknown): ValidatedDropFile | null {
  if (typeof candidate !== 'string') return null;
  if (candidate.length === 0 || candidate.length > MAX_DROP_PATH_LENGTH) return null;
  if (candidate.includes('\0')) return null;
  if (!path.isAbsolute(candidate)) return null;
  if (isUncOrDevicePath(candidate)) return null;
  if (path.basename(candidate).includes(':')) return null;
  if (!DROP_ALLOWED_EXTENSIONS.includes(extOf(candidate))) return null;

  let real: string;
  try {
    real = fs.realpathSync.native(path.resolve(candidate));
  } catch {
    return null; // missing, unreadable, loop — all deny
  }
  // realpath can surface a UNC target behind a local link (e.g. a symlink to
  // \\host\share\x.pdf); never bless a network location.
  if (isUncOrDevicePath(real)) return null;
  if (path.basename(real).includes(':')) return null;
  const ext = extOf(real);
  if (!DROP_ALLOWED_EXTENSIONS.includes(ext)) return null;

  let stat: fs.Stats;
  try {
    stat = fs.statSync(real);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;

  return { path: real, name: path.basename(real), ext };
}

/**
 * Validate a whole drop payload (the private channel's message body). Returns
 * the de-duplicated canonical files that passed, preserving drop order, plus
 * the count refused. A non-array payload refuses everything; entries beyond
 * MAX_DROP_FILES are refused rather than silently truncated.
 */
export function validateDropPayload(payload: unknown): { accepted: ValidatedDropFile[]; rejected: number } {
  if (!Array.isArray(payload)) return { accepted: [], rejected: 0 };
  const accepted: ValidatedDropFile[] = [];
  const seen = new Set<string>();
  let rejected = 0;
  payload.forEach((candidate, index) => {
    if (index >= MAX_DROP_FILES) {
      rejected++;
      return;
    }
    const file = validateDroppedFilePath(candidate);
    if (!file) {
      rejected++;
      return;
    }
    const key = blessedFileKey(file.path);
    if (seen.has(key)) return; // same file dropped twice — one record
    seen.add(key);
    accepted.push(file);
  });
  return { accepted, rejected };
}

/**
 * True iff `dirPath` canonicalizes to exactly the directory that CONTAINS the
 * canonical `filePath`. Used to let a conversion of an exactly-blessed input
 * write its main-derived `<name>.pdf` beside that input, without blessing the
 * directory itself. Fails closed if either side cannot be canonicalized.
 */
export function isContainingDirOf(dirPath: unknown, filePath: unknown): boolean {
  const realDir = resolveRealPath(dirPath);
  const realFile = resolveRealPath(filePath);
  if (realDir === null || realFile === null) return false;
  return blessedFileKey(path.dirname(realFile)) === blessedFileKey(realDir);
}

/** What an exact-file blessing permits. */
export type FileAccess = 'read' | 'write';

/**
 * Registry of exactly-blessed files (trusted drops). Every blessed file is
 * readable (open / convert input). Only PDFs are writable — in-place save
 * exists for PDFs alone, so a dropped .docx never becomes a renderer-writable
 * target through save-raw-bytes-to-path.
 */
export class BlessedFileRegistry {
  private readonly readable = new Set<string>();
  private readonly writable = new Set<string>();

  /** Bless a canonical path that has ALREADY passed validateDroppedFilePath. */
  add(file: ValidatedDropFile): void {
    const key = blessedFileKey(file.path);
    this.readable.add(key);
    if (file.ext === 'pdf') this.writable.add(key);
  }

  /**
   * Bless a main-derived output file (e.g. the PDF LibreOffice wrote beside a
   * blessed input). Re-validated like a drop so only an existing regular PDF
   * can enter the set.
   */
  addDerivedPdf(outputPath: string): boolean {
    const file = validateDroppedFilePath(outputPath);
    if (!file || file.ext !== 'pdf') return false;
    this.add(file);
    return true;
  }

  /** Validate + bless a drop payload; returns the accepted records and refused count. */
  blessDrop(payload: unknown): { accepted: ValidatedDropFile[]; rejected: number } {
    const result = validateDropPayload(payload);
    result.accepted.forEach((file) => this.add(file));
    return result;
  }

  has(targetPath: unknown, access: FileAccess): boolean {
    return isFileBlessed(targetPath, access === 'write' ? this.writable : this.readable);
  }

  get size(): number {
    return this.readable.size;
  }
}

/**
 * The trusted-drop channel accepts only the main window's top frame. Identity
 * comparisons only: any other webContents (e.g. the transient print window) or
 * a subframe is refused, as is a destroyed/missing main window.
 */
export function isTrustedDropSender(input: {
  windowAlive: boolean;
  sender: unknown;
  senderFrame: unknown;
  mainContents: unknown;
  mainFrame: unknown;
}): boolean {
  return (
    input.windowAlive &&
    input.mainContents != null &&
    input.sender === input.mainContents &&
    input.mainFrame != null &&
    input.senderFrame === input.mainFrame
  );
}

/**
 * convert-to-pdf may write next to an exactly-blessed (dropped) input without
 * the output directory itself being blessed, but ONLY into the directory that
 * directly contains that input. A blessed output directory takes the normal
 * dir-guard path instead, so this returns false for it.
 */
export function isOutputBesideBlessedInput(
  outputDir: unknown,
  inputPath: unknown,
  deps: { isDirBlessed: (p: string) => boolean; isInputFileBlessed: (p: string) => boolean }
): boolean {
  if (typeof outputDir !== 'string' || typeof inputPath !== 'string') return false;
  return (
    !deps.isDirBlessed(outputDir) &&
    deps.isInputFileBlessed(inputPath) &&
    isContainingDirOf(outputDir, inputPath)
  );
}
