import { readFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { expect, test } from '../helpers/browser';
import { configureDeliveryDomain } from '../helpers/delivery';

test.use({ accountMode: 'new' });

function stepButton(page: Page, name: string) {
  return page
    .getByRole('navigation', { name: 'Setup progress' })
    .getByRole('button', { name, exact: true });
}

async function signIn(page: Page) {
  const key = await readFile(process.env.TEST_KEY_FILE!, 'utf8');
  await page.goto('/login');
  await page.getByLabel('Your API key').fill(key);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  return key;
}
async function start(page: Page) {
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await expect(page.getByLabel('Your display name')).toBeVisible();
}
async function sharexStep(page: Page) {
  await start(page);
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByRole('group', { name: 'Your delivery selection' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByRole('group', { name: 'Default image expiration' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByLabel('Current API key', { exact: true }),
  ).toBeVisible();
}

async function sharexUpload(page: Page, baseURL: string, key: string) {
  return page.request.post(`${baseURL}/api/v1/images`, {
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type':
        'multipart/form-data; boundary=--------------------8df2247211d47b0',
      'User-Agent': 'ShareX/21.0.0',
    },
    data: await readFile('tests/fixtures/sharex/sharex21-multipart.bin'),
  });
}

test('welcomes a new account, saves preferences, reuses its key and completes truthfully', async ({
  page,
  hearth,
  baseURL,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  const key = await signIn(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Welcome to hearth',
  );
  await configureDeliveryDomain(
    page.request,
    baseURL!,
    'onboarding.localhost',
    true,
  );
  await hearth.DB.prepare(
    "UPDATE users SET defaultExpiry='7d',stripImageMetadata=0",
  ).run();
  await page.getByRole('button', { name: 'Get started', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await page.getByLabel('Your display name').fill('A new home');
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await page
    .getByRole('radio', {
      name: 'onboarding.localhost Instance default · Use for your new share links',
    })
    .check();
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByRole('radio', { name: /7 days Automatically expires/ }),
  ).toBeChecked();
  await page
    .getByRole('radio', { name: /1 hour Automatically expires/ })
    .check();
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByLabel('Current API key', { exact: true }),
  ).toBeVisible();
  expect(
    (await page.getByLabel('Current API key', { exact: true }).inputValue()) ===
      key,
  ).toBe(true);
  await page.route('**/api/actions/sxcu', (route) => route.abort());
  await page
    .getByRole('button', { name: 'Download ShareX configuration' })
    .click();
  await expect(page.locator('.sharex-config .error')).toBeVisible();
  await expect(
    page.getByText('Configuration download started.', { exact: false }),
  ).toHaveCount(0);
  await page.unroute('**/api/actions/sxcu');
  for (let attempt = 0; attempt < 2; attempt++) {
    const download = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Download ShareX configuration' })
      .click();
    const file = await download;
    const config = JSON.parse(await readFile(await file.path(), 'utf8')) as {
      Headers: { Authorization: string };
      RequestURL: string;
    };
    expect(config.Headers.Authorization === `Bearer ${key}`).toBe(true);
    expect(config.RequestURL).toBe(`${baseURL}/api/v1/images`);
  }
  const credentials = await hearth.DB.prepare(
    'SELECT count(*) AS count FROM api_keys',
  ).all();
  expect(credentials.results[0]).toEqual({ count: 1 });
  const preferences = await hearth.DB.prepare(
    'SELECT defaultExpiry,stripImageMetadata FROM users',
  ).all();
  expect(preferences.results[0]).toEqual({
    defaultExpiry: '1h',
    stripImageMetadata: 0,
  });
  await page
    .getByRole('button', { name: 'Check an image', exact: true })
    .click();
  await expect(page.getByText('Waiting for your first image…')).toBeVisible();
  const upload = await sharexUpload(page, baseURL!, key);
  expect(upload.status()).toBe(201);
  await expect(page.getByText('Your first image is ready.')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByAltText('Your uploaded screenshot')).toBeVisible();
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Go to dashboard' }),
  ).toBeVisible();
  await expect(page.locator('dd')).toContainText([
    'A new home',
    'onboarding.localhost',
    '1 hour',
    'Configuration download started',
    'Upload received',
  ]);
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Go to dashboard' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Go to dashboard' }).click();
  await expect(page).toHaveURL(baseURL! + '/');
  await page.goto('/settings');
  await page
    .getByRole('button', { name: 'Download ShareX configuration' })
    .click();
  await expect(page.getByLabel('Current API key', { exact: true })).toBeEmpty();
  await page.keyboard.press('Escape');
});

test('cancels a delayed configuration download when the retained key expires', async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page);
  await sharexStep(page);
  const { promise: whenRequested, resolve: requested } =
    Promise.withResolvers<void>();
  const { promise: whenServed, resolve: served } =
    Promise.withResolvers<void>();
  const { promise: responseReady, resolve: release } =
    Promise.withResolvers<void>();
  const downloads: string[] = [];
  page.on('download', (file) => {
    downloads.push(file.suggestedFilename());
  });
  await page.route('**/api/actions/sxcu', async (route) => {
    requested();
    await responseReady;
    try {
      await route.fulfill({ json: { Name: 'Delayed configuration' } });
    } catch {
      // Expiry can cancel the intercepted request before its response is ready.
    }
    served();
  });
  await page
    .getByRole('button', { name: 'Download ShareX configuration' })
    .click();
  await whenRequested;
  const cancelled = page.waitForEvent('requestfailed', (request) =>
    request.url().endsWith('/api/actions/sxcu'),
  );
  await page.clock.fastForward(15 * 60_000);
  await cancelled;
  await expect(page.getByLabel('Current API key', { exact: true })).toBeEmpty();
  await expect(page.locator('.sharex-config .error')).toHaveText(
    'Enter your current API key to try again.',
  );
  release();
  await whenServed;
  expect(downloads).toEqual([]);
});

test('resumes after refresh with manual key fallback, preserved drafts when going back and optional setup', async ({
  page,
  hearth,
}) => {
  await signIn(page);
  await start(page);
  await page.getByLabel('Your display name').fill('A draft name');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await start(page);
  await expect(page.getByLabel('Your display name')).toHaveValue(
    'A draft name',
  );
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByText('No delivery domains available yet'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByLabel('Current API key', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Current API key', { exact: true })).toBeEmpty();
  await page
    .getByRole('button', { name: 'Check an image', exact: true })
    .click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByText('Setup still needed', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Available in Settings', { exact: true }),
  ).toBeVisible();
  const saved = await hearth.DB.prepare(
    'SELECT displayName,onboardingStatus FROM users',
  ).all();
  expect(saved.results[0]).toEqual({
    displayName: 'Browser administrator',
    onboardingStatus: 'completed',
  });
});

test('handles failed persistence and expired sessions without losing saved progress', async ({
  page,
  hearth,
}) => {
  await signIn(page);
  await start(page);
  await page.getByLabel('Your display name').fill('Try again');
  await page.route('**/api/actions/preferences', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Please retry this save.' } }),
    }),
  );
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(page.locator('.save-error')).toHaveText(
    'Please retry this save.',
  );
  await expect(page.getByLabel('Your display name')).toHaveValue('Try again');
  await page.unroute('**/api/actions/preferences');
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByRole('group', { name: 'Your delivery selection' }),
  ).toBeVisible();
  await hearth.DB.prepare('DELETE FROM sessions').run();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  const saved = await hearth.DB.prepare(
    'SELECT onboardingStep,displayName FROM users',
  ).all();
  expect(saved.results[0]).toEqual({
    onboardingStep: 3,
    displayName: 'Try again',
  });
});

test.describe('bootstrap administrator', () => {
  test.use({ accountMode: 'bootstrap' });

  test('uses the actual bootstrap path and validates a first delivery domain', async ({
    page,
    hearth,
  }) => {
    await signIn(page);
    await page
      .getByRole('button', { name: 'Get started', exact: true })
      .click();
    await expect(page.getByLabel('Delivery hostname')).toBeVisible();
    await page.getByLabel('Delivery hostname').fill('first.localhost');
    await stepButton(page, 'Your name').click();
    await stepButton(page, 'Delivery setup').click();
    await expect(page.getByLabel('Delivery hostname')).toHaveValue(
      'first.localhost',
    );
    await page.getByRole('button', { name: 'Add delivery domain' }).click();
    await expect(
      page.getByRole('button', { name: 'Validate domain', exact: true }),
    ).toBeEnabled();
    await page
      .getByRole('button', { name: 'Validate domain', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Set as instance default', exact: true })
      .click();
    await expect(
      page.getByText('Your delivery domain is ready for new share links.'),
    ).toBeVisible();
    await stepButton(page, 'Image lifetime').click();
    await stepButton(page, 'Delivery setup').click();
    await expect(
      page.getByText('Your delivery domain is ready for new share links.'),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Continue setup', exact: true })
      .click();
    await expect(page.getByLabel('Your display name')).toBeVisible();
    const account = await hearth.DB.prepare(
      'SELECT bootstrapAdministrator FROM users',
    ).all();
    expect(account.results[0]).toEqual({ bootstrapAdministrator: 1 });
    const domain = await hearth.DB.prepare(
      'SELECT hostname,isPrimary,health FROM delivery_domains',
    ).all();
    expect(domain.results[0]).toEqual({
      hostname: 'first.localhost',
      isPrimary: 1,
      health: 'active',
    });
  });
});
