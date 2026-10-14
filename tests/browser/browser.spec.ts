/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed request and binding results. */
import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';

import type { Page, Request } from '@playwright/test';
import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { z } from 'zod';

import { expect, test } from '../helpers/browser';

function deferred() {
  let resolve!: () => void;
  // The project targets ES2022, whose types do not include Promise.withResolvers.
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function getLocalKey() {
  return readFile(process.env.TEST_KEY_FILE!, 'utf8');
}

async function prepareDeliveryDomain(page: Page) {
  await page.goto('/admin/domains?q=shots.localhost');
  const row = page
    .locator('.domain-row')
    .filter({ hasText: 'shots.localhost' });
  const dialog = page.getByRole('dialog');
  if (await row.count()) {
    if (await row.getByText('Active', { exact: true }).count()) return;
    await row
      .getByLabel('Actions for shots.localhost', { exact: true })
      .click();
    await row
      .getByRole('button', { name: 'Details & diagnostics', exact: true })
      .click();
  } else {
    await page
      .getByRole('button', { name: 'Add delivery domain', exact: true })
      .first()
      .click();
    await dialog
      .getByRole('textbox', { name: 'Hostname', exact: true })
      .fill('shots.localhost');
    await dialog
      .getByRole('button', { name: 'Add delivery domain', exact: true })
      .click();
    await expect(
      dialog.getByText('Pending validation', { exact: true }),
    ).toBeVisible();
  }
  await dialog
    .getByRole('button', { name: 'Validate domain', exact: true })
    .click();
  await expect(dialog.getByText('Active', { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  await expect(
    dialog.getByRole('button', { name: 'Close dialog', exact: true }),
  ).toBeEnabled();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
}

async function selectPersonalDeliveryDomain(page: Page) {
  await page.goto('/domains?q=shots.localhost');
  const row = page
    .locator('.domain-row')
    .filter({ hasText: 'shots.localhost' });
  if (!(await row.getByText('Your selection', { exact: true }).count())) {
    await row
      .getByLabel('Actions for shots.localhost', { exact: true })
      .click();
    await row
      .getByRole('button', { name: 'Use for my new links', exact: true })
      .click();
  }
  await expect(row.getByText('Your selection', { exact: true })).toBeVisible();
}

test('share-link IDs show configured and effective lengths and preserve automatic growth', async ({
  page,
  request,
  baseURL,
}) => {
  const key = await getLocalKey();
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  expect(login.status()).toBe(200);
  const storage = await request.storageState();
  await page.context().addCookies(storage.cookies);
  const seed = spawnSync(
    process.execPath,
    [
      nodePath.resolve('node_modules/wrangler/bin/wrangler.js'),
      'd1',
      'execute',
      'DB',
      '--local',
      '--config',
      process.env.TEST_DB_CONFIG!,
      '--command',
      "UPDATE app_settings SET value=json_set(value,'$.defaultLength',5,'$.automaticFloor',7) WHERE key='shareSlugConfiguration'",
    ],
    { encoding: 'utf8' },
  );
  expect(seed.status).toBe(0);
  await page.goto('/admin/settings');
  const panel = page.getByRole('region', {
    name: 'Share-link IDs',
    exact: true,
  });
  const length = panel.getByRole('spinbutton', {
    name: 'Default share-link slug length',
  });
  await expect(length).toHaveValue('5');
  await expect(length).toHaveAttribute('min', '3');
  await expect(length).toHaveAttribute('max', '64');
  await expect(length).toHaveAttribute('step', '1');
  await expect(panel).toContainText('Current allocation length: 7 characters');
  await expect(panel).toContainText(
    'automatically increased the allocation minimum to 7',
  );
  for (const value of ['2', '5.5', '65']) {
    await length.fill(value);
    expect(
      await length.evaluate((input: HTMLInputElement) => input.checkValidity()),
    ).toBe(false);
  }
  for (const value of ['8', '5']) {
    await length.fill(value);
    const saving = page.waitForResponse((response) =>
      response.url().endsWith('/api/actions/share-slug-settings'),
    );
    await panel.getByRole('button', { name: 'Save slug length' }).click();
    const response = await saving;
    expect(response.status()).toBe(200);
    await expect(panel).toContainText(`Configured length: ${value} characters`);
    await expect(panel).toContainText(
      `Current allocation length: ${value === '8' ? '8' : '7'} characters`,
    );
  }
  await page.reload();
  await expect(length).toHaveValue('5');
  await expect(panel).toContainText('Current allocation length: 7 characters');
});

test('global drops, targeted refresh and visible select all work together', async ({
  page,
  request,
  baseURL,
}) => {
  await page.clock.install();
  const key = await getLocalKey();
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  expect(login.status()).toBe(200);
  const state = await request.storageState();
  await page.context().addCookies(state.cookies);
  await page.goto('/admin/domains');
  await prepareDeliveryDomain(page);
  await page.goto('/domains');
  await selectPersonalDeliveryDomain(page);
  const name = `drop-123456789`;
  await page.goto('/settings');
  await page
    .getByRole('textbox', { name: 'Display name', exact: true })
    .fill('Unsaved preference');
  const textDrag = await page.evaluateHandle(() => {
    const transfer = new DataTransfer();
    transfer.setData('text/plain', 'ordinary text');
    return transfer;
  });
  await page
    .locator('main')
    .dispatchEvent('dragenter', { dataTransfer: textDrag });
  await expect(
    page.getByText('Release to upload', { exact: true }),
  ).toHaveCount(0);
  const files = await page.evaluateHandle((name) => {
    const transfer = new DataTransfer();
    const bytes = Uint8Array.from(
      atob(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
      ),
      (c) => c.codePointAt(0)!,
    );
    transfer.items.add(
      new File([bytes], `${name}-one.png`, { type: 'image/png' }),
    );
    transfer.items.add(
      new File([bytes], `${name}-two.png`, { type: 'image/png' }),
    );
    return transfer;
  }, name);
  await page
    .locator('main')
    .dispatchEvent('dragstart', { dataTransfer: files });
  await page
    .locator('main')
    .dispatchEvent('dragenter', { dataTransfer: files });
  await expect(
    page.getByText('Release to upload', { exact: true }),
  ).toHaveCount(0);
  await page.locator('main').dispatchEvent('dragend', { dataTransfer: files });
  await page
    .locator('main')
    .dispatchEvent('dragenter', { dataTransfer: files });
  await expect(
    page.getByText('Release to upload', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('heading', { name: 'Settings', exact: true })
    .dispatchEvent('dragenter', { dataTransfer: files });
  await page
    .getByRole('heading', { name: 'Settings', exact: true })
    .dispatchEvent('dragleave', { dataTransfer: files });
  await expect(
    page.getByText('Release to upload', { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 375, height: 812 });
  await page.setViewportSize({ width: 1440, height: 1000 });
  const uploadGate = deferred();
  await page.route('**/api/upload', async (route) => {
    await uploadGate.promise;
    await route.continue();
  });
  const uploading = page.waitForRequest('**/api/upload');
  await page.locator('main').dispatchEvent('drop', { dataTransfer: files });
  await uploading;
  const activeRefresh = page.waitForResponse((response) =>
    response.url().includes('/api/settings'),
  );
  await page.clock.fastForward(5000);
  await activeRefresh;
  uploadGate.resolve();

  await expect(
    page.getByText('2 of 2 uploaded', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Release to upload', { exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('textbox', { name: 'Display name', exact: true }),
  ).toHaveValue('Unsaved preference');
  page.once('dialog', (dialog) => dialog.accept());
  await page.goto(`/images?q=${name}`);
  const selectAll = page.getByRole('button', {
    name: 'Select all',
    exact: true,
  });
  await expect(selectAll).toHaveCount(0);
  await expect(
    page.getByRole('group', { name: 'Selected image actions' }),
  ).toHaveCount(0);
  await page
    .getByRole('checkbox', { name: `Select ${name}-one.png`, exact: true })
    .check();
  await expect(selectAll).toBeEnabled();
  await expect(
    page
      .getByRole('group', { name: 'Selected image actions' })
      .getByRole('button', { name: 'Select all', exact: true }),
  ).toBeVisible();
  const allImages = await request.post('/api/actions/image-select-all', {
    headers: { Origin: baseURL! },
    data: { admin: false, query: `q=${name}` },
  });
  const allResult = z
    .object({ ids: z.array(z.string()) })
    .parse(await allImages.json());
  const allIds = allResult.ids;
  await selectAll.click();
  await expect(
    page.getByText(`${allIds.length} selected`, { exact: true }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Clear', exact: true }).focus();
  await page.keyboard.press('Space');
  await expect(page.getByText('2 selected', { exact: true })).toHaveCount(0);
  await expect(selectAll).toHaveCount(0);
  await page
    .getByRole('checkbox', { name: `Select ${name}-one.png`, exact: true })
    .check();
  await page
    .getByRole('checkbox', { name: `Select ${name}-two.png`, exact: true })
    .check();

  const updated = await request.post('/api/v1/images', {
    headers: { Authorization: `Bearer ${key}` },
    multipart: {
      file: {
        name: `${name}-three.gif`,
        mimeType: 'image/gif',
        buffer: await readFile('tests/fixtures/animated.gif'),
      },
    },
  });
  expect(updated.status()).toBe(201);
  const navigationCount = await page.evaluate(
    () => performance.getEntriesByType('navigation').length,
  );
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('checkbox', {
      name: `Select ${name}-three.gif`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(selectAll).toBeEnabled();
  expect(
    await page.evaluate(
      () => performance.getEntriesByType('navigation').length,
    ),
  ).toBe(navigationCount);
  const gif = page.getByRole('img', { name: `${name}-three.gif`, exact: true });
  await expect(gif).toHaveJSProperty('naturalWidth', 2);
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  const automatic = await request.post('/api/v1/images', {
    headers: { Authorization: `Bearer ${key}` },
    multipart: {
      file: {
        name: `${name}-four.gif`,
        mimeType: 'image/gif',
        buffer: await readFile('tests/fixtures/animated.gif'),
      },
    },
  });
  expect(automatic.status()).toBe(201);
  await page.clock.fastForward(15_000);
  await expect(
    page.getByRole('checkbox', {
      name: `Select ${name}-four.gif`,
      exact: true,
    }),
  ).toBeVisible();
  await expect(page.getByText('2 selected', { exact: true })).toBeVisible();
  await page.goto(`/images?q=${name}-three`);
  await expect(selectAll).toHaveCount(0);
});

test('image actions download originals and delete in the background with partial results', async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const key = await getLocalKey();
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  expect(login.status()).toBe(200);
  const storageState = await request.storageState();
  await page.context().addCookies(storageState.cookies);
  await page.goto('/admin/domains');
  await prepareDeliveryDomain(page);
  await page.goto('/domains');
  await selectPersonalDeliveryDomain(page);
  await page.addInitScript(() =>
    Object.defineProperty(globalThis, 'showSaveFilePicker', {
      value: undefined,
      configurable: true,
    }),
  );
  const name = `polish-123456789 café space.gif`;
  const bytes = await readFile('tests/fixtures/animated.gif');
  const ids: string[] = [];
  for (let index = 0; index < 2; index++) {
    const response = await request.post('/api/v1/images', {
      headers: { Authorization: `Bearer ${key}` },
      multipart: {
        file: { name, mimeType: 'image/gif', buffer: bytes },
        expiry: 'never',
      },
    });
    expect(response.status()).toBe(201);
    ids.push(z.object({ id: z.string() }).parse(await response.json()).id);
  }
  await page.goto(`/images/${ids[0]}`);
  const detailData = await request.get(`/images/${ids[0]}/__data.json`);
  expect(detailData.status()).toBe(200);
  expect(await detailData.text()).not.toContain('"objectKey"');
  const singleDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const single = await singleDownload;
  expect(single.suggestedFilename()).toBe(name);
  expect(await readFile(await single.path())).toEqual(bytes);
  await page.goto(`/images?q=${name.split(' ', 1)[0]}`);
  const listData = await request.get('/images/__data.json');
  expect(listData.status()).toBe(200);
  expect(await listData.text()).not.toContain('"previewKey"');
  const toolbar = page.getByRole('group', { name: 'Selected image actions' });
  await expect(toolbar).toHaveCount(0);
  const cardDownload = page.waitForEvent('download');
  await page
    .locator('.image-card')
    .first()
    .getByRole('button', { name: 'Download', exact: true })
    .click();
  const cardOriginal = await cardDownload;
  expect(cardOriginal.suggestedFilename()).toBe(name);
  expect(await readFile(await cardOriginal.path())).toEqual(bytes);
  await page
    .getByRole('checkbox', { name: `Select ${name}`, exact: true })
    .first()
    .check();
  await page
    .getByRole('checkbox', { name: `Select ${name}`, exact: true })
    .nth(1)
    .check();
  await expect(toolbar.getByText('2 selected', { exact: true })).toBeVisible();
  const zipDownload = page.waitForEvent('download');
  await toolbar.getByRole('button', { name: 'Download', exact: true }).click();
  const archive = await zipDownload;
  const zip = new ZipReader(
    new Uint8ArrayReader(await readFile(await archive.path())),
    { useWebWorkers: false },
  );
  const allEntries = await zip.getEntries();
  const entries = allEntries.filter((entry) => !entry.directory);
  expect(entries.map((entry) => entry.filename)).toEqual([
    name,
    name.replace('.gif', ' (2).gif'),
  ]);
  for (const entry of entries)
    expect(await entry.getData(new Uint8ArrayWriter())).toEqual(
      new Uint8Array(bytes),
    );
  await zip.close();
  await expect(toolbar.getByText('2 selected', { exact: true })).toBeVisible();
  await toolbar.getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(toolbar).toHaveCount(0);
  await page
    .getByRole('checkbox', { name: `Select ${name}`, exact: true })
    .first()
    .check();
  await page
    .getByRole('checkbox', { name: `Select ${name}`, exact: true })
    .nth(1)
    .check();
  await page.setViewportSize({ width: 375, height: 812 });
  await expect(page.locator('.image-expiry')).toHaveCount(0);
  const expiryUpdate = await request.post('/api/actions/image-expiry', {
    headers: { Origin: baseURL! },
    data: { ids, expiry: '1h' },
  });
  expect(expiryUpdate.status()).toBe(200);
  await page.clock.install();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.image-expiry').first()).toContainText(
    /^Expires in (1 hour|60 minutes)$/,
  );
  await page.clock.fastForward(3_570_000);
  await expect(page.locator('.image-expiry').first()).toContainText(
    'Expires soon',
  );
  await page.clock.fastForward(60_000);
  await expect(page.locator('.image-expiry').first()).toContainText(
    'Pending deletion',
  );
  const gate = deferred();
  await page.route('**/api/actions/image-delete', async (route) => {
    await gate.promise;
    const input = z
      .object({ ids: z.array(z.string()) })
      .parse(route.request().postDataJSON());
    const response = await route.fetch({
      postData: JSON.stringify({ ids: [input.ids[0]] }),
    });
    expect(response.status()).toBe(200);
    await route.fulfill({
      json: {
        deletedIds: [input.ids[0]],
        alreadyRemovedIds: [],
        failed: [
          {
            id: input.ids[1],
            code: 'UNAVAILABLE',
            message: 'Please try again.',
          },
        ],
      },
    });
  });
  await toolbar.getByRole('button', { name: 'Delete', exact: true }).click();
  const dialog = page.getByRole('dialog');
  const deleting = page.waitForRequest('**/api/actions/image-delete');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await deleting;
  await expect(dialog).toHaveCount(0);
  await expect(page.getByText('0 of 2 deleted', { exact: true })).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.locator('.image-card')).toHaveCount(2);
  const refreshedNotice = page.getByRole('region', {
    name: 'Success notification',
  });
  await expect(
    refreshedNotice.getByText('Dashboard refreshed.', { exact: true }),
  ).toBeVisible();
  await refreshedNotice
    .getByRole('button', { name: 'Dismiss notification' })
    .click();
  gate.resolve();
  await expect(page.locator('.image-card')).toHaveCount(1);
  await expect(toolbar.getByText('1 selected', { exact: true })).toBeVisible();
  await expect(
    page
      .getByRole('region', { name: 'Something went wrong notification' })
      .getByText('1 of 2 deleted · 1 failed', { exact: true }),
  ).toBeVisible();
  const deletionNotice = page.getByRole('region', {
    name: 'Something went wrong notification',
  });
  await deletionNotice.getByRole('button', { name: 'Show details' }).click();
  await expect(
    deletionNotice.getByLabel('Deletion items').locator('.item-row').first(),
  ).toHaveAttribute('data-state', 'failed');
  await expect(
    deletionNotice.getByLabel('Deletion items').locator('.item-row').nth(1),
  ).toHaveAttribute('data-state', 'completed');
  await page.unroute('**/api/actions/image-delete');
  await toolbar.getByRole('button', { name: 'Delete', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await expect(page.locator('.image-card')).toHaveCount(0);
  await expect(toolbar).toHaveCount(0);
});

test('detail deletion returns to its filtered list and completion preserves later navigation', async ({
  page,
  request,
  baseURL,
}) => {
  const key = await getLocalKey();
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  expect(login.status()).toBe(200);
  const storageState = await request.storageState();
  await page.context().addCookies(storageState.cookies);
  await prepareDeliveryDomain(page);
  await selectPersonalDeliveryDomain(page);
  const name = `detail-delete-123456789.gif`;
  const response = await request.post('/api/v1/images', {
    headers: { Authorization: `Bearer ${key}` },
    multipart: {
      file: {
        name,
        mimeType: 'image/gif',
        buffer: await readFile('tests/fixtures/animated.gif'),
      },
    },
  });
  expect(response.status()).toBe(201);
  const { id } = z.object({ id: z.string() }).parse(await response.json());
  await page.goto(`/images?q=${name}`);
  await page
    .locator('.image-meta')
    .getByRole('link', { name, exact: true })
    .click();
  await expect(page).toHaveURL(`/images/${id}?q=${name}`);
  const gate = deferred();
  await page.route('**/api/actions/image-delete', async (route) => {
    await gate.promise;
    await route.continue();
  });
  await page.getByRole('button', { name: 'Delete image', exact: true }).click();
  const deleting = page.waitForRequest('**/api/actions/image-delete');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await deleting;
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page).toHaveURL(`/images?q=${name}`);
  await expect(page.getByText('0 of 1 deleted', { exact: true })).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Settings', exact: true })
    .click();
  gate.resolve();
  await expect(page.getByText('1 of 1 deleted', { exact: true })).toBeVisible();
  await expect(page).toHaveURL('/settings');
  await page.goto(`/images?q=${name}`);
  await expect(page.locator('.image-card')).toHaveCount(0);
});

test('image search is immediate, composable and persistent in Images and Admin', async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const key = await getLocalKey();
  const searchTerm = `search-screenshot-123456789`;
  const filename = `${searchTerm}.png`;
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  expect(login.status()).toBe(200);
  const state = await request.storageState();
  await page.context().addCookies(state.cookies);
  await page.goto('/admin/domains');
  await prepareDeliveryDomain(page);
  await page.goto('/domains');
  await selectPersonalDeliveryDomain(page);
  const uploaded = await request.post('/api/v1/images', {
    headers: { Authorization: `Bearer ${key}` },
    multipart: {
      file: {
        name: filename,
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
          'base64',
        ),
      },
    },
  });
  expect(uploaded.status()).toBe(201);
  const image = z
    .object({ id: z.string(), url: z.string() })
    .parse(await uploaded.json());
  for (const path of ['/images', '/admin/images']) {
    await page.goto(path);
    const search = page.getByRole('textbox', { name: 'Search images' });
    await expect(
      page.getByRole('button', { name: 'Find', exact: true }),
    ).toHaveCount(0);
    await expect
      .poll(async () => {
        await page.keyboard.press('/');
        return search.evaluate((element) => element === document.activeElement);
      })
      .toBe(true);
    await expect(search).toBeFocused();
    const requests: string[] = [];
    const trackSearch = (request: Request) => {
      requests.push(request.url());
    };
    page.on('request', trackSearch);
    await search.pressSequentially('SCREENSHOT', { delay: 15 });
    await expect(page).toHaveURL(/q=SCREENSHOT/);
    page.off('request', trackSearch);
    expect(
      requests.filter(
        (url) =>
          url.includes('/__data.json') && new URL(url).searchParams.has('q'),
      ),
    ).toHaveLength(1);
    await expect(page.locator('h3 mark').first()).toHaveText(/screenshot/i);
    await expect(search).toBeFocused();
    await search.press('/');
    await expect(search).toHaveValue('SCREENSHOT/');
    await search.fill('screensht');
    await expect(
      page.getByRole('heading', { name: filename }).first(),
    ).toBeVisible();
    await expect(page).toHaveURL(/q=screensht/);
    await search.fill(image.url);
    await expect(page).toHaveURL(/q=http/);
    await expect(page.getByRole('heading', { name: filename })).toBeVisible();
    await search.fill(searchTerm);
    await expect(page).toHaveURL(new RegExp(`q=${searchTerm}`));
    await page.locator('summary[title="Filter images"]').click();
    await page
      .getByRole('combobox', { name: 'Format', exact: true })
      .selectOption('png');
    for (const preset of ['today', '7d', '30d']) {
      await page
        .getByRole('combobox', { name: 'Upload date (local time)' })
        .selectOption(preset);
      await expect(page).toHaveURL(new RegExp(`date=${preset}`));
      expect(new URL(page.url()).searchParams.get('tz')).toBe(
        await page.evaluate(
          () => new Intl.DateTimeFormat().resolvedOptions().timeZone,
        ),
      );
      await expect(page.getByRole('heading', { name: filename })).toBeVisible();
    }
    await page
      .getByRole('combobox', { name: 'Upload date (local time)' })
      .selectOption('custom');
    const today = await page.evaluate(() => {
      const now = new Date();
      return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
    });
    await page.getByLabel('From', { exact: true }).fill(today);
    await page.getByLabel('Through', { exact: true }).fill(today);
    await expect(page).toHaveURL(new RegExp(`to=${today}`));
    await expect(page.getByRole('heading', { name: filename })).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Upload date (local time)' })
      .selectOption('30d');
    await page
      .getByRole('combobox', { name: 'Orientation', exact: true })
      .selectOption('square');
    await page
      .getByRole('combobox', { name: 'File size', exact: true })
      .selectOption('small');
    await expect(page).toHaveURL(/size=small/);
    await page.keyboard.press('Escape');
    await page.locator('summary[title="Sort images"]').click();
    await expect(page.getByRole('radio', { name: 'Best match' })).toBeVisible();
    await page.getByRole('radio', { name: 'Newest first' }).check();
    await expect(page).toHaveURL(/sort=newest/);
    await page.keyboard.press('Escape');
    await expect(page.locator('.filter-chips button')).toHaveCount(4);
    await expect(
      page.locator('.search-status').getByRole('status'),
    ).toContainText(/1(?: of \d+)?\s+images?/);
    const filtered = page.url();
    await page.getByRole('heading', { name: filename }).click();
    await expect(
      page.getByRole('heading', { level: 1, name: filename }),
    ).toBeVisible();
    await page.getByRole('link', { name: 'Back to images' }).click();
    await expect(page).toHaveURL(filtered);
    await page.reload();
    await expect(search).toHaveValue(searchTerm);
    await expect(page.locator('.filter-chips button')).toHaveCount(4);
    await search.fill('no-such-image-xyz');
    await expect(
      page.getByRole('heading', { name: 'No images match your search.' }),
    ).toBeVisible();
    await page.goBack();
    await expect(search).toHaveValue(searchTerm);
    await expect(page.getByRole('heading', { name: filename })).toBeVisible();
    await page
      .getByRole('button', { name: 'Clear search', exact: true })
      .click();
    await expect(page).not.toHaveURL(/[?&]q=/);
    await expect(page.locator('.filter-chips button')).toHaveCount(4);
    await page.locator('summary[title="Sort images"]').click();
    await expect(page.getByRole('radio', { name: 'Best match' })).toHaveCount(
      0,
    );
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Clear all', exact: true }).click();
    await expect(page).toHaveURL(new RegExp(path + '$'));
    // Force older responses to finish last, including clearing back to the
    // already-displayed URL while its replacement request is still pending.
    for (const replacement of [searchTerm, '']) {
      await search.fill('');
      await expect(page).toHaveURL(new RegExp(path + '$'));
      const hold = deferred();
      const finished = deferred();
      const pattern = '**/__data.json*q=delayed-no-match*';
      await page.route(pattern, async (route) => {
        const response = await route.fetch();
        await hold.promise;
        await route.fulfill({ response });
        finished.resolve();
      });
      const started = page.waitForRequest(
        (request) =>
          new URL(request.url()).searchParams.get('q') === 'delayed-no-match',
      );
      await search.fill('delayed-no-match');
      await started;
      await expect(page.getByRole('heading', { name: filename })).toBeVisible();
      await search.fill(replacement);
      await expect(page).toHaveURL(
        new RegExp(replacement ? `q=${searchTerm}` : path + '$'),
      );
      hold.resolve();
      await finished.promise;
      await expect(search).toHaveValue(replacement);
      await expect(page.getByRole('heading', { name: filename })).toBeVisible();
      await expect(page).not.toHaveURL(/delayed-no-match/);
      await page.unroute(pattern);
    }
    for (const width of [320, 375, 1440]) {
      await page.setViewportSize({ width, height: 667 });
      await page.locator('summary[title="Filter images"]').click();
      await expect(
        page.getByRole('combobox', { name: 'Format', exact: true }),
      ).toBeVisible();
      await page.keyboard.press('Escape');
    }
  }
  const deletion = await request.post('/api/actions/image-delete', {
    headers: { Origin: baseURL! },
    data: { ids: [image.id] },
  });
  expect(deletion.status()).toBe(200);
});

test('complete authenticated dashboard and ShareX workflow', async ({
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const key = await getLocalKey();
  await page.goto('/login', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('heading', { name: 'Sign in' })).toBeVisible();
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  expect(login.status(), await login.text()).toBe(200);
  const storageState = await request.storageState();
  await page.context().addCookies(storageState.cookies);
  await page.goto('/admin/domains');
  await expect(
    page.getByRole('heading', { name: 'Domains', exact: true }),
  ).toBeVisible();
  await prepareDeliveryDomain(page);
  await expect(
    page
      .getByRole('article', {
        name: 'Delivery domain shots.localhost',
        exact: true,
      })
      .getByText('shots.localhost', { exact: true }),
  ).toBeVisible();
  await page.goto('/domains');
  await selectPersonalDeliveryDomain(page);
  await expect(page.getByText('Your selection', { exact: true })).toBeVisible();
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.getByRole('button', { name: 'Dismiss ShareX banner' }).click();
  await expect(page.getByRole('button', { name: 'Set up ShareX' })).toHaveCount(
    0,
  );
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Overview' })).toBeVisible();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Set up ShareX' })).toHaveCount(
    0,
  );
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
    'base64',
  );
  const uploaded = await request.post('/api/v1/images', {
    headers: { Authorization: `Bearer ${key}` },
    multipart: {
      file: {
        name: 'first-screenshot.png',
        mimeType: 'application/octet-stream',
        buffer: png,
      },
    },
  });
  expect(uploaded.status(), await uploaded.text()).toBe(201);
  const image = z
    .object({ id: z.string(), url: z.url(), deleteUrl: z.url() })
    .parse(await uploaded.json());
  expect(image.url).toMatch(/shots.localhost/);
  expect(image.deleteUrl).toContain('#');
  await page.goto('/images');
  await expect(
    page.getByRole('heading', { name: 'first-screenshot.png' }).first(),
  ).toBeVisible();
  await page.goto(`/images/${image.id}`);
  await page.getByRole('button', { name: 'Create link' }).click();
  await page.getByRole('textbox', { name: 'Slug' }).fill(`qa-123456789`);
  await page
    .getByRole('button', { name: 'Create link', exact: true })
    .last()
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const sxcu = await request.post('/api/actions/sxcu', {
    headers: { Origin: baseURL! },
    data: { key },
  });
  expect(sxcu.status()).toBe(200);
  const config = z
    .object({ URL: z.string(), DeletionURL: z.string() })
    .parse(await sxcu.json());
  expect(config.URL).toBe('{json:url}');
  expect(config.DeletionURL).toBe('{json:deleteUrl}');
  const invalid = await request.post('/api/v1/images', {
    headers: { Authorization: `Bearer ${key}` },
    multipart: {
      file: {
        name: 'fake.png',
        mimeType: 'image/png',
        buffer: Buffer.from('<svg onload="alert(1)"></svg>'),
      },
    },
  });
  expect(invalid.status()).toBe(400);
  const csrf = await request.post('/api/actions/preferences', {
    headers: { Origin: 'https://evil.example' },
    data: { displayName: 'Changed', expiry: 'never', stripImageMetadata: true },
  });
  expect(csrf.status()).toBe(403);
  await page.goto(
    new URL(image.deleteUrl).pathname + new URL(image.deleteUrl).hash,
  );
  await expect(
    page.getByText('first-screenshot.png', { exact: true }),
  ).toBeVisible();
  const mediaBeforeDeletion = await request.get(`/api/media/${image.id}`);
  expect(mediaBeforeDeletion.status()).toBe(200);
  const deletion = await request.post('/api/actions/delete-token', {
    headers: { Origin: baseURL! },
    data: {
      imageId: image.id,
      token: new URL(image.deleteUrl).hash.slice(1),
      turnstile: 'XXXX.DUMMY.TOKEN.XXXX',
    },
  });
  expect(deletion.status(), await deletion.text()).toBe(200);
  const mediaAfterDeletion = await request.get(`/api/media/${image.id}`);
  expect(mediaAfterDeletion.status()).toBe(404);
  const repeated = await request.post('/api/actions/delete-token', {
    headers: { Origin: baseURL! },
    data: {
      imageId: image.id,
      token: new URL(image.deleteUrl).hash.slice(1),
      turnstile: 'XXXX.DUMMY.TOKEN.XXXX',
    },
  });
  expect(repeated.status()).toBe(404);
});

test('audit search composes filters, paginates and retains navigation state', async ({
  page,
  request,
  baseURL,
  hearth,
}) => {
  const key = await getLocalKey();
  expect(
    (
      await request.post('/api/actions/login', {
        headers: { Origin: baseURL! },
        data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
      })
    ).status(),
  ).toBe(200);
  await page.context().addCookies((await request.storageState()).cookies);
  await hearth.DB.prepare('DELETE FROM audit_log').run();
  await hearth.DB.prepare(
    `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<60)
    INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt)
    SELECT 'browser-audit-'||x,(SELECT id FROM users WHERE role='admin' LIMIT 1),'image.uploaded','image-'||x,
    json_object('version',1,'actorName','Fixture Investigator','targetName','Evidence '||x),2000000000+x FROM n`,
  ).run();
  await page.goto('/admin/audit-log');
  const search = page.getByRole('textbox', { name: 'Search audit events' });
  const pager = page.getByRole('navigation', {
    name: 'Pagination',
    exact: true,
  });
  await expect(page.locator('details.audit-entry')).toHaveCount(50);
  await search.fill('Evidence');
  await expect(page).toHaveURL(/q=Evidence/);
  await pager.getByRole('link', { name: 'Next page', exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await expect(page.locator('details.audit-entry')).toHaveCount(10);
  await page.reload();
  await expect(search).toHaveValue('Evidence');
  await page.locator('summary[title="Filter audit events"]').click();
  await page
    .getByRole('combobox', { name: 'Action', exact: true })
    .selectOption('image.uploaded');
  await expect(page).not.toHaveURL(/[?&]page=/);
  await page
    .getByRole('textbox', { name: 'Actor / user' })
    .fill('Fixture Investigator');
  await expect(page).toHaveURL(/actor=Fixture/);
  await page.reload();
  await page.locator('summary[title="Filter audit events"]').click();
  await expect(page.getByRole('textbox', { name: 'Actor / user' })).toHaveValue(
    'Fixture Investigator',
  );
  await page.keyboard.press('Escape');
  const filtered = page.url();
  await page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('link', { name: 'Images', exact: true })
    .click();
  await expect(page).toHaveURL(baseURL + '/images');
  await page.goBack();
  await expect(page).toHaveURL(filtered);
  await expect(search).toHaveValue('Evidence');
  await search.fill('not-found');
  await expect(
    page.getByRole('heading', { name: 'No audit events match your search' }),
  ).toBeVisible();
});

test('upload queue stays bounded across picker batches and navigation with partial failures', async ({
  page,
  request,
  baseURL,
}) => {
  const key = await getLocalKey();
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  expect(login.status()).toBe(200);
  const storage = await request.storageState();
  await page.context().addCookies(storage.cookies);
  await page.goto('/admin/domains');
  await prepareDeliveryDomain(page);
  await page.goto('/domains');
  await selectPersonalDeliveryDomain(page);
  await page.goto('/images');
  const gate = deferred();
  let started = 0;
  await page.route('**/api/upload', async (route) => {
    const index = ++started;
    await gate.promise;
    if (index === 3 || index === 5) {
      const response = await route.fetch();
      const uploaded = z
        .object({ id: z.string(), url: z.string().nullable() })
        .parse(await response.json());
      await route.fulfill({
        response,
        json: { ...uploaded, sharingWarning: 'Delivery is unavailable.' },
      });
      return;
    }
    await route.continue();
  });
  const png = await readFile('tests/fixtures/upload.jpeg');
  const stamp = 123_456_789;
  const image = (index: number) => ({
    name: `queue-${stamp}-${index}.jpg`,
    mimeType: 'image/jpeg',
    buffer: png,
  });
  await page.locator('input[type="file"]').setInputFiles([
    image(1),
    {
      name: 'invalid-image-with-a-long-descriptive-filename-that-must-stay-within-the-notification.png',
      mimeType: 'image/png',
      buffer: Buffer.from('This is not an image.'),
    },
    image(2),
    image(3),
  ]);
  await expect.poll(() => started).toBe(2);
  await page.locator('input[type="file"]').setInputFiles([image(4)]);
  await page.getByRole('button', { name: 'Show details', exact: true }).click();
  const card = page.getByRole('region', { name: 'In progress notification' });
  await expect(
    card.getByText('0 of 5 uploaded · 0%', { exact: true }),
  ).toBeVisible();
  await expect(
    card.getByLabel('Upload files').locator('[data-state="pending"]'),
  ).toHaveCount(3);
  const bar = card.getByRole('progressbar');
  await expect(bar).toBeVisible();
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Settings', exact: true }),
  ).toBeVisible();
  expect(started).toBe(2);
  await page.setViewportSize({ width: 375, height: 812 });
  gate.resolve();
  await expect(
    page.getByText('4 of 5 uploaded · 1 failed', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Something went wrong notification' }),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: /^Retry / })).toBeVisible();
  const uploadRows = page.getByLabel('Upload files').locator('.item-row');
  await expect(uploadRows.first()).toHaveAttribute('data-state', 'failed');
  await expect(uploadRows.locator('strong')).toHaveText([
    'invalid-image-with-a-long-descriptive-filename-that-must-stay-within-the-notification.png',
    ...[2, 4, 1, 3].map((index) => image(index).name),
  ]);
  await expect(uploadRows.nth(1).locator('.item-warning')).toBeVisible();
  await expect(uploadRows.nth(2).locator('.item-warning')).toBeVisible();
  await page.getByRole('button', { name: /^Retry / }).click();
  await expect.poll(() => started).toBe(6);
  await expect(
    page.getByText('4 of 5 uploaded · 1 failed', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Something went wrong notification' }),
  ).toBeVisible();
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page
    .getByRole('button', { name: 'Dismiss notification', exact: true })
    .click();
  await page.getByRole('link', { name: 'Images', exact: true }).click();
  for (const index of [1, 2, 3, 4]) {
    await expect(
      page.getByRole('checkbox', {
        name: `Select queue-${stamp}-${index}.jpg`,
        exact: true,
      }),
    ).toBeVisible();
  }
});

test('upload cancellation requires confirmation and preserves completed files', async ({
  page,
  request,
  baseURL,
}) => {
  const key = await getLocalKey();
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  expect(login.status()).toBe(200);
  const storage = await request.storageState();
  await page.context().addCookies(storage.cookies);
  await page.goto('/admin/domains');
  await prepareDeliveryDomain(page);
  await page.goto('/domains');
  await selectPersonalDeliveryDomain(page);
  await page.goto('/images');
  const first = deferred();
  const remaining = deferred();
  let started = 0;
  let aborted = 0;
  page.on('requestfailed', (request) => {
    if (request.url().endsWith('/api/upload')) aborted++;
  });
  await page.route('**/api/upload', async (route) => {
    const index = ++started;
    await (index === 1 ? first.promise : remaining.promise);
    await route.fulfill({
      status: 201,
      json: {
        id: 'img_test',
        url: 'https://shots.localhost:8788/testlink',
        sharingWarning: null,
      },
    });
  });
  const buffer = await readFile('tests/fixtures/upload.jpeg');
  await page.locator('input[type="file"]').setInputFiles(
    Array.from({ length: 4 }, (_, index) => ({
      name: `cancel-${index}.jpg`,
      mimeType: 'image/jpeg',
      buffer,
    })),
  );
  await expect.poll(() => started).toBe(2);
  first.resolve();
  await expect.poll(() => started).toBe(3);
  const card = page.getByRole('region', { name: 'In progress notification' });
  const cancel = card.getByRole('button', {
    name: 'Cancel Upload',
    exact: true,
  });
  const dialog = page.getByRole('dialog', { name: 'Cancel upload?' });
  await cancel.click();
  await expect(dialog).toContainText('The upload is still in progress.');
  expect(aborted).toBe(0);
  await dialog.getByRole('button', { name: 'Keep Uploading' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(cancel).toBeFocused();
  await cancel.click();
  await dialog.getByRole('button', { name: 'Close dialog' }).click();
  await expect(dialog).toHaveCount(0);
  expect(aborted).toBe(0);
  await cancel.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(aborted).toBe(0);
  await card.getByRole('button', { name: 'Show details' }).click();
  await card
    .getByRole('button', { name: 'Cancel cancel-3.jpg', exact: true })
    .click();
  await expect(dialog).toContainText('Other files will continue.');
  await dialog.getByRole('button', { name: 'Keep Uploading' }).click();
  await page.setViewportSize({ width: 375, height: 812 });
  await cancel.click();
  await dialog
    .getByRole('button', { name: 'Cancel Upload', exact: true })
    .click();
  await expect(dialog).toHaveCount(0);
  await expect(
    page.getByText('1 of 4 uploaded · 3 cancelled', { exact: true }),
  ).toBeVisible();
  await expect.poll(() => aborted).toBe(2);
  expect(started).toBe(3);
  remaining.resolve();
  const result = page.getByRole('region', {
    name: 'Something went wrong notification',
  });
  await expect(result.locator('[data-state="completed"]')).toHaveCount(1);
  await expect(result.locator('[data-state="cancelled"]')).toHaveCount(3);
  await result.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(dialog).toHaveCount(0);
});
