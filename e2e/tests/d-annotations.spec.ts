import { test, expect } from '../fixtures/electron-app';
import {
  openPDFViaIPC,
  selectTool,
  selectToolByKey,
  clickOnPage,
  drawStroke,
  drawRect,
  getAnnotationCount,
  isToolActive,
} from '../fixtures/helpers';

test.describe('Annotations', () => {
  test.beforeEach(async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
  });

  test('text tool places annotation on click', async ({ appPage }) => {
    const countBefore = await getAnnotationCount(appPage);

    await selectTool(appPage, 'Text');
    await appPage.waitForTimeout(200);
    await clickOnPage(appPage, 0, 0.5, 0.5);
    await appPage.waitForTimeout(500);

    // Type some text into the annotation
    await appPage.keyboard.type('Test annotation');
    await appPage.waitForTimeout(300);

    const countAfter = await getAnnotationCount(appPage);
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  test('highlight tool draws highlight region', async ({ appPage }) => {
    const countBefore = await getAnnotationCount(appPage);

    await selectTool(appPage, 'Highlight');
    await appPage.waitForTimeout(200);
    await drawRect(appPage, 0, 0.2, 0.2, 0.6, 0.25);
    await appPage.waitForTimeout(500);

    const countAfter = await getAnnotationCount(appPage);
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  test('drawing tool creates freehand stroke', async ({ appPage }) => {
    const countBefore = await getAnnotationCount(appPage);

    await selectTool(appPage, 'Draw');
    await appPage.waitForTimeout(200);
    await drawStroke(appPage, 0, [
      { rx: 0.2, ry: 0.4 },
      { rx: 0.3, ry: 0.35 },
      { rx: 0.4, ry: 0.45 },
      { rx: 0.5, ry: 0.4 },
    ]);
    await appPage.waitForTimeout(500);

    const countAfter = await getAnnotationCount(appPage);
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  test('shape tool rectangle', async ({ appPage }) => {
    const countBefore = await getAnnotationCount(appPage);

    await selectTool(appPage, 'Shape');
    await appPage.waitForTimeout(200);
    await drawRect(appPage, 0, 0.3, 0.3, 0.6, 0.5);
    await appPage.waitForTimeout(500);

    const countAfter = await getAnnotationCount(appPage);
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  test('sticky note placement', async ({ appPage }) => {
    const countBefore = await getAnnotationCount(appPage);

    await selectTool(appPage, 'Sticky Note');
    await appPage.waitForTimeout(200);
    await clickOnPage(appPage, 0, 0.5, 0.3);
    await appPage.waitForTimeout(500);

    const countAfter = await getAnnotationCount(appPage);
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  test('stamp tool places stamp', async ({ appPage }) => {
    const countBefore = await getAnnotationCount(appPage);

    await selectTool(appPage, 'Stamp');
    await appPage.waitForTimeout(200);
    await clickOnPage(appPage, 0, 0.5, 0.5);
    await appPage.waitForTimeout(500);

    const countAfter = await getAnnotationCount(appPage);
    expect(countAfter).toBeGreaterThan(countBefore);
  });

  test('signature tool opens pad', async ({ appPage }) => {
    await selectTool(appPage, 'Signature');
    await appPage.waitForTimeout(300);

    // The signature pad only appears after clicking ON THE PDF PAGE
    await clickOnPage(appPage, 0, 0.5, 0.5);
    await appPage.waitForTimeout(500);

    const signaturePad = appPage.locator('.signature-pad-overlay');
    await expect(signaturePad).toBeVisible({ timeout: 5_000 });

    const canvas = appPage.locator('.signature-pad-canvas');
    await expect(canvas).toBeVisible();
  });

  test('eraser removes annotation', async ({ appPage }) => {
    // First create an annotation
    await selectTool(appPage, 'Draw');
    await appPage.waitForTimeout(200);
    await drawStroke(appPage, 0, [
      { rx: 0.3, ry: 0.3 },
      { rx: 0.5, ry: 0.35 },
      { rx: 0.7, ry: 0.3 },
    ]);
    await appPage.waitForTimeout(500);

    const countWithAnnotation = await getAnnotationCount(appPage);
    expect(countWithAnnotation).toBeGreaterThan(0);

    // Switch to eraser — clicking directly on an annotation element deletes it
    // The annotation-layer only has pointer-events in select/erase mode
    await selectTool(appPage, 'Eraser');
    await appPage.waitForTimeout(300);

    // The eraser deletes annotations on mousedown. SVG paths have pointer-events: stroke
    // which makes precise clicking unreliable. Use dispatchEvent on the path element directly.
    const erased = await appPage.evaluate(() => {
      const path = document.querySelector('.annotation-layer svg path') as SVGPathElement;
      if (!path) return false;
      const rect = path.getBoundingClientRect();
      const evt = new MouseEvent('mousedown', {
        bubbles: true, cancelable: true,
        clientX: rect.left + rect.width / 2,
        clientY: rect.top + rect.height / 2,
      });
      path.dispatchEvent(evt);
      return true;
    });
    expect(erased).toBe(true);
    await appPage.waitForTimeout(500);

    const countAfterErase = await getAnnotationCount(appPage);
    expect(countAfterErase).toBeLessThan(countWithAnnotation);
  });

  test('undo removes last annotation (Ctrl+Z)', async ({ appPage }) => {
    // Create an annotation
    await selectTool(appPage, 'Draw');
    await appPage.waitForTimeout(200);
    await drawStroke(appPage, 0, [
      { rx: 0.2, ry: 0.5 },
      { rx: 0.4, ry: 0.55 },
      { rx: 0.6, ry: 0.5 },
    ]);
    await appPage.waitForTimeout(500);

    const countBefore = await getAnnotationCount(appPage);
    expect(countBefore).toBeGreaterThan(0);

    // Undo
    await appPage.keyboard.press('Control+z');
    await appPage.waitForTimeout(500);

    const countAfter = await getAnnotationCount(appPage);
    expect(countAfter).toBeLessThan(countBefore);
  });

  test('redo restores annotation (Ctrl+Y)', async ({ appPage }) => {
    // Create and undo an annotation
    await selectTool(appPage, 'Draw');
    await appPage.waitForTimeout(200);
    await drawStroke(appPage, 0, [
      { rx: 0.2, ry: 0.6 },
      { rx: 0.4, ry: 0.65 },
      { rx: 0.6, ry: 0.6 },
    ]);
    await appPage.waitForTimeout(500);

    const countWithAnnotation = await getAnnotationCount(appPage);
    expect(countWithAnnotation).toBeGreaterThan(0);

    await appPage.keyboard.press('Control+z');
    await appPage.waitForTimeout(500);
    const countAfterUndo = await getAnnotationCount(appPage);
    expect(countAfterUndo).toBeLessThan(countWithAnnotation);

    // Redo
    await appPage.keyboard.press('Control+y');
    await appPage.waitForTimeout(500);

    const countAfterRedo = await getAnnotationCount(appPage);
    expect(countAfterRedo).toBe(countWithAnnotation);
  });

  test('delete key removes selected annotation', async ({ appPage }) => {
    // Create an annotation
    await selectTool(appPage, 'Draw');
    await appPage.waitForTimeout(200);
    await drawStroke(appPage, 0, [
      { rx: 0.3, ry: 0.7 },
      { rx: 0.5, ry: 0.75 },
      { rx: 0.7, ry: 0.7 },
    ]);
    await appPage.waitForTimeout(500);

    const countBefore = await getAnnotationCount(appPage);
    expect(countBefore).toBeGreaterThan(0);

    // Switch to select tool and click the actual annotation element to select it
    await selectToolByKey(appPage, 'v');
    await appPage.waitForTimeout(300);

    // Click annotation to select it via dispatchEvent (SVG paths have pointer-events: stroke)
    await appPage.evaluate(() => {
      const path = document.querySelector('.annotation-layer svg path') as SVGPathElement;
      if (path) {
        const rect = path.getBoundingClientRect();
        path.dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true,
          clientX: rect.left + rect.width / 2,
          clientY: rect.top + rect.height / 2,
        }));
      }
    });
    await appPage.waitForTimeout(300);

    // Delete the selected annotation
    await appPage.keyboard.press('Delete');
    await appPage.waitForTimeout(500);

    const countAfter = await getAnnotationCount(appPage);
    expect(countAfter).toBeLessThan(countBefore);
  });

  test('select tool activates with V key', async ({ appPage }) => {
    // First switch to a different tool
    await selectTool(appPage, 'Draw');
    await appPage.waitForTimeout(200);

    const drawActive = await isToolActive(appPage, 'Draw');
    expect(drawActive).toBe(true);

    // Press V to switch to select
    await selectToolByKey(appPage, 'v');
    await appPage.waitForTimeout(200);

    const selectActive = await isToolActive(appPage, 'Select');
    expect(selectActive).toBe(true);
  });

  test('draw tool activates with D key', async ({ appPage }) => {
    // Ensure select tool is active first
    await selectToolByKey(appPage, 'v');
    await appPage.waitForTimeout(200);

    const selectActive = await isToolActive(appPage, 'Select');
    expect(selectActive).toBe(true);

    // Press D to switch to draw
    await selectToolByKey(appPage, 'd');
    await appPage.waitForTimeout(200);

    const drawActive = await isToolActive(appPage, 'Draw');
    expect(drawActive).toBe(true);
  });

  test('all tool keyboard shortcuts work (V,T,H,D,S,N,G,E)', async ({ appPage }) => {
    const shortcuts: Array<{ key: string; label: string }> = [
      { key: 'v', label: 'Select' },
      { key: 't', label: 'Text' },
      { key: 'h', label: 'Highlight' },
      { key: 'd', label: 'Draw' },
      { key: 's', label: 'Shape' },
      { key: 'n', label: 'Sticky Note' },
      { key: 'g', label: 'Signature' },
      { key: 'e', label: 'Eraser' },
    ];

    for (const { key, label } of shortcuts) {
      await selectToolByKey(appPage, key);
      await appPage.waitForTimeout(200);

      const active = await isToolActive(appPage, label);
      expect(active).toBe(true);
    }
  });

  test('annotation toolbar appears for draw tool', async ({ appPage }) => {
    const annotationToolbar = appPage.locator('.annotation-toolbar');

    // Select draw tool
    await selectTool(appPage, 'Draw');
    await appPage.waitForTimeout(300);

    await expect(annotationToolbar).toBeVisible();
  });
});
