import { test, expect } from '../fixtures/electron-app';
import { openPDFViaIPC, selectTool, drawRect } from '../fixtures/helpers';
import type { ElectronApplication, Page } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument as PDFLib, PDFName, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib';

/**
 * Capture the bytes the app saves. window.electronAPI is frozen by
 * contextBridge, so interception happens in the MAIN process: the save IPC
 * handlers are swapped for ones that record the payload and touch no file.
 */
async function saveAndCapture(app: ElectronApplication, page: Page): Promise<Uint8Array> {
  await app.evaluate(({ ipcMain }) => {
    (globalThis as any).__savedPdf = null;
    const capture = async (_e: unknown, args: { data: string }) => {
      (globalThis as any).__savedPdf = args.data;
      return { success: true, path: 'C:/fake/saved.pdf' };
    };
    ipcMain.removeHandler('save-file');
    ipcMain.removeHandler('save-file-dialog');
    ipcMain.handle('save-file', capture);
    ipcMain.handle('save-file-dialog', capture);
  });
  await page.keyboard.press('Control+s');
  await expect
    .poll(async () => app.evaluate(() => (globalThis as any).__savedPdf !== null), { timeout: 60_000 })
    .toBe(true);
  const b64: string = await app.evaluate(() => (globalThis as any).__savedPdf);
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

async function extractText(bytes: Uint8Array): Promise<string> {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
  let text = '';
  for (let i = 1; i <= doc.numPages; i++) {
    const tc = await (await doc.getPage(i)).getTextContent();
    text += tc.items.map((it: any) => it.str ?? '').join(' ') + '\n';
  }
  await doc.destroy();
  return text;
}

async function rawStreams(bytes: Uint8Array): Promise<string[]> {
  const lib = await PDFLib.load(bytes, { updateMetadata: false });
  const out: string[] = [];
  for (const [, obj] of lib.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFStream)) continue;
    try {
      out.push(Buffer.from(obj instanceof PDFRawStream ? decodePDFRawStream(obj).decode() : obj.getContents()).toString('latin1'));
    } catch {
      /* image codecs */
    }
  }
  return out;
}

const squash = (s: string) => s.replace(/\s+/g, '').toLowerCase();

test.describe('Text markup and true redaction', () => {
  test('strikeout from a real text selection is saved as a /StrikeOut annotation with QuadPoints', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    await selectTool(appPage, 'Text Markup');
    await appPage.click('[aria-label="Strikeout"]');

    // The pdf.js text layer is mounted while the selection tool is active.
    const span = appPage.locator('[data-testid="markup-layer-1"] .markup-text-layer span', { hasText: 'Board of Trustees' }).first();
    await expect(span).toBeVisible({ timeout: 15_000 });
    const box = (await span.boundingBox())!;
    await appPage.mouse.move(box.x + 1, box.y + box.height / 2);
    await appPage.mouse.down();
    await appPage.mouse.move(box.x + box.width - 1, box.y + box.height / 2, { steps: 8 });
    await appPage.mouse.up();

    await expect(appPage.locator('[data-testid="text-markup"][data-markup-type="strikeout"]')).toHaveCount(1);

    const bytes = await saveAndCapture(electronApp, appPage);
    const lib = await PDFLib.load(bytes);
    const annots = lib.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const strike = annots.asArray().map((r) => lib.context.lookup(r) as PDFDict).find((d) => (d.get(PDFName.of('Subtype')) as PDFName).decodeText() === 'StrikeOut');
    expect(strike).toBeTruthy();
    const qp = (strike!.get(PDFName.of('QuadPoints')) as PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    expect(qp.length % 8).toBe(0);
    // The quads must cover the selected text as an independent reader places it.
    const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
    const doc = await pdfjs.getDocument({ data: new Uint8Array(bytes), isEvalSupported: false }).promise;
    const items = (await (await doc.getPage(1)).getTextContent()).items as Array<{ str: string; transform: number[]; width: number; height: number }>;
    await doc.destroy();
    const item = items.find((i) => i.str.includes('Board of Trustees'))!;
    expect(item).toBeTruthy();
    const ys = qp.filter((_, i) => i % 2 === 1);
    const xs = qp.filter((_, i) => i % 2 === 0);
    const baseline = item.transform[5];
    expect(Math.min(...ys)).toBeLessThanOrEqual(baseline + 1);
    expect(Math.max(...ys)).toBeGreaterThanOrEqual(baseline + item.height * 0.5);
    expect(Math.min(...xs)).toBeLessThan(item.transform[4] + item.width);
    expect(Math.max(...xs)).toBeGreaterThan(item.transform[4]);
    expect(strike!.lookup(PDFName.of('AP'), PDFDict).lookup(PDFName.of('N'))).toBeInstanceOf(PDFStream);
  });

  test('area redaction removes the text under the mark and keeps the rest', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'test-with-images.pdf');
    await selectTool(appPage, 'Redact');
    await expect(appPage.locator('[data-testid="redaction-toolbar"]')).toBeVisible();

    // "Test Page - Images" is at x 50–190, baseline y 750 on a 612×792 page.
    await drawRect(appPage, 0, 0.06, 0.025, 0.2, 0.07);
    await expect(appPage.locator('[data-testid="redaction-mark"]')).toHaveCount(1);

    await appPage.click('[aria-label="Apply redactions"]');
    await expect(appPage.locator('[data-testid="apply-redactions-dialog"]')).toBeVisible();
    await appPage.click('[data-testid="confirm-apply-redactions"]');
    await expect(appPage.locator('[data-testid="redaction-report"]')).toBeVisible({ timeout: 60_000 });
    await appPage.click('.redaction-dialog-actions >> text=Done');
    await expect(appPage.locator('[data-testid="redaction-mark"]')).toHaveCount(0);

    const bytes = await saveAndCapture(electronApp, appPage);
    const text = squash(await extractText(bytes));
    expect(text).not.toContain('testpage');
    expect(text).toContain('images'); // the part of the line right of the mark survives
    for (const s of await rawStreams(bytes)) expect(s).not.toContain('Test Page');
  });

  test('search-and-redact marks every occurrence and the applied result no longer contains the term', async ({ electronApp, appPage }) => {
    await openPDFViaIPC(electronApp, appPage, 'announcement.pdf');
    await selectTool(appPage, 'Redact');
    await appPage.fill('[aria-label="Text to redact"]', 'Softball');
    await appPage.click('[aria-label="Mark all occurrences"]');
    await expect(appPage.locator('[data-testid="redaction-count"]')).toHaveText(/^[5-9]\d* pending marks$/, { timeout: 30_000 });

    await appPage.click('[aria-label="Apply redactions"]');
    await appPage.click('[data-testid="confirm-apply-redactions"]');
    await expect(appPage.locator('[data-testid="redaction-report"]')).toBeVisible({ timeout: 60_000 });
    await appPage.click('.redaction-dialog-actions >> text=Done');

    const bytes = await saveAndCapture(electronApp, appPage);
    const text = squash(await extractText(bytes));
    expect(text).not.toContain('softball');
    expect(text).toContain(squash('Valley Youth League'));
    for (const s of await rawStreams(bytes)) expect(s.toLowerCase()).not.toContain('softball');
  });
});
