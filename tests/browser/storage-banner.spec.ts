/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed browser API responses. */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

import { createUser } from '../../packages/core/auth';
import { expect, test } from '../helpers/browser';

const pixel = {
  name: 'pixel.png',
  mimeType: 'image/png',
  buffer: Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
    'base64',
  ),
};

test('storage banner follows thresholds, role priority, navigation and focus refresh', async ({
  hearth,
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(120_000);
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: {
      key: await readFile(process.env.TEST_KEY_FILE!, 'utf8'),
      token: 'XXXX.DUMMY.TOKEN.XXXX',
    },
  });
  expect(login.status()).toBe(200);
  await page.context().addCookies((await request.storageState()).cookies);
  await page.goto('/settings');
  expect((await request.get('/api/settings?admin')).status()).toBe(200);
  const banner = page.locator('.delivery-notice');
  await expect(banner).toContainText('Uploads will save privately.');
  await hearth.DB.prepare('UPDATE users SET quotaBytes=1000').run();
  await hearth.DB.prepare('UPDATE user_storage_stats SET bytes=989').run();
  await hearth.DB.prepare(
    'UPDATE storage_capacity SET ready=1,limitBytes=1000,persistedBytes=989 WHERE id=1',
  ).run();
  await page.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
  await expect(banner).toContainText('Uploads will save privately.');
  const other = await createUser(
    hearth.DB,
    'Other storage owner',
    'user',
    null,
  );
  await hearth.DB.prepare('UPDATE users SET quotaBytes=0 WHERE id=?')
    .bind(other.userId)
    .run();
  await hearth.DB.prepare(
    'UPDATE user_storage_stats SET bytes=5000 WHERE userId=?',
  )
    .bind(other.userId)
    .run();
  await page.goto('/admin');
  await expect(banner).toContainText('Uploads will save privately.');
  await hearth.DB.prepare('UPDATE user_storage_stats SET bytes=990').run();
  await hearth.DB.prepare(
    'UPDATE storage_capacity SET persistedBytes=990 WHERE id=1',
  ).run();
  // Navigation also reads the threshold projection on every dashboard surface.
  for (const path of [
    '/',
    '/images',
    '/links',
    '/domains',
    '/settings',
    '/admin',
    '/admin/images',
    '/admin/links',
    '/admin/domains',
    '/admin/users',
    '/admin/storage',
    '/admin/settings',
    '/admin/audit-log',
  ]) {
    await page.goto(path);
    await expect(banner).toHaveCount(1);
    await expect(banner).toContainText('Instance storage is nearly full.');
    await expect(
      banner.getByRole('link', { name: 'Manage storage' }),
    ).toHaveAttribute('href', '/admin/storage');
  }
  await hearth.DB.prepare('UPDATE user_storage_stats SET bytes=1000').run();
  await page.goto('/settings');
  await expect(banner).toContainText('Your storage is full.');
  const manageImages = banner.getByRole('link', { name: 'Manage images' });
  await expect(manageImages).toHaveAttribute('href', '/images');
  await manageImages.focus();
  await expect(manageImages).toBeFocused();
  await page.setViewportSize({ width: 320, height: 720 });
  await expect(banner).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await expect(page.locator('#main-navigation')).toHaveJSProperty(
    'inert',
    true,
  );
  await hearth.DB.prepare(
    'UPDATE storage_capacity SET persistedBytes=1000 WHERE id=1',
  ).run();
  await page.goto('/admin');
  await expect(banner).toContainText('Instance storage is full.');

  const regular = await createUser(hearth.DB, 'Banner user', 'user', null);
  await hearth.DB.prepare(
    "UPDATE users SET onboardingStatus='exempt',quotaBytes=1000 WHERE id=?",
  )
    .bind(regular.userId)
    .run();
  await hearth.DB.prepare(
    'UPDATE user_storage_stats SET bytes=1000 WHERE userId=?',
  )
    .bind(regular.userId)
    .run();
  await page.context().clearCookies();
  await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: { key: regular.key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  await page.context().addCookies((await request.storageState()).cookies);
  await page.goto('/settings');
  await expect(banner).toContainText('Your storage is full.');
  expect((await request.get('/api/settings?admin')).status()).toBe(403);
  await expect(
    banner.getByRole('link', { name: 'Manage images' }),
  ).toBeVisible();
  await hearth.DB.prepare(
    'UPDATE user_storage_stats SET bytes=0 WHERE userId=?',
  )
    .bind(regular.userId)
    .run();
  const refreshed = page.waitForResponse((response) =>
    response.url().includes('/api/settings'),
  );
  await page.evaluate(() => globalThis.dispatchEvent(new Event('focus')));
  const data = await (await refreshed).text();
  expect(data).not.toContain('persistedBytes');
  expect(data).not.toContain('reservedBytes');
  expect(data).not.toContain('limitBytes');
  await expect(banner).toContainText(
    'Instance storage is full. New uploads are temporarily unavailable. Please try again later.',
  );
  await expect(banner.getByRole('link')).toHaveCount(0);
  await hearth.DB.prepare(
    'UPDATE storage_capacity SET limitBytes=NULL WHERE id=1',
  ).run();
  // Force the visibility-resume path, which also coalesces companion focus events.
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'hidden',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    Object.defineProperty(document, 'visibilityState', {
      configurable: true,
      value: 'visible',
    });
    document.dispatchEvent(new Event('visibilitychange'));
    globalThis.dispatchEvent(new Event('focus'));
  });
  await expect(banner).toContainText('Uploads will save privately.');
  await page.goto('/domains');
  await expect(banner).toHaveCount(0);
});

test('real quota failures below the threshold use upload notifications and successful deletion clears the banner', async ({
  hearth,
  page,
  request,
  baseURL,
}) => {
  test.setTimeout(60_000);
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: {
      key: await readFile(process.env.TEST_KEY_FILE!, 'utf8'),
      token: 'XXXX.DUMMY.TOKEN.XXXX',
    },
  });
  expect(login.status()).toBe(200);
  await page.context().addCookies((await request.storageState()).cookies);
  await hearth.DB.prepare(
    'UPDATE storage_capacity SET ready=1 WHERE id=1',
  ).run();
  await page.goto('/images');
  const banner = page.locator('.delivery-notice');
  for (const scope of ['personal', 'instance']) {
    await hearth.DB.prepare('UPDATE users SET quotaBytes=?')
      .bind(scope === 'personal' ? 1 : null)
      .run();
    await hearth.DB.prepare(
      'UPDATE storage_capacity SET limitBytes=? WHERE id=1',
    )
      .bind(scope === 'instance' ? 1 : null)
      .run();
    const failed = page.waitForResponse('/api/upload');
    await page.locator('input[type=file]').setInputFiles(pixel);
    expect((await failed).status()).toBe(413);
    await expect(page.locator('.notification-deck')).toContainText(
      scope === 'personal'
        ? 'Not enough storage in your quota'
        : 'Not enough instance storage',
    );
    await expect(banner).toContainText('Uploads will save privately.');
    await page.getByRole('button', { name: 'Dismiss notification' }).click();
  }
  await hearth.DB.prepare(
    'UPDATE storage_capacity SET limitBytes=NULL WHERE id=1',
  ).run();
  const saved = page.waitForResponse('/api/upload');
  await page.locator('input[type=file]').setInputFiles(pixel);
  const image = (await (await saved).json()) as { id: string };
  await expect(page.locator('.image-card')).toHaveCount(1);
  await hearth.DB.prepare('UPDATE users SET quotaBytes=?')
    .bind(pixel.buffer.length)
    .run();
  await page.goto(`/images/${image.id}`);
  await expect(banner).toContainText('Your storage is full.');
  await page.getByRole('button', { name: 'Delete image', exact: true }).click();
  await page
    .getByRole('dialog')
    .getByRole('button', { name: 'Confirm', exact: true })
    .click();
  await expect(banner).toContainText('Uploads will save privately.');
  await expect(page).toHaveURL(/\/images$/);
});
