/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect HTTP responses directly. */
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { id, now } from '../../packages/core/common';
import { expect, signIn, test } from '../helpers/browser';
import { configureDeliveryDomain } from '../helpers/delivery';

test('Links shares collection controls and manages primary and unshared images', async ({
  hearth,
  proxy,
  page,
  request,
  baseURL,
  browser,
}) => {
  test.setTimeout(180_000);
  const key = await signIn(page, request, baseURL!);
  const headers = { Origin: baseURL! };
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  const stamp = 123_456_789,
    slug = `linksqa-${stamp}`;
  const domain = await configureDeliveryDomain(
    request,
    baseURL!,
    `linksqa-${stamp}.localhost`,
  );
  const preference = await request.post('/api/actions/delivery-preference', {
    headers,
    data: { deliveryDomainId: domain.id },
  });
  expect(preference.status()).toBe(200);
  const uploaded = await request.post('/api/v1/images', {
    headers: { Authorization: `Bearer ${key}` },
    multipart: {
      file: {
        name: `linksqa-${stamp}.gif`,
        mimeType: 'image/gif',
        buffer: await readFile('tests/fixtures/animated.gif'),
      },
    },
  });
  expect(uploaded.status()).toBe(201);
  const image = z
    .object({ id: z.string(), url: z.string() })
    .parse(await uploaded.json());
  await page.goto(`/images?q=linksqa-${stamp}`);
  const card = page
    .locator('.image-card')
    .filter({ hasText: `linksqa-${stamp}.gif` });
  const imageMenu = card.getByLabel(`Actions for linksqa-${stamp}.gif`);
  await imageMenu.click();
  await imageMenu.click();
  await page.getByRole('heading', { name: 'Images', exact: true }).click();
  await expect(card.locator('details')).not.toHaveAttribute('open', '');
  await imageMenu.click();
  await card.getByRole('button', { name: 'Copy image ID' }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(image.id);
  await expect(card.locator('details')).not.toHaveAttribute('open', '');
  for (const name of ['Change expiry', 'Create share link', 'Delete image']) {
    await imageMenu.click();
    await card.getByRole('button', { name, exact: true }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(card.locator('details')).not.toHaveAttribute('open', '');
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
  }
  const timestamp = now();
  const unavailableHost = id('dom');
  const fixture = Array.from(
    { length: 102 },
    (_, index) =>
      `('${id('lnk')}','${image.id}',${index === 2 ? `'${unavailableHost}'` : `(SELECT deliveryDomainId FROM aliases WHERE imageId='${image.id}' LIMIT 1)`},'${slug}-${index}',${timestamp + index},${index === 0 ? timestamp + 3600 : index === 1 ? timestamp - 3600 : 'NULL'})`,
  ).join(',');
  await hearth.DB.batch([
    hearth.DB.prepare(
      `INSERT INTO delivery_domains(id,hostname,health,createdAt,updatedAt) VALUES ('${unavailableHost}','unavailable-${stamp}.localhost','active',${timestamp},${timestamp})`,
    ),
    hearth.DB.prepare(
      `INSERT INTO aliases(id,imageId,deliveryDomainId,slug,createdAt,expiresAt) VALUES ${fixture}`,
    ),
    hearth.DB.prepare('UPDATE delivery_domains SET enabled=0 WHERE id=?').bind(
      unavailableHost,
    ),
  ]);
  for (const status of ['expired', 'unavailable']) {
    await page.goto(`/links?image=${image.id}&status=${status}`);
    await expect(page.locator('.link-row')).toHaveCount(1);
    await expect(
      page
        .locator('.link-row')
        .getByRole('link', { name: 'Open link', exact: true }),
    ).toHaveCount(0);
    await page
      .locator('.link-row')
      .getByLabel(`Actions for ${slug}-${status === 'expired' ? 1 : 2}`)
      .click();
    await expect(
      page.getByRole('button', { name: 'Make primary', exact: true }),
    ).toBeDisabled();
  }
  await page.goto(`/links?image=${image.id}`);
  const pagination = page.getByRole('navigation', { name: 'Pagination' });
  await expect(page.locator('.collection-search')).toBeVisible();
  await expect(pagination.getByLabel('Previous page')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await expect(
    pagination.getByRole('link', { name: 'Page 1', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await pagination.getByRole('link', { name: 'Page 5', exact: true }).click();
  await expect(pagination.getByLabel('Next page')).toHaveAttribute(
    'aria-disabled',
    'true',
  );
  await page.getByRole('textbox', { name: 'Search links' }).fill(`${slug}-0`);
  await expect(page.locator('.link-row')).toHaveCount(1);
  await expect(page).not.toHaveURL(/page=5/);
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(page.locator('.link-row')).toHaveCount(24);
  const chosen = page.locator('.link-row').first();
  await chosen.getByLabel(/^Actions for /).click();
  await expect(
    chosen.getByRole('button', { name: 'Copy slug', exact: true }),
  ).toHaveText('Copy slug');
  await page.getByRole('heading', { name: 'Links', exact: true }).hover();
  await chosen.getByRole('button', { name: 'Copy slug', exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(`${slug}-101`);
  await expect(chosen.locator('details')).not.toHaveAttribute('open', '');
  await chosen.getByLabel(/^Actions for /).click();
  await chosen
    .getByRole('button', { name: 'Make primary', exact: true })
    .click();
  await expect(chosen).toContainText('Primary');
  await page.goto(
    `/links?image=${image.id}&q=${new URL(image.url).pathname.slice(1)}`,
  );
  await page
    .locator('.link-row')
    .getByLabel(/^Actions for /)
    .click();
  await page.getByRole('button', { name: 'Make primary', exact: true }).click();
  await expect(page.locator('.link-row')).toContainText('Primary');
  await page.goto(`/links?image=${image.id}`);
  await page.getByLabel('Sort links').click();
  await page.keyboard.press('Escape');
  await expect(
    page.getByRole('checkbox', { name: 'Select this page' }),
  ).toHaveCount(0);
  await page
    .getByRole('checkbox', { name: /^Select link / })
    .first()
    .check();
  await expect(page.getByText('1 selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(page.getByText('103 selected', { exact: true })).toBeVisible();
  await pagination.getByRole('link', { name: 'Page 2', exact: true }).click();
  await expect(page.getByText('103 selected', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy links', exact: true }).click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => navigator.clipboard.readText())).split('\n')
          .length,
    )
    .toBe(103);
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(
    copied
      .split('\n')
      .every(
        (url) =>
          new URL(url).host === new URL(image.url).host ||
          new URL(url).host ===
            `unavailable-${stamp}.localhost:${new URL(image.url).port}`,
      ),
  ).toBe(true);
  await page
    .getByRole('button', { name: 'Change expiry', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: 'Link expiration' })
    .selectOption('1h');
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: 'Link expiration' })
    .selectOption('custom');
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: 'Link expiration' })
    .selectOption('1h');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save expiry' })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.getByLabel(/Filter links/).click();
  await page
    .getByRole('combobox', { name: 'Status', exact: true })
    .selectOption('soon');
  await expect(page).not.toHaveURL(/page=2/);
  await expect(page.locator('.link-row').first()).toContainText(
    'Expiring soon',
  );
  await page.getByLabel(/Filter links/).click();
  await page.goto(
    `/links?image=${image.id}&q=${new URL(image.url).pathname.slice(1)}`,
  );
  await expect(page.locator('.link-row')).toHaveCount(1);
  const row = page.locator('.link-row');
  await expect(row).toContainText('Primary');
  await row
    .getByLabel(`Actions for ${new URL(image.url).pathname.slice(1)}`)
    .click();
  await page.keyboard.press('Escape');
  await expect(row.locator('details')).not.toHaveAttribute('open', '');
  await expect(row.locator('summary')).toBeFocused();
  await row
    .getByLabel(`Actions for ${new URL(image.url).pathname.slice(1)}`)
    .click();
  await row.getByRole('button', { name: 'Delete share link' }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'underlying images will remain stored',
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(page.locator('.link-row')).toHaveCount(0);
  await page.goto(`/images/${image.id}?q=linksqa-${stamp}&page=3`);
  await expect(
    page.getByRole('link', { name: /Manage all .* share links/ }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('checkbox', { name: /^Select link / }),
  ).toHaveCount(24);
  await page
    .getByRole('checkbox', { name: /^Select link / })
    .first()
    .check();
  await expect(
    page.getByRole('group', { name: 'Selected link actions' }),
  ).toContainText('1 selected');
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await pagination.getByRole('link', { name: 'Page 5', exact: true }).click();
  await expect(page).toHaveURL(/linkPage=5/);
  expect(new URL(page.url()).searchParams.get('page')).toBe('3');
  await expect(
    page.getByRole('link', { name: 'Back to images' }),
  ).not.toHaveAttribute('href', /linkPage/);
  const linkBulk = page.getByRole('group', { name: 'Selected link actions' });
  await linkBulk
    .getByRole('button', { name: 'Copy links', exact: true })
    .click();
  await expect
    .poll(
      async () =>
        (await page.evaluate(() => navigator.clipboard.readText())).split('\n')
          .length,
    )
    .toBe(102);
  await linkBulk
    .getByRole('button', { name: 'Change expiry', exact: true })
    .click();
  await page
    .getByRole('dialog')
    .getByRole('combobox', { name: 'Link expiration' })
    .selectOption('1h');
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Save expiry', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(linkBulk).toHaveCount(0);
  await page
    .getByRole('checkbox', { name: /^Select link / })
    .first()
    .check();
  await page.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(page.getByText('102 selected', { exact: true })).toBeVisible();
  await page.route('**/api/actions/alias-delete', async (route) => {
    const { ids } = z
      .object({ ids: z.array(z.string()) })
      .parse(route.request().postDataJSON());
    if (ids.length === 100) {
      await route.continue();
      return;
    }
    const response = await route.fetch({
      postData: JSON.stringify({ ids: ids.slice(0, -1) }),
    });
    expect(response.status()).toBe(200);
    await route.fulfill({
      json: {
        deletedIds: ids.slice(0, -1),
        alreadyRemovedIds: [],
        failed: [
          { id: ids.at(-1), code: 'UNAVAILABLE', message: 'Please try again.' },
        ],
      },
    });
  });
  await linkBulk.getByRole('button', { name: 'Delete', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  const deletionNotice = page.getByRole('region', {
    name: 'Something went wrong notification',
  });
  await expect(deletionNotice).toContainText('101 of 102 deleted · 1 failed');
  await deletionNotice.getByRole('button', { name: 'Show details' }).click();
  const notificationRows = deletionNotice
    .getByLabel('Deletion items')
    .locator('.item-row');
  await expect(notificationRows).toHaveCount(20);
  await expect(notificationRows.first()).toHaveAttribute(
    'data-state',
    'failed',
  );
  await expect(notificationRows.nth(1)).toHaveAttribute(
    'data-state',
    'completed',
  );
  await expect(deletionNotice).toContainText('Page 1 of 6');
  await deletionNotice.getByRole('button', { name: 'Next items' }).click();
  await expect(
    deletionNotice
      .getByLabel('Deletion items')
      .locator('[data-state="failed"]'),
  ).toHaveCount(0);
  await deletionNotice.getByRole('button', { name: 'Previous items' }).click();
  await expect(notificationRows.first()).toHaveAttribute(
    'data-state',
    'failed',
  );
  await deletionNotice
    .getByRole('button', { name: 'Dismiss notification' })
    .click();
  await page.unroute('**/api/actions/alias-delete');
  await expect(linkBulk).toContainText('1 selected');
  await linkBulk.getByRole('button', { name: 'Delete', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: "This image isn't currently shared." }),
  ).toBeVisible({ timeout: 30_000 });
  await page.goto(`/links?image=${image.id}`);
  await expect(
    page.getByRole('heading', { name: 'No links match your search.' }),
  ).toBeVisible();
  await page.goto(`/images/${image.id}`);
  await expect(
    page.getByRole('heading', { name: "This image isn't currently shared." }),
  ).toBeVisible();
  await page.goto(`/images?q=linksqa-${stamp}`);
  await expect(
    card.getByRole('button', { name: 'Create share link', exact: true }),
  ).toBeVisible();
  await expect(
    card.getByRole('button', { name: 'Copy link', exact: true }),
  ).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Create share link', exact: true })
    .click();
  await expect(
    page
      .getByRole('dialog')
      .getByRole('button', { name: 'Create link', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Create link', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('button', { name: 'Copy link', exact: true }),
  ).toBeVisible();
  await page.goto(`/images/${image.id}`);
  await expect(page.locator('.link-row')).toContainText('Never expires');
  await page
    .locator('.link-row')
    .getByLabel(/^Actions for /)
    .click();
  await page
    .getByRole('button', { name: 'Delete share link', exact: true })
    .click();
  await expect(page.getByRole('dialog')).toContainText(
    "This is the image's only share link.",
  );
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Cancel', exact: true })
    .click();
  await expect(page.locator('.link-row summary')).toBeFocused();
  await page.goto('/');
  await page.goto('/admin/users');
  await page.goto(`/admin/links?image=${image.id}`);
  await page.getByLabel(/Filter links/).click();
  await expect(
    page.getByRole('combobox', { name: 'Owner', exact: true }),
  ).toHaveCount(1);
  await expect(page.locator('.link-row')).toContainText('Primary');
  const account = await request.post('/api/actions/user-create', {
    headers,
    data: {
      displayName: `Empty Links ${stamp}`,
      role: 'user',
      token: 'XXXX.DUMMY.TOKEN.XXXX',
    },
  });
  expect(account.status()).toBe(200);
  const member = z
    .object({ userId: z.string(), key: z.string() })
    .parse(await account.json());
  await hearth.DB.prepare(
    "UPDATE users SET onboardingStatus='exempt' WHERE id=?",
  )
    .bind(member.userId)
    .run();
  const memberContext = await browser.newContext({ proxy, baseURL });
  try {
    const signedIn = await memberContext.request.post('/api/actions/login', {
      headers,
      data: { key: member.key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
    });
    expect(signedIn.status()).toBe(200);
    const memberPage = await memberContext.newPage();
    await memberPage.goto('/links');
    await expect(
      memberPage.getByRole('heading', {
        name: 'No share links yet',
        exact: true,
      }),
    ).toBeVisible();
    await memberPage.getByLabel(/Filter links/).click();
    await expect(
      memberPage.getByRole('combobox', { name: 'Owner', exact: true }),
    ).toHaveCount(0);
    await memberPage.goto('/images');
    await expect(
      memberPage.getByRole('heading', { name: 'No images yet', exact: true }),
    ).toBeVisible();
  } finally {
    await memberContext.close();
  }
  expect(errors).toEqual([]);
});
