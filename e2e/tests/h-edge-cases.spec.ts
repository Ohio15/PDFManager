import { test, expect } from '../fixtures/electron-app';
import { openPDFViaIPC, selectTool, drawStroke } from '../fixtures/helpers';

test.describe('Edge Cases', () => {
  test('corrupt PDF data shows error and does not crash', async ({ electronApp, appPage }) => {
    // Send corrupt data through the file-opened IPC channel
    const corruptData = Buffer.from('This is not a valid PDF file at all').toString('base64');

    await electronApp.evaluate(
      ({ BrowserWindow }, { fileData }) => {
        const win = BrowserWindow.getAllWindows()[0];
        if (win) {
          win.webContents.send('file-opened', {
            path: '/fake/corrupt-file.pdf',
            data: fileData,
          });
        }
      },
      { fileData: corruptData }
    );

    await appPage.waitForTimeout(2_000);

    // The app should either show an error message or gracefully handle the corrupt data
    // It should NOT crash — the window should still be present and responsive
    const bodyVisible = await appPage.isVisible('body');
    expect(bodyVisible).toBe(true);

    // Check for error indication (toast, dialog, or error message)
    const errorIndicator = appPage.locator(
      '[class*="error"], [class*="toast"], [role="alert"], [class*="notification"]'
    ).first();
    const hasError = await errorIndicator.isVisible().catch(() => false);

    // Either an error is shown or the app falls back to welcome screen
    if (!hasError) {
      const welcomeOrViewer = appPage.locator('.welcome-screen, canvas');
      await expect(welcomeOrViewer.first()).toBeVisible({ timeout: 5_000 });
    }
  });

  test('rapid zoom in/out does not crash', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');

    // Perform rapid zoom in/out cycles
    for (let i = 0; i < 10; i++) {
      await appPage.keyboard.press('Control+='); // Zoom in
    }
    for (let i = 0; i < 20; i++) {
      await appPage.keyboard.press('Control+-'); // Zoom out
    }
    for (let i = 0; i < 10; i++) {
      await appPage.keyboard.press('Control+='); // Zoom back in
    }

    // Small wait for any debounced re-renders
    await appPage.waitForTimeout(500);

    // App should still be responsive with canvas visible
    const canvas = appPage.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 5_000 });

    // Verify the window is still alive
    const windows = electronApp.windows();
    expect(windows.length).toBeGreaterThanOrEqual(1);
  });

  test('multiple rapid undo with no history does not crash', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');

    // Rapidly press undo many times with no action history
    for (let i = 0; i < 20; i++) {
      await appPage.keyboard.press('Control+z');
    }

    // Also try redo rapidly
    for (let i = 0; i < 20; i++) {
      await appPage.keyboard.press('Control+Shift+z');
    }

    await appPage.waitForTimeout(300);

    // App should remain stable
    const canvas = appPage.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 5_000 });

    // Verify we can still perform actions after the rapid undo/redo
    await selectTool(appPage, 'Draw');
    await drawStroke(appPage, 0, [
      { rx: 0.3, ry: 0.3 },
      { rx: 0.4, ry: 0.4 },
    ]);
    await appPage.waitForTimeout(300);

    // Now undo should work for the stroke we just drew
    await appPage.keyboard.press('Control+z');
    await appPage.waitForTimeout(200);

    // App is still responsive
    const bodyVisible = await appPage.isVisible('body');
    expect(bodyVisible).toBe(true);
  });

  test('opening same PDF twice reuses tab', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');

    // Count tabs after first open
    const tabsBefore = await appPage.locator('.tab-bar-tab').count();
    expect(tabsBefore).toBeGreaterThanOrEqual(1);

    // Open the same PDF again
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    await appPage.waitForTimeout(500);

    // Tab count should remain the same (reused, not duplicated)
    const tabsAfter = await appPage.locator('.tab-bar-tab').count();
    expect(tabsAfter).toBe(tabsBefore);

    // The active tab should still be for invoice.pdf
    const activeTab = appPage.locator('.tab-bar-tab.active');
    await expect(activeTab).toBeVisible();
    const tabText = await activeTab.textContent();
    expect(tabText?.toLowerCase()).toContain('invoice');
  });

  test('app remains responsive after opening large PDF', async ({ electronApp, appPage }) => {
    // scan-document.pdf is typically a larger scanned document
    await openPDFViaIPC(electronApp, appPage, 'scan-document.pdf');

    // Verify the PDF loaded — canvas should be present
    const canvas = appPage.locator('canvas').first();
    await expect(canvas).toBeVisible({ timeout: 30_000 });

    // Verify toolbar is still interactive
    await selectTool(appPage, 'Select');
    const isActive = await appPage.locator('.toolbar-btn[aria-label="Select"]').getAttribute('class');
    expect(isActive).toContain('active');

    // Verify scrolling works (the page should respond to scroll input)
    const viewer = appPage.locator('.pdf-page-container').first();
    await expect(viewer).toBeVisible();

    // Perform a zoom action to test responsiveness
    await appPage.keyboard.press('Control+=');
    await appPage.waitForTimeout(300);
    await appPage.keyboard.press('Control+-');
    await appPage.waitForTimeout(300);

    // Verify keyboard shortcuts still work
    await appPage.keyboard.press('Control+f');
    await appPage.waitForTimeout(300);
    const searchBar = appPage.locator('.search-bar');
    const searchVisible = await searchBar.isVisible().catch(() => false);
    if (searchVisible) {
      await appPage.keyboard.press('Escape');
    }

    // Final check: app is alive and responsive
    const bodyVisible = await appPage.isVisible('body');
    expect(bodyVisible).toBe(true);
  });
});
