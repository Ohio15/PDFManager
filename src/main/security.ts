/**
 * Main-process input validation for IPC handlers.
 *
 * The renderer is a security boundary: a compromised renderer (e.g. via a
 * malicious PDF hitting a Chromium/pdf.js bug) can call any ipcMain handler with
 * arbitrary arguments. These pure validators gate the handlers that would
 * otherwise hand the renderer code-execution or store-poisoning primitives.
 * They import only `path` so they can be unit-tested without electron.
 */
import * as path from 'path';

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
