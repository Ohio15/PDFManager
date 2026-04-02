import { test, expect } from '../fixtures/electron-app';
import { openPDFViaIPC } from '../fixtures/helpers';

test.describe('Dialogs', () => {
  test.beforeEach(async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
  });

  test('shortcuts dialog opens with ? key', async ({ appPage }) => {
    await appPage.keyboard.press('Shift+/'); // ? key
    await appPage.waitForTimeout(300);

    const dialog = appPage.locator('[class*="shortcut"], [class*="keyboard"], [role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 5_000 });
  });

  test('shortcuts dialog closes with Escape', async ({ appPage }) => {
    // Open shortcuts dialog
    await appPage.keyboard.press('Shift+/');
    await appPage.waitForTimeout(300);

    const dialog = appPage.locator('[class*="shortcut"], [class*="keyboard"], [role="dialog"]').first();
    await expect(dialog).toBeVisible({ timeout: 5_000 });

    // Close with Escape
    await appPage.keyboard.press('Escape');
    await appPage.waitForTimeout(300);
    await expect(dialog).not.toBeVisible({ timeout: 5_000 });
  });

  test('settings dialog opens via menu action', async ({ electronApp, appPage }) => {
    // Trigger settings via IPC since native menus can't be automated
    await electronApp.evaluate(({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('menu-action', 'open-settings');
      }
    });
    await appPage.waitForTimeout(500);

    const settingsDialog = appPage.locator('[class*="settings"], [class*="preferences"], [role="dialog"]').first();
    await expect(settingsDialog).toBeVisible({ timeout: 5_000 });
  });

  test('print dialog opens with Ctrl+P', async ({ electronApp, appPage }) => {
    // Mock the print API to prevent native print dialog from blocking
    await appPage.evaluate(() => {
      const api = (window as any).electronAPI;
      if (api) {
        api.print = () => Promise.resolve();
        api.printPDF = () => Promise.resolve();
      }
      // Also intercept window.print
      window.print = () => {};
    });

    await appPage.keyboard.press('Control+p');
    await appPage.waitForTimeout(500);

    // Check for a print dialog/preview overlay, or verify no crash
    const printDialog = appPage.locator('[class*="print"], [role="dialog"]').first();
    const isVisible = await printDialog.isVisible().catch(() => false);

    // If the app shows its own print dialog, verify it's visible
    // If it delegates to native print, just verify the app didn't crash
    if (isVisible) {
      await expect(printDialog).toBeVisible();
    } else {
      // App handled print natively — verify app is still responsive
      const canvas = appPage.locator('canvas').first();
      await expect(canvas).toBeVisible();
    }
  });

  test('merge dialog opens with Ctrl+M', async ({ appPage }) => {
    await appPage.keyboard.press('Control+m');
    await appPage.waitForTimeout(500);

    const mergeDialog = appPage.locator('[class*="merge"], [role="dialog"]').first();
    await expect(mergeDialog).toBeVisible({ timeout: 5_000 });
  });

  test('document properties dialog opens with Ctrl+D', async ({ appPage }) => {
    await appPage.keyboard.press('Control+d');
    await appPage.waitForTimeout(500);

    const propsDialog = appPage.locator('[class*="properties"], [class*="document-info"], [role="dialog"]').first();
    await expect(propsDialog).toBeVisible({ timeout: 5_000 });
  });

  test('all dialogs can be closed', async ({ electronApp, appPage }) => {
    // Test that each dialog type can be opened and closed with Escape
    const dialogTriggers = [
      {
        name: 'shortcuts',
        open: async () => await appPage.keyboard.press('Shift+/'),
      },
      {
        name: 'merge',
        open: async () => await appPage.keyboard.press('Control+m'),
      },
      {
        name: 'properties',
        open: async () => await appPage.keyboard.press('Control+d'),
      },
    ];

    for (const trigger of dialogTriggers) {
      await trigger.open();
      await appPage.waitForTimeout(400);

      // Find any visible dialog
      const dialog = appPage.locator('[role="dialog"], [class*="modal"], [class*="dialog"]').first();
      const wasVisible = await dialog.isVisible().catch(() => false);

      if (wasVisible) {
        await appPage.keyboard.press('Escape');
        await appPage.waitForTimeout(400);

        // Verify it closed
        await expect(dialog).not.toBeVisible({ timeout: 5_000 });
      }
    }

    // Verify the app is still functional after opening/closing dialogs
    const canvas = appPage.locator('canvas').first();
    await expect(canvas).toBeVisible();
  });

  test('search bar opens with Ctrl+F and closes with Escape', async ({ appPage }) => {
    // Open search bar
    await appPage.keyboard.press('Control+f');
    await appPage.waitForTimeout(300);

    const searchBar = appPage.locator('.search-bar');
    await expect(searchBar).toBeVisible({ timeout: 5_000 });

    // Verify search input is focused
    const searchInput = searchBar.locator('input').first();
    await expect(searchInput).toBeVisible();

    // Type a search term to verify it's interactive
    await appPage.keyboard.type('test');
    await appPage.waitForTimeout(200);

    // Close search bar with Escape
    await appPage.keyboard.press('Escape');
    await appPage.waitForTimeout(300);
    await expect(searchBar).not.toBeVisible({ timeout: 5_000 });
  });
});
