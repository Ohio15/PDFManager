import { describe, it, expect } from 'vitest';
import {
  isAllowedStoreWrite,
  isSafeConvertInput,
  isSafeOutputDir,
  isAllowedExternalUrl,
} from './security';

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
    expect(isSafeConvertInput('C:\\Users\\me\\a.docx')).toBe(true);
    expect(isSafeConvertInput('/home/me/report.odt')).toBe(true);
  });
  it('rejects option-injection and relative paths', () => {
    expect(isSafeConvertInput('--convert-to=pdf:writer_web_pdf_Export')).toBe(false);
    expect(isSafeConvertInput('-x.docx')).toBe(false);
    expect(isSafeConvertInput('relative/a.docx')).toBe(false);
  });
  it('rejects non-convertible or missing extensions', () => {
    expect(isSafeConvertInput('C:\\evil.exe')).toBe(false);
    expect(isSafeConvertInput('C:\\noext')).toBe(false);
    expect(isSafeConvertInput('')).toBe(false);
    expect(isSafeConvertInput(123 as unknown)).toBe(false);
  });
});

describe('isSafeOutputDir', () => {
  it('accepts absolute dirs, rejects relative/empty/non-string', () => {
    expect(isSafeOutputDir('C:\\out')).toBe(true);
    expect(isSafeOutputDir('/tmp/out')).toBe(true);
    expect(isSafeOutputDir('out')).toBe(false);
    expect(isSafeOutputDir('')).toBe(false);
    expect(isSafeOutputDir(null as unknown)).toBe(false);
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
