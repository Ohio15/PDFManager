import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { isOutputBesideBlessedInput, isTrustedDropSender } from './security';
import { TRUSTED_DROP_CHANNEL } from '../shared/ipc';

describe('isTrustedDropSender', () => {
  const mainContents = { id: 'main' };
  const mainFrame = { id: 'top' };
  const base = { windowAlive: true, sender: mainContents, senderFrame: mainFrame, mainContents, mainFrame };

  it('accepts only the main window top frame', () => {
    expect(isTrustedDropSender(base)).toBe(true);
  });
  it('refuses another webContents (e.g. the print window)', () => {
    expect(isTrustedDropSender({ ...base, sender: { id: 'print' } })).toBe(false);
  });
  it('refuses a subframe of the main window', () => {
    expect(isTrustedDropSender({ ...base, senderFrame: { id: 'iframe' } })).toBe(false);
  });
  it('refuses when the main window is gone', () => {
    expect(isTrustedDropSender({ ...base, windowAlive: false })).toBe(false);
    expect(isTrustedDropSender({ ...base, mainContents: null, sender: null })).toBe(false);
    expect(isTrustedDropSender({ ...base, mainFrame: null, senderFrame: null })).toBe(false);
  });
});

describe('isOutputBesideBlessedInput', () => {
  const dir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'pdfm-beside-')));
  const input = path.join(dir, 'report.docx');
  const blessedInput = (p: string) => p === input;
  const noDirs = () => false;

  it('allows exactly the directory containing a blessed dropped input', () => {
    expect(isOutputBesideBlessedInput(dir, input, { isDirBlessed: noDirs, isInputFileBlessed: blessedInput })).toBe(true);
  });
  it('refuses the parent of that directory', () => {
    expect(isOutputBesideBlessedInput(path.dirname(dir), input, { isDirBlessed: noDirs, isInputFileBlessed: blessedInput })).toBe(false);
  });
  it('refuses a subdirectory or a sibling directory', () => {
    expect(isOutputBesideBlessedInput(path.join(dir, 'sub'), input, { isDirBlessed: noDirs, isInputFileBlessed: blessedInput })).toBe(false);
    expect(isOutputBesideBlessedInput(`${dir}-other`, input, { isDirBlessed: noDirs, isInputFileBlessed: blessedInput })).toBe(false);
  });
  it('refuses when the input is not an exactly-blessed file', () => {
    expect(isOutputBesideBlessedInput(dir, input, { isDirBlessed: noDirs, isInputFileBlessed: () => false })).toBe(false);
  });
  it('defers a blessed output directory to the normal dir guard', () => {
    expect(isOutputBesideBlessedInput(dir, input, { isDirBlessed: () => true, isInputFileBlessed: blessedInput })).toBe(false);
  });
  it('refuses non-string arguments', () => {
    expect(isOutputBesideBlessedInput(undefined, input, { isDirBlessed: noDirs, isInputFileBlessed: blessedInput })).toBe(false);
    expect(isOutputBesideBlessedInput(dir, 42, { isDirBlessed: noDirs, isInputFileBlessed: blessedInput })).toBe(false);
  });
});

describe('trusted-drop channel literal', () => {
  it('preload sends on exactly the channel main listens on', () => {
    // A sandboxed preload cannot import shared/ipc at runtime, so it carries a
    // copy of the literal; drift would silently disable drag-and-drop.
    const preload = fs.readFileSync(path.join(__dirname, 'preload.ts'), 'utf8');
    const m = preload.match(/const TRUSTED_DROP_CHANNEL = '([^']+)'/);
    expect(m?.[1]).toBe(TRUSTED_DROP_CHANNEL);
  });
});
