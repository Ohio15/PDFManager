import { test as base, _electron, ElectronApplication, Page } from '@playwright/test';
import path from 'path';

type Fixtures = {
  electronApp: ElectronApplication;
  appPage: Page;
};

export const test = base.extend<Fixtures>({
  electronApp: async ({}, use) => {
    const app = await _electron.launch({
      args: [path.resolve(__dirname, '../../dist/main/main.js')],
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
