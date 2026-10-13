import { readFile, writeFile } from 'node:fs/promises';

import type { Page } from '@playwright/test';

import { expect, test } from '../helpers/browser';

// Hold real finite motion halfway through, without depending on wall-clock timing.
async function holdMotion(page: Page) {
  await page.addInitScript(() => {
    Reflect.set(globalThis, 'motionHold', true);
    // eslint-disable-next-line @typescript-eslint/unbound-method -- Forward the original receiver in this browser-only instrumentation.
    const animate = Element.prototype.animate;
    /* eslint-disable unicorn/no-this-outside-of-class -- A native prototype override must preserve its receiver. */
    Element.prototype.animate = function (frames, options) {
      const animation = animate.call(this, frames, options);
      const duration = animation.effect?.getComputedTiming().duration;
      if (
        typeof duration === 'number' &&
        duration > 0 &&
        Reflect.get(globalThis, 'motionHold') &&
        this.matches(
          '.dialog-surface, .modal-backdrop, .disclosure-reveal, .notification-details, .empty, .bulk-bar, .item-icon > span, .state-icon > span',
        )
      ) {
        animation.pause();
        animation.currentTime = duration / 2;
      }
      return animation;
    };
    /* eslint-enable unicorn/no-this-outside-of-class */
  });
}

async function finishMotion(page: Page) {
  await page.evaluate(() => {
    Reflect.set(globalThis, 'motionHold', false);
    for (const animation of document.getAnimations()) {
      if (Number.isFinite(animation.effect?.getComputedTiming().endTime))
        animation.finish();
    }
  });
}

async function toggleMenu(node: HTMLElement) {
  node.click();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  const animations = node.parentElement!.getAnimations({ subtree: true });
  for (const animation of animations) {
    const duration = animation.effect?.getComputedTiming().duration;
    if (typeof duration !== 'number' || duration <= 0) continue;
    animation.pause();
    animation.currentTime = duration / 2;
  }
  return Number(
    getComputedStyle(node.parentElement!.querySelector('.search-popover')!)
      .opacity,
  );
}

test.beforeEach(async ({ page, request, baseURL }) => {
  const login = await request.post('/api/actions/login', {
    headers: { Origin: baseURL! },
    data: {
      key: await readFile(process.env.TEST_KEY_FILE!, 'utf8'),
      token: 'XXXX.DUMMY.TOKEN.XXXX',
    },
  });
  expect(login.status()).toBe(200);
  const storage = await request.storageState();
  await page.context().addCookies(storage.cookies);
});

test('dialog surface and backdrop visibly render entrance and exit in every engine', async ({
  page,
}, testInfo) => {
  await holdMotion(page);
  await page.goto('/admin/domains');
  const add = page
    .getByRole('button', { name: 'Add delivery domain', exact: true })
    .first();
  await add.focus();
  await add.press('Enter');
  const host = page.locator('dialog');
  for (const selector of ['.dialog-surface', '.modal-backdrop']) {
    const child = host.locator(selector);
    await expect(child).toBeVisible();
    await expect
      .poll(() =>
        child.evaluate((node) => Number(getComputedStyle(node).opacity)),
      )
      .toBeGreaterThan(0);
    expect(
      await child.evaluate((node) => Number(getComputedStyle(node).opacity)),
    ).toBeLessThan(1);
    expect(
      await child.evaluate((node) =>
        node
          .getAnimations()
          .some((animation) => animation.playState === 'paused'),
      ),
    ).toBe(true);
  }
  await page.screenshot({
    path: testInfo.outputPath('dialog-mid-entrance.png'),
  });
  await finishMotion(page);
  await page.evaluate(() => Reflect.set(globalThis, 'motionHold', true));
  // A gesture beginning inside the surface cannot become a backdrop dismissal.
  await host.locator('h2').hover();
  await page.mouse.down();
  await page.mouse.move(8, 8);
  await page.mouse.up();
  await expect(host).toHaveAttribute('open', '');
  await page.mouse.click(8, 8);
  await expect(host).not.toHaveAttribute('open', '');
  await expect(host).toHaveAttribute('inert', '');
  await expect(host).toHaveAttribute('aria-hidden', 'true');
  await expect(host).toHaveCSS('pointer-events', 'none');
  await expect(add).toBeFocused();
  for (const selector of ['.dialog-surface', '.modal-backdrop']) {
    const child = host.locator(selector);
    await expect
      .poll(() =>
        child.evaluate((node) => Number(getComputedStyle(node).opacity)),
      )
      .toBeGreaterThan(0);
    expect(
      await child.evaluate((node) => Number(getComputedStyle(node).opacity)),
    ).toBeLessThan(1);
  }
  await page.screenshot({ path: testInfo.outputPath('dialog-mid-exit.png') });
  await add.evaluate((node: HTMLButtonElement) => node.click());
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await expect(page.locator('dialog[open]')).not.toHaveAttribute('inert', '');
  await expect(page.getByLabel('Hostname', { exact: true })).toBeEditable();
  await finishMotion(page);
  await page.keyboard.press('Escape');
  await expect(host).toHaveCount(0);
});

test('press feedback brightens primary, secondary and icon controls without changing geometry', async ({
  page,
}) => {
  await page.goto('/admin/domains');
  const controls = [
    page
      .getByRole('button', { name: 'Add delivery domain', exact: true })
      .first(),
    page.getByRole('button', { name: 'Refresh', exact: true }),
    page.locator('.search-trigger').first(),
  ];
  for (const control of controls) {
    await control.hover();
    await control.evaluate((node) => {
      for (const animation of node.getAnimations()) animation.finish();
    });
    const before = await control.evaluate((node) => {
      const rectangle = node.getBoundingClientRect();
      return {
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
        color: getComputedStyle(node).backgroundColor,
      };
    });
    await page.mouse.down();
    await control.evaluate((node) => {
      for (const animation of node.getAnimations()) animation.finish();
    });
    const after = await control.evaluate((node) => {
      const rectangle = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      return {
        x: rectangle.x,
        y: rectangle.y,
        width: rectangle.width,
        height: rectangle.height,
        color: style.backgroundColor,
        scale: style.scale,
        transform: style.transform,
      };
    });
    expect({
      x: after.x,
      y: after.y,
      width: after.width,
      height: after.height,
    }).toEqual({
      x: before.x,
      y: before.y,
      width: before.width,
      height: before.height,
    });
    expect(after.scale).toBe('none');
    expect(after.transform).toBe('none');
    const brightness = await page.evaluate(
      ([rest, pressed]) => {
        const context = document.createElement('canvas').getContext('2d')!;
        function lightness(color: string) {
          context.fillStyle = color;
          context.fillRect(0, 0, 1, 1);
          const [red, green, blue] = context.getImageData(0, 0, 1, 1).data;
          return red + green + blue;
        }
        return lightness(pressed) - lightness(rest);
      },
      [before.color, after.color],
    );
    expect(brightness).toBeGreaterThan(0);
    await page.mouse.move(8, 8);
    await page.mouse.up();
  }
  const add = controls[0];
  await add.focus();
  await page.keyboard.down('Space');
  await expect(add).toHaveCSS('transform', 'none');
  await expect(add).toHaveCSS('scale', 'none');
  await page.keyboard.up('Space');
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await page.keyboard.press('Escape');
});

test('native disclosures retain collapse presentation, reverse and settle on reduced motion', async ({
  page,
}) => {
  await holdMotion(page);
  await page.goto('/admin/users');
  await page
    .getByRole('link', { name: /Browser administrator/ })
    .first()
    .click();
  const trigger = page.getByRole('button', {
    name: 'Account configuration',
    exact: true,
  });
  const reveal = trigger.locator('..').locator('.disclosure-reveal');
  await trigger.click();
  await expect(reveal).not.toHaveAttribute('inert', '');
  await expect
    .poll(() => reveal.evaluate((node) => node.getBoundingClientRect().height))
    .toBeGreaterThan(0);
  expect(
    await reveal.evaluate(
      (node) =>
        node.getBoundingClientRect().height <
        node.firstElementChild!.getBoundingClientRect().height,
    ),
  ).toBe(true);
  await trigger.evaluate((node: HTMLElement) => node.click());
  await expect(reveal).toHaveAttribute('inert', '');
  await expect(reveal).toHaveAttribute('aria-hidden', 'true');
  await expect(trigger.locator('..')).toHaveAttribute('data-collapsing', '');
  await expect(trigger).toHaveCSS('border-bottom-left-radius', '0px');
  expect(
    await reveal.evaluate((node) => node.getBoundingClientRect().height),
  ).toBeGreaterThan(0);
  await trigger.evaluate((node: HTMLElement) => node.click());
  await expect(trigger.locator('..')).not.toHaveAttribute('data-collapsing');
  await expect(reveal).not.toHaveAttribute('inert', '');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect
    .poll(() => reveal.evaluate((node) => node.style.height))
    .toBe('auto');
  await expect
    .poll(() => reveal.evaluate((node) => node.getAnimations().length))
    .toBe(0);
  await trigger.click();
  await expect(reveal).toHaveCSS('height', '0px');
  await expect(trigger.locator('..')).not.toHaveAttribute('data-collapsing');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await finishMotion(page);
  await trigger.click();
  await expect
    .poll(() => reveal.evaluate((node) => node.style.height))
    .toBe('auto');
  await page.setViewportSize({ width: 600, height: 900 });
  await expect
    .poll(() =>
      reveal.evaluate((node) =>
        Math.abs(
          node.getBoundingClientRect().height -
            node.firstElementChild!.getBoundingClientRect().height,
        ),
      ),
    )
    .toBeLessThan(1);
  await page.evaluate(() => Reflect.set(globalThis, 'motionHold', true));
  await trigger.click();
  await expect(trigger).toHaveCSS('border-bottom-left-radius', '0px');
  await finishMotion(page);
  await expect(trigger.locator('..')).not.toHaveAttribute('data-collapsing');
  await expect(trigger).not.toHaveCSS('border-bottom-left-radius', '0px');
});

function gate() {
  let release!: () => void;
  // The project's ES2022 types do not include Promise.withResolvers.
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

test('notification detail expansion reverses and cancellation confirmation renders before releasing modality', async ({
  page,
}, testInfo) => {
  await holdMotion(page);
  await page.goto('/images');
  const upload = gate();
  await page.route('**/api/upload', async (route) => {
    await upload.promise;
    await route.fulfill({
      status: 201,
      json: { id: 'img_motion', url: null, sharingWarning: null },
    });
  });
  const buffer = await readFile('tests/fixtures/upload.jpeg');
  await page.locator('input[type="file"]').setInputFiles([
    { name: 'first.jpg', mimeType: 'image/jpeg', buffer },
    { name: 'second.jpg', mimeType: 'image/jpeg', buffer },
  ]);
  const deck = page.locator('.notification-deck');
  const details = deck.locator('.active .notification-details');
  await expect(details).toHaveAttribute('inert', '');
  await deck.getByRole('button', { name: 'Show details' }).click();
  await expect(details).not.toHaveAttribute('inert', '');
  await expect
    .poll(() => details.evaluate((node) => node.getBoundingClientRect().height))
    .toBeGreaterThan(0);
  expect(
    await details.evaluate(
      (node) =>
        node.getBoundingClientRect().height <
        node.firstElementChild!.getBoundingClientRect().height,
    ),
  ).toBe(true);
  await expect
    .poll(() =>
      deck.evaluate((node) =>
        Math.abs(
          Number(
            (node as HTMLElement).style
              .getPropertyValue('--height')
              .replace('px', ''),
          ) - node.querySelector('section')!.getBoundingClientRect().height,
        ),
      ),
    )
    .toBeLessThan(1);
  await deck
    .getByRole('button', { name: 'Hide details' })
    .evaluate((node: HTMLButtonElement) => node.click());
  await expect(details).toHaveAttribute('inert', '');
  expect(
    await details.evaluate((node) => node.getBoundingClientRect().height),
  ).toBeGreaterThan(0);
  await deck
    .getByRole('button', { name: 'Show details' })
    .evaluate((node: HTMLButtonElement) => node.click());
  await finishMotion(page);
  await page.evaluate(() => Reflect.set(globalThis, 'motionHold', true));
  await deck
    .getByRole('button', { name: 'Cancel Upload', exact: true })
    .click();
  const confirmation = page.getByRole('dialog', { name: 'Cancel upload?' });
  for (const selector of ['.dialog-surface', '.modal-backdrop']) {
    const child = confirmation.locator(selector);
    await expect
      .poll(() =>
        child.evaluate((node) => Number(getComputedStyle(node).opacity)),
      )
      .toBeGreaterThan(0);
    expect(
      await child.evaluate((node) => Number(getComputedStyle(node).opacity)),
    ).toBeLessThan(1);
  }
  await page.screenshot({
    path: testInfo.outputPath('confirmation-mid-entrance.png'),
  });
  await finishMotion(page);
  const destructive = confirmation.getByRole('button', {
    name: 'Cancel Upload',
    exact: true,
  });
  await destructive.hover();
  await page.mouse.down();
  await expect(destructive).toHaveCSS('scale', 'none');
  await expect(destructive).toHaveCSS('transform', 'none');
  await page.mouse.move(8, 8);
  await page.mouse.up();
  await page.evaluate(() => Reflect.set(globalThis, 'motionHold', true));
  await confirmation.getByRole('button', { name: 'Keep Uploading' }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect(page.locator('dialog')).toHaveAttribute('inert', '');
  await page.getByRole('textbox', { name: 'Search images' }).fill('immediate');
  await expect(page).toHaveURL(/q=immediate/);
  await finishMotion(page);
  await page.evaluate(() => Reflect.set(globalThis, 'motionHold', true));
  upload.release();
  await expect(
    deck.getByRole('region', { name: 'Success notification' }),
  ).toBeVisible();
  const icons = deck.locator('.active .item-icon').first().locator('span');
  await expect.poll(() => icons.count()).toBeGreaterThan(1);
  const positions = await icons.evaluateAll((nodes) =>
    nodes.map((node) => {
      const rectangle = node.getBoundingClientRect();
      return { x: rectangle.x, y: rectangle.y };
    }),
  );
  for (const position of positions) expect(position).toEqual(positions[0]);
  await finishMotion(page);
  await expect(deck.locator('.operation-progress')).toHaveCount(0);
  await deck.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(deck.locator('.toast')).toHaveCount(0);
});

test('navigation backgrounds crossfade across wrapped tabs without moving controls', async ({
  page,
}) => {
  await page.setViewportSize({ width: 800, height: 900 });
  await page.goto('/admin/domains');
  const tabs = page.getByRole('navigation', {
    name: 'Administration',
    exact: true,
  });
  const settings = tabs.getByRole('link', { name: 'Settings', exact: true });
  const before = await settings.boundingBox();
  await settings.click();
  await expect(page).toHaveURL(/\/admin\/settings$/);
  await expect(tabs.locator('.navigation-indicator')).toHaveCount(1);
  await expect(settings).toHaveClass(/active/);
  expect(await settings.boundingBox()).toEqual(before);
  await expect
    .poll(() =>
      settings
        .locator('.navigation-indicator')
        .evaluate((node) => node.getAnimations().length),
    )
    .toBe(0);
  expect(
    await settings
      .locator('.navigation-indicator')
      .evaluate((node) => node.getBoundingClientRect().width),
  ).toBeGreaterThan(0);
});

test('selection and empty-state fades preserve immediate result interaction and stable refresh identity', async ({
  page,
  request,
  baseURL,
}) => {
  const upload = await request.post('/api/v1/images', {
    headers: {
      Authorization: `Bearer ${await readFile(process.env.TEST_KEY_FILE!, 'utf8')}`,
    },
    multipart: {
      file: {
        name: 'stable.gif',
        mimeType: 'image/gif',
        buffer: await readFile('tests/fixtures/animated.gif'),
      },
    },
  });
  expect(upload.status()).toBe(409);
  await holdMotion(page);
  await page.goto('/images');
  await page
    .getByRole('checkbox', { name: 'Select stable.gif', exact: true })
    .check();
  const bulk = page.locator('.bulk-bar');
  await expect
    .poll(() => bulk.evaluate((node) => Number(getComputedStyle(node).opacity)))
    .toBeGreaterThan(0);
  expect(
    await bulk.evaluate((node) => Number(getComputedStyle(node).opacity)),
  ).toBeLessThan(1);
  await bulk
    .getByRole('button', { name: 'Clear', exact: true })
    .evaluate((node: HTMLButtonElement) => node.click());
  await expect(bulk).toHaveAttribute('inert', '');
  await finishMotion(page);
  await page.evaluate(() => Reflect.set(globalThis, 'motionHold', true));
  const search = page.getByRole('textbox', { name: 'Search images' });
  await search.fill('no-matching-image');
  await expect(page).toHaveURL(/q=no-matching-image/);
  const empty = page.locator('.empty');
  await expect
    .poll(() =>
      empty.evaluate((node) => Number(getComputedStyle(node).opacity)),
    )
    .toBeGreaterThan(0);
  expect(
    await empty.evaluate((node) => Number(getComputedStyle(node).opacity)),
  ).toBeLessThan(1);
  await finishMotion(page);
  const original = await empty.elementHandle();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  expect(
    await empty.evaluate((node, previous) => node === previous, original),
  ).toBe(true);
  expect(await empty.evaluate((node) => node.getAnimations().length)).toBe(0);
  await page.evaluate(() => Reflect.set(globalThis, 'motionHold', true));
  await search.fill('');
  await expect(page).toHaveURL(/\/images$/);
  await expect(empty).toHaveAttribute('inert', '');
  await expect(
    page.getByRole('checkbox', { name: 'Select stable.gif', exact: true }),
  ).toBeEnabled();
  const card = page.locator('.image-card');
  const arrivingBounds = await card.boundingBox();
  await finishMotion(page);
  await expect(empty).toHaveCount(0);
  expect(await card.boundingBox()).toEqual(arrivingBounds);
  await original?.dispose();

  const domain = await request.post('/api/actions/delivery-domain-save', {
    headers: { Origin: baseURL! },
    data: { hostname: 'stable.localhost', accessMode: 'everyone' },
  });
  expect(domain.status()).toBe(200);
  await page.goto('/admin/domains');
  await page.evaluate(() => Reflect.set(globalThis, 'motionHold', true));
  const domainSearch = page.getByRole('textbox', { name: 'Search domains' });
  await domainSearch.fill('not-existing');
  await expect(page).toHaveURL(/q=not-existing/);
  await expect(page.locator('.empty')).toBeVisible();
  await finishMotion(page);
  await page.evaluate(() => Reflect.set(globalThis, 'motionHold', true));
  await domainSearch.fill('');
  await expect(page).toHaveURL(/\/admin\/domains$/);
  await expect(page.locator('.empty')).toHaveAttribute('inert', '');
  const row = page.getByRole('article', {
    name: 'Delivery domain stable.localhost',
    exact: true,
  });
  const rowBounds = await row.boundingBox();
  await finishMotion(page);
  await expect(page.locator('.empty')).toHaveCount(0);
  expect(await row.boundingBox()).toEqual(rowBounds);
});

test('menus reverse and release closed controls; dialogs reopen without stale close events', async ({
  page,
}) => {
  await page.goto('/admin/domains');
  const filter = page.locator('.filter-popover').locator('..');
  const trigger = filter.locator('summary');
  const entranceOpacity = await trigger.evaluate(toggleMenu);
  expect(entranceOpacity).toBeGreaterThan(0);
  expect(entranceOpacity).toBeLessThan(1);
  await expect(filter).toHaveAttribute('open', '');
  const exitOpacity = await trigger.evaluate(toggleMenu);
  expect(exitOpacity).toBeGreaterThan(0);
  expect(exitOpacity).toBeLessThan(1);
  await expect(filter.locator('.search-popover')).toHaveAttribute('inert', '');
  await trigger.evaluate((node: HTMLElement) => node.click());
  await expect(filter.locator('.search-popover')).not.toHaveAttribute(
    'inert',
    '',
  );
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  await expect(filter).not.toHaveAttribute('open', '');

  const add = page
    .getByRole('button', { name: 'Add delivery domain', exact: true })
    .first();
  await add.focus();
  await add.press('Enter');
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(add).toBeFocused();
  // DOM click avoids Playwright waiting for the decorative exit to settle.
  await add.evaluate((node: HTMLButtonElement) => node.click());
  await expect(dialog).toHaveCount(1);
  await expect(dialog).not.toHaveAttribute('inert', '');
  await expect(dialog.getByLabel('Hostname', { exact: true })).toBeEditable();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(add).toBeFocused();
});

test('reduced motion finishes active exits and conditional controls disappear immediately', async ({
  page,
}) => {
  await page.goto('/admin/settings');
  const maximum = page.getByRole('combobox', {
    name: 'Maximum lifetime',
    exact: true,
  });
  await maximum.selectOption('custom');
  await expect(
    page.getByRole('spinbutton', { name: 'Duration', exact: true }),
  ).toBeVisible();
  await maximum.selectOption('unlimited');
  await expect(
    page.getByRole('spinbutton', { name: 'Duration', exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole('combobox', { name: 'Duration unit', exact: true }),
  ).toHaveCount(0);
  await page.goto('/admin/domains');
  const add = page
    .getByRole('button', { name: 'Add delivery domain', exact: true })
    .first();
  await add.click();
  await page.keyboard.press('Escape');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(page.locator('dialog')).toHaveCount(0);
  await add.hover();
  await page.mouse.down();
  await expect(add).toHaveCSS('scale', 'none');
  await page.mouse.up();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  expect(
    await page
      .locator('dialog')
      .evaluate((node) => node.getAnimations({ subtree: true }).length),
  ).toBe(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await add.click();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
});

test('mobile navigation closes immediately, restores Escape focus and resets across resizing', async ({
  page,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/images');
  const aside = page.locator('#main-navigation');
  const toggle = page.getByRole('button', {
    name: /^(Open|Close) navigation$/,
  });
  await expect(aside).toHaveAttribute('inert', '');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await expect(aside).not.toHaveAttribute('inert', '');
  await page.keyboard.press('Escape');
  await expect(aside).toHaveAttribute('inert', '');
  await expect(toggle).toBeFocused();
  await toggle.click();
  await page.setViewportSize({ width: 1200, height: 900 });
  await expect(aside).not.toHaveAttribute('inert', '');
  await expect(aside).not.toHaveClass(/open/);
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(aside).toHaveAttribute('inert', '');
  await toggle.click();
  await aside.getByRole('link', { name: 'Settings', exact: true }).click();
  await expect(page).toHaveURL(/\/settings$/);
  await expect(aside).toHaveAttribute('inert', '');
});

test('drag presentation reverses and resets without intercepting interaction', async ({
  page,
}) => {
  await page.goto('/images');
  const transfer = await page.evaluateHandle(() => {
    const data = new DataTransfer();
    data.items.add(new File(['fixture'], 'motion.png', { type: 'image/png' }));
    return data;
  });
  await page
    .locator('body')
    .dispatchEvent('dragenter', { dataTransfer: transfer });
  const overlay = page.locator('.file-drop-overlay');
  await expect(overlay).toContainText('Release to upload');
  await page.locator('body').dispatchEvent('dragleave');
  await page
    .locator('body')
    .dispatchEvent('dragenter', { dataTransfer: transfer });
  await expect(overlay).toHaveCount(1);
  await expect(overlay).toHaveCSS('pointer-events', 'none');
  await page.locator('body').dispatchEvent('dragend');
  await expect(overlay).toHaveCount(0);
  await page.getByRole('textbox', { name: 'Search images' }).fill('responsive');
  await expect(page).toHaveURL(/q=responsive/);
  await transfer.dispose();
});

test('busy dismissal stays restricted and nested cancellation restores its parent dialog', async ({
  page,
}, testInfo) => {
  await holdMotion(page);
  await page.goto('/admin/domains');
  const add = page
    .getByRole('button', { name: 'Add delivery domain', exact: true })
    .first();
  await add.focus();
  await add.press('Enter');
  const parent = page.locator('dialog[open]');
  await finishMotion(page);
  await parent.getByLabel('Hostname', { exact: true }).fill('motion.localhost');
  const save = gate();
  await page.route('**/api/actions/delivery-domain-save', async (route) => {
    await save.promise;
    await route.fulfill({
      status: 400,
      json: { error: 'Motion fixture rejected the save.' },
    });
  });
  await parent
    .getByRole('button', { name: 'Add delivery domain', exact: true })
    .click();
  await expect(
    parent.getByRole('button', { name: 'Close dialog' }),
  ).toBeDisabled();
  const disabledClose = parent.getByRole('button', { name: 'Close dialog' });
  const disabledColor = await disabledClose.evaluate(
    (node) => getComputedStyle(node).backgroundColor,
  );
  await disabledClose.hover();
  await page.mouse.down();
  await expect(disabledClose).toHaveCSS('background-color', disabledColor);
  await expect(disabledClose).toHaveCSS('scale', 'none');
  await expect(disabledClose).toHaveCSS('transform', 'none');
  await page.mouse.up();
  await page.keyboard.press('Escape');
  await expect(parent).toHaveCount(1);
  save.release();
  await expect(
    parent.getByRole('button', { name: 'Close dialog' }),
  ).toBeEnabled();

  const upload = gate();
  await page.route('**/api/upload', async (route) => {
    await upload.promise;
    await route.fulfill({
      status: 201,
      json: { id: 'img_motion', url: null, sharingWarning: null },
    });
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'motion.jpg',
    mimeType: 'image/jpeg',
    buffer: await readFile('tests/fixtures/upload.jpeg'),
  });
  const cancel = page.getByRole('button', {
    name: 'Cancel Upload',
    exact: true,
    includeHidden: true,
  });
  await expect(cancel).toHaveCount(1);
  const hostname = parent.getByLabel('Hostname', { exact: true });
  await hostname.focus();
  await cancel.evaluate((node: HTMLButtonElement) => node.click());
  const confirmation = page.getByRole('dialog', { name: 'Cancel upload?' });
  await expect(confirmation).toBeVisible();
  await page.evaluate(() => Reflect.set(globalThis, 'motionHold', true));
  await confirmation.getByRole('button', { name: 'Keep Uploading' }).click();
  await expect(hostname).toBeFocused();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  const outgoing = page.locator('dialog:not([open])');
  await expect(outgoing).toHaveAttribute('inert', '');
  await expect(outgoing).toHaveAttribute('aria-hidden', 'true');
  await expect
    .poll(() => outgoing.evaluate((node) => node.matches(':popover-open')))
    .toBe(true);
  await expect
    .poll(() =>
      outgoing
        .locator('.dialog-surface')
        .evaluate((node) => Number(getComputedStyle(node).opacity)),
    )
    .toBeGreaterThan(0);
  expect(
    await outgoing
      .locator('.dialog-surface')
      .evaluate((node) => Number(getComputedStyle(node).opacity)),
  ).toBeLessThan(1);
  await page.screenshot({
    path: testInfo.outputPath('nested-confirmation-mid-exit.png'),
  });
  await finishMotion(page);
  await expect(outgoing).toHaveCount(0);
  upload.release();
  await expect(
    page.getByRole('region', {
      name: 'Success notification',
      includeHidden: true,
    }),
  ).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(add).toBeFocused();
});

test('navigation tears down a cancellation surface and preserves operation completion', async ({
  page,
}) => {
  await page.goto('/images');
  const upload = gate();
  await page.route('**/api/upload', async (route) => {
    await upload.promise;
    await route.fulfill({
      status: 201,
      json: { id: 'img_motion', url: null, sharingWarning: null },
    });
  });
  await page.locator('input[type="file"]').setInputFiles({
    name: 'navigation.jpg',
    mimeType: 'image/jpeg',
    buffer: await readFile('tests/fixtures/upload.jpeg'),
  });
  await page
    .getByRole('button', { name: 'Cancel Upload', exact: true })
    .click();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  await page
    .locator('aside')
    .getByRole('link', { name: 'Settings', exact: true, includeHidden: true })
    .evaluate((node: HTMLAnchorElement) => node.click());
  await expect(page).toHaveURL(/\/settings$/);
  await expect(page.locator('dialog')).toHaveCount(0);
  await page
    .getByRole('button', { name: 'Cancel Upload', exact: true })
    .click();
  await expect(page.locator('dialog[open]')).toHaveCount(1);
  upload.release();
  await expect(page.locator('dialog')).toHaveCount(0);
  await expect(
    page.getByRole('region', { name: 'Success notification' }),
  ).toBeVisible();
  await page
    .getByRole('button', { name: 'Dismiss notification', exact: true })
    .click();
  await expect(page.locator('.toast')).toHaveCount(0);
});

test('collection refresh preserves identity and notification arrival during exit preserves its successor', async ({
  page,
  request,
  browserName,
}, testInfo) => {
  const upload = await request.post('/api/v1/images', {
    headers: {
      Authorization: `Bearer ${await readFile(process.env.TEST_KEY_FILE!, 'utf8')}`,
    },
    multipart: {
      file: {
        name: 'motion.gif',
        mimeType: 'image/gif',
        buffer: await readFile('tests/fixtures/animated.gif'),
      },
    },
  });
  // The image is saved privately; ShareX reports that no public link was made.
  expect(upload.status()).toBe(409);
  await page.goto('/images');
  const card = page.locator('.image-card').filter({ hasText: 'motion.gif' });
  const original = await card.elementHandle();
  await page.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(
    page.getByRole('button', { name: 'Refresh', exact: true }),
  ).toBeEnabled();
  expect(
    await card.evaluate((node, previous) => node === previous, original),
  ).toBe(true);

  // Isolate notification behavior from platform clipboard permission prompts.
  await page.evaluate(() =>
    Object.defineProperty(navigator, 'clipboard', {
      value: { writeText: async () => {} },
    }),
  );
  const menu = card.locator('.action-menu');
  const trigger = menu.locator('summary');
  await trigger.click();
  const copy = menu.getByRole('button', { name: 'Copy image ID', exact: true });
  await copy.hover();
  await page.mouse.down();
  await expect(copy).toHaveCSS('scale', 'none');
  await page.mouse.up();
  const deck = page.locator('.notification-deck');
  await expect(deck.locator('.active')).toHaveCount(1);
  // A new arrival and a dismissal share one task; the old outro cannot mark
  // the new card inactive or steal its focus.
  await page.evaluate(() => {
    document
      .querySelector<HTMLButtonElement>(
        '.notification-deck .active button[aria-label="Dismiss notification"]',
      )!
      .click();
    document
      .querySelector<HTMLButtonElement>('.action-menu button[title="Copied"]')!
      .click();
  });
  await expect(deck.locator('.active')).toHaveCount(1);
  await expect(deck.locator('.active')).not.toHaveAttribute('inert', '');
  await expect(
    deck.getByRole('region', { name: 'Success notification' }),
  ).toHaveCount(1);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(deck.locator('.active .expiration-progress')).toHaveCSS(
    'visibility',
    'hidden',
  );
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await expect(deck.locator('.active .expiration-progress')).toHaveCSS(
    'visibility',
    'visible',
  );
  await deck.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(
    deck.getByText('Dashboard refreshed.', { exact: true }),
  ).toBeVisible();
  await expect(deck.locator('.active')).not.toHaveAttribute('inert', '');
  await deck.getByRole('button', { name: 'Dismiss notification' }).click();
  await expect(deck.locator('.toast')).toHaveCount(0);

  // eslint-disable-next-line playwright/no-conditional-in-test -- CDP profiling is Chromium-only; behavioral assertions above run in every engine.
  if (browserName === 'chromium') {
    const session = await page.context().newCDPSession(page);
    await session.send('Performance.enable');
    const traceEvents: unknown[] = [];
    session.on('Tracing.dataCollected', ({ value }: { value: unknown[] }) => {
      traceEvents.push(...value);
    });
    await session.send('Tracing.start', {
      categories: 'devtools.timeline,blink.user_timing,loading',
    });
    const before = await session.send('Performance.getMetrics');
    for (let index = 0; index < 3; index++) {
      await trigger.click();
      await menu
        .getByRole('button', { name: 'Change expiry', exact: true })
        .click();
      await page.keyboard.press('Escape');
    }
    const search = page.getByRole('textbox', { name: 'Search images' });
    await search.fill('mo');
    await search.fill('mot');
    await search.fill('motion');
    await page.waitForURL(/q=motion/);
    await search.fill('');
    await page.waitForURL(/\/images$/);
    const after = await session.send('Performance.getMetrics');

    const traced = new Promise<void>((resolve) =>
      session.once('Tracing.tracingComplete', () => resolve()),
    );
    await session.send('Tracing.end');
    await traced;
    const timelinePath = testInfo.outputPath('motion-timeline.json');
    await writeFile(timelinePath, JSON.stringify({ traceEvents }));
    await testInfo.attach('motion-timeline', {
      path: timelinePath,
      contentType: 'application/json',
    });
    const performancePath = testInfo.outputPath('motion-performance.json');
    await writeFile(performancePath, JSON.stringify({ before, after }));
    await testInfo.attach('motion-performance', {
      path: performancePath,
      contentType: 'application/json',
    });
    await session.detach();
  }
  expect(
    await card.evaluate((node, previous) => node === previous, original),
  ).toBe(true);
  await trigger.click();
  const screenshotPath = testInfo.outputPath('image-controls.png');
  await page.screenshot({ path: screenshotPath, animations: 'disabled' });
  await testInfo.attach('image-controls', {
    path: screenshotPath,
    contentType: 'image/png',
  });
  await page.keyboard.press('Escape');
  await original?.dispose();
});
