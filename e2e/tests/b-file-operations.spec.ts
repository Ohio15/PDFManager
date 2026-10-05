import { test, expect } from '../fixtures/electron-app';
import {
  openPDFViaIPC,
  selectTool,
  selectToolByKey,
  getPageCount,
  mockElectronAPI,
  drawStroke,
  isToolActive, interceptSaveIpc, getInterceptedSaves } from '../fixtures/helpers';

test.describe('File Operations', () => {
  test('open PDF via IPC', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    const canvas = appPage.locator('canvas').first();
    await expect(canvas).toBeVisible();
  });

  test('status bar shows filename after open', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    const statusBar = appPage.locator('.status-bar');
    await expect(statusBar).toBeVisible();
    const statusText = await statusBar.textContent();
    expect(statusText).toContain('invoice.pdf');
  });

  test('page count displayed correctly', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    const count = await getPageCount(appPage);
    expect(count).toBeGreaterThan(0);
  });

  test('open second PDF creates new tab', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    const tabsBefore = await appPage.locator('.tab-bar-tab').count();

    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    const tabsAfter = await appPage.locator('.tab-bar-tab').count();

    expect(tabsAfter).toBe(tabsBefore + 1);
  });

  test('switch between tabs', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    await appPage.waitForTimeout(500);
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    await appPage.waitForTimeout(500);

    // Wait for both tabs to appear
    await appPage.waitForSelector('.tab-bar-tab', { timeout: 10_000 });
    const tabCount = await appPage.locator('.tab-bar-tab').count();
    expect(tabCount).toBeGreaterThanOrEqual(2);

    // The second tab should be active after opening
    const activeTab = appPage.locator('.tab-bar-tab.active');
    const activeText = await activeTab.textContent();
    expect(activeText).toContain('announcement');

    // Click the first tab to switch
    const firstTab = appPage.locator('.tab-bar-tab').first();
    await firstTab.click();
    await appPage.waitForTimeout(500);

    const newActiveTab = appPage.locator('.tab-bar-tab.active');
    const newActiveText = await newActiveTab.textContent();
    expect(newActiveText).toContain('invoice');
  });

  test('close tab removes it', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    await appPage.waitForTimeout(500);
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    await appPage.waitForTimeout(500);

    const tabsBeforeClose = await appPage.locator('.tab-bar-tab').count();
    expect(tabsBeforeClose).toBeGreaterThanOrEqual(2);

    // Hover the active tab to reveal the close button, then click it
    const activeTab = appPage.locator('.tab-bar-tab.active');
    await activeTab.hover();
    await appPage.waitForTimeout(200);

    const closeBtn = appPage.locator('.tab-bar-tab.active .tab-close-btn');
    await closeBtn.click();
    await appPage.waitForTimeout(500);

    const tabsAfterClose = await appPage.locator('.tab-bar-tab').count();
    expect(tabsAfterClose).toBe(tabsBeforeClose - 1);
  });

  test('save triggers electronAPI.saveFile', async ({ electronApp, appPage, }) => {
    // Note: Ctrl+S goes through Electron menu accelerator → IPC to main → back to renderer.
    // The save pipeline (applyEditsAndAnnotations) may throw on some PDFs in test environment.
    // Save round-trip is verified in f-save-pipeline.spec.ts instead.
    test.slow();
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    await appPage.waitForTimeout(1500);

    // Intercept at the real IPC boundary (main process): Ctrl+S -> handleSave ->
    // applyEditsAndAnnotations -> save-file / save-file-dialog. If the pipeline
    // throws, no save reaches main and the poll below fails.
    await interceptSaveIpc(electronApp);
    await appPage.evaluate(() => {
      (window as any).__saveError = null;
      window.addEventListener('unhandledrejection', (e) => {
        (window as any).__saveError = String(e.reason);
      });
    });

    await appPage.keyboard.press('Control+s');

    // The save must cross the IPC boundary with real PDF bytes.
    await expect.poll(async () => (await getInterceptedSaves(electronApp)).length, { timeout: 20_000 }).toBeGreaterThan(0);
    const [saved] = await getInterceptedSaves(electronApp);
    expect(await appPage.evaluate(() => (window as any).__saveError)).toBeNull();
    expect(Buffer.from(saved.data, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('Ctrl+S triggers save', async ({ electronApp, appPage, }) => {
    test.slow();
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    await appPage.waitForTimeout(1500);

    await interceptSaveIpc(electronApp);
    await appPage.evaluate(() => {
      (window as any).__saveError = null;
      window.addEventListener('unhandledrejection', (e) => {
        (window as any).__saveError = String(e.reason);
      });
    });

    await appPage.keyboard.press('Control+s');

    // The save must cross the IPC boundary with real PDF bytes.
    await expect.poll(async () => (await getInterceptedSaves(electronApp)).length, { timeout: 20_000 }).toBeGreaterThan(0);
    const [saved] = await getInterceptedSaves(electronApp);
    expect(await appPage.evaluate(() => (window as any).__saveError)).toBeNull();
    expect(Buffer.from(saved.data, 'base64').subarray(0, 5).toString('latin1')).toBe('%PDF-');
  });

  test('modified indicator shows after annotation', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');

    // Draw a stroke to modify the document
    await selectToolByKey(appPage, 'd');
    await appPage.waitForTimeout(200);
    await drawStroke(appPage, 0, [
      { rx: 0.3, ry: 0.3 },
      { rx: 0.4, ry: 0.35 },
      { rx: 0.5, ry: 0.3 },
    ]);
    await appPage.waitForTimeout(500);

    // The active tab should show a modified indicator (.tab-modified-dot is an empty span styled via CSS)
    const activeTab = appPage.locator('.tab-bar-tab.active');
    const modifiedDot = activeTab.locator('.tab-modified-dot');
    await expect(modifiedDot).toBeVisible({ timeout: 5_000 });
  });

  test('Escape resets to select tool', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');

    // Switch to drawing tool
    await selectToolByKey(appPage, 'd');
    await appPage.waitForTimeout(200);

    // Press Escape to go back to select
    await appPage.keyboard.press('Escape');
    await appPage.waitForTimeout(200);

    const selectActive = await isToolActive(appPage, 'Select');
    expect(selectActive).toBe(true);
  });
});
