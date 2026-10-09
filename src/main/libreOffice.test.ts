/**
 * The LibreOffice launcher is code execution (convert-to-pdf execFiles it), so
 * neither the environment nor a remembered settings value may steer it to a
 * binary outside the fixed install roots.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectLibreOffice,
  isTrustedSofficePath,
  libreOfficeInstallRoots,
  resolveTrustedLibreOffice,
} from './libreOffice';

const isWin = process.platform === 'win32';
const launcherName = isWin ? 'soffice.exe' : 'soffice';

function tempDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
}

/** An attacker-planted "LibreOffice" install: <dir>/LibreOffice/program/soffice(.exe). */
function plant(dir: string): string {
  const program = path.join(dir, 'LibreOffice', 'program');
  fs.mkdirSync(program, { recursive: true });
  const exe = path.join(program, launcherName);
  fs.writeFileSync(exe, 'planted');
  return exe;
}

describe('install roots come from Electron and fixed paths, never the environment', () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'USERPROFILE']) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  it('ignores ProgramFiles / LOCALAPPDATA / APPDATA / HOME pointing at a planted install', () => {
    const evil = tempDir('pdfm-evil-env-');
    const planted = plant(evil);
    const appData = 'C:\\Users\\someone\\AppData\\Roaming';
    const before = libreOfficeInstallRoots({ platform: 'win32', appData });
    for (const k of ['ProgramFiles', 'ProgramFiles(x86)', 'LOCALAPPDATA', 'APPDATA', 'HOME', 'USERPROFILE']) process.env[k] = evil;
    const after = libreOfficeInstallRoots({ platform: 'win32', appData });
    expect(after).toEqual(before);
    expect(after).toEqual([
      'C:\\Program Files',
      'C:\\Program Files (x86)',
      'C:\\Users\\someone\\AppData\\Local\\Programs',
      'C:\\Users\\someone\\AppData\\Roaming',
    ]);
    const roots = libreOfficeInstallRoots({ platform: process.platform, appData: tempDir('pdfm-appdata-') });
    expect(detectLibreOffice(process.platform, roots)).not.toBe(planted);
    expect(isTrustedSofficePath(planted, roots, process.platform)).toBe(false);
  });

  it('macOS and Linux roots are fixed system locations', () => {
    expect(libreOfficeInstallRoots({ platform: 'darwin', appData: '/Users/x/Library/Application Support' })).toEqual(['/Applications']);
    expect(libreOfficeInstallRoots({ platform: 'linux', appData: '/home/x/.config' })).not.toContain('/home/x');
  });
});

describe('isTrustedSofficePath', () => {
  it('accepts a launcher inside a root and refuses one outside every root', () => {
    const root = tempDir('pdfm-root-');
    const inside = plant(root);
    const outside = plant(tempDir('pdfm-outside-'));
    expect(isTrustedSofficePath(inside, [root], process.platform)).toBe(true);
    expect(isTrustedSofficePath(outside, [root], process.platform)).toBe(false);
  });

  it('refuses a link inside a root that resolves outside it', () => {
    const root = tempDir('pdfm-root-');
    const outsideInstall = tempDir('pdfm-outside-');
    plant(outsideInstall);
    const link = path.join(root, 'Linked');
    fs.symlinkSync(outsideInstall, link, isWin ? 'junction' : 'dir');
    expect(isTrustedSofficePath(path.join(link, 'LibreOffice', 'program', launcherName), [root], process.platform)).toBe(false);
  });

  it('refuses a binary with another name, a directory, and non-absolute or non-string input', () => {
    const root = tempDir('pdfm-root-');
    const other = path.join(root, isWin ? 'calc.exe' : 'sh');
    fs.writeFileSync(other, 'x');
    fs.mkdirSync(path.join(root, launcherName));
    expect(isTrustedSofficePath(other, [root], process.platform)).toBe(false);
    expect(isTrustedSofficePath(path.join(root, launcherName), [root], process.platform)).toBe(false);
    expect(isTrustedSofficePath(launcherName, [root], process.platform)).toBe(false);
    expect(isTrustedSofficePath(42, [root], process.platform)).toBe(false);
  });

  it('a remembered (store) path outside the roots is replaced, not run', () => {
    const root = tempDir('pdfm-root-');
    const good = plant(root);
    const poisoned = plant(tempDir('pdfm-poison-'));
    const resolved = resolveTrustedLibreOffice(poisoned, process.platform, [root]);
    expect(resolved).not.toBe(poisoned);
    if (isWin) expect(resolved).toBe(good);
  });
});

// The real install on this workstation is found and trusted.
const REAL = isWin ? 'C:\\Program Files\\LibreOffice\\program\\soffice.exe' : '/usr/bin/soffice';
describe.skipIf(!fs.existsSync(REAL))('real LibreOffice install', () => {
  it('is detected under the default roots', () => {
    const roots = libreOfficeInstallRoots({ platform: process.platform, appData: path.join(os.homedir(), 'AppData', 'Roaming') });
    expect(isTrustedSofficePath(REAL, roots, process.platform)).toBe(true);
    expect(detectLibreOffice(process.platform, roots)).not.toBeNull();
  });
});

describe('main.ts runs only a trusted launcher', () => {
  const main = fs.readFileSync(path.join(__dirname, 'main.ts'), 'utf8');
  const fnStart = main.indexOf('function trustedLibreOffice(');
  const fnBody = main.slice(fnStart, main.indexOf('\n}', fnStart));

  it('reads the remembered libreOfficePath only inside trustedLibreOffice, through resolveTrustedLibreOffice', () => {
    expect(fnStart).toBeGreaterThan(-1);
    const reads = [...main.matchAll(/store\.get\(\s*['"]libreOfficePath['"]\s*\)/g)].map((m) => m.index!);
    expect(reads).toHaveLength(1);
    expect(reads[0]).toBeGreaterThan(fnStart);
    expect(reads[0]).toBeLessThan(fnStart + fnBody.length);
    expect(fnBody).toMatch(/resolveTrustedLibreOffice\(/);
  });

  it('hands convert-to-pdf and the renderer only the trusted launcher', () => {
    expect(main).toMatch(/converterPath:\s*trustedLibreOffice\s*,/);
    expect(main).toMatch(/ipcMain\.handle\(\s*'detect-libreoffice',\s*\(\)\s*=>\s*trustedLibreOffice\(\)\s*\)/);
    expect(main).not.toMatch(/\bexecSync\b/);
  });
});
