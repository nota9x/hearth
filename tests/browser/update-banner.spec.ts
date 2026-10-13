/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed browser requests and measurements. */
import { readFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { expect, test } from '../helpers/browser';

async function showUpdate(page: Page) {
  await page.route('**/_app/version.json', async (route) => {
    await route.fulfill({ json: { version: 'new-deployment' } });
  });
  await page.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
  await expect(
    page.getByRole('region', { name: 'Application update' }),
  ).toBeVisible();
}

test.beforeEach(async ({ page, request, baseURL }) => {
  const response = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: {
      key: await readFile(process.env.TEST_KEY_FILE!, 'utf8'),
      token: 'XXXX.DUMMY.TOKEN.XXXX',
    },
  });
  expect(response.status()).toBe(200);
  await page.context().addCookies((await request.storageState()).cookies);
});

test('deployment banner spans the viewport, fits desktop and mobile, and stays dismissed across navigation', async ({
  page,
}) => {
  await page.goto('/');
  const banner = page.getByRole('region', { name: 'Application update' });
  await expect(banner).toHaveCount(0);
  await showUpdate(page);
  await expect(
    banner.getByRole('button', { name: 'Reload', exact: true }),
  ).toBeEnabled();
  const rectangle = await banner.boundingBox();
  expect(rectangle?.x).toBe(0);
  expect(rectangle?.y).toBe(0);
  expect(rectangle?.width).toBe(1440);
  await expect
    .poll(() =>
      page
        .locator('aside')
        .evaluate((node) => node.getBoundingClientRect().top),
    )
    .toBe(rectangle!.height);
  await page.screenshot({
    path: 'artifacts/deployment-update-desktop.png',
    fullPage: true,
  });
  for (const width of [320, 375, 767]) {
    await page.setViewportSize({ width, height: 812 });
    expect((await banner.boundingBox())?.width).toBe(width);
    await expect
      .poll(() => page.evaluate(() => document.documentElement.scrollWidth))
      .toBe(width);
    const height = (await banner.boundingBox())!.height;
    await expect
      .poll(() =>
        page
          .locator('.mobile-bar')
          .evaluate((node) => node.getBoundingClientRect().top),
      )
      .toBeCloseTo(height, 0);
    await page.getByRole('button', { name: 'Open navigation' }).click();
    await expect
      .poll(() =>
        page
          .locator('aside')
          .evaluate((node) => node.getBoundingClientRect().top),
      )
      .toBeCloseTo(height + 73, 0);
    await page.keyboard.press('Escape');
    await expect(page.locator('aside')).toBeHidden();
  }
  await page.setViewportSize({ width: 375, height: 812 });
  await page.screenshot({
    path: 'artifacts/deployment-update-mobile.png',
    fullPage: false,
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const dismiss = banner.getByRole('button', { name: 'Dismiss update notice' });
  await dismiss.focus();
  await dismiss.press('Enter');
  await expect(banner).toHaveCount(0);
  await expect
    .poll(() =>
      page
        .locator('aside')
        .evaluate((node) => node.getBoundingClientRect().top),
    )
    .toBe(0);
  await page.getByRole('link', { name: 'Images', exact: true }).click();
  await expect(page).toHaveURL(/\/images$/);
  await expect(banner).toHaveCount(0);
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
  let release!: () => void;
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- The project targets ES2022.
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
  let release!: () => void;
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- The project targets ES2022.
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
  let release!: () => void;
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- The project targets ES2022.
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
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
