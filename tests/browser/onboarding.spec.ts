import { readFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { createUser } from '../../packages/core/auth';
import { expect, test } from '../helpers/browser';
import { configureDeliveryDomain } from '../helpers/delivery';

test.use({ accountMode: 'new' });

function stepButton(page: Page, name: string) {
  return page
    .getByRole('navigation', { name: 'Setup progress' })
    .getByRole('button', { name, exact: true });
}

async function signIn(page: Page, credential?: string) {
  const key =
    credential ?? (await readFile(process.env.TEST_KEY_FILE!, 'utf8'));
  await page.goto('/login');
  await page.getByLabel('Your API key').fill(key);
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page).toHaveURL(/\/onboarding$/);
  return key;
}
async function start(page: Page) {
  await page.getByRole('button', { name: 'Get started', exact: true }).click();
  await expect(page.getByLabel('Your display name')).toBeVisible();
}
async function sharexStep(page: Page) {
  await start(page);
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByRole('group', { name: 'Your delivery selection' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByRole('group', { name: 'Default image expiration' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByLabel('Current API key', { exact: true }),
  ).toBeVisible();
}

async function sharexUpload(page: Page, baseURL: string, key: string) {
  return page.request.post(`${baseURL}/api/v1/images`, {
    headers: {
      Authorization: `Bearer ${key}`,
      'Content-Type':
        'multipart/form-data; boundary=--------------------8df2247211d47b0',
      'User-Agent': 'ShareX/21.0.0',
    },
    data: await readFile('tests/fixtures/sharex/sharex21-multipart.bin'),
  });
}

test('navigates freely, arms only the image check, and preserves drafts across every step', async ({
  page,
  hearth,
}) => {
  await signIn(page);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (/\/api\/actions\/|__data\.json/.test(request.url()))
      requests.push(request.url());
  });
  await stepButton(page, 'Your name').click();
  await page.getByLabel('Your display name').fill('Draft name');
  await stepButton(page, 'Image lifetime').click();
  await page.getByRole('radio', { name: /A custom duration/ }).check();
  await page.getByLabel('Duration in seconds').fill('0');
  await expect(
    page.getByRole('button', { name: 'Save & continue', exact: true }),
  ).toBeDisabled();
  await stepButton(page, 'ShareX').click();
  await page.getByLabel('Current API key', { exact: true }).fill('draft-key');
  await stepButton(page, 'First image').click();
  await expect(page.getByText('Waiting for your first image…')).toBeVisible();
  await stepButton(page, 'Ready').click();
  await expect(page.locator('dd').first()).toHaveText('Browser administrator');
  await stepButton(page, 'Your links').click();
  await expect(
    page.getByRole('radio', { name: /Use instance default/ }),
  ).toBeChecked();
  await stepButton(page, 'Welcome').click();
  await expect(stepButton(page, 'Welcome')).toHaveAttribute(
    'aria-current',
    'step',
  );
  await stepButton(page, 'Your name').focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('heading', { name: 'Your display name', exact: true }),
  ).toBeFocused();
  await expect(page.getByLabel('Your display name')).toHaveValue('Draft name');
  await stepButton(page, 'Image lifetime').click();
  await expect(page.getByLabel('Duration in seconds')).toHaveValue('0');
  await stepButton(page, 'ShareX').click();
  await expect(page.getByLabel('Current API key', { exact: true })).toHaveValue(
    'draft-key',
  );
  expect(requests).toEqual([
    expect.stringContaining('/api/actions/onboarding-upload-arm'),
    expect.stringContaining('/api/actions/onboarding-progress'),
    expect.stringContaining('/api/actions/onboarding-progress'),
  ]);
  const saved = await hearth.DB.prepare(
    'SELECT displayName,defaultExpiry,onboardingStatus,onboardingStep FROM users',
  ).all();
  expect(saved.results[0]).toEqual({
    displayName: 'Browser administrator',
    defaultExpiry: 'never',
    onboardingStatus: 'pending',
    onboardingStep: 6,
  });
  await stepButton(page, 'Your name').click();
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(stepButton(page, 'Your name, completed')).toBeVisible();
  await expect(stepButton(page, 'Your links')).toHaveAttribute(
    'aria-current',
    'step',
  );
  await stepButton(page, 'Your name, completed').click();
  await expect(page.getByLabel('Your display name')).toHaveValue('Draft name');
});

test('covers the viewport with one background and removes decorative copy', async ({
  page,
}) => {
  await signIn(page);
  for (const viewport of [
    { width: 1920, height: 1080 },
    { width: 820, height: 1180 },
    { width: 390, height: 844 },
    { width: 320, height: 568 },
  ]) {
    await page.setViewportSize(viewport);
    const background = await page.locator('.onboarding').evaluate((node) => {
      const rect = node.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        height: rect.height,
        gradient: getComputedStyle(node).backgroundImage,
        overflow: document.documentElement.scrollWidth > innerWidth,
      };
    });
    expect(background.left).toBe(0);
    expect(background.right).toBe(viewport.width);
    expect(background.height).toBeGreaterThanOrEqual(viewport.height);
    expect(background.gradient).toContain('radial-gradient');
    expect(background.overflow).toBe(false);
    await expect(
      page
        .getByRole('navigation', { name: 'Setup progress' })
        .getByRole('button'),
    ).toHaveCount(7);
  }
  for (const name of [
    'Welcome',
    'Your name',
    'Your links',
    'Image lifetime',
    'ShareX',
    'First image',
    'Ready',
  ]) {
    await stepButton(page, name).click();
    await expect(page.locator('.onboarding')).not.toContainText(
      /A little setup|A home for your images|Make it yours|A place to call your own|Explore at my own pace|Keep for now|Skip for now/,
    );
    await expect(page.locator('.eyebrow')).toHaveCount(0);
  }
});

test('completes from Ready once, keeps setup visible during loading and cleans up the dashboard transition', async ({
  page,
  hearth,
  baseURL,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  await signIn(page);
  await stepButton(page, 'Ready').click();
  await page.evaluate(() => {
    const start = document.startViewTransition.bind(document);
    document.startViewTransition = (options) => {
      document.documentElement.dataset.transitionStarts = String(
        Number(document.documentElement.dataset.transitionStarts ?? 0) + 1,
      );
      const transition = start(options);
      void transition.ready
        .then(() => {
          const animations = document
            .getAnimations()
            .filter(
              (animation) =>
                animation instanceof CSSAnimation &&
                animation.animationName.startsWith('hearth-'),
            );
          const durations = animations.map((animation) => {
            const duration = Number(
              animation.effect!.getComputedTiming().duration,
            );
            animation.pause();
            animation.currentTime = duration / 2;
            return duration;
          });
          document.documentElement.dataset.handoffDurations =
            JSON.stringify(durations);
        })
        .catch(() => {
          document.documentElement.dataset.handoffDurations = '[]';
        });
      return transition;
    };
  });
  let submissions = 0;
  await page.route('**/api/actions/onboarding-complete', async (route) => {
    submissions++;
    if (submissions === 1)
      await route.fulfill({
        status: 503,
        json: { error: { message: 'Try completing setup again.' } },
      });
    else await route.continue();
  });
  await page.getByRole('button', { name: 'Go to dashboard' }).click();
  await expect(page.locator('.save-error')).toHaveText(
    'Try completing setup again.',
  );
  await expect(
    page.getByRole('button', { name: 'Go to dashboard' }),
  ).toBeEnabled();
  await page.route('**/__data.json*', async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 600));
    await route.continue();
  });
  await page
    .getByRole('button', { name: 'Go to dashboard' })
    .evaluate((button: HTMLButtonElement) => {
      button.click();
      button.click();
    });
  await expect(page.locator('.onboarding')).toHaveAttribute(
    'aria-busy',
    'true',
  );
  await expect(page.locator('.onboarding')).toBeVisible();
  await expect(page.locator('.workspace')).toHaveCount(0);
  await expect(page).toHaveURL(baseURL! + '/');
  await expect(page.locator('html')).toHaveAttribute(
    'data-transition-starts',
    '1',
  );
  await expect(page.locator('html')).toHaveAttribute(
    'data-handoff-durations',
    /\[\d+,\d+\]/,
  );
  await page.screenshot({
    path: 'artifacts/onboarding-review/dashboard-transition.png',
  });
  await page.evaluate(() => {
    for (const animation of document.getAnimations()) {
      if (
        animation instanceof CSSAnimation &&
        animation.animationName.startsWith('hearth-')
      )
        animation.finish();
    }
  });
  await expect(page.locator('style[data-onboarding-transition]')).toHaveCount(
    0,
  );
  await expect(page.locator('.onboarding')).toHaveCount(0);
  expect(submissions).toBe(2);
  const status = await hearth.DB.prepare(
    'SELECT onboardingStatus FROM users',
  ).all();
  expect(status.results[0]).toEqual({ onboardingStatus: 'completed' });
  await page.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute(
    'data-transition-starts',
    '1',
  );
  expect(errors).toEqual([]);
});

for (const mode of ['reduced motion', 'animation fallback'] as const) {
  test(`enters the dashboard with ${mode} and releases animations`, async ({
    page,
    baseURL,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });
    // eslint-disable-next-line playwright/no-conditional-in-test -- Run the same behavior under both browser capabilities.
    if (mode === 'reduced motion')
      await page.emulateMedia({ reducedMotion: 'reduce' });
    await signIn(page);
    // eslint-disable-next-line playwright/no-conditional-in-test -- Run the same behavior under both browser capabilities.
    if (mode === 'animation fallback')
      await page.evaluate(() =>
        Object.defineProperty(document, 'startViewTransition', {
          value: undefined,
        }),
      );
    await stepButton(page, 'Ready').click();
    await page.getByRole('button', { name: 'Go to dashboard' }).click();
    await expect(page).toHaveURL(baseURL! + '/');
    await expect(
      page.locator('style[data-onboarding-transition], .onboarding'),
    ).toHaveCount(0);
    await expect
      .poll(() => page.evaluate(() => document.body.getAnimations().length))
      .toBe(0);
    expect(errors).toEqual([]);
  });
}

test('welcomes a new account, saves preferences, reuses its key and completes truthfully', async ({
  page,
  hearth,
  baseURL,
}) => {
  const key = await signIn(page);
  await expect(page.getByRole('heading', { level: 1 })).toContainText(
    'Welcome to hearth',
  );
  await page.screenshot({
    path: 'artifacts/onboarding-review/welcome-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await configureDeliveryDomain(
    page.request,
    baseURL!,
    'onboarding.localhost',
    true,
  );
  await hearth.DB.prepare(
    "UPDATE users SET defaultExpiry='7d',stripImageMetadata=0",
  ).run();
  await start(page);
  await page.getByLabel('Your display name').fill('A new home');
  await page.screenshot({
    path: 'artifacts/onboarding-review/name-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await page
    .getByRole('radio', {
      name: 'onboarding.localhost Instance default · Use for your new share links',
    })
    .check();
  await page.screenshot({
    path: 'artifacts/onboarding-review/delivery-preference-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByRole('radio', { name: /7 days Automatically expires/ }),
  ).toBeChecked();
  await page
    .getByRole('radio', { name: /1 hour Automatically expires/ })
    .check();
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByLabel('Current API key', { exact: true }),
  ).toBeVisible();
  expect(
    (await page.getByLabel('Current API key', { exact: true }).inputValue()) ===
      key,
  ).toBe(true);
  await page.screenshot({
    path: 'artifacts/onboarding-review/sharex-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.route('**/api/actions/sxcu', (route) => route.abort());
  await page
    .getByRole('button', { name: 'Download ShareX configuration' })
    .click();
  await expect(page.locator('.sharex-config .error')).toBeVisible();
  await expect(
    page.getByText('Configuration download started.', { exact: false }),
  ).toHaveCount(0);
  await page.unroute('**/api/actions/sxcu');
  for (let attempt = 0; attempt < 2; attempt++) {
    const download = page.waitForEvent('download');
    await page
      .getByRole('button', { name: 'Download ShareX configuration' })
      .click();
    const file = await download;
    const config = JSON.parse(await readFile(await file.path(), 'utf8')) as {
      Headers: { Authorization: string };
      RequestURL: string;
    };
    expect(config.Headers.Authorization === `Bearer ${key}`).toBe(true);
    expect(config.RequestURL).toBe(`${baseURL}/api/v1/images`);
  }
  const credentials = await hearth.DB.prepare(
    'SELECT count(*) AS count FROM api_keys',
  ).all();
  expect(credentials.results[0]).toEqual({ count: 1 });
  const preferences = await hearth.DB.prepare(
    'SELECT defaultExpiry,stripImageMetadata FROM users',
  ).all();
  expect(preferences.results[0]).toEqual({
    defaultExpiry: '1h',
    stripImageMetadata: 0,
  });
  await page
    .getByRole('button', { name: 'Check an image', exact: true })
    .click();
  await expect(page.getByText('Waiting for your first image…')).toBeVisible();
  await page.screenshot({
    path: 'artifacts/onboarding-review/first-image-waiting-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  const upload = await sharexUpload(page, baseURL!, key);
  expect(upload.status()).toBe(201);
  await expect(page.getByText('Your first image is ready.')).toBeVisible({
    timeout: 10_000,
  });
  await expect(page.getByAltText('Your uploaded screenshot')).toBeVisible();
  await page.screenshot({
    path: 'artifacts/onboarding-review/first-image-success-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Go to dashboard' }),
  ).toBeVisible();
  await expect(page.locator('dd')).toContainText([
    'A new home',
    'onboarding.localhost',
    '1 hour',
    'Configuration download started',
    'Upload received',
  ]);
  await page.screenshot({
    path: 'artifacts/onboarding-review/completion-desktop.png',
    fullPage: true,
    animations: 'disabled',
  });
  await page.reload();
  await expect(
    page.getByRole('button', { name: 'Go to dashboard' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Go to dashboard' }).click();
  await expect(page).toHaveURL(baseURL! + '/');
  await page.goto('/settings');
  await page
    .getByRole('button', { name: 'Download ShareX configuration' })
    .click();
  await expect(page.getByLabel('Current API key', { exact: true })).toBeEmpty();
  await page.keyboard.press('Escape');
  await page.getByLabel('Display name', { exact: true }).fill('A saved name');
  await hearth.DB.prepare(
    "UPDATE users SET defaultExpiry='7d',stripImageMetadata=1",
  ).run();
  const saving = page.waitForResponse('**/api/actions/preferences');
  await page.getByRole('button', { name: 'Save preferences' }).click();
  const response = await saving;
  expect(response.status()).toBe(200);
  const saved = await hearth.DB.prepare(
    'SELECT displayName,defaultExpiry,stripImageMetadata FROM users',
  ).all();
  expect(saved.results[0]).toEqual({
    displayName: 'A saved name',
    defaultExpiry: '7d',
    stripImageMetadata: 1,
  });
});

test('first image check ignores older, browser, and other-account uploads and survives navigation', async ({
  page,
  hearth,
  baseURL,
}) => {
  const key = await signIn(page);
  const older = await sharexUpload(page, baseURL!, key);
  expect(older.status()).toBe(409);
  await stepButton(page, 'First image').click();
  await expect(page.getByText('Waiting for your first image…')).toBeVisible();
  const other = await createUser(hearth.DB, 'Other uploader', 'user', null);
  const foreign = await sharexUpload(page, baseURL!, other.key);
  expect(foreign.status()).toBe(409);
  const browserUpload = await page.request.post(`${baseURL}/api/upload`, {
    headers: { Origin: baseURL! },
    multipart: {
      file: {
        name: 'Browser.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
          'base64',
        ),
      },
    },
  });
  expect(browserUpload.status()).toBe(201);
  const waiting = await page.request.get(
    `${baseURL}/api/onboarding/first-image`,
  );
  expect(await waiting.json()).toEqual({ status: 'waiting', imageId: null });
  await stepButton(page, 'ShareX').click();
  const recent = await sharexUpload(page, baseURL!, key);
  expect(recent.status()).toBe(409);
  await stepButton(page, 'First image').click();
  await expect(page.getByText('Your first image is ready.')).toBeVisible();
  await page.reload();
  await expect(page.getByText('Your first image is ready.')).toBeVisible();
});

test('recognizes an upload completed while the first image step is opening', async ({
  page,
  baseURL,
}) => {
  const key = await signIn(page);
  await page.route('**/api/actions/onboarding-upload-arm', async (route) => {
    const response = await route.fetch();
    const upload = await sharexUpload(page, baseURL!, key);
    expect(upload.status()).toBe(409);
    await route.fulfill({ response });
  });
  await stepButton(page, 'First image').click();
  await expect(page.getByText('Your first image is ready.')).toBeVisible();
});

test('can skip and revisit the first image check', async ({
  page,
  hearth,
  baseURL,
}) => {
  await signIn(page);
  await stepButton(page, 'First image').click();
  await expect(page.getByText('Waiting for your first image…')).toBeVisible();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(page.getByText('Skipped', { exact: true })).toBeVisible();
  const skipped = await hearth.DB.prepare(
    'SELECT onboardingUploadStatus,onboardingUploadImageId FROM users',
  ).all();
  expect(skipped.results[0]).toEqual({
    onboardingUploadStatus: 'skipped',
    onboardingUploadImageId: null,
  });
  await page.getByRole('button', { name: 'Go to dashboard' }).click();
  await page.goto(`${baseURL}/settings`);
  await page.getByRole('link', { name: 'Revisit onboarding' }).click();
  await stepButton(page, 'First image').click();
  await expect(page.getByText('Waiting for your first image…')).toBeVisible();
  const retry = await hearth.DB.prepare(
    'SELECT onboardingUploadStatus,onboardingUploadImageId FROM users',
  ).all();
  expect(retry.results[0]).toEqual({
    onboardingUploadStatus: 'waiting',
    onboardingUploadImageId: null,
  });
});

test('recovers from a status outage and completes when the preview is unavailable', async ({
  page,
  baseURL,
}) => {
  await page.clock.install();
  const key = await signIn(page);
  await page.route('**/api/onboarding/first-image', (route) => route.abort());
  await page.route('**/api/media/*?preview', (route) =>
    route.fulfill({ status: 404 }),
  );
  await stepButton(page, 'First image').click();
  await expect(page.getByText('Connection interrupted.')).toBeVisible();
  await page.clock.fastForward(121_000);
  await expect(page.getByRole('button', { name: 'Check again' })).toBeVisible();
  await expect(page.getByText('Having trouble?')).toBeVisible();
  await page.unroute('**/api/onboarding/first-image');
  await page.getByRole('button', { name: 'Check again' }).click();
  const upload = await sharexUpload(page, baseURL!, key);
  expect(upload.status()).toBe(409);
  await expect(page.getByText('Your first image is ready.')).toBeVisible({
    timeout: 10_000,
  });
  await expect(
    page.getByText('The preview is unavailable, but your image was saved.'),
  ).toBeVisible();
  await expect(page.getByRole('button', { name: 'Continue' })).toBeEnabled();
});

test('expires the login handoff and permits manual configuration retries', async ({
  page,
}) => {
  await page.clock.install();
  const key = await signIn(page);
  await sharexStep(page);
  expect(
    (await page.getByLabel('Current API key', { exact: true }).inputValue()) ===
      key,
  ).toBe(true);
  await page.clock.fastForward(15 * 60_000);
  await expect(page.getByLabel('Current API key', { exact: true })).toBeEmpty();
  await page.getByLabel('Current API key', { exact: true }).fill('invalid');
  await page
    .getByRole('button', { name: 'Download ShareX configuration' })
    .click();
  await expect(page.locator('.sharex-config .error')).toHaveText(
    'The API key is invalid.',
  );
  await expect(page).toHaveURL(/\/onboarding$/);
  await page.getByLabel('Current API key', { exact: true }).fill(key);
  const download = page.waitForEvent('download');
  await page
    .getByRole('button', { name: 'Download ShareX configuration' })
    .click();
  await download;
  const another = await page.context().newPage();
  await another.goto('/onboarding');
  await expect(
    another.getByLabel('Current API key', { exact: true }),
  ).toBeEmpty();
  await another.close();
});

test('cancels a delayed configuration download when the retained key expires', async ({
  page,
}) => {
  await page.clock.install();
  await signIn(page);
  await sharexStep(page);
  let requested!: () => void;
  let served!: () => void;
  /* eslint-disable unicorn/prefer-promise-with-resolvers -- Repository test typings target ES2022. */
  const whenRequested = new Promise<void>((resolve) => {
    requested = resolve;
  });
  const whenServed = new Promise<void>((resolve) => {
    served = resolve;
  });
  /* eslint-enable unicorn/prefer-promise-with-resolvers */
  const downloads: string[] = [];
  page.on('download', (file) => {
    downloads.push(file.suggestedFilename());
  });
  await page.route('**/api/actions/sxcu', async (route) => {
    requested();
    await new Promise((resolve) => setTimeout(resolve, 500));
    try {
      await route.fulfill({ json: { Name: 'Delayed configuration' } });
    } catch {
      // Expiry can cancel the intercepted request before its response is ready.
    }
    served();
  });
  await page
    .getByRole('button', { name: 'Download ShareX configuration' })
    .click();
  await whenRequested;
  await page.clock.fastForward(15 * 60_000);
  await expect(page.getByLabel('Current API key', { exact: true })).toBeEmpty();
  await expect(page.locator('.sharex-config .error')).toHaveText(
    'Enter your current API key to try again.',
  );
  await whenServed;
  expect(downloads).toEqual([]);
});

test('skips immediately with exactly one dismissible notification and can revisit without resetting eligibility', async ({
  page,
  hearth,
  baseURL,
}) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Skip onboarding' }).click();
  await expect(page).toHaveURL(baseURL! + '/');
  await expect(
    page
      .locator('.notification-deck')
      .getByText('You can revisit onboarding anytime', { exact: true }),
  ).toHaveCount(1);
  await page.getByRole('link', { name: 'Open settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await page.getByRole('button', { name: 'Dismiss notification' }).click();
  await page.reload();
  await expect(page.locator('.notification-deck .toast')).toHaveCount(0);
  await page.getByRole('link', { name: 'Revisit onboarding' }).click();
  await sharexStep(page);
  await expect(page.getByLabel('Current API key', { exact: true })).toBeEmpty();
  await page.goto('/settings');
  await expect(page).toHaveURL(/\/settings$/);
  const saved = await hearth.DB.prepare(
    'SELECT onboardingStatus,defaultExpiry,displayName FROM users',
  ).all();
  expect(saved.results[0]).toEqual({
    onboardingStatus: 'skipped',
    defaultExpiry: 'never',
    displayName: 'Browser administrator',
  });
});

test('resumes after refresh with manual key fallback, preserved drafts when going back and optional setup', async ({
  page,
  hearth,
}) => {
  await signIn(page);
  await start(page);
  await page.getByLabel('Your display name').fill('A draft name');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await start(page);
  await expect(page.getByLabel('Your display name')).toHaveValue(
    'A draft name',
  );
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByText('No delivery domains available yet'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByLabel('Current API key', { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Current API key', { exact: true })).toBeEmpty();
  await page
    .getByRole('button', { name: 'Check an image', exact: true })
    .click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByText('Setup still needed', { exact: true }),
  ).toBeVisible();
  await expect(
    page.getByText('Available in Settings', { exact: true }),
  ).toBeVisible();
  const saved = await hearth.DB.prepare(
    'SELECT displayName,onboardingStatus FROM users',
  ).all();
  expect(saved.results[0]).toEqual({
    displayName: 'Browser administrator',
    onboardingStatus: 'completed',
  });
});

test('handles failed persistence and expired sessions without losing saved progress', async ({
  page,
  hearth,
}) => {
  await signIn(page);
  await start(page);
  await page.getByLabel('Your display name').fill('Try again');
  await page.route('**/api/actions/preferences', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ error: { message: 'Please retry this save.' } }),
    }),
  );
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(page.locator('.save-error')).toHaveText(
    'Please retry this save.',
  );
  await expect(page.getByLabel('Your display name')).toHaveValue('Try again');
  await page.unroute('**/api/actions/preferences');
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByRole('group', { name: 'Your delivery selection' }),
  ).toBeVisible();
  await hearth.DB.prepare('DELETE FROM sessions').run();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(page).toHaveURL(/\/login$/);
  const saved = await hearth.DB.prepare(
    'SELECT onboardingStep,displayName FROM users',
  ).all();
  expect(saved.results[0]).toEqual({
    onboardingStep: 3,
    displayName: 'Try again',
  });
});

test('preserves unavailable delivery and invalid expiry defaults until explicitly changed', async ({
  page,
  hearth,
}) => {
  const member = await createUser(hearth.DB, 'Restricted member', 'user', null);
  await hearth.DB.prepare(
    "INSERT INTO delivery_domains(id,hostname,enabled,health,accessMode,createdAt,updatedAt) VALUES('unavailable','unavailable.localhost',0,'active','everyone',unixepoch(),unixepoch())",
  ).run();
  await hearth.DB.prepare(
    "INSERT INTO delivery_domains(id,hostname,health,accessMode,createdAt,updatedAt) VALUES('usable','usable.localhost','active','everyone',unixepoch(),unixepoch())",
  ).run();
  await hearth.DB.prepare(
    'UPDATE users SET preferredDeliveryDomainId=?,stripImageMetadata=0,expiryPolicy=? WHERE id=?',
  )
    .bind(
      'unavailable',
      JSON.stringify({ requireExpiry: true, maxLifetimeSeconds: 1800 }),
      member.userId,
    )
    .run();
  await signIn(page, member.key);
  await start(page);
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByText('Your saved delivery selection is unavailable.', {
      exact: false,
    }),
  ).toBeVisible();
  await expect(
    page.getByRole('radio', { name: /usable.localhost/ }),
  ).not.toBeChecked();
  await page.getByRole('radio', { name: /Use instance default/ }).check();
  await expect(
    page.getByText('No instance default is configured.', { exact: false }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Save & continue', exact: true }),
  ).toBeDisabled();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByText(
      'Your saved image expiration needs attention before uploading.',
      { exact: false },
    ),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await page.getByRole('radio', { name: /A custom duration/ }).check();
  await page.getByLabel('Duration in seconds').fill('1801');
  await expect(
    page.getByRole('button', { name: 'Save & continue', exact: true }),
  ).toBeDisabled();
  await page.getByLabel('Duration in seconds').fill('1800');
  await page
    .getByRole('button', { name: 'Save & continue', exact: true })
    .click();
  await expect(
    page.getByLabel('Current API key', { exact: true }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Check an image', exact: true })
    .click();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByText('Setup still needed', { exact: true }),
  ).toBeVisible();
  const saved = await hearth.DB.prepare(
    'SELECT preferredDeliveryDomainId,stripImageMetadata,defaultExpiry FROM users WHERE id=?',
  )
    .bind(member.userId)
    .all();
  expect(saved.results[0]).toEqual({
    preferredDeliveryDomainId: 'unavailable',
    stripImageMetadata: 0,
    defaultExpiry: '1800s',
  });
});

test('works with keyboard, mobile and tablet layouts and reduced motion', async ({
  page,
}) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.setViewportSize({ width: 390, height: 844 });
  await signIn(page);
  await page.screenshot({
    path: 'artifacts/onboarding-review/welcome-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.getByRole('button', { name: 'Get started', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1 })).toBeFocused();
  await page.getByLabel('Your display name').focus();
  await page.keyboard.press('Enter');
  await expect(
    page.getByRole('group', { name: 'Your delivery selection' }),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByRole('group', { name: 'Default image expiration' }),
  ).toBeVisible();
  await page.screenshot({
    path: 'artifacts/onboarding-review/expiry-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 820, height: 1180 });
  await page.getByRole('button', { name: 'Skip', exact: true }).click();
  await expect(
    page.getByLabel('Current API key', { exact: true }),
  ).toBeVisible();
  await page.screenshot({
    path: 'artifacts/onboarding-review/sharex-tablet.png',
    fullPage: true,
    animations: 'disabled',
  });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await stepButton(page, 'First image').click();
  await expect(page.getByText('Waiting for your first image…')).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.setViewportSize({ width: 320, height: 568 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  expect(
    await page
      .locator('.first-image .loading-spinner')
      .evaluate((node) => getComputedStyle(node).animationName),
  ).toBe('none');
  await page.screenshot({
    path: 'artifacts/onboarding-review/first-image-waiting-mobile.png',
    fullPage: true,
    animations: 'disabled',
  });
});

test.describe('bootstrap administrator', () => {
  test.use({ accountMode: 'bootstrap' });

  test('uses the actual bootstrap path and validates a first delivery domain', async ({
    page,
    hearth,
  }) => {
    await signIn(page);
    await page
      .getByRole('button', { name: 'Get started', exact: true })
      .click();
    await expect(page.getByLabel('Delivery hostname')).toBeVisible();
    await page.getByLabel('Delivery hostname').fill('first.localhost');
    await stepButton(page, 'Your name').click();
    await stepButton(page, 'Delivery setup').click();
    await expect(page.getByLabel('Delivery hostname')).toHaveValue(
      'first.localhost',
    );
    await page.getByRole('button', { name: 'Add delivery domain' }).click();
    await expect(
      page.getByRole('button', { name: 'Validate domain', exact: true }),
    ).toBeEnabled();
    await page.screenshot({
      path: 'artifacts/onboarding-review/delivery-setup-desktop.png',
      fullPage: true,
      animations: 'disabled',
    });
    await page
      .getByRole('button', { name: 'Validate domain', exact: true })
      .click();
    await page
      .getByRole('button', { name: 'Set as instance default', exact: true })
      .click();
    await expect(
      page.getByText('Your delivery domain is ready for new share links.'),
    ).toBeVisible();
    await stepButton(page, 'Image lifetime').click();
    await stepButton(page, 'Delivery setup').click();
    await expect(
      page.getByText('Your delivery domain is ready for new share links.'),
    ).toBeVisible();
    await page
      .getByRole('button', { name: 'Continue setup', exact: true })
      .click();
    await expect(page.getByLabel('Your display name')).toBeVisible();
    const account = await hearth.DB.prepare(
      'SELECT bootstrapAdministrator FROM users',
    ).all();
    expect(account.results[0]).toEqual({ bootstrapAdministrator: 1 });
    const domain = await hearth.DB.prepare(
      'SELECT hostname,isPrimary,health FROM delivery_domains',
    ).all();
    expect(domain.results[0]).toEqual({
      hostname: 'first.localhost',
      isPrimary: 1,
      health: 'active',
    });
  });

  test('can skip domain setup without creating anything or showing the global skip notice', async ({
    page,
    hearth,
  }) => {
    await signIn(page);
    await page
      .getByRole('button', { name: 'Get started', exact: true })
      .click();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(page.getByLabel('Your display name')).toBeVisible();
    const domains = await hearth.DB.prepare(
      'SELECT count(*) AS count FROM delivery_domains',
    ).all();
    expect(domains.results[0]).toEqual({ count: 0 });
    await expect(page.locator('.notification-deck .toast')).toHaveCount(0);
  });
});

test.describe('returning account isolation', () => {
  test.use({ accountMode: 'established' });

  test('never loads onboarding assets on dashboard, settings or revisit hover', async ({
    page,
    baseURL,
  }) => {
    const manifest = JSON.parse(
      await readFile(
        'apps/web/.svelte-kit/output/client/.vite/manifest.json',
        'utf8',
      ),
    ) as Record<
      string,
      {
        file: string;
        css?: string[];
        imports?: string[];
        dynamicImports?: string[];
        isEntry?: boolean;
      }
    >;
    const routeSources = await Promise.all(
      Object.keys(manifest)
        .filter((name) =>
          /generated\/client-optimized\/nodes\/\d+\.js$/.test(name),
        )
        .map(
          async (name) =>
            [name, await readFile(`apps/web/${name}`, 'utf8')] as const,
        ),
    );
    const onboarding = Object.entries(manifest).filter(
      ([name]) =>
        name.includes('routes/onboarding/') ||
        routeSources.some(
          ([route, source]) =>
            route === name && source.includes('src/routes/onboarding/'),
        ),
    );
    expect(onboarding.length).toBeGreaterThan(0);
    const assets = new Set(
      onboarding.flatMap(([, entry]) => [entry.file, ...(entry.css ?? [])]),
    );
    function dependencies(
      name: string,
      found = new Set<string>(),
      dynamic = false,
    ) {
      // eslint-disable-next-line playwright/no-conditional-in-test -- Manifest traversal has to avoid dependency cycles.
      if (found.has(name)) return found;
      found.add(name);
      const imports = [
        ...(manifest[name]?.imports ?? []),
        // eslint-disable-next-line playwright/no-conditional-in-test -- Dynamic imports belong only to the onboarding dependency traversal.
        ...(dynamic ? (manifest[name]?.dynamicImports ?? []) : []),
      ];
      for (const dependency of imports)
        dependencies(dependency, found, dynamic);
      return found;
    }
    const dashboard = Object.keys(manifest).filter(
      (name) =>
        manifest[name].isEntry && onboarding.every(([route]) => route !== name),
    );
    const dashboardDependencies = new Set(
      dashboard.flatMap((name) => [...dependencies(name)]),
    );
    const onboardingDependencies = new Set(
      onboarding.flatMap(([name]) => [...dependencies(name, new Set(), true)]),
    );
    for (const [name] of onboarding)
      expect(dashboardDependencies.has(name)).toBe(false);
    for (const name of onboardingDependencies) {
      // eslint-disable-next-line playwright/no-conditional-in-test -- Shared dependencies are allowed on both routes.
      if (dashboardDependencies.has(name)) continue;
      assets.add(manifest[name].file);
      const styles = manifest[name].css ?? [];
      for (const css of styles) assets.add(css);
    }
    const loaded: string[] = [];
    page.on('request', (request) => {
      if (/\.(?:js|css)(?:\?|$)/.test(request.url()))
        loaded.push(new URL(request.url()).pathname.slice(1));
    });
    await page.goto('/login');
    await page
      .getByLabel('Your API key')
      .fill(await readFile(process.env.TEST_KEY_FILE!, 'utf8'));
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page).toHaveURL(baseURL! + '/');
    await page.goto('/settings');
    const link = page.getByRole('link', { name: 'Revisit onboarding' });
    await expect(link).toHaveAttribute('data-sveltekit-preload-data', 'off');
    await expect(link).toHaveAttribute('data-sveltekit-preload-code', 'off');
    await link.hover();
    await page.getByRole('heading', { name: 'Personal preferences' }).click();
    expect(loaded.filter((asset) => assets.has(asset))).toEqual([]);
    await expect(
      page.locator('.onboarding, style[data-onboarding-transition]'),
    ).toHaveCount(0);
  });
});
