/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed request and binding results. */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader } from '@zip.js/zip.js';
import { z } from 'zod';

import { expect, signIn, test } from '../helpers/browser';
import { configureDeliveryDomain } from '../helpers/delivery';

test('global drops, targeted refresh and visible select all work together', async ({
  page,
  request,
  baseURL,
}) => {
  await page.clock.install();
  const key = await signIn(page, request, baseURL!);
  await configureDeliveryDomain(request, baseURL!, 'shots.localhost', true);
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
  const uploadGate = Promise.withResolvers<void>();
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
  const key = await signIn(page, request, baseURL!);
  await configureDeliveryDomain(request, baseURL!, 'shots.localhost', true);
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
  const singleDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download', exact: true }).click();
  const single = await singleDownload;
  expect(single.suggestedFilename()).toBe(name);
  expect(await readFile(await single.path())).toEqual(bytes);
  await page.goto(`/images?q=${name.split(' ', 1)[0]}`);
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
  const gate = Promise.withResolvers<void>();
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
  const key = await signIn(page, request, baseURL!);
  await configureDeliveryDomain(request, baseURL!, 'shots.localhost', true);
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
  const gate = Promise.withResolvers<void>();
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

test('image search preserves filters and navigation and discards stale responses', async ({
  page,
  request,
  baseURL,
}) => {
  const key = await signIn(page, request, baseURL!);
  const term = 'search-fixture';
  const filename = `${term}.png`;
  await configureDeliveryDomain(request, baseURL!, 'shots.localhost', true);
  for (const [name, mimeType, fixture] of [
    [filename, 'image/png', 'metadata/clean.png'],
    [`${term}.jpg`, 'image/jpeg', 'upload.jpeg'],
  ]) {
    const uploaded = await request.post('/api/v1/images', {
      headers: { Authorization: `Bearer ${key}` },
      multipart: {
        file: {
          name,
          mimeType,
          buffer: await readFile(`tests/fixtures/${fixture}`),
        },
      },
    });
    expect(uploaded.status(), await uploaded.text()).toBe(201);
  }
  await page.goto('/images');
  const search = page.getByRole('textbox', { name: 'Search images' });
  const result = page.getByRole('heading', { name: filename, exact: true });
  await page.locator('#svelte-announcer').waitFor({ state: 'attached' });
  await search.fill(term);
  await expect(page).toHaveURL(/q=search-fixture/);
  await expect(
    page.getByRole('heading', { name: `${term}.jpg`, exact: true }),
  ).toBeVisible();
  await page.getByTitle('Filter images', { exact: true }).click();
  await page
    .getByRole('combobox', { name: 'Format', exact: true })
    .selectOption('png');
  await expect(page).toHaveURL(/type=png/);
  await expect(result).toBeVisible();
  await expect(
    page.getByRole('heading', { name: `${term}.jpg`, exact: true }),
  ).toHaveCount(0);
  await page.keyboard.press('Escape');
  const filtered = page.url();
  await result.click();
  await expect(
    page.getByRole('heading', { level: 1, name: filename }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Back to images' }).click();
  await expect(page).toHaveURL(filtered);
  await page.reload();
  await expect(search).toHaveValue(term);
  await expect(result).toBeVisible();
  await search.fill('no-such-image');
  await expect(
    page.getByRole('heading', { name: 'No images match your search.' }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(filtered);
  await expect(search).toHaveValue(term);
  await expect(result).toBeVisible();
  await page.getByRole('button', { name: 'Clear all', exact: true }).click();
  await expect(page).toHaveURL('/images');

  // A late response must not replace a newer search or restore a cleared query.
  for (const replacement of [term, '']) {
    await search.fill('');
    await expect(page).toHaveURL('/images');
    const hold = Promise.withResolvers<void>();
    const finished = Promise.withResolvers<void>();
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
    await search.fill(replacement);
    await expect(page).toHaveURL(
      replacement ? /q=search-fixture/ : /\/images$/,
    );
    hold.resolve();
    await finished.promise;
    await expect(search).toHaveValue(replacement);
    await expect(result).toBeVisible();
    await expect(page).not.toHaveURL(/delayed-no-match/);
    await page.unroute(pattern);
  }
});

test('audit search composes filters, paginates and retains navigation state', async ({
  page,
  request,
  baseURL,
  hearth,
}) => {
  await signIn(page, request, baseURL!);
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
  await signIn(page, request, baseURL!);
  await configureDeliveryDomain(request, baseURL!, 'shots.localhost', true);
  await page.goto('/images');
  const gate = Promise.withResolvers<void>();
  await page.locator('#svelte-announcer').waitFor({ state: 'attached' });
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
      name: 'invalid.png',
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
  await expect(
    page.getByLabel('Upload files').getByText(image(2).name, { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Delivery is unavailable.', { exact: false }),
  ).toHaveCount(2);
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
  hearth,
  page,
  request,
  baseURL,
}) => {
  await signIn(page, request, baseURL!);
  await configureDeliveryDomain(request, baseURL!, 'shots.localhost', true);
  await page.goto('/images');
  const first = Promise.withResolvers<void>();
  const remaining = Promise.withResolvers<void>();
  let started = 0;
  let aborted = 0;
  page.on('requestfailed', (request) => {
    if (request.url().endsWith('/api/upload')) aborted++;
  });
  await page.route('**/api/upload', async (route) => {
    const index = ++started;
    await (index === 1 ? first.promise : remaining.promise);
    if (index === 1) {
      await route.continue();
      return;
    }
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
  expect(
    (await hearth.DB.prepare('SELECT filename,deletedAt FROM images').all())
      .results,
  ).toEqual([{ filename: 'cancel-0.jpg', deletedAt: null }]);
  remaining.resolve();
  const result = page.getByRole('region', {
    name: 'Something went wrong notification',
  });
  await expect(result.locator('[data-state="completed"]')).toHaveCount(1);
  await expect(result.locator('[data-state="cancelled"]')).toHaveCount(3);
  await result.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(dialog).toHaveCount(0);
});
