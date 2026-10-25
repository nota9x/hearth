/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed request and binding results. */
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
