import { test, expect } from '../fixtures/electron-app';
import { openPDFViaIPC, interceptSaveIpc, getInterceptedSaves } from '../fixtures/helpers';
import type { ElectronApplication, Page } from '@playwright/test';

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

/**
 * Save via Ctrl+S and capture the bytes at the main-process IPC boundary
 * (the contextBridge API cannot be patched from the renderer).
 */
async function captureSave(electronApp: ElectronApplication, page: Page): Promise<Buffer> {
  await interceptSaveIpc(electronApp);
  // Ctrl+S is ignored while an input has focus.
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+s');
  await expect.poll(async () => (await getInterceptedSaves(electronApp)).length, { timeout: 20_000 }).toBeGreaterThan(0);
  const saves = await getInterceptedSaves(electronApp);
  const bytes = Buffer.from(saves[saves.length - 1].data, 'base64');
  expect(bytes.subarray(0, 5).toString('latin1')).toBe('%PDF-');
  return bytes;
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

    const texts = await pageTexts(await captureSave(electronApp, appPage));
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
    expect((await pageTexts(await captureSave(electronApp, appPage)))[0]).toContain('E2E-WATERMARK');

    // Undo restores the unstamped bytes.
    await appPage.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    await appPage.keyboard.press('Control+z');
    await expect.poll(async () => (await pageTexts(await captureSave(electronApp, appPage)))[0], { timeout: 15_000 })
      .not.toContain('E2E-WATERMARK');

    // Redo, then remove through the dialog.
    await appPage.keyboard.press('Control+y');
    await expect.poll(async () => (await pageTexts(await captureSave(electronApp, appPage)))[0], { timeout: 15_000 })
      .toContain('E2E-WATERMARK');
    await openStampDialog(appPage);
    const remove = appPage.locator('[data-testid="stamp-remove"]');
    await expect(remove).toBeVisible({ timeout: 10_000 });
    await remove.click();
    await expect(appPage.locator('[data-testid="stamping-dialog"]')).toBeHidden({ timeout: 15_000 });
    expect((await pageTexts(await captureSave(electronApp, appPage)))[0]).not.toContain('E2E-WATERMARK');
  });

  test('text the bundled fonts cannot show is named and blocks Apply', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    await openStampDialog(appPage);
    await appPage.fill('#wm-text', '機密');
    await expect(appPage.locator('[data-testid="stamp-preview-error"]')).toContainText('cannot show', { timeout: 10_000 });
    await expect(appPage.locator('[data-testid="stamp-apply"]')).toBeDisabled();
    // The app is still alive and the dialog closes normally.
    await appPage.keyboard.press('Escape');
    await expect(appPage.locator('[data-testid="stamping-dialog"]')).toBeHidden();
  });
});
