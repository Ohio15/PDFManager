import { Page, ElectronApplication } from '@playwright/test';
import path from 'path';
import fs from 'fs';

const TEST_PDFS_DIR = path.resolve(__dirname, '../../test-pdfs');

/**
 * Open a PDF by sending file-opened IPC event via Electron main process.
 * Bypasses native file dialog which cannot be automated.
 */
export async function openPDFViaIPC(
  electronApp: ElectronApplication,
  page: Page,
  pdfName: string
): Promise<void> {
  const pdfPath = path.join(TEST_PDFS_DIR, pdfName);
  const data = fs.readFileSync(pdfPath).toString('base64');

  await electronApp.evaluate(
    ({ BrowserWindow }, { filePath, fileData }) => {
      const win = BrowserWindow.getAllWindows()[0];
      if (win) {
        win.webContents.send('file-opened', { path: filePath, data: fileData });
      }
    },
    { filePath: pdfPath, fileData: data }
  );

  // Wait for PDF to render
  await page.waitForSelector('canvas', { timeout: 20_000 });
  // Give rendering a moment to complete
  await page.waitForTimeout(500);
}

/** Select a tool by clicking its toolbar button. */
export async function selectTool(page: Page, toolLabel: string): Promise<void> {
  await page.click(`.toolbar-btn[aria-label="${toolLabel}"]`);
}

/** Select a tool via keyboard shortcut. */
export async function selectToolByKey(page: Page, key: string): Promise<void> {
  await page.keyboard.press(key);
}

/** Wait for the app to be fully loaded. */
export async function waitForAppReady(page: Page): Promise<void> {
  await page.waitForLoadState('domcontentloaded');
  await page.waitForSelector('.welcome-screen, .pdf-viewer, canvas', { timeout: 15_000 });
}

/** Get page count from status bar. */
export async function getPageCount(page: Page): Promise<number> {
  const text = await page.textContent('.status-bar');
  const match = text?.match(/of\s+(\d+)/);
  return match ? parseInt(match[1], 10) : 0;
}

/** Click on a PDF page at relative coordinates (0-1 range). */
export async function clickOnPage(
  page: Page,
  pageIndex: number,
  relX: number,
  relY: number
): Promise<void> {
  const containers = page.locator('.pdf-page-container');
  const container = containers.nth(pageIndex);
  const box = await container.boundingBox();
  if (!box) throw new Error(`Page container ${pageIndex} not visible`);
  await page.mouse.click(box.x + box.width * relX, box.y + box.height * relY);
}

/** Draw a freehand stroke on a page. */
export async function drawStroke(
  page: Page,
  pageIndex: number,
  points: Array<{ rx: number; ry: number }>
): Promise<void> {
  const containers = page.locator('.pdf-page-container');
  const container = containers.nth(pageIndex);
  const box = await container.boundingBox();
  if (!box) throw new Error(`Page container ${pageIndex} not visible`);

  const abs = points.map(p => ({
    x: box.x + box.width * p.rx,
    y: box.y + box.height * p.ry,
  }));

  await page.mouse.move(abs[0].x, abs[0].y);
  await page.mouse.down();
  for (const pt of abs.slice(1)) {
    await page.mouse.move(pt.x, pt.y, { steps: 3 });
  }
  await page.mouse.up();
}

/** Draw a rectangle region (for highlights, shapes). */
export async function drawRect(
  page: Page,
  pageIndex: number,
  startRx: number,
  startRy: number,
  endRx: number,
  endRy: number
): Promise<void> {
  const containers = page.locator('.pdf-page-container');
  const container = containers.nth(pageIndex);
  const box = await container.boundingBox();
  if (!box) throw new Error(`Page container ${pageIndex} not visible`);

  await page.mouse.move(box.x + box.width * startRx, box.y + box.height * startRy);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width * endRx, box.y + box.height * endRy, { steps: 5 });
  await page.mouse.up();
}

/** Override an electronAPI method in the renderer to return controlled data. */
export async function mockElectronAPI(
  page: Page,
  method: string,
  returnValue: unknown
): Promise<void> {
  await page.evaluate(
    ({ method, value }) => {
      (window as any).electronAPI[method] = () => Promise.resolve(value);
    },
    { method, value: returnValue }
  );
}

/** Count annotation elements on the current view. */
export async function getAnnotationCount(page: Page): Promise<number> {
  return page.locator('.annotation-layer > *').count();
}

/** Check if a toolbar button is active. */
export async function isToolActive(page: Page, toolLabel: string): Promise<boolean> {
  const btn = page.locator(`.toolbar-btn[aria-label="${toolLabel}"]`);
  const className = await btn.getAttribute('class');
  return className?.includes('active') ?? false;
}
