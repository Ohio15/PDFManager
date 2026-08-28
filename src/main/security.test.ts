import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import {
  isAllowedStoreWrite,
  isAllowedStoreRead,
  isSafeConvertInput,
  isSafeOutputDir,
  isAllowedExternalUrl,
  isAllowedSaveTarget,
  isWithinAnyDir,
  resolveRealPath,
  isPathWithinBlessed,
} from './security';
import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';

const isWin = process.platform === 'win32';
// A Windows-style absolute path is only recognized as absolute by the win32
// path parser, so assertions about drive-letter paths must run on win32 only —
// the Node `path` module is `path.posix` on Linux CI (round-3 T-1/T-2).

describe('isAllowedStoreWrite', () => {
  it('accepts whitelisted keys with correct types', () => {
    expect(isAllowedStoreWrite('sidebarVisible', true)).toBe(true);
    expect(isAllowedStoreWrite('theme', 'dark')).toBe(true);
    expect(isAllowedStoreWrite('defaultZoom', 100)).toBe(true);
    expect(isAllowedStoreWrite('hasSeenOnboarding', false)).toBe(true);
  });
  it('rejects the RCE vector key libreOfficePath', () => {
    expect(isAllowedStoreWrite('libreOfficePath', 'C:/Windows/System32/cmd.exe')).toBe(false);
  });
  it('rejects other main-owned keys', () => {
    expect(isAllowedStoreWrite('recentFiles', ['x'])).toBe(false);
    expect(isAllowedStoreWrite('lastSaveDirectory', 'C:/')).toBe(false);
    expect(isAllowedStoreWrite('windowBounds', { width: 1 })).toBe(false);
  });
  it('rejects unknown keys and prototype keys', () => {
    expect(isAllowedStoreWrite('__proto__', {})).toBe(false);
    expect(isAllowedStoreWrite('constructor', {})).toBe(false);
    expect(isAllowedStoreWrite('anythingElse', 1)).toBe(false);
  });
  it('rejects wrong value types for whitelisted keys', () => {
    expect(isAllowedStoreWrite('sidebarVisible', 'true')).toBe(false);
    expect(isAllowedStoreWrite('theme', 'neon')).toBe(false);
    expect(isAllowedStoreWrite('defaultZoom', 99999)).toBe(false);
    expect(isAllowedStoreWrite('defaultZoom', NaN)).toBe(false);
    expect(isAllowedStoreWrite('defaultZoom', '100')).toBe(false);
  });
  it('rejects a non-string key', () => {
    expect(isAllowedStoreWrite(42 as unknown, true)).toBe(false);
  });
});

describe('isSafeConvertInput', () => {
  it('accepts an absolute path to a convertible document', () => {
    expect(isSafeConvertInput('/home/me/report.odt')).toBe(true);
    if (isWin) expect(isSafeConvertInput('C:\\Users\\me\\a.docx')).toBe(true);
  });
  it('rejects option-injection and relative paths', () => {
    expect(isSafeConvertInput('--convert-to=pdf:writer_web_pdf_Export')).toBe(false);
    expect(isSafeConvertInput('-x.docx')).toBe(false);
    expect(isSafeConvertInput('relative/a.docx')).toBe(false);
  });
  it('rejects UNC and device paths (SMB / device I/O)', () => {
    // The `//` forward-slash form is caught by isUncOrDevicePath on any platform;
    // the backslash forms are additionally exercised on win32.
    expect(isSafeConvertInput('//attacker/share/x.docx')).toBe(false);
    if (isWin) {
      expect(isSafeConvertInput('\\\\attacker\\share\\x.docx')).toBe(false);
      expect(isSafeConvertInput('\\\\?\\C:\\x.docx')).toBe(false);
      expect(isSafeConvertInput('\\\\.\\C:\\x.docx')).toBe(false);
    }
  });
  it('rejects NTFS alternate-data-stream syntax in the basename (round-3 L-2)', () => {
    expect(isSafeConvertInput('/home/me/id_rsa:x.docx')).toBe(false);
    expect(isSafeConvertInput('/home/me/payload.exe:z.docx')).toBe(false);
    if (isWin) expect(isSafeConvertInput('C:\\B\\id_rsa:x.docx')).toBe(false);
  });
  it('rejects non-convertible or missing extensions', () => {
    expect(isSafeConvertInput('/home/me/evil.exe')).toBe(false);
    expect(isSafeConvertInput('/home/me/noext')).toBe(false);
    expect(isSafeConvertInput('')).toBe(false);
    expect(isSafeConvertInput(123 as unknown)).toBe(false);
  });
});

describe('isAllowedStoreRead (round-3 M-2)', () => {
  it('allows the renderer UI-preference keys', () => {
    expect(isAllowedStoreRead('sidebarVisible')).toBe(true);
    expect(isAllowedStoreRead('theme')).toBe(true);
    expect(isAllowedStoreRead('defaultZoom')).toBe(true);
  });
  it('refuses main-owned keys that would enumerate blessed dirs / installed paths', () => {
    expect(isAllowedStoreRead('recentFiles')).toBe(false);
    expect(isAllowedStoreRead('lastOpenDirectory')).toBe(false);
    expect(isAllowedStoreRead('lastSaveDirectory')).toBe(false);
    expect(isAllowedStoreRead('libreOfficePath')).toBe(false);
    expect(isAllowedStoreRead('windowBounds')).toBe(false);
  });
  it('refuses prototype and non-string keys', () => {
    expect(isAllowedStoreRead('__proto__')).toBe(false);
    expect(isAllowedStoreRead('constructor')).toBe(false);
    expect(isAllowedStoreRead(42 as unknown)).toBe(false);
  });
});

describe('isAllowedSaveTarget (round-3 M-3)', () => {
  it('confines each handler to its own extensions', () => {
    expect(isAllowedSaveTarget('/b/out.pdf', 'pdf')).toBe(true);
    expect(isAllowedSaveTarget('/b/out.svg', 'pdf')).toBe(false);
    expect(isAllowedSaveTarget('/b/page.svg', 'pdfOrSvg')).toBe(true);
    expect(isAllowedSaveTarget('/b/page.pdf', 'pdfOrSvg')).toBe(true);
    expect(isAllowedSaveTarget('/b/doc.docx', 'docx')).toBe(true);
    expect(isAllowedSaveTarget('/b/img.png', 'image')).toBe(true);
    expect(isAllowedSaveTarget('/b/img.jpeg', 'image')).toBe(true);
  });
  it('rejects executable/link extensions inside a blessed dir', () => {
    expect(isAllowedSaveTarget('/b/evil.exe', 'pdf')).toBe(false);
    expect(isAllowedSaveTarget('/b/evil.dll', 'pdfOrSvg')).toBe(false);
    expect(isAllowedSaveTarget('/b/evil.lnk', 'image')).toBe(false);
    expect(isAllowedSaveTarget('/b/evil.bat', 'docx')).toBe(false);
  });
  it('rejects ADS syntax and non-strings', () => {
    expect(isAllowedSaveTarget('/b/out.pdf:evil.exe', 'pdf')).toBe(false);
    expect(isAllowedSaveTarget('', 'pdf')).toBe(false);
    expect(isAllowedSaveTarget(null as unknown, 'pdf')).toBe(false);
  });
});

describe('isSafeOutputDir', () => {
  it('accepts absolute dirs, rejects relative/empty/non-string/UNC', () => {
    expect(isSafeOutputDir('/tmp/out')).toBe(true);
    expect(isSafeOutputDir('out')).toBe(false);
    expect(isSafeOutputDir('')).toBe(false);
    expect(isSafeOutputDir(null as unknown)).toBe(false);
    expect(isSafeOutputDir('//attacker/share')).toBe(false);
    if (isWin) {
      expect(isSafeOutputDir('C:\\out')).toBe(true);
      expect(isSafeOutputDir('\\\\attacker\\share')).toBe(false);
      expect(isSafeOutputDir('\\\\?\\C:\\out')).toBe(false);
    }
  });
});

describe('isAllowedExternalUrl', () => {
  it('accepts http/https/mailto', () => {
    expect(isAllowedExternalUrl('https://www.libreoffice.org/download/')).toBe(true);
    expect(isAllowedExternalUrl('http://example.com')).toBe(true);
    expect(isAllowedExternalUrl('mailto:a@b.com')).toBe(true);
  });
  it('rejects file, javascript, and custom schemes', () => {
    expect(isAllowedExternalUrl('file:///C:/Windows/System32/cmd.exe')).toBe(false);
    expect(isAllowedExternalUrl('javascript:alert(1)')).toBe(false);
    expect(isAllowedExternalUrl('vscode://x')).toBe(false);
    expect(isAllowedExternalUrl('not a url')).toBe(false);
    expect(isAllowedExternalUrl(42 as unknown)).toBe(false);
  });
});

describe('isWithinAnyDir', () => {
  const A = path.resolve('/blessed/out');
  const B = path.resolve('/home/user/docs');
  const dirs = [A, B];
  it('accepts the dir itself and its subtree', () => {
    expect(isWithinAnyDir(A, dirs)).toBe(true);
    expect(isWithinAnyDir(path.join(A, 'file.pdf'), dirs)).toBe(true);
    expect(isWithinAnyDir(path.join(A, 'sub', 'deep', 'x.docx'), dirs)).toBe(true);
    expect(isWithinAnyDir(path.join(B, 'a.png'), dirs)).toBe(true);
  });
  it('rejects paths outside every blessed dir', () => {
    expect(isWithinAnyDir(path.resolve('/etc/passwd'), dirs)).toBe(false);
    expect(isWithinAnyDir(path.resolve('/blessed/other/x'), dirs)).toBe(false);
  });
  it('rejects .. escapes and sibling-prefix confusion', () => {
    expect(isWithinAnyDir(path.join(A, '..', 'evil.exe'), dirs)).toBe(false);
    // /blessed/out-side must NOT match /blessed/out
    expect(isWithinAnyDir(path.resolve('/blessed/out-side/x'), dirs)).toBe(false);
  });
  it('rejects relative, empty, and non-string targets', () => {
    expect(isWithinAnyDir('relative/x', dirs)).toBe(false);
    expect(isWithinAnyDir('', dirs)).toBe(false);
    expect(isWithinAnyDir(null as unknown, dirs)).toBe(false);
  });
  it('is case-insensitive on win32/darwin', () => {
    if (process.platform === 'win32' || process.platform === 'darwin') {
      expect(isWithinAnyDir(path.join(A.toUpperCase(), 'x.pdf'), dirs)).toBe(true);
    }
  });
});

describe('resolveRealPath / isPathWithinBlessed (round-3 H-1/M-1 — fail closed)', () => {
  let root: string;
  let blessed: string;
  let blessedReal: string;
  let outside: string;
  let linkInside: string; // reparse point inside `blessed` → `outside`
  let linkSupported = false;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfm-sec-'));
    blessed = path.join(root, 'blessed');
    outside = path.join(root, 'outside');
    fs.mkdirSync(blessed);
    fs.mkdirSync(outside);
    blessedReal = fs.realpathSync.native(blessed);
    linkInside = path.join(blessed, 'link');
    try {
      // Dir junction (win32) / symlink (posix): neither needs elevation.
      fs.symlinkSync(fs.realpathSync.native(outside), linkInside, isWin ? 'junction' : 'dir');
      linkSupported = true;
    } catch {
      linkSupported = false;
    }
  });
  afterAll(() => {
    try { fs.rmSync(root, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('canonicalizes a not-yet-created target inside a blessed dir (allowed)', () => {
    const target = path.join(blessed, 'a', 'b', 'new.pdf');
    expect(isPathWithinBlessed(target, [blessedReal])).toBe(true);
  });

  it('does NOT fail open on a very deep (>64-component) non-existent tail', () => {
    // The old 64-iteration cap fell through to the lexical path here.
    const deep = path.join(blessed, ...Array.from({ length: 80 }, (_, i) => `d${i}`), 'x.pdf');
    expect(isPathWithinBlessed(deep, [blessedReal])).toBe(true); // still inside, canonicalized
  });

  it('denies escape through a junction/symlink in the tail (H-1)', () => {
    if (!linkSupported) return; // environment without reparse-point support
    // Real target of `blessed/link` is `outside` — must be denied even though it
    // is lexically under `blessed`.
    expect(isPathWithinBlessed(path.join(linkInside, 'x.pdf'), [blessedReal])).toBe(false);
    // And denies it no matter how deep the non-existent tail is (no cap fallthrough).
    const deepEscape = path.join(linkInside, ...Array.from({ length: 80 }, (_, i) => `z${i}`), 'x.pdf');
    expect(isPathWithinBlessed(deepEscape, [blessedReal])).toBe(false);
  });

  it('fails closed on an empty blessed set', () => {
    expect(isPathWithinBlessed(path.join(blessed, 'x.pdf'), [])).toBe(false);
    expect(resolveRealPath(path.join(blessed, 'x.pdf'))).not.toBeNull(); // resolvable, just not blessed
  });

  it('returns null (deny) for non-string / empty input', () => {
    expect(resolveRealPath('')).toBeNull();
    expect(resolveRealPath(null as unknown)).toBeNull();
    expect(isPathWithinBlessed(undefined as unknown, [blessedReal])).toBe(false);
  });
});
