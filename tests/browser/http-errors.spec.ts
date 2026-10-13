/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed request and binding results. */
import { readFile } from 'node:fs/promises';

import {
  httpErrorHeaders,
  renderHttpErrorDocument,
} from '../../packages/core/http-error';
import { expect, test } from '../helpers/browser';

test('unavailable pages recover without JavaScript and delivery errors conceal internal details', async ({
  proxy,
  browser,
  request,
  baseURL,
}) => {
  const context = await browser.newContext({
    proxy,
    javaScriptEnabled: false,
    baseURL,
  });
  try {
    const page = await context.newPage();
    expect((await page.goto('/missing-page'))?.status()).toBe(404);
    await expect(page.getByRole('heading')).toBeVisible();
    await page.locator('summary').click();
    await expect(page.locator('details')).toHaveAttribute('open', '');
    await page.getByRole('link', { name: 'Go home' }).click();
    await expect(page).toHaveURL(baseURL + '/login');
  } finally {
    await context.close();
  }
  const unavailable = await request.get(
    'http://127.0.0.1:' + process.env.TEST_DELIVERY_PORT! + '/missing-image',
  );
  expect(unavailable.status()).toBe(404);
  expect(await unavailable.text()).not.toMatch(
    /objectKey|SELECT |stack trace|userId/i,
  );
});

test('failed navigation supports retry and returning to the authenticated dashboard', async ({
  page,
  request,
  baseURL,
}) => {
  const key = await readFile(process.env.TEST_KEY_FILE!, 'utf8');
  expect(
    (
      await request.post('/api/actions/login', {
        headers: { Origin: baseURL! },
        data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
      })
    ).status(),
  ).toBe(200);
  await page.context().addCookies((await request.storageState()).cookies);
  await page.goto('/');
  await page.route('**/temporary-failure', async (route) => {
    await route.fulfill({
      status: 503,
      headers: Object.fromEntries(httpErrorHeaders(baseURL)),
      body: renderHttpErrorDocument(503, 'page', 'Test workspace', baseURL),
    });
  });
  await page.goto('/temporary-failure');
  const retry = page.waitForRequest('**/temporary-failure');
  await page.getByRole('link', { name: 'Try again' }).click();
  await retry;
  await page.getByRole('link', { name: 'Go home' }).click();
  await expect(
    page.getByRole('navigation', { name: 'Main navigation' }),
  ).toBeVisible();
});

test('client navigation errors use the supplied error status and recover on navigation', async ({
  page,
  request,
  baseURL,
}) => {
  const key = await readFile(process.env.TEST_KEY_FILE!, 'utf8');
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  expect(login.status()).toBe(200);
  await page.context().addCookies((await request.storageState()).cookies);
  await page.goto('/');
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByText('Dashboard refreshed.', { exact: true }),
  ).toBeVisible();
  await page.evaluate(() => {
    const link = document.createElement('a');
    link.href = '/missing-page';
    link.textContent = 'Missing page';
    // eslint-disable-next-line unicorn/prefer-dom-node-append -- Workers and DOM Element.append declarations conflict.
    document.querySelector('#main')!.appendChild(link);
  });
  await page.getByRole('link', { name: 'Missing page', exact: true }).click();
  await expect(
    page.getByRole('heading', {
      name: "We couldn't find that page",
      exact: true,
    }),
  ).toBeVisible();
  await expect(page).toHaveTitle(/^404 /);
  await page.getByRole('link', { name: 'Go home', exact: true }).click();
  await expect(
    page.getByRole('heading', { name: 'Overview', exact: true }),
  ).toBeVisible();
});
