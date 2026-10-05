import { test, expect } from '../fixtures/electron-app';
import { openPDFViaIPC } from '../fixtures/helpers';
import type { Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

/**
 * Trusted drag-and-drop, driven through Chromium's real input pipeline.
 *
 * CDP `Input.dispatchDragEvent` with `data.files` makes the BROWSER process
 * deliver dragenter/dragover/drop with native, file-backed File objects — the
 * same renderer-side path an OS drag takes after Chromium has translated it.
 * So these events are `isTrusted`, `webUtils.getPathForFile()` returns the real
 * path, and the private preload->main bless channel is exercised for real.
 *
 * What this does NOT prove: the OS drag source (Explorer's OLE drag) -> Chromium
 * translation. That part is Chromium's own code and is covered only by a
 * manual drag from Explorer.
 *
 * Fixtures are copied into a fresh temp directory that no dialog has blessed,
 * so any access the app gets comes from the drop blessing alone.
 */

const TEST_PDFS_DIR = path.resolve(__dirname, '../../test-pdfs');

function stageFixtures(names: string[]): { dir: string; paths: Record<string, string> } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfm-drop-e2e-'));
  const paths: Record<string, string> = {};
  for (const name of names) {
    const target = path.join(dir, name);
    const source = path.join(TEST_PDFS_DIR, name);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, target);
    } else {
      fs.writeFileSync(target, `not a supported document: ${name}\n`);
    }
    paths[name] = fs.realpathSync.native(target);
  }
  return { dir, paths };
}

/** Drop real files at the centre of `selector` via the browser input pipeline. */
async function trustedDrop(page: Page, selector: string, files: string[]): Promise<void> {
  const box = await page.locator(selector).first().boundingBox();
  if (!box) throw new Error(`drop target ${selector} not visible`);
  const x = Math.round(box.x + box.width / 2);
  const y = Math.round(box.y + box.height / 2);
  const cdp = await page.context().newCDPSession(page);
  const data = { items: [], files, dragOperationsMask: 1 };
  try {
    await cdp.send('Input.dispatchDragEvent', { type: 'dragEnter', x, y, data });
    await cdp.send('Input.dispatchDragEvent', { type: 'dragOver', x, y, data });
    await cdp.send('Input.dispatchDragEvent', { type: 'drop', x, y, data });
  } finally {
    await cdp.detach();
  }
}

test.describe('Trusted drag-and-drop', () => {
  let staged: { dir: string; paths: Record<string, string> } | null = null;

  test.afterEach(() => {
    if (staged) {
      try { fs.rmSync(staged.dir, { recursive: true, force: true }); } catch { /* best effort */ }
      staged = null;
    }
  });

  test('drop onto an open document opens a second tab that saves in place', async ({ electronApp, appPage }) => {
    staged = stageFixtures(['announcement.pdf', 'invoice.pdf']);
    const dropped = staged.paths['announcement.pdf'];
    const sibling = staged.paths['invoice.pdf'];

    await openPDFViaIPC(electronApp, appPage, 'scan-document.pdf');
    await expect(appPage.locator('.tab-bar-tab')).toHaveCount(1);

    await trustedDrop(appPage, '.main-content', [dropped]);

    await expect(appPage.locator('.tab-bar-tab')).toHaveCount(2, { timeout: 20_000 });
    await expect(appPage.locator('.tab-bar-tab.active .tab-name')).toHaveText('announcement.pdf');

    // In-place save through the real UI path (Ctrl+S -> handleSave -> save-file):
    // it must succeed without the Save As fallback.
    const before = fs.statSync(dropped).mtimeMs;
    await appPage.waitForTimeout(50);
    await appPage.keyboard.press('Control+s');
    await expect(appPage.locator('.toast-success .toast-message', { hasText: 'Document saved successfully' }))
      .toBeVisible({ timeout: 20_000 });
    const after = fs.statSync(dropped);
    expect(after.mtimeMs).toBeGreaterThan(before);
    expect(fs.readFileSync(dropped).subarray(0, 5).toString('latin1')).toBe('%PDF-');

    // The blessing is the exact file, not its folder: a sibling stays out of reach.
    const access = await appPage.evaluate(async ({ siblingPath }) => {
      const read = await window.electronAPI.readFileByPath(siblingPath);
      const write = await window.electronAPI.saveFile('JVBERi0xLjQK', siblingPath);
      return { readNull: read === null, write };
    }, { siblingPath: sibling });
    expect(access.readNull).toBe(true);
    expect(access.write).toEqual({ success: false, error: 'Path not permitted' });
    expect(fs.readFileSync(sibling).equals(fs.readFileSync(path.join(TEST_PDFS_DIR, 'invoice.pdf')))).toBe(true);
  });

  test('multi-file drop opens each PDF in its own tab and reports skipped files', async ({ appPage }) => {
    staged = stageFixtures(['announcement.pdf', 'invoice.pdf', 'notes.xyz']);

    await trustedDrop(appPage, '.main-content', [
      staged.paths['announcement.pdf'],
      staged.paths['invoice.pdf'],
      staged.paths['notes.xyz'],
    ]);

    await expect(appPage.locator('.tab-bar-tab')).toHaveCount(2, { timeout: 30_000 });
    await expect(appPage.locator('.tab-bar-tab .tab-name')).toHaveText(['announcement.pdf', 'invoice.pdf']);
    await expect(appPage.locator('.toast-warning .toast-message', { hasText: '1 dropped file was skipped' }))
      .toBeVisible({ timeout: 10_000 });
  });

  test('a dropped Word document is staged for conversion', async ({ appPage }) => {
    staged = stageFixtures(['invoice-test.docx']);

    await trustedDrop(appPage, '.main-content', [staged.paths['invoice-test.docx']]);

    await expect(appPage.getByText('invoice-test.docx').first()).toBeVisible({ timeout: 10_000 });
    await expect(appPage.locator('.tab-bar-tab')).toHaveCount(0);
  });

  test('a forged synthetic drop is ignored and blesses nothing', async ({ appPage }) => {
    staged = stageFixtures(['announcement.pdf']);
    const target = staged.paths['announcement.pdf'];

    const outcome = await appPage.evaluate(async ({ forgedPath }) => {
      // The main world has no way to name a path to the bless channel.
      const apiKeys = Object.keys(window.electronAPI);

      // A page-built File carrying the real path as its name, in a synthetic
      // (untrusted) event sequence.
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array([37, 80, 68, 70, 45])], forgedPath, { type: 'application/pdf' }));
      const target = document.querySelector('.main-content')!;
      for (const type of ['dragenter', 'dragover', 'drop']) {
        target.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: dt }));
      }

      // Claiming directly yields nothing either.
      const claim = await window.electronAPI.takeDroppedFiles();
      const read = await window.electronAPI.readFileByPath(forgedPath);
      const write = await window.electronAPI.saveFile('JVBERi0xLjQK', forgedPath);
      return { apiKeys, claim, readNull: read === null, write };
    }, { forgedPath: target });

    expect(outcome.apiKeys.filter((k) => /bless|trusted|drop/i.test(k))).toEqual(['takeDroppedFiles']);
    expect(outcome.claim).toEqual({ files: [], rejected: 0 });
    expect(outcome.readNull).toBe(true);
    expect(outcome.write).toEqual({ success: false, error: 'Path not permitted' });
    // The app saw the drop, found no trusted file, and opened nothing.
    await expect(appPage.locator('.toast-error .toast-message', { hasText: 'That file cannot be opened' }))
      .toBeVisible({ timeout: 10_000 });
    await expect(appPage.locator('.tab-bar-tab')).toHaveCount(0);
  });

  test('drop onto the Merge PDFs dialog adds the files to the merge list', async ({ appPage }) => {
    staged = stageFixtures(['announcement.pdf', 'invoice.pdf']);

    await appPage.keyboard.press('Control+m');
    await expect(appPage.locator('[data-testid="merge-drop-zone"]')).toBeVisible({ timeout: 10_000 });

    await trustedDrop(appPage, '[data-testid="merge-drop-zone"]', [
      staged.paths['announcement.pdf'],
      staged.paths['invoice.pdf'],
    ]);

    await expect(appPage.locator('.merge-dialog .file-list-item .file-name')).toHaveText(
      ['announcement.pdf', 'invoice.pdf'],
      { timeout: 15_000 }
    );
    // The dialog's zone consumed the drop: nothing opened behind the modal.
    await expect(appPage.locator('.tab-bar-tab')).toHaveCount(0);
  });

  test('a PDF dropped onto a thumbnail inserts its pages there instead of opening a tab', async ({ electronApp, appPage }) => {
    staged = stageFixtures(['announcement.pdf']);
    const { PDFDocument } = await import('pdf-lib');
    const insertedCount = (await PDFDocument.load(fs.readFileSync(staged.paths['announcement.pdf']), { ignoreEncryption: true })).getPageCount();

    await openPDFViaIPC(electronApp, appPage, 'scan-document.pdf');
    const thumbs = appPage.locator('.page-thumbnail');
    await expect(thumbs.first()).toBeVisible({ timeout: 10_000 });
    const before = await thumbs.count();

    await trustedDrop(appPage, '.page-thumbnail', [staged.paths['announcement.pdf']]);

    await expect(thumbs).toHaveCount(before + insertedCount, { timeout: 20_000 });
    await expect(appPage.locator('.toast-success .toast-message', { hasText: `Inserted ${insertedCount} page` }))
      .toBeVisible({ timeout: 10_000 });
    // Inserted into the open document: no new tab, and the overlay reset.
    await expect(appPage.locator('.tab-bar-tab')).toHaveCount(1);
    await expect(appPage.locator('[data-testid="drop-overlay"]')).toHaveCount(0);
    await expect(appPage.locator('.tab-bar-tab .tab-modified-dot')).toHaveCount(1);
  });

  test('in-app thumbnail reorder still works and is not taken for a file drop', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'scan-document.pdf');
    const thumbs = appPage.locator('.page-thumbnail');
    const count = await thumbs.count();
    test.skip(count < 2, 'fixture has a single page');

    await thumbs.nth(0).dragTo(thumbs.nth(1));

    await expect(appPage.locator('.tab-bar-tab .tab-modified-dot')).toHaveCount(1, { timeout: 10_000 });
    await expect(appPage.locator('[data-testid="drop-overlay"]')).toHaveCount(0);
    await expect(appPage.locator('.tab-bar-tab')).toHaveCount(1);
  });
});
