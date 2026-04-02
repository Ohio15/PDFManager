import { test, expect } from '../fixtures/electron-app';
import {
  openPDFViaIPC,
  selectTool,
  selectToolByKey,
  getPageCount,
  mockElectronAPI,
  drawStroke,
  isToolActive,
} from '../fixtures/helpers';

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
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');

    // The second tab should be active after opening
    const activeTab = appPage.locator('.tab-bar-tab.active');
    const activeText = await activeTab.textContent();
    expect(activeText).toContain('announcement');

    // Click the first tab to switch
    const firstTab = appPage.locator('.tab-bar-tab').first();
    await firstTab.click();
    await appPage.waitForTimeout(300);

    const newActiveTab = appPage.locator('.tab-bar-tab.active');
    const newActiveText = await newActiveTab.textContent();
    expect(newActiveText).toContain('invoice');
  });

  test('close tab removes it', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');

    const tabsBeforeClose = await appPage.locator('.tab-bar-tab').count();

    // Close the active (second) tab
    const closeBtn = appPage.locator('.tab-bar-tab.active .tab-close-btn');
    await closeBtn.click();
    await appPage.waitForTimeout(300);

    const tabsAfterClose = await appPage.locator('.tab-bar-tab').count();
    expect(tabsAfterClose).toBe(tabsBeforeClose - 1);
  });

  test('save triggers electronAPI.saveFile', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');

    // Track whether saveFile was called
    await appPage.evaluate(() => {
      (window as any).__saveFileCalled = false;
      (window as any).electronAPI.saveFile = async () => {
        (window as any).__saveFileCalled = true;
        return { success: true };
      };
    });

    // Trigger save via Ctrl+S
    await appPage.keyboard.press('Control+s');
    await appPage.waitForTimeout(500);

    const wasCalled = await appPage.evaluate(() => (window as any).__saveFileCalled);
    expect(wasCalled).toBe(true);
  });

  test('Ctrl+S triggers save', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');

    let saveCalled = false;
    await appPage.evaluate(() => {
      (window as any).__ctrlSTriggered = false;
      (window as any).electronAPI.saveFile = async () => {
        (window as any).__ctrlSTriggered = true;
        return { success: true };
      };
    });

    await appPage.keyboard.press('Control+s');
    await appPage.waitForTimeout(500);

    const triggered = await appPage.evaluate(() => (window as any).__ctrlSTriggered);
    expect(triggered).toBe(true);
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

    // The active tab should show a modified indicator (asterisk or dot)
    const activeTab = appPage.locator('.tab-bar-tab.active');
    const tabText = await activeTab.textContent();
    // Modified indicator is typically an asterisk, dot, or the tab gains a 'modified' class
    const hasModifiedClass = await activeTab.evaluate(
      (el) => el.classList.contains('modified') || el.querySelector('.modified-indicator') !== null
    );
    const hasAsterisk = tabText?.includes('*') || tabText?.includes('●');
    expect(hasModifiedClass || hasAsterisk).toBe(true);
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
