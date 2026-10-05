import { test as base, _electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

type Fixtures = {
  userDataDir: string;
  electronApp: ElectronApplication;
  appPage: Page;
};

export const test = base.extend<Fixtures>({
  // Every test gets its own throwaway userData directory. Without this, runs
  // share the developer's real `pdf-manager` profile: its recent files/last
  // dirs leak blessed directories into the test, and — because the single-
  // instance lock lives in userData — a concurrent run from another worktree
  // (or a lingering instance) makes the launched app quit immediately.
  userDataDir: async ({}, use) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfm-e2e-'));
    // Pre-seed electron-store so the first-run onboarding tour does not
    // overlay the UI under test.
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ hasSeenOnboarding: true }));
    await use(dir);
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  },

  electronApp: async ({ userDataDir }, use) => {
    const app = await _electron.launch({
      args: [path.resolve(__dirname, '../../dist/main/main.js'), `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    });
    await use(app);
    await app.close();
  },

  appPage: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.welcome-screen, .pdf-viewer', { timeout: 15_000 });
    await use(page);
  },
});

export { expect } from '@playwright/test';
