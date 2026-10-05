import { test, expect } from '../fixtures/electron-app';
import { openPDFViaIPC, getPageCount, interceptSaveIpc, getInterceptedSaves } from '../fixtures/helpers';
import type { Page, ElectronApplication } from '@playwright/test';
import { PDFDocument as PDFLib, PDFName, PDFArray, PDFNumber } from 'pdf-lib';
import path from 'path';
import fs from 'fs';

const TEST_PDFS_DIR = path.resolve(__dirname, '../../test-pdfs');
const thumbs = (page: Page) => page.locator('.sidebar .page-thumbnail');

/**
 * Save through the real renderer pipeline and return the bytes that crossed
 * the IPC boundary. window.electronAPI is a frozen contextBridge object, so the
 * save handlers are replaced in the MAIN process (Wave A's interceptSaveIpc).
 */
async function saveAndCapture(app: ElectronApplication, page: Page): Promise<PDFLib> {
  await interceptSaveIpc(app);
  await page.locator('.pdf-viewer').click({ position: { x: 5, y: 5 } });
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await getInterceptedSaves(app)).length, { timeout: 20_000 }).toBeGreaterThan(0);
  const saves = await getInterceptedSaves(app);
  return PDFLib.load(Buffer.from(saves[saves.length - 1].data, 'base64'));
}

/** Make the native PDF picker + raw read return a fixture (native dialogs cannot be automated). */
async function mockPickPdf(app: ElectronApplication, fixture: string): Promise<void> {
  const filePath = path.join(TEST_PDFS_DIR, fixture);
  const b64 = fs.readFileSync(filePath).toString('base64');
  await app.evaluate(({ ipcMain }, { fp, data }) => {
    ipcMain.removeHandler('pick-pdf-file');
    ipcMain.handle('pick-pdf-file', () => fp);
    ipcMain.removeHandler('read-file-raw');
    ipcMain.handle('read-file-raw', (_e, requested: string) => {
      if (requested !== fp) return null;
      const buf = Buffer.from(data, 'base64');
      return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    });
  }, { fp: filePath, data: b64 });
}

async function contextMenu(page: Page, thumbIndex: number, item: string): Promise<void> {
  await thumbs(page).nth(thumbIndex).click({ button: 'right' });
  await page.locator('.page-context-menu').getByRole('menuitem', { name: item, exact: true }).click();
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
    await contextMenu(appPage, 0, 'Duplicate page');
    await expectPageCount(appPage, 4);
    await appPage.locator('.pdf-viewer').click({ position: { x: 5, y: 5 } });
    await appPage.keyboard.press('Control+z');
    await expectPageCount(appPage, 3);
    await appPage.keyboard.press('Control+y');
    await expectPageCount(appPage, 4);
    const saved = await saveAndCapture(electronApp, appPage);
    expect(saved.getPageCount()).toBe(4);
  });

  test('bulk rotate left/right and bulk delete of a selection', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'scan-document.pdf');
    await expectPageCount(appPage, 9);
    await thumbs(appPage).nth(0).click();
    await thumbs(appPage).nth(2).click({ modifiers: ['Shift'] });
    await contextMenu(appPage, 1, 'Rotate 3 pages right');
    await contextMenu(appPage, 1, 'Rotate 3 pages right');
    await contextMenu(appPage, 1, 'Rotate 3 pages left');
    // Thumbnails are not double-rotated by CSS on top of the baked /Rotate.
    await expect.poll(async () => thumbs(appPage).nth(0).locator('img').evaluate(
      (img: HTMLImageElement) => [img.naturalWidth > img.naturalHeight, img.style.transform || '']
    ), { timeout: 30_000 }).toEqual([true, '']);

    await thumbs(appPage).nth(4).click();
    await thumbs(appPage).nth(5).click({ modifiers: ['Control'] });
    await contextMenu(appPage, 4, 'Delete 2 pages');
    await expectPageCount(appPage, 7);

    const saved = await saveAndCapture(electronApp, appPage);
    expect(saved.getPageCount()).toBe(7);
    expect(saved.getPages().map((p) => p.getRotation().angle)).toEqual([90, 90, 90, 0, 0, 0, 0]);
  });

  test('drag a selection of thumbnails to a new position', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    await expectPageCount(appPage, 3);
    // Mark page 1 by rotating it, then drag it below page 3.
    await contextMenu(appPage, 0, 'Rotate page right');
    await thumbs(appPage).nth(0).click();
    const target = thumbs(appPage).nth(2);
    const box = (await target.boundingBox())!;
    await thumbs(appPage).nth(0).dragTo(target, { targetPosition: { x: box.width / 2, y: box.height - 4 } });
    await expect.poll(async () => {
      const saved = await saveAndCapture(electronApp, appPage);
      return saved.getPages().map((p) => p.getRotation().angle);
    }, { timeout: 20_000 }).toEqual([0, 0, 90]);
  });

  test('insert pages from another PDF at a position', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    await expectPageCount(appPage, 3);
    await mockPickPdf(electronApp, 'cleaning-services.pdf');
    await contextMenu(appPage, 0, 'Insert pages from PDF after…');
    await expectPageCount(appPage, 4);
    const saved = await saveAndCapture(electronApp, appPage);
    expect(saved.getPages().map((p) => Math.round(p.getSize().width))).toEqual([612, 595, 612, 612]);
  });

  test('inserting a password-protected PDF fails with a clear error and changes nothing', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    await expectPageCount(appPage, 3);
    await mockPickPdf(electronApp, 'encrypted-sample.pdf');
    await contextMenu(appPage, 0, 'Insert pages from PDF before…');
    await expect(appPage.getByText(/password-protected/)).toBeVisible({ timeout: 15_000 });
    await expectPageCount(appPage, 3);
  });

  test('crop with numeric margins sets the CropBox and keeps the MediaBox', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    await expectPageCount(appPage, 1);
    const before = (await appPage.locator('.pdf-page-container').first().boundingBox())!;
    await contextMenu(appPage, 0, 'Crop page…');
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

    const saved = await saveAndCapture(electronApp, appPage);
    const crop = (saved.getPage(0).node.get(PDFName.of('CropBox')) as PDFArray).asArray()
      .map((n) => (n as PDFNumber).asNumber());
    expect(crop).toEqual([54, 72, 594, 756]);
    const media = saved.getPage(0).getMediaBox();
    expect([media.width, media.height]).toEqual([612, 792]);
  });

  test('Rotate All then Undo restores every page, and queued ops each get their own undo step', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    await expectPageCount(appPage, 3);
    const rotations = async () => (await saveAndCapture(electronApp, appPage)).getPages().map((p) => p.getRotation().angle);

    await appPage.locator('.tool-btn', { hasText: 'Rotate All Pages' }).click();
    await expect.poll(rotations, { timeout: 20_000 }).toEqual([90, 90, 90]);
    await appPage.keyboard.press('Control+z');
    await expect.poll(rotations, { timeout: 20_000 }).toEqual([0, 0, 0]);

    // Three ops queued from ONE render (no re-render in between): each must
    // record its own history entry, so three undos walk back cleanly and a
    // fourth is a harmless no-op instead of throwing.
    const pageErrors: string[] = [];
    appPage.on('pageerror', (e) => pageErrors.push(e.message));
    await appPage.evaluate(() => {
      const right = document.querySelector('.toolbar-btn[aria-label="Rotate Right"]') as HTMLButtonElement;
      right.click(); right.click(); right.click();
    });
    await expect.poll(rotations, { timeout: 20_000 }).toEqual([270, 0, 0]);
    for (const expected of [[180, 0, 0], [90, 0, 0], [0, 0, 0]]) {
      await appPage.keyboard.press('Control+z');
      await expect.poll(rotations, { timeout: 20_000 }).toEqual(expected);
    }
    await appPage.keyboard.press('Control+z');
    await expect.poll(rotations, { timeout: 20_000 }).toEqual([0, 0, 0]);
    expect(pageErrors).toEqual([]);
  });

  test('duplicating a form page keeps every field (linked widgets)', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'repair-calibration-form.pdf');
    await expectPageCount(appPage, 1);
    await contextMenu(appPage, 0, 'Duplicate page');
    await expectPageCount(appPage, 2);
    const saved = await saveAndCapture(electronApp, appPage);
    const fields = saved.getForm().getFields();
    expect(fields.length).toBe(47);
    for (const f of fields) expect(f.acroField.getWidgets().length).toBe(2);
  });
});
