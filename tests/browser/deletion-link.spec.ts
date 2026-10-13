import { readFile } from 'node:fs/promises';

import { z } from 'zod';

import { expect, test } from '../helpers/browser';

test('deletion links clear their secret while preserving history and completing deletion', async ({
  page,
  request,
  baseURL,
}) => {
  const uploaded = await request.post('/api/v1/images', {
    headers: {
      Authorization: `Bearer ${await readFile(process.env.TEST_KEY_FILE!, 'utf8')}`,
    },
    multipart: {
      file: {
        name: 'deletion-history.jpg',
        mimeType: 'image/jpeg',
        buffer: await readFile('tests/fixtures/upload.jpeg'),
      },
    },
  });
  expect(uploaded.status()).toBe(409);
  const image = z
    .object({ id: z.string(), deleteUrl: z.url() })
    .parse(await uploaded.json());
  const url = new URL(image.deleteUrl);
  const token = url.hash.slice(1);
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  await page.goto('/login');
  await page.goto(`${url.pathname}${url.hash}`);
  await expect(
    page.getByText('deletion-history.jpg', { exact: true }),
  ).toBeVisible();
  await expect(page).toHaveURL(baseURL + url.pathname);
  const state: unknown = await page.evaluate(() => history.state as unknown);
  expect(state).not.toBeNull();
  expect(JSON.stringify(state)).not.toContain(token);
  await page.getByRole('button', { name: 'Delete image', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Image removed', exact: true }),
  ).toBeVisible();
  await page.goBack();
  await expect(page).toHaveURL(baseURL + '/login');
  await expect(
    page.getByRole('heading', { name: 'Sign in', exact: true }),
  ).toBeVisible();
  await page.goForward();
  await expect(page).toHaveURL(baseURL + url.pathname);
  expect(await page.evaluate(() => location.hash)).toBe('');
  expect(errors).toEqual([]);
});
