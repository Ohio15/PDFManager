import { test, expect } from '../fixtures/electron-app';
import { openPDFViaIPC, drawRect } from '../fixtures/helpers';
import { Page, ElectronApplication } from '@playwright/test';
import { PDFDocument, PDFName, PDFRawStream, PDFNumber } from 'pdf-lib';
import path from 'path';
import fs from 'fs';

const TEST_PDFS_DIR = path.resolve(__dirname, '../../test-pdfs');

/**
 * Capture the bytes the app writes on Ctrl+S at the main-process IPC boundary.
 * (window.electronAPI is a frozen contextBridge object, so renderer-side
 * overrides are silently ignored.) The fixture file on disk is never touched.
 */
async function saveAndCapture(electronApp: ElectronApplication, page: Page): Promise<Uint8Array> {
  await electronApp.evaluate(({ ipcMain }) => {
    (globalThis as any).__savedPdf = null;
    const capture = async (_event: unknown, payload: { data: string }) => {
      (globalThis as any).__savedPdf = payload.data;
      return { success: true, path: '/fake/saved.pdf' };
    };
    for (const channel of ['save-file', 'save-file-dialog']) {
      ipcMain.removeHandler(channel);
      ipcMain.handle(channel, capture);
    }
  });
  await page.locator('.pdf-viewer').click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+s');
  let b64: string | null = null;
  for (let i = 0; i < 120 && !b64; i++) {
    b64 = await electronApp.evaluate(() => (globalThis as any).__savedPdf as string | null);
    if (!b64) await page.waitForTimeout(250);
  }
  if (!b64) throw new Error('save produced no PDF data within 30s');
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function pageText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), verbosity: 0 }).promise;
  const parts: string[] = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const content = await (await doc.getPage(i)).getTextContent();
    parts.push(content.items.map((it: any) => it.str).join(' '));
  }
  await doc.destroy();
  return parts.join('\n');
}

function collectPageErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  return errors;
}

async function openTool(page: Page, label: string): Promise<void> {
  const btn = page.locator(`.tools-panel .tool-btn:has-text("${label}")`);
  if (!(await btn.isVisible())) await page.keyboard.press('Control+t');
  await btn.click();
}

test.describe('Forms + Finalize', () => {
  test('form tool: create, edit, fill in pdf.js, undo, and save a real AcroForm field', async ({ electronApp, appPage }) => {
    const errors = collectPageErrors(appPage);
    await openPDFViaIPC(electronApp, appPage, 'invoice.pdf');
    await appPage.click('.toolbar-btn[aria-label="Form Fields"]');
    await expect(appPage.locator('[data-testid="form-designer-panel"]')).toBeVisible();

    // Text field (default kind): drag a rectangle on page 1.
    await drawRect(appPage, 0, 0.15, 0.10, 0.55, 0.14);
    const textBox = appPage.locator('.form-design-box[data-field-name="Text1"]');
    await expect(textBox).toBeVisible({ timeout: 15_000 });

    // Rename + required through the property panel.
    const props = appPage.locator('[data-testid="form-field-properties"]');
    await props.locator('#ffd-name').fill('Customer');
    await props.locator('label:has-text("Required") input').check();
    await props.locator('button:has-text("Apply")').click();
    await expect(appPage.locator('.form-design-box[data-field-name="Customer"]')).toBeVisible({ timeout: 15_000 });

    // Name validation: a duplicate is rejected before Apply.
    await appPage.click('.form-kind-btn[data-kind="checkbox"]');
    await drawRect(appPage, 0, 0.15, 0.18, 0.18, 0.2);
    await expect(appPage.locator('.form-design-box[data-field-name="Checkbox1"]')).toBeVisible({ timeout: 15_000 });
    await props.locator('#ffd-name').fill('Customer');
    await expect(props.locator('.form-field-error')).toContainText('already exists');
    await expect(props.locator('button:has-text("Apply")')).toBeDisabled();

    // Undo removes the checkbox; the text field remains.
    await appPage.locator('#ffd-name').blur();
    await appPage.mouse.click(5, 5);
    await appPage.keyboard.press('Control+z');
    await expect(appPage.locator('.form-design-box[data-field-name="Checkbox1"]')).toHaveCount(0, { timeout: 15_000 });
    await expect(appPage.locator('.form-design-box[data-field-name="Customer"]')).toBeVisible();

    // Leave form mode: the field is immediately fillable in the pdf.js form layer.
    await appPage.click('.toolbar-btn[aria-label="Select"]');
    const input = appPage.locator('.pdfjs-annotation-layer input[type="text"], .pdfjs-annotation-layer textarea').first();
    await expect(input).toBeVisible({ timeout: 15_000 });
    await input.click();
    await input.fill('Filled In App');
    await input.press('Tab');

    const saved = await saveAndCapture(electronApp, appPage);
    const doc = await PDFDocument.load(saved);
    const field = doc.getForm().getTextField('Customer');
    expect(field.getText()).toBe('Filled In App');
    expect(field.isRequired()).toBe(true);
    expect(doc.getForm().getFieldMaybe('Checkbox1')).toBeUndefined();
    expect(errors).toEqual([]);
  });

  test('flatten: typed values become page text, widgets are removed, and it is undoable', async ({ electronApp, appPage }) => {
    const errors = collectPageErrors(appPage);
    await openPDFViaIPC(electronApp, appPage, 'repair-calibration-form.pdf');
    const firstInput = appPage.locator('.pdfjs-annotation-layer input[type="text"]').first();
    await expect(firstInput).toBeVisible({ timeout: 15_000 });
    await firstInput.click();
    await firstInput.fill('Quincy Flattened');
    await firstInput.press('Tab');

    await openTool(appPage, 'Flatten');
    const dialog = appPage.locator('[data-testid="flatten-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('.finalize-stats')).toContainText('47 form widgets');
    await dialog.locator('input[value="both"]').check();
    await dialog.locator('[data-testid="flatten-confirm"]').click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });
    await expect(appPage.locator('.pdfjs-annotation-layer input')).toHaveCount(0, { timeout: 15_000 });

    const saved = await saveAndCapture(electronApp, appPage);
    const doc = await PDFDocument.load(saved);
    expect(doc.catalog.has(PDFName.of('AcroForm'))).toBe(false);
    expect(await pageText(saved)).toContain('Quincy Flattened');

    // Undo restores the fields, with the typed value baked in.
    await appPage.keyboard.press('Control+z');
    await expect(appPage.locator('.pdfjs-annotation-layer input[type="text"]').first()).toBeVisible({ timeout: 15_000 });
    await expect(appPage.locator('.pdfjs-annotation-layer input[type="text"]').first()).toHaveValue('Quincy Flattened');
    expect(errors).toEqual([]);
  });

  test('compress: canvas downsampling shrinks scan-document.pdf, keeps 9 pages, applies on confirm and undoes', async ({ electronApp, appPage }) => {
    const errors = collectPageErrors(appPage);
    const original = fs.readFileSync(path.join(TEST_PDFS_DIR, 'scan-document.pdf'));
    await openPDFViaIPC(electronApp, appPage, 'scan-document.pdf');

    await openTool(appPage, 'Compress');
    const dialog = appPage.locator('[data-testid="compress-dialog"]');
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid="compress-apply"]')).toBeDisabled();
    await dialog.locator('[data-testid="compress-lossy"]').check();
    await dialog.locator('#compress-dpi').selectOption('150');
    await dialog.locator('[data-testid="compress-analyze"]').click();
    await expect(dialog.locator('[data-testid="compress-result"]')).toBeVisible({ timeout: 120_000 });
    await expect(dialog.locator('[data-testid="compress-result"]')).toContainText('9 of 9 images downsampled');
    await dialog.locator('[data-testid="compress-apply"]').click();
    await expect(dialog).toBeHidden({ timeout: 30_000 });

    const saved = await saveAndCapture(electronApp, appPage);
    expect(saved.length).toBeLessThan(original.length / 2);
    const doc = await PDFDocument.load(saved);
    expect(doc.getPageCount()).toBe(9);
    let images = 0;
    for (const [, obj] of doc.context.enumerateIndirectObjects()) {
      if (obj instanceof PDFRawStream && obj.dict.lookup(PDFName.of('Subtype'))?.toString() === '/Image') {
        images++;
        const width = (obj.dict.lookup(PDFName.of('Width')) as PDFNumber).asNumber();
        expect(width).toBeGreaterThan(1200);
        expect(width).toBeLessThan(1350);
        expect(obj.dict.lookup(PDFName.of('Filter'))?.toString()).toBe('/DCTDecode');
      }
    }
    expect(images).toBe(9);
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const reopened = await pdfjs.getDocument({ data: new Uint8Array(saved), verbosity: 0 }).promise;
    expect(reopened.numPages).toBe(9);
    for (let i = 1; i <= 9; i++) await (await reopened.getPage(i)).getOperatorList();
    await reopened.destroy();

    // Undo returns the original image data.
    await appPage.keyboard.press('Control+z');
    const undone = await saveAndCapture(electronApp, appPage);
    expect(undone.length).toBeGreaterThan(original.length * 0.9);
    expect(errors).toEqual([]);
  });

  test('rotate all pages then undo every step without corrupting history', async ({ electronApp, appPage }) => {
    const errors = collectPageErrors(appPage);
    await openPDFViaIPC(electronApp, appPage, 'vaccine-card.pdf');
    await openTool(appPage, 'Rotate All Pages');
    await appPage.waitForTimeout(1500);
    let saved = await saveAndCapture(electronApp, appPage);
    expect((await PDFDocument.load(saved)).getPages().map((p) => p.getRotation().angle)).toEqual([90, 90]);
    // One undo per rotated page; each press lands after the previous render.
    await appPage.keyboard.press('Control+z');
    await appPage.waitForTimeout(400);
    await appPage.keyboard.press('Control+z');
    await appPage.waitForTimeout(400);
    // History bottomed out: a further undo must be a no-op, not a crash.
    await appPage.keyboard.press('Control+z');
    await appPage.waitForTimeout(400);
    saved = await saveAndCapture(electronApp, appPage);
    expect((await PDFDocument.load(saved)).getPages().map((p) => p.getRotation().angle)).toEqual([0, 0]);
    expect(errors).toEqual([]);
  });
});
