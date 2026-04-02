import { test, expect } from '../fixtures/electron-app';
import {
  openPDFViaIPC,
  getPageCount,
} from '../fixtures/helpers';

test.describe('PDF Viewing', () => {
  test.beforeEach(async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
  });

  test('PDF renders canvas elements', async ({ appPage }) => {
    const canvasCount = await appPage.locator('canvas').count();
    expect(canvasCount).toBeGreaterThan(0);
  });

  test('zoom in increases canvas size', async ({ appPage }) => {
    const canvas = appPage.locator('canvas').first();
    const sizeBefore = await canvas.boundingBox();
    expect(sizeBefore).not.toBeNull();

    // Click zoom in button or use keyboard
    const zoomInBtn = appPage.locator('.toolbar-btn[aria-label="Zoom In"]');
    if (await zoomInBtn.isVisible()) {
      await zoomInBtn.click();
    } else {
      await appPage.keyboard.press('Control+=');
    }
    await appPage.waitForTimeout(500);

    const sizeAfter = await canvas.boundingBox();
    expect(sizeAfter).not.toBeNull();
    expect(sizeAfter!.width).toBeGreaterThan(sizeBefore!.width);
  });

  test('zoom out decreases canvas size', async ({ appPage }) => {
    // First zoom in so we have room to zoom out
    await appPage.keyboard.press('Control+=');
    await appPage.waitForTimeout(500);

    const canvas = appPage.locator('canvas').first();
    const sizeBefore = await canvas.boundingBox();
    expect(sizeBefore).not.toBeNull();

    await appPage.keyboard.press('Control+-');
    await appPage.waitForTimeout(500);

    const sizeAfter = await canvas.boundingBox();
    expect(sizeAfter).not.toBeNull();
    expect(sizeAfter!.width).toBeLessThan(sizeBefore!.width);
  });

  test('Ctrl+= zooms in', async ({ appPage }) => {
    const canvas = appPage.locator('canvas').first();
    const sizeBefore = await canvas.boundingBox();
    expect(sizeBefore).not.toBeNull();

    await appPage.keyboard.press('Control+=');
    await appPage.waitForTimeout(500);

    const sizeAfter = await canvas.boundingBox();
    expect(sizeAfter).not.toBeNull();
    expect(sizeAfter!.width).toBeGreaterThan(sizeBefore!.width);
  });

  test('Ctrl+- zooms out', async ({ appPage }) => {
    // Zoom in first so we can zoom out
    await appPage.keyboard.press('Control+=');
    await appPage.keyboard.press('Control+=');
    await appPage.waitForTimeout(500);

    const canvas = appPage.locator('canvas').first();
    const sizeBefore = await canvas.boundingBox();
    expect(sizeBefore).not.toBeNull();

    await appPage.keyboard.press('Control+-');
    await appPage.waitForTimeout(500);

    const sizeAfter = await canvas.boundingBox();
    expect(sizeAfter).not.toBeNull();
    expect(sizeAfter!.width).toBeLessThan(sizeBefore!.width);
  });

  test('sidebar toggle with Ctrl+B', async ({ appPage }) => {
    // Check initial sidebar state
    const sidebar = appPage.locator('.sidebar');
    const wasVisible = await sidebar.isVisible().catch(() => false);

    await appPage.keyboard.press('Control+b');
    await appPage.waitForTimeout(500);

    if (wasVisible) {
      await expect(sidebar).not.toBeVisible();
    } else {
      await expect(sidebar).toBeVisible();
    }

    // Toggle back
    await appPage.keyboard.press('Control+b');
    await appPage.waitForTimeout(500);

    if (wasVisible) {
      await expect(sidebar).toBeVisible();
    } else {
      await expect(sidebar).not.toBeVisible();
    }
  });

  test('search opens with Ctrl+F', async ({ appPage }) => {
    const searchBar = appPage.locator('.search-bar');
    await expect(searchBar).not.toBeVisible();

    await appPage.keyboard.press('Control+f');
    await appPage.waitForTimeout(500);

    await expect(searchBar).toBeVisible();
  });

  test('search finds text', async ({ appPage }) => {
    await appPage.keyboard.press('Control+f');
    await appPage.waitForTimeout(500);

    const searchInput = appPage.locator('.search-bar input, .search-bar [type="text"]').first();
    await expect(searchInput).toBeVisible();

    // Type a term likely found in invoice.pdf
    await searchInput.fill('invoice');
    await appPage.keyboard.press('Enter');
    await appPage.waitForTimeout(1000);

    // Check for highlighted results or match count
    const highlights = appPage.locator('.search-highlight, .text-highlight, mark');
    const matchInfo = appPage.locator('.search-bar').getByText(/\d+/);

    const hasHighlights = await highlights.count() > 0;
    const hasMatchInfo = await matchInfo.isVisible().catch(() => false);
    expect(hasHighlights || hasMatchInfo).toBe(true);
  });

  test('rotate page changes dimensions', async ({ appPage }) => {
    const canvas = appPage.locator('canvas').first();
    const sizeBefore = await canvas.boundingBox();
    expect(sizeBefore).not.toBeNull();

    const originalRatio = sizeBefore!.width / sizeBefore!.height;

    // Rotate via toolbar button or keyboard shortcut
    const rotateBtn = appPage.locator('.toolbar-btn[aria-label="Rotate"]');
    if (await rotateBtn.isVisible()) {
      await rotateBtn.click();
    } else {
      await appPage.keyboard.press('Control+r');
    }
    await appPage.waitForTimeout(1000);

    const sizeAfter = await canvas.boundingBox();
    expect(sizeAfter).not.toBeNull();

    const newRatio = sizeAfter!.width / sizeAfter!.height;
    // After 90-degree rotation, the aspect ratio should invert (portrait <-> landscape)
    // Allow some tolerance for rendering differences
    expect(Math.abs(newRatio - 1 / originalRatio)).toBeLessThan(0.5);
  });

  test('page navigation via sidebar thumbnail click', async ({ appPage }) => {
    // Ensure sidebar is open
    const sidebar = appPage.locator('.sidebar');
    if (!(await sidebar.isVisible().catch(() => false))) {
      await appPage.keyboard.press('Control+b');
      await appPage.waitForTimeout(500);
    }

    const pageCount = await getPageCount(appPage);
    if (pageCount < 2) {
      // Single-page PDF — just verify first thumbnail is clickable
      const thumbnail = sidebar.locator('canvas, .thumbnail, img').first();
      await expect(thumbnail).toBeVisible();
      return;
    }

    // Click second page thumbnail
    const secondThumb = sidebar.locator('canvas, .thumbnail, img').nth(1);
    await expect(secondThumb).toBeVisible({ timeout: 5000 });
    await secondThumb.click();
    await appPage.waitForTimeout(500);

    // Verify page indicator changed
    const pageIndicator = appPage.locator('.status-page-indicator');
    const indicatorText = await pageIndicator.textContent();
    expect(indicatorText).toContain('2');
  });

  test('Ctrl+0 fits width', async ({ appPage }) => {
    // Zoom in first so we can see the change
    await appPage.keyboard.press('Control+=');
    await appPage.keyboard.press('Control+=');
    await appPage.waitForTimeout(500);

    const canvas = appPage.locator('canvas').first();
    const zoomedSize = await canvas.boundingBox();
    expect(zoomedSize).not.toBeNull();

    await appPage.keyboard.press('Control+0');
    await appPage.waitForTimeout(500);

    const fittedSize = await canvas.boundingBox();
    expect(fittedSize).not.toBeNull();

    // After fit-width, the canvas width should be different from heavily zoomed-in size
    expect(fittedSize!.width).not.toEqual(zoomedSize!.width);
  });

  test('keyboard shortcut ? opens shortcuts dialog', async ({ appPage }) => {
    await appPage.keyboard.press('?');
    await appPage.waitForTimeout(500);

    const dialog = appPage.locator('.shortcuts-dialog, .keyboard-shortcuts, [role="dialog"]');
    await expect(dialog).toBeVisible({ timeout: 5000 });

    const dialogText = await dialog.textContent();
    expect(dialogText?.toLowerCase()).toContain('shortcut');
  });
});
