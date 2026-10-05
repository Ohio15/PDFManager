import { test as base, _electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';
import fs from 'fs';
import os from 'os';

type Fixtures = {
  electronApp: ElectronApplication;
  appPage: Page;
};

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    // Each launch gets its own userData dir. The app takes a single-instance
    // lock keyed on userData, so a shared default dir made any concurrently
    // running PDF Manager (another checkout's e2e run, or the installed app)
    // quit the app under test at launch.
    const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pdfm-e2e-'));
    // A fresh profile would start the first-run onboarding tour, whose overlay
    // intercepts every click; seed electron-store's default config like a
    // returning user's profile (the tour has its own coverage in its spec).
    fs.writeFileSync(path.join(userDataDir, 'config.json'), JSON.stringify({ hasSeenOnboarding: true }));
    const app = await _electron.launch({
      args: [path.resolve(__dirname, '../../dist/main/main.js'), `--user-data-dir=${userDataDir}`],
      env: {
        ...process.env,
        NODE_ENV: 'test',
      },
    });
    try {
      await use(app);
    } finally {
      await app.close();
      fs.rmSync(userDataDir, { recursive: true, force: true, maxRetries: 3 });
    }
  },

  appPage: async ({ electronApp }, use) => {
    const page = await electronApp.firstWindow();
    await page.waitForLoadState('domcontentloaded');
    await page.waitForSelector('.welcome-screen, .pdf-viewer', { timeout: 15_000 });
    await use(page);
  },
});

export { expect } from '@playwright/test';
