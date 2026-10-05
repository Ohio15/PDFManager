import { test, expect } from '../fixtures/electron-app';
import { openPDFViaIPC } from '../fixtures/helpers';
import type { Page } from '@playwright/test';

/**
 * Stamping end to end: drive the real dialog, then capture the bytes the app
 * saves and re-read them with pdf.js to assert the stamp is in the OUTPUT.
 */

async function openStampDialog(page: Page): Promise<void> {
  const toggle = page.locator('.tools-panel-toggle.collapsed');
  if (await toggle.isVisible().catch(() => false)) await toggle.click();
  await page.locator('.tool-btn', { hasText: 'Stamp Pages' }).click();
  await expect(page.locator('[data-testid="stamping-dialog"]')).toBeVisible({ timeout: 5_000 });
}

/** Save via Ctrl+S with the IPC write intercepted; returns the saved PDF bytes. */
async function captureSave(page: Page): Promise<Buffer> {
  await page.evaluate(() => {
    const api = (window as any).electronAPI;
    (window as any).__savedPdfData = null;
    const interceptor = (data: string) => {
      (window as any).__savedPdfData = data;
      return Promise.resolve({ success: true, path: 'C:/fake/stamped.pdf' });
    };
    api.saveFile = interceptor;
    api.saveFileDialog = interceptor;
  });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => (window as any).__savedPdfData !== null, undefined, { timeout: 20_000 });
  const b64 = await page.evaluate(() => (window as any).__savedPdfData as string);
  return Buffer.from(b64, 'base64');
}

async function pageTexts(bytes: Buffer): Promise<string[]> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false, verbosity: 0 }).promise;
  const out: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    out.push((tc.items as Array<{ str?: string }>).map((it) => it.str ?? '').join('|'));
  }
  await doc.destroy();
  return out;
}

test.describe('Stamping', () => {
  test('Bates numbers are written to every page of the saved file', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf'); // 3 pages
    await openStampDialog(appPage);

    await appPage.locator('[data-stamp-tab="Bates"]').click();
    await expect(appPage.getByText('applies to this document only')).toBeVisible();
    await appPage.fill('#bt-prefix', 'E2E');
    await appPage.fill('#bt-start', '41');
    await appPage.fill('#bt-digits', '5');

    // The live preview renders the stamped page through pdf.js.
    const canvas = appPage.locator('[data-testid="stamp-preview-canvas"]');
    await expect(canvas).toBeVisible({ timeout: 10_000 });
    await expect.poll(async () => canvas.evaluate((c: HTMLCanvasElement) => c.width), { timeout: 10_000 }).toBeGreaterThan(0);

    await appPage.locator('[data-testid="stamp-apply"]').click();
    await expect(appPage.locator('[data-testid="stamping-dialog"]')).toBeHidden({ timeout: 15_000 });

    const texts = await pageTexts(await captureSave(appPage));
    expect(texts).toHaveLength(3);
    expect(texts[0]).toContain('E2E00041');
    expect(texts[1]).toContain('E2E00042');
    expect(texts[2]).toContain('E2E00043');
  });

  test('watermark applies, is undoable, and Remove deletes it', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    await openStampDialog(appPage);

    await appPage.fill('#wm-text', 'E2E-WATERMARK');
    await expect(appPage.locator('[data-testid="stamp-apply"]')).toBeEnabled({ timeout: 10_000 });
    await appPage.locator('[data-testid="stamp-apply"]').click();
    await expect(appPage.locator('[data-testid="stamping-dialog"]')).toBeHidden({ timeout: 15_000 });
    expect((await pageTexts(await captureSave(appPage)))[0]).toContain('E2E-WATERMARK');

    // Undo restores the unstamped bytes.
    await appPage.locator('.pdf-viewer').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
    await appPage.keyboard.press('Control+z');
    await expect.poll(async () => (await pageTexts(await captureSave(appPage)))[0], { timeout: 15_000 })
      .not.toContain('E2E-WATERMARK');

    // Redo, then remove through the dialog.
    await appPage.keyboard.press('Control+y');
    await expect.poll(async () => (await pageTexts(await captureSave(appPage)))[0], { timeout: 15_000 })
      .toContain('E2E-WATERMARK');
    await openStampDialog(appPage);
    const remove = appPage.locator('[data-testid="stamp-remove"]');
    await expect(remove).toBeVisible({ timeout: 10_000 });
    await remove.click();
    await expect(appPage.locator('[data-testid="stamping-dialog"]')).toBeHidden({ timeout: 15_000 });
    expect((await pageTexts(await captureSave(appPage)))[0]).not.toContain('E2E-WATERMARK');
  });

  test('non-WinAnsi text shows a validation error and blocks Apply', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    await openStampDialog(appPage);
    await appPage.fill('#wm-text', 'Привет');
    await expect(appPage.locator('[data-testid="stamp-preview-error"]')).toContainText('WinAnsi', { timeout: 10_000 });
    await expect(appPage.locator('[data-testid="stamp-apply"]')).toBeDisabled();
    // The app is still alive and the dialog closes normally.
    await appPage.keyboard.press('Escape');
    await expect(appPage.locator('[data-testid="stamping-dialog"]')).toBeHidden();
  });
});
