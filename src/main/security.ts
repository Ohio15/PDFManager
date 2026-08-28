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
