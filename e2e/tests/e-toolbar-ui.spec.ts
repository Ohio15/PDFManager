import { test, expect } from '../fixtures/electron-app';
import { openPDFViaIPC, selectTool, isToolActive } from '../fixtures/helpers';

test.describe('Toolbar UI', () => {
  test.beforeEach(async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
  });

  test('all tool buttons are visible', async ({ appPage }) => {
    const toolbar = appPage.locator('.toolbar');
    await expect(toolbar).toBeVisible();

    const toolLabels = ['Select', 'Text', 'Highlight', 'Draw', 'Shape', 'Stamp', 'Signature'];
    for (const label of toolLabels) {
      const btn = appPage.locator(`.toolbar-btn[aria-label="${label}"]`);
      await expect(btn).toBeVisible({ timeout: 5_000 });
    }
  });

  test('annotation toolbar appears for text tool', async ({ appPage }) => {
    await selectTool(appPage, 'Text');
    const annotationToolbar = appPage.locator('.annotation-toolbar');
    await expect(annotationToolbar).toBeVisible({ timeout: 5_000 });
  });

  test('annotation toolbar appears for highlight tool', async ({ appPage }) => {
    await selectTool(appPage, 'Highlight');
    const annotationToolbar = appPage.locator('.annotation-toolbar');
    await expect(annotationToolbar).toBeVisible({ timeout: 5_000 });
  });

  test('annotation toolbar appears for draw tool', async ({ appPage }) => {
    await selectTool(appPage, 'Draw');
    const annotationToolbar = appPage.locator('.annotation-toolbar');
    await expect(annotationToolbar).toBeVisible({ timeout: 5_000 });
  });

  test('annotation toolbar appears for shape tool', async ({ appPage }) => {
    await selectTool(appPage, 'Shape');
    const annotationToolbar = appPage.locator('.annotation-toolbar');
    await expect(annotationToolbar).toBeVisible({ timeout: 5_000 });
  });

  test('annotation toolbar appears for stamp tool', async ({ appPage }) => {
    await selectTool(appPage, 'Stamp');
    const annotationToolbar = appPage.locator('.annotation-toolbar');
    await expect(annotationToolbar).toBeVisible({ timeout: 5_000 });
  });

  test('annotation toolbar appears for signature tool', async ({ appPage }) => {
    await selectTool(appPage, 'Signature');
    const annotationToolbar = appPage.locator('.annotation-toolbar');
    await expect(annotationToolbar).toBeVisible({ timeout: 5_000 });
  });

  test('annotation toolbar has no controls for select tool', async ({ appPage }) => {
    // First activate a tool that shows annotation toolbar controls
    await selectTool(appPage, 'Text');
    const toolbar = appPage.locator('.annotation-toolbar');
    await expect(toolbar).toBeVisible({ timeout: 5_000 });
    // Verify it has content sections when a tool is active
    const sectionsWithText = toolbar.locator('.annotation-toolbar-section');
    expect(await sectionsWithText.count()).toBeGreaterThan(0);

    // Switch back to Select — annotation toolbar should have no tool-specific sections
    await selectTool(appPage, 'Select');
    await appPage.waitForTimeout(300);
    const sectionsAfter = toolbar.locator('.annotation-toolbar-section');
    expect(await sectionsAfter.count()).toBe(0);
  });

  test('zoom controls present', async ({ appPage }) => {
    const zoomIn = appPage.locator('.toolbar-btn[aria-label="Zoom In"]');
    const zoomOut = appPage.locator('.toolbar-btn[aria-label="Zoom Out"]');
    await expect(zoomIn).toBeVisible();
    await expect(zoomOut).toBeVisible();
  });

  test('undo/redo buttons present and initially disabled', async ({ appPage }) => {
    const undoBtn = appPage.locator('.toolbar-btn[aria-label="Undo"]');
    const redoBtn = appPage.locator('.toolbar-btn[aria-label="Redo"]');

    await expect(undoBtn).toBeVisible();
    await expect(redoBtn).toBeVisible();

    // Both should be disabled when no actions have been performed
    await expect(undoBtn).toBeDisabled();
    await expect(redoBtn).toBeDisabled();
  });
});
