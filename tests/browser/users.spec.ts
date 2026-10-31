/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed HTTP responses directly. */
import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { expect, signIn, test } from '../helpers/browser';
import { configureDeliveryDomain } from '../helpers/delivery';

test('Users searches, restores state, and manages scoped overviews and account actions', async ({
  hearth,
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(240_000);
  await signIn(page, request, baseURL!);
  const headers = { Origin: baseURL! };
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  const stamp = 123_456_789;
  const prefix = `Users fixture ${stamp}`;
  const created = await request.post('/api/actions/user-create', {
    headers,
    data: {
      displayName: `${prefix} target`,
      role: 'user',
      token: 'XXXX.DUMMY.TOKEN.XXXX',
    },
  });
  expect(created.status()).toBe(200);
  const member = z
    .object({ userId: z.string(), key: z.string() })
    .parse(await created.json());
  await hearth.DB.prepare(
    "UPDATE users SET onboardingStatus='exempt' WHERE id=?",
  )
    .bind(member.userId)
    .run();
  await configureDeliveryDomain(
    request,
    baseURL!,
    `usersqa-${stamp}.localhost`,
    true,
  );
  await hearth.DB.prepare(
    `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<25) INSERT INTO users(id,displayName,status,createdAt,updatedAt) SELECT 'usr_'||lower(hex(randomblob(16))),'${prefix} '||x,CASE WHEN x=1 THEN 'deleted' WHEN x=2 THEN 'disabled' ELSE 'active' END,unixepoch()+x,unixepoch() FROM n;`,
  ).run();
  for (let n = 0; n < 9; n++) {
    const image = await request.post('/api/v1/images', {
      headers: { Authorization: `Bearer ${member.key}` },
      multipart: {
        file: {
          name: `usersqa-${stamp}-${n}.gif`,
          mimeType: 'image/gif',
          buffer: await readFile('tests/fixtures/animated.gif'),
        },
      },
    });
    expect(image.status(), await image.text()).toBe(201);
  }
  await page.goto('/admin');
  await page.goto('/admin/storage');
  await page
    .getByRole('link', { name: 'View all users by storage usage' })
    .click();
  await expect(page).toHaveURL(/\/admin\/users\?sort=storage$/);
  await page.goto('/admin/users');
  await page
    .getByRole('textbox', { name: 'Search users', exact: true })
    .fill(prefix);
  await expect(page).toHaveURL(new RegExp(`q=Users`));
  await expect(page.locator('.user-table tbody tr')).toHaveCount(24);
  await page.getByRole('link', { name: 'Page 2', exact: true }).click();
  await expect(page).toHaveURL(/page=2/);
  await page.reload();
  await expect(page.getByRole('textbox', { name: 'Search users' })).toHaveValue(
    prefix,
  );
  await expect(
    page.getByRole('link', { name: 'Page 2', exact: true }),
  ).toHaveAttribute('aria-current', 'page');
  await page.goBack();
  await expect(page).not.toHaveURL(/page=2/);
  await page.goForward();
  await expect(page).toHaveURL(/page=2/);
  await page.getByLabel(/Filter users/).click();
  await page
    .getByRole('combobox', { name: 'Account status' })
    .selectOption('deleted');
  await expect(page).toHaveURL(/status=deleted/);
  await expect(page).not.toHaveURL(/page=2/);
  await expect(page.locator('.user-table tbody tr')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page
    .getByRole('textbox', { name: 'Search users' })
    .fill('unmatched-' + stamp);
  await expect(
    page.getByRole('heading', { name: 'No users match your search' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Clear search and filters' }).click();
  await expect(page.getByRole('textbox', { name: 'Search users' })).toHaveValue(
    '',
  );
  await page.goto(`/admin/users?q=${encodeURIComponent(prefix)}&sort=oldest`);
  const row = page.locator('tr').filter({
    has: page.getByRole('link', { name: `${prefix} target`, exact: true }),
  });
  const menu = row.getByLabel(`Actions for ${prefix} target`);
  await menu.click();
  await expect(row.getByRole('link', { name: 'View images' })).toHaveAttribute(
    'href',
    `/admin/images?owner=${member.userId}`,
  );
  await page.keyboard.press('Escape');
  await expect(menu).toBeFocused();
  await row
    .getByRole('link', { name: `${prefix} target`, exact: true })
    .click();
  await expect(
    page.getByRole('heading', { name: `${prefix} target`, exact: true }),
  ).toBeVisible();
  await expect(page.locator('.image-card')).toHaveCount(8);
  await expect(page.locator('dl.statistics dd').first()).toHaveText('9');
  await expect(page.locator('.audit-entry')).toHaveCount(5);
  const overviewLogs = await page.locator('.audit-entry').all();
  for (const log of overviewLogs)
    await expect(
      log.locator('summary a[href^="/admin/users/"]').first(),
    ).toHaveAttribute('href', `/admin/users/${member.userId}`);
  await expect(
    page.getByRole('link', { name: 'Back to users' }),
  ).toHaveAttribute(
    'href',
    `/admin/users?q=${encodeURIComponent(prefix).replaceAll('%20', '+')}&sort=oldest`,
  );
  await page.getByRole('link', { name: 'Page 2', exact: true }).click();
  await expect(page).toHaveURL(/imagePage=2/);
  await expect(page.locator('.image-card')).toHaveCount(1);
  await page
    .getByRole('link', { name: 'View all images', exact: true })
    .click();
  await expect(page).toHaveURL(
    new RegExp(String.raw`/admin/images\?owner=${member.userId}`),
  );
  await expect(page.locator('.image-card')).toHaveCount(9);
  await page.locator('.image-card a.image-owner').first().click();
  await expect(page).toHaveURL(new RegExp(`/admin/users/${member.userId}`));
  await page.locator('.image-card .image-preview a').first().click();
  await expect(page).toHaveURL(/\/admin\/images\/img_/);
  await page.locator('main > p a[href^="/admin/users/"]').click();
  await page.getByRole('link', { name: 'View all audit events' }).click();
  await expect(page).toHaveURL(new RegExp(`actorId=${member.userId}`));
  await page
    .locator('.audit-entry summary a[href^="/admin/users/"]')
    .first()
    .click();
  await page.setViewportSize({ width: 1440, height: 1000 });
  const settings = page.locator('details.disclosure').filter({
    has: page.locator('summary').filter({
      has: page.getByText('Account configuration', { exact: true }),
    }),
  });
  await settings.locator('summary').click();
  await settings
    .getByRole('textbox', { name: 'Display name' })
    .fill(`${prefix} renamed`);
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    settings.getByRole('textbox', { name: 'Display name' }),
  ).toHaveValue(`${prefix} renamed`);
  const saved = page.waitForResponse('**/api/actions/user-update');
  await settings
    .getByRole('button', { name: 'Save user', exact: true })
    .click();
  expect((await saved).status()).toBe(200);
  await expect(
    page.getByRole('heading', { name: `${prefix} renamed` }),
  ).toBeVisible();
  await settings
    .getByRole('combobox', { name: 'Account status' })
    .selectOption('disabled');
  await settings
    .getByRole('button', { name: 'Save user', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Reset credential', exact: true }),
  ).toBeDisabled();
  await settings
    .getByRole('combobox', { name: 'Account status' })
    .selectOption('active');
  await settings
    .getByRole('button', { name: 'Save user', exact: true })
    .click();
  await expect(
    page.getByRole('button', { name: 'Reset credential', exact: true }),
  ).toBeEnabled();
  await page
    .getByRole('button', { name: 'Reset credential', exact: true })
    .click();
  const dialog = page.getByRole('dialog');
  await expect(
    dialog.getByRole('button', { name: 'Confirm', exact: true }),
  ).toBeEnabled({ timeout: 30_000 });
  const reset = page.waitForResponse('**/api/actions/user-reset');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  expect((await reset).status()).toBe(200);
  await expect(dialog.locator('.secret')).toBeVisible();
  await dialog.getByRole('button', { name: 'I’ve saved it' }).click();
  await hearth.DB.prepare(
    `WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<24) INSERT INTO users(id,displayName,createdAt,updatedAt) SELECT 'usr_'||lower(hex(randomblob(16))),'${prefix} renamed '||x,0,0 FROM n;`,
  ).run();
  const recovery = new URLSearchParams({
    q: `${prefix} renamed`,
    sort: 'oldest',
    page: '2',
  });
  await page.goto(`/admin/users?${recovery}`);
  await expect(page.locator('.user-table tbody tr')).toHaveCount(1);
  await page
    .getByRole('link', { name: `${prefix} renamed`, exact: true })
    .click();
  await page.getByRole('button', { name: 'Delete user', exact: true }).click();
  await expect(
    dialog.getByRole('button', { name: 'Confirm', exact: true }),
  ).toBeEnabled({ timeout: 30_000 });
  const removed = page.waitForResponse('**/api/actions/user-delete');
  await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  expect((await removed).status()).toBe(200);
  await expect(page).toHaveURL(`/admin/users?${recovery}`);
  await expect(page.locator('.user-table tbody tr')).toHaveCount(24);
  await page.goto(`/admin/users/${member.userId}`);
  await expect(
    page.getByRole('heading', { name: 'No images owned by this user' }),
  ).toBeVisible();
  await expect(
    page.getByRole('button', { name: 'Delete user', exact: true }),
  ).toBeDisabled();
  await page.getByRole('link', { name: 'Back to users' }).click();
  await page
    .getByRole('button', { name: 'Invite someone', exact: true })
    .click();
  await dialog
    .getByRole('textbox', { name: 'Display name' })
    .fill(`Invited ${stamp}`);
  await expect(
    dialog.getByRole('button', { name: 'Create invitation' }),
  ).toBeEnabled({ timeout: 30_000 });
  const invited = page.waitForResponse('**/api/actions/user-create');
  await dialog.getByRole('button', { name: 'Create invitation' }).click();
  expect((await invited).status()).toBe(200);
  await expect(dialog.locator('.secret')).toBeVisible();
  await dialog.getByRole('button', { name: 'I’ve saved it' }).click();
  expect(errors).toEqual([]);
});

test('Users restores interrupted searches and recovers from collection load failure', async ({
  page,
  request,
  baseURL,
}) => {
  await signIn(page, request, baseURL!);
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  await page.goto('/admin/users');
  await page.locator('#svelte-announcer').waitFor({ state: 'attached' });
  const search = page.getByRole('textbox', { name: 'Search users' });
  await search.fill('unmatched');
  await expect(
    page.getByRole('heading', { name: 'No users match your search' }),
  ).toBeVisible();
  await search.fill('cancel-me');
  await page.getByRole('button', { name: 'Clear search', exact: true }).click();
  await expect(search).toHaveValue('');
  await expect(page).not.toHaveURL(/q=/);
  await page.unroute('**/admin/users/__data.json?*');
  await page.route('**/admin/users/__data.json?*', async (route) => {
    await route.fulfill({
      json: {
        type: 'data',
        nodes: [
          { type: 'skip' },
          {
            type: 'error',
            error: { status: 500, message: 'The user list is unavailable.' },
          },
        ],
      },
    });
  });
  await search.fill('failure');
  await expect(
    page.getByRole('heading', { name: 'Something went wrong on our end' }),
  ).toBeVisible();
  await page.unroute('**/admin/users/__data.json?*');
  await page.getByRole('link', { name: 'Try again', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'No users match your search' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Clear search and filters' }).click();
  await expect(page).not.toHaveURL(/q=/);
  expect(errors).toEqual([]);
});
