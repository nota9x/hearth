import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/browser',
  testMatch: '**/*.spec.ts',
  globalSetup: 'tests/helpers/build-browser.ts',
  workers: 1,
  forbidOnly: !!process.env.CI,
  failOnFlakyTests: !!process.env.CI,
  globalTimeout: process.env.CI ? 10 * 60 * 1000 : undefined,
  use: {
    viewport: { width: 1440, height: 1000 },
    headless: true,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  reporter: process.env.CI
    ? [['github'], ['list'], ['html', { open: 'never' }]]
    : 'list',
});
