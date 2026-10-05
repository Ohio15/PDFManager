import { test, expect } from '../fixtures/electron-app';
import { openPDFViaIPC, selectTool, drawRect } from '../fixtures/helpers';
import type { Page } from '@playwright/test';
import { PDFArray, PDFDict, PDFDocument as PDFLib, PDFName, PDFNumber, PDFRawStream, PDFStream, decodePDFRawStream } from 'pdf-lib';

/** Intercept saving and return the bytes the app writes. */
async function saveAndCapture(page: Page): Promise<Uint8Array> {
  await page.evaluate(() => {
    const api = (window as any).electronAPI;
    (window as any).__saved = null;
    const interceptor = (data: string) => {
      (window as any).__saved = data;
      return Promise.resolve({ success: true, path: '/fake/saved.pdf' });
    };
    api.saveFile = interceptor;
    api.saveFileDialog = interceptor;
  });
  await page.keyboard.press('Control+s');
  await page.waitForFunction(() => (window as any).__saved !== null, undefined, { timeout: 30_000 });
  const b64: string = await page.evaluate(() => (window as any).__saved);
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

    const bytes = await saveAndCapture(appPage);
    const lib = await PDFLib.load(bytes);
    const annots = lib.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
    const strike = annots.asArray().map((r) => lib.context.lookup(r) as PDFDict).find((d) => (d.get(PDFName.of('Subtype')) as PDFName).decodeText() === 'StrikeOut');
    expect(strike).toBeTruthy();
    const qp = (strike!.get(PDFName.of('QuadPoints')) as PDFArray).asArray().map((n) => (n as PDFNumber).asNumber());
    expect(qp.length % 8).toBe(0);
    // The quad sits on the "Board of Trustees" line (pdf.js: baseline y ≈ 726 on page 1).
    const ys = qp.filter((_, i) => i % 2 === 1);
    expect(Math.min(...ys)).toBeLessThan(735);
    expect(Math.max(...ys)).toBeGreaterThan(715);
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

    const bytes = await saveAndCapture(appPage);
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

    const bytes = await saveAndCapture(appPage);
    const text = squash(await extractText(bytes));
    expect(text).not.toContain('softball');
    expect(text).toContain(squash('Valley Youth League'));
    for (const s of await rawStreams(bytes)) expect(s.toLowerCase()).not.toContain('softball');
  });
});
