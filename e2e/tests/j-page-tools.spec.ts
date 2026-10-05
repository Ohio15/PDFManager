import { test, expect } from '../fixtures/electron-app';
import { openPDFViaIPC, getPageCount } from '../fixtures/helpers';
import type { Page } from '@playwright/test';
import { PDFDocument as PDFLib, PDFName, PDFArray, PDFNumber } from 'pdf-lib';
import path from 'path';
import fs from 'fs';

const TEST_PDFS_DIR = path.resolve(__dirname, '../../test-pdfs');
const thumbs = (page: Page) => page.locator('.sidebar .page-thumbnail');

/** Intercept the save IPC and return the bytes the app would have written. */
async function saveAndCapture(page: Page): Promise<PDFLib> {
  await page.evaluate(() => {
    const api = (window as any).electronAPI;
    (window as any).__saved = null;
    const intercept = (data: string) => {
      (window as any).__saved = data;
      return Promise.resolve({ success: true, path: '/fake/saved.pdf' });
    };
    api.saveFile = intercept;
    api.saveFileDialog = intercept;
  });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => (window as any).__saved !== null, null, { timeout: 20_000 });
  const b64 = await page.evaluate(() => (window as any).__saved as string);
  return PDFLib.load(Buffer.from(b64, 'base64'));
}

/** Make the native PDF picker + raw read return a fixture (dialogs cannot be automated). */
async function mockPickPdf(page: Page, fixture: string): Promise<void> {
  const b64 = fs.readFileSync(path.join(TEST_PDFS_DIR, fixture)).toString('base64');
  await page.evaluate(({ name, data }) => {
    const api = (window as any).electronAPI;
    api.pickPdfFile = () => Promise.resolve(`C:/fixtures/${name}`);
    api.readFileRaw = () => {
      const bin = atob(data);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      return Promise.resolve(bytes.buffer);
    };
  }, { name: fixture, data: b64 });
}

async function contextMenu(page: Page, thumbIndex: number, item: RegExp): Promise<void> {
  await thumbs(page).nth(thumbIndex).click({ button: 'right' });
  await page.locator('.page-context-menu .context-menu-item', { hasText: item }).click();
}

async function expectPageCount(page: Page, n: number): Promise<void> {
  await expect(thumbs(page)).toHaveCount(n, { timeout: 15_000 });
  await expect.poll(() => getPageCount(page), { timeout: 10_000 }).toBe(n);
}

test.describe('Page tools', () => {
  test('multi-select: ctrl-click, shift-click range, Ctrl+A', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'scan-document.pdf');
    await expectPageCount(appPage, 9);
    await thumbs(appPage).nth(1).click();
    await thumbs(appPage).nth(3).click({ modifiers: ['Control'] });
    await expect(appPage.locator('.sidebar .page-thumbnail.selected')).toHaveCount(2);
    await thumbs(appPage).nth(6).click({ modifiers: ['Shift'] });
    // Shift extends from the anchor (page 4) to page 7, replacing the selection.
    await expect(appPage.locator('.sidebar .page-thumbnail.selected')).toHaveCount(4);
    await appPage.locator('.sidebar .pages-content').focus();
    await appPage.keyboard.press('Control+a');
    await expect(appPage.locator('.sidebar .page-thumbnail.selected')).toHaveCount(9);
    // With everything selected, delete is refused.
    await thumbs(appPage).nth(0).click({ button: 'right' });
    await expect(appPage.locator('.page-context-menu .context-menu-item.danger')).toBeDisabled();
  });

  test('duplicate page is undoable/redoable and survives save', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    await expectPageCount(appPage, 3);
    await contextMenu(appPage, 0, /^Duplicate page$/);
    await expectPageCount(appPage, 4);
    await appPage.locator('.pdf-viewer').click({ position: { x: 5, y: 5 } });
    await appPage.keyboard.press('Control+z');
    await expectPageCount(appPage, 3);
    await appPage.keyboard.press('Control+y');
    await expectPageCount(appPage, 4);
    const saved = await saveAndCapture(appPage);
    expect(saved.getPageCount()).toBe(4);
  });

  test('bulk rotate left/right and bulk delete of a selection', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'scan-document.pdf');
    await expectPageCount(appPage, 9);
    await thumbs(appPage).nth(0).click();
    await thumbs(appPage).nth(2).click({ modifiers: ['Shift'] });
    await contextMenu(appPage, 1, /Rotate 3 pages right/);
    await contextMenu(appPage, 1, /Rotate 3 pages right/);
    await contextMenu(appPage, 1, /Rotate 3 pages left/);
    // Thumbnails are not double-rotated by CSS on top of the baked /Rotate.
    await expect.poll(async () => thumbs(appPage).nth(0).locator('img').evaluate(
      (img: HTMLImageElement) => [img.naturalWidth > img.naturalHeight, img.style.transform || '']
    ), { timeout: 15_000 }).toEqual([true, '']);

    await thumbs(appPage).nth(4).click();
    await thumbs(appPage).nth(5).click({ modifiers: ['Control'] });
    await contextMenu(appPage, 4, /Delete 2 pages/);
    await expectPageCount(appPage, 7);

    const saved = await saveAndCapture(appPage);
    expect(saved.getPageCount()).toBe(7);
    expect(saved.getPages().map((p) => p.getRotation().angle)).toEqual([90, 90, 90, 0, 0, 0, 0]);
  });

  test('drag a selection of thumbnails to a new position', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    await expectPageCount(appPage, 3);
    // Mark page 1 by rotating it, then drag it below page 3.
    await contextMenu(appPage, 0, /Rotate page right/);
    await thumbs(appPage).nth(0).click();
    const target = thumbs(appPage).nth(2);
    const box = (await target.boundingBox())!;
    await thumbs(appPage).nth(0).dragTo(target, { targetPosition: { x: box.width / 2, y: box.height - 4 } });
    await expect.poll(async () => {
      const saved = await saveAndCapture(appPage);
      return saved.getPages().map((p) => p.getRotation().angle);
    }, { timeout: 20_000 }).toEqual([0, 0, 90]);
  });

  test('insert pages from another PDF at a position', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    await expectPageCount(appPage, 3);
    await mockPickPdf(appPage, 'cleaning-services.pdf');
    await contextMenu(appPage, 0, /Insert pages from PDF after/);
    await expectPageCount(appPage, 4);
    const saved = await saveAndCapture(appPage);
    expect(saved.getPages().map((p) => Math.round(p.getSize().width))).toEqual([612, 595, 612, 612]);
  });

  test('inserting a password-protected PDF fails with a clear error and changes nothing', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    await expectPageCount(appPage, 3);
    await mockPickPdf(appPage, 'encrypted-sample.pdf');
    await contextMenu(appPage, 0, /Insert pages from PDF before/);
    await expect(appPage.getByText(/password-protected/)).toBeVisible({ timeout: 15_000 });
    await expectPageCount(appPage, 3);
  });

  test('crop with numeric margins sets the CropBox and keeps the MediaBox', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    await expectPageCount(appPage, 1);
    const before = (await appPage.locator('.pdf-page-container').first().boundingBox())!;
    await contextMenu(appPage, 0, /Crop page/);
    const dialog = appPage.getByTestId('crop-dialog');
    await expect(dialog.getByTestId('crop-box')).toBeVisible({ timeout: 15_000 });
    for (const [side, v] of [['top', '36'], ['right', '18'], ['bottom', '72'], ['left', '54']]) {
      await dialog.getByLabel(`Crop ${side}`).fill(v);
    }
    await expect(dialog.getByTestId('crop-result-size')).toContainText('540 × 684 pt');
    await dialog.getByTestId('crop-apply').click();
    await expect(dialog).toBeHidden();
    // The viewer shows the cropped page size.
    await expect.poll(async () => {
      const b = (await appPage.locator('.pdf-page-container').first().boundingBox())!;
      return Math.round((b.width / b.height) * 1000) / 1000;
    }).toBeCloseTo(540 / 684, 2);
    expect(before.width / before.height).toBeCloseTo(612 / 792, 2);

    const saved = await saveAndCapture(appPage);
    const crop = (saved.getPage(0).node.get(PDFName.of('CropBox')) as PDFArray).asArray()
      .map((n) => (n as PDFNumber).asNumber());
    expect(crop).toEqual([54, 72, 594, 756]);
    const media = saved.getPage(0).getMediaBox();
    expect([media.width, media.height]).toEqual([612, 792]);
  });

  test('duplicating a form page keeps every field (linked widgets)', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'repair-calibration-form.pdf');
    await expectPageCount(appPage, 1);
    await contextMenu(appPage, 0, /^Duplicate page$/);
    await expectPageCount(appPage, 2);
    const saved = await saveAndCapture(appPage);
    const fields = saved.getForm().getFields();
    expect(fields.length).toBe(47);
    for (const f of fields) expect(f.acroField.getWidgets().length).toBe(2);
  });
});
