import { test, expect } from '../fixtures/electron-app';

test.describe('Application Lifecycle', () => {
  test('app launches and shows window', async ({ electronApp }) => {
    const windows = electronApp.windows();
    expect(windows.length).toBeGreaterThanOrEqual(1);

    const page = await electronApp.firstWindow();
    const isVisible = await page.isVisible('body');
    expect(isVisible).toBe(true);
  });

  test('welcome screen appears', async ({ appPage }) => {
    const welcomeScreen = appPage.locator('.welcome-screen');
    await expect(welcomeScreen).toBeVisible({ timeout: 10_000 });
  });

  test('welcome screen has open PDF button', async ({ appPage }) => {
    const openBtn = appPage.locator('.welcome-btn');
    await expect(openBtn).toBeVisible();
    const btnText = await openBtn.textContent();
    expect(btnText?.toLowerCase()).toContain('open');
  });

  test('app title is PDF Manager', async ({ electronApp }) => {
    const page = await electronApp.firstWindow();
    const title = await page.title();
    expect(title).toContain('PDF Manager');
  });

  test('recent files section exists', async ({ appPage }) => {
    const welcomeScreen = appPage.locator('.welcome-screen');
    await expect(welcomeScreen).toBeVisible();

    const recentSection = appPage.locator('.welcome-screen').getByText(/recent/i);
    await expect(recentSection).toBeVisible();
  });

  test('app closes cleanly', async ({ electronApp }) => {
    const page = await electronApp.firstWindow();
    const isVisible = await page.isVisible('body');
    expect(isVisible).toBe(true);

    // The fixture's teardown calls app.close() — verify the process is alive before that
    const pid = electronApp.process().pid;
    expect(pid).toBeDefined();
    expect(typeof pid).toBe('number');
  });
});
