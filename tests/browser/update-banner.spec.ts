import { readFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { expect, signIn, test } from '../helpers/browser';

async function showUpdate(page: Page) {
  await page.route('**/_app/version.json', async (route) => {
    await route.fulfill({ json: { version: 'new-deployment' } });
  });
  const banner = page.getByRole('region', { name: 'Application update' });
  await expect
    .poll(async () => {
      await page.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
      return banner.isVisible();
    })
    .toBe(true);
}

test.beforeEach(async ({ page, request, baseURL }) => {
  await signIn(page, request, baseURL!);
});

test('reload protects unsaved settings and pending mutations, and performs a full reload when accepted', async ({
  page,
}) => {
  await page.goto('/settings');
  await showUpdate(page);
  const reload = page
    .getByRole('region', { name: 'Application update' })
    .getByRole('button', { name: 'Reload', exact: true });
  const name = page.getByLabel('Display name', { exact: true });
  await name.fill('Unsaved update draft');
  // eslint-disable-next-line unicorn/prefer-await -- Handle the dialog concurrently so the click can complete.
  const cancelled = page.waitForEvent('dialog').then(async (confirmation) => {
    expect(confirmation.type()).toBe('beforeunload');
    await confirmation.dismiss();
  });
  await reload.click();
  await cancelled;
  await expect(name).toHaveValue('Unsaved update draft');
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  await page.route('**/api/actions/preferences', async (route) => {
    await gate;
    await route.continue();
  });
  const saving = page.waitForRequest('**/api/actions/preferences');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  await saving;
  await expect(reload).toBeDisabled();
  release();
  await expect(reload).toBeEnabled();
  await expect(
    page.getByRole('button', { name: 'Save preferences' }),
  ).toBeDisabled();
  await page.evaluate(() => Reflect.set(globalThis, 'reloadMarker', true));
  await reload.click();
  await page.waitForLoadState();
  await expect
    .poll(() => page.evaluate(() => Reflect.has(globalThis, 'reloadMarker')))
    .toBe(false);
  await expect(name).toHaveValue('Unsaved update draft');
});

test('reload waits for active uploads without interrupting their completion', async ({
  page,
}) => {
  await page.goto('/images');
  await showUpdate(page);
  const reload = page
    .getByRole('region', { name: 'Application update' })
    .getByRole('button', { name: 'Reload', exact: true });
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  await page.route('**/api/upload', async (route) => {
    await gate;
    await route.fulfill({
      status: 201,
      json: { id: 'img_update', url: null, sharingWarning: null },
    });
  });
  const sending = page.waitForRequest('**/api/upload');
  await page.locator('input[type="file"]').setInputFiles({
    name: 'banner-upload.jpg',
    mimeType: 'image/jpeg',
    buffer: await readFile('tests/fixtures/upload.jpeg'),
  });
  await sending;
  await expect(reload).toBeDisabled();
  await expect(
    page.getByText('Reload once your current activity finishes.'),
  ).toBeVisible();
  release();
  await expect(reload).toBeEnabled();
  await expect(
    page.getByText('1 of 1 uploaded', { exact: true }),
  ).toBeVisible();
});

test('reload stays blocked while ZIP bytes are downloading after the manifest request finishes', async ({
  page,
  request,
}) => {
  const buffer = await readFile('tests/fixtures/upload.jpeg');
  const key = await readFile(process.env.TEST_KEY_FILE!, 'utf8');
  for (const name of ['zip-first.jpg', 'zip-second.jpg']) {
    const response = await request.post('/api/v1/images', {
      headers: { Authorization: `Bearer ${key}` },
      multipart: { file: { name, mimeType: 'image/jpeg', buffer } },
    });
    expect(response.status()).toBe(409);
  }
  await page.goto('/images');
  await page.evaluate(() =>
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      value: undefined,
      configurable: true,
    }),
  );
  await showUpdate(page);
  await page
    .getByRole('checkbox', { name: 'Select zip-first.jpg', exact: true })
    .check();
  await page
    .getByRole('checkbox', { name: 'Select zip-second.jpg', exact: true })
    .check();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  await page.route('**/api/media/*?download', async (route) => {
    await gate;
    await route.continue();
  });
  const bytesRequested = page.waitForRequest('**/api/media/*?download');
  await page
    .getByRole('group', { name: 'Selected image actions', exact: true })
    .getByRole('button', { name: 'Download', exact: true })
    .click();
  await bytesRequested;
  const reload = page
    .getByRole('region', { name: 'Application update' })
    .getByRole('button', { name: 'Reload', exact: true });
  await expect(reload).toBeDisabled();
  const completed = page.waitForEvent('download');
  release();
  const archive = await completed;
  expect(archive.suggestedFilename()).toBe('hearth-images.zip');
  await expect(reload).toBeEnabled();
});
