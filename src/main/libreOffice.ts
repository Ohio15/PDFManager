import * as fs from 'fs';
import * as path from 'path';
import { isPathWithinBlessed, resolveRealPath } from './security';

/**
 * Locating the LibreOffice binary that convert-to-pdf runs with execFile.
 *
 * The binary path is code execution, so nothing that chooses it may come from
 * the process environment (a launcher controls that: ProgramFiles, LOCALAPPDATA,
 * HOME, or PATH for a shelled-out lookup). Install roots are fixed system
 * locations plus the user's Roaming AppData folder from Electron's known-folder
 * API, and every candidate, including a path remembered in the settings store,
 * must canonicalize (links and junctions followed) to a soffice binary inside
 * one of those roots.
 */

export interface InstallRootSources {
  platform: NodeJS.Platform;
  /** Electron app.getPath('appData'): the Roaming known folder on Windows. */
  appData: string;
}

/** Directories a trusted LibreOffice install may live under. */
export function libreOfficeInstallRoots(src: InstallRootSources): string[] {
  if (src.platform === 'win32') {
    const roots = ['C:\\Program Files', 'C:\\Program Files (x86)'];
    const appData = path.win32.resolve(src.appData);
    const profileDrive = path.win32.parse(appData).root;
    roots.push(path.win32.join(profileDrive, 'Program Files'), path.win32.join(profileDrive, 'Program Files (x86)'));
    // Per-user installs: %LOCALAPPDATA%\Programs, derived from the Roaming known
    // folder (its sibling), and Roaming itself, both without reading the env.
    roots.push(path.win32.join(path.win32.dirname(appData), 'Local', 'Programs'), appData);
    return [...new Set(roots)];
  }
  if (src.platform === 'darwin') return ['/Applications'];
  return ['/usr/bin', '/usr/lib', '/usr/lib64', '/usr/local', '/opt', '/snap'];
}

const SOFFICE_NAMES: Record<string, readonly string[]> = {
  win32: ['soffice.exe'],
  darwin: ['soffice'],
  other: ['soffice', 'soffice.bin', 'libreoffice'],
};

function sofficeNames(platform: NodeJS.Platform): readonly string[] {
  return SOFFICE_NAMES[platform] ?? SOFFICE_NAMES.other;
}

/**
 * True when `candidate` canonicalizes to an existing regular file named like
 * the LibreOffice launcher inside one of `roots` (also canonicalized).
 */
export function isTrustedSofficePath(candidate: unknown, roots: readonly string[], platform: NodeJS.Platform): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0 || !path.isAbsolute(candidate)) return false;
  const real = resolveRealPath(candidate);
  if (real === null) return false;
  const name = path.basename(real);
  const names = sofficeNames(platform);
  if (!names.some((n) => (platform === 'win32' ? n.toLowerCase() === name.toLowerCase() : n === name))) return false;
  try {
    if (!fs.statSync(real).isFile()) return false;
  } catch {
    return false;
  }
  const canonicalRoots = roots.map((r) => resolveRealPath(r)).filter((r): r is string => r !== null);
  return isPathWithinBlessed(real, canonicalRoots);
}

const WINDOWS_FOLDERS = ['LibreOffice', 'LibreOffice 7', 'LibreOffice 24', 'LibreOffice 25'];

/** Candidate launcher paths under the install roots, most specific first. */
export function sofficeCandidates(platform: NodeJS.Platform, roots: readonly string[]): string[] {
  const out: string[] = [];
  if (platform === 'win32') {
    for (const root of roots) {
      for (const folder of WINDOWS_FOLDERS) {
        const base = path.win32.join(root, folder);
        out.push(path.win32.join(base, 'program', 'soffice.exe'));
        let items: string[] = [];
        try {
          items = fs.readdirSync(base);
        } catch {
          continue;
        }
        for (const item of items) {
          if (item !== 'program') out.push(path.win32.join(base, item, 'program', 'soffice.exe'));
        }
      }
    }
    return out;
  }
  if (platform === 'darwin') return ['/Applications/LibreOffice.app/Contents/MacOS/soffice'];
  return [
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/lib/libreoffice/program/soffice',
    '/usr/local/bin/soffice',
    '/usr/local/bin/libreoffice',
    '/opt/libreoffice/program/soffice',
    '/snap/bin/libreoffice',
  ];
}

/** First trusted LibreOffice launcher found under the install roots, or null. */
export function detectLibreOffice(platform: NodeJS.Platform, roots: readonly string[]): string | null {
  for (const candidate of sofficeCandidates(platform, roots)) {
    if (isTrustedSofficePath(candidate, roots, platform)) return candidate;
  }
  return null;
}

/**
 * The launcher convert-to-pdf may run: the remembered path if it is still
 * trusted, else a fresh detection. Returns what should be remembered (null
 * clears a stale or untrusted entry).
 */
export function resolveTrustedLibreOffice(
  stored: unknown,
  platform: NodeJS.Platform,
  roots: readonly string[]
): string | null {
  if (isTrustedSofficePath(stored, roots, platform)) return stored as string;
  return detectLibreOffice(platform, roots);
}
