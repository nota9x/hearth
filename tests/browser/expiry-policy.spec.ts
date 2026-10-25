/* eslint-disable unicorn/no-await-expression-member -- Assertions read completed HTTP responses directly. */
import { Buffer } from 'node:buffer';

import { z } from 'zod';

import { expect, signIn, test } from '../helpers/browser';
import { configureDeliveryDomain } from '../helpers/delivery';

test('expiry administration, saved-default uploads and atomic selections across pages', async ({
  hearth,
  proxy,
  page,
  request,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  await signIn(page, request, baseURL!);
  const headers = { Origin: baseURL! };
  const errors: string[] = [];
  page.on('pageerror', (error) => {
    errors.push(error.message);
  });
  const stamp = 123_456_789;
  const created = await request.post('/api/actions/user-create', {
    headers,
    data: {
      displayName: `Expiry member ${stamp}`,
      role: 'user',
      token: 'XXXX.DUMMY.TOKEN.XXXX',
    },
  });
  expect(created.status()).toBe(200);
  const member = z
    .object({ userId: z.string(), key: z.string() })
    .parse(await created.json());
  const memberContext = await browser.newContext({ proxy, baseURL });
  const memberPage = await memberContext.newPage();
  memberPage.on('pageerror', (error) => {
    errors.push(error.message);
  });
  try {
    await page.goto('/admin/settings');
    const policy = page.locator('section').filter({
      has: page.getByRole('heading', {
        name: 'Expiry policy',
        exact: true,
      }),
    });
    await policy
      .getByRole('switch', { name: 'Require image and link expiry' })
      .check();
    await policy
      .getByRole('combobox', { name: 'Maximum lifetime' })
      .selectOption('custom');
    await policy
      .getByRole('spinbutton', { name: 'Duration', exact: true })
      .fill('30');
    await policy
      .getByRole('combobox', { name: 'Duration unit' })
      .selectOption({ label: 'Minutes' });
    const policySave = page.waitForResponse('**/api/actions/expiry-policy');
    await policy.getByRole('button', { name: 'Save expiry policy' }).click();
    expect((await policySave).status()).toBe(200);
    await page.goto(`/admin/users/${member.userId}`);
    await page
      .getByRole('button', { name: 'Expiry policy', exact: true })
      .click();
    await expect(
      page.getByText('Maximum lifetime: 30 minutes', { exact: false }),
    ).toBeVisible();
    await page
      .getByRole('combobox', { name: 'Expiry policy', exact: true })
      .selectOption({ label: 'Custom overrides' });
    await page
      .getByRole('combobox', { name: 'Expiry requirement', exact: true })
      .selectOption({ label: 'Optional' });
    await page
      .getByRole('combobox', { name: 'Maximum lifetime policy', exact: true })
      .selectOption({ label: 'Override maximum lifetime' });
    await expect(
      page.getByText('Maximum lifetime: Unlimited', { exact: false }),
    ).toBeVisible();
    await page.setViewportSize({ width: 320, height: 640 });
    await page.setViewportSize({ width: 1440, height: 1000 });
    const overrideSave = page.waitForResponse(
      '**/api/actions/user-expiry-policy',
    );
    await page.getByRole('button', { name: 'Save user expiry policy' }).click();
    expect((await overrideSave).status()).toBe(200);
    await page
      .getByRole('combobox', { name: 'Expiry policy', exact: true })
      .selectOption({ label: 'Use instance defaults' });
    const inheritSave = page.waitForResponse(
      '**/api/actions/user-expiry-policy',
    );
    await page.getByRole('button', { name: 'Save user expiry policy' }).click();
    expect((await inheritSave).status()).toBe(200);

    const deliveryDomainId = `dom_${crypto.randomUUID().replaceAll('-', '')}`;
    await configureDeliveryDomain(
      request,
      baseURL!,
      `expiry-${stamp}.localhost`,
    );
    const fixture = `UPDATE users SET onboardingStatus='exempt',preferredDeliveryDomainId=(SELECT id FROM delivery_domains WHERE hostname='expiry-${stamp}.localhost') WHERE id='${member.userId}';
      WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<120)
      INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt)
      SELECT 'img_'||lower(hex(randomblob(16))), '${member.userId}', '${deliveryDomainId}-'||x, 'Expiry fixture '||x||'.png', 'image/png','png',1,'test',1,1,unixepoch() FROM n;`;
    await hearth.DB.batch(
      fixture
        .split(';')
        .filter((sql) => sql.trim())
        .map((sql) => hearth.DB.prepare(sql)),
    );
    const memberLogin = await memberContext.request.post('/api/actions/login', {
      headers,
      data: { key: member.key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
    });
    expect(memberLogin.status()).toBe(200);
    await memberPage.goto('/settings');
    await expect(
      memberPage.getByText('Your saved default is no longer allowed.', {
        exact: false,
      }),
    ).toBeVisible();
    const defaults = memberPage.getByRole('combobox', {
      name: 'Default image expiry',
    });
    await expect(
      defaults.locator('option[value="never"]:not([disabled])'),
    ).toHaveCount(0);
    await expect(defaults.locator('option[value="1h"]')).toHaveCount(0);
    await defaults.selectOption('duration');
    await memberPage
      .getByRole('spinbutton', { name: 'Default duration (seconds)' })
      .fill('900');
    const preferencesSave = memberPage.waitForResponse(
      '**/api/actions/preferences',
    );
    await memberPage.getByRole('button', { name: 'Save preferences' }).click();
    expect((await preferencesSave).status()).toBe(200);
    await memberPage.goto('/images');
    const file = {
      name: 'Saved-default.png',
      mimeType: 'image/png',
      buffer: Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
        'base64',
      ),
    };
    const pickerUpload = memberPage.waitForResponse('**/api/upload');
    await memberPage.locator('input[type="file"]').setInputFiles(file);
    expect((await pickerUpload).status()).toBe(201);
    await expect(memberPage.getByRole('dialog')).toHaveCount(0);
    const dropUpload = memberPage.waitForResponse('**/api/upload');
    const transfer = await memberPage.evaluateHandle(
      (bytes) => {
        const data = new DataTransfer();
        data.items.add(
          new File([Uint8Array.from(bytes)], 'Drop-default.png', {
            type: 'image/png',
          }),
        );
        return data;
      },
      [...file.buffer],
    );
    await memberPage
      .locator('main')
      .dispatchEvent('drop', { dataTransfer: transfer });
    expect((await dropUpload).status()).toBe(201);
    await expect(memberPage.getByRole('dialog')).toHaveCount(0);
    await memberPage
      .getByRole('checkbox', { name: /^Select / })
      .first()
      .check();
    await memberPage
      .getByRole('button', { name: 'Select all', exact: true })
      .click();
    await expect(memberPage.locator('.bulk-bar')).toContainText('122 selected');
    const downloadBatches: number[] = [];
    memberPage.on('request', (outgoing) => {
      if (!outgoing.url().endsWith('/api/actions/image-download')) return;
      const batch = z
        .object({ ids: z.array(z.string()) })
        .parse(outgoing.postDataJSON());
      downloadBatches.push(batch.ids.length);
    });
    await memberPage.evaluate(() => {
      Reflect.deleteProperty(globalThis, 'showSaveFilePicker');
    });
    const [archive] = await Promise.all([
      memberPage.waitForEvent('download'),
      memberPage
        .locator('.bulk-bar')
        .getByRole('button', { name: 'Download', exact: true })
        .click(),
    ]);
    expect(archive.suggestedFilename()).toMatch(/\.zip$/);
    expect(downloadBatches).toEqual([100, 22]);
    await memberPage
      .getByRole('button', { name: 'Change expiry', exact: true })
      .click();
    const dialog = memberPage.getByRole('dialog');
    const expirySelect = dialog.getByRole('combobox', { name: 'Image expiry' });
    await expect(expirySelect.locator('option[value="never"]')).toHaveCount(0);
    await expirySelect.selectOption('custom');
    const dateInput = dialog.getByLabel('Expiration date and time');
    await expect(dateInput).toHaveAttribute('max', /\d{4}-\d\d-\d\dT/);
    const localDate = (seconds: number) =>
      memberPage.evaluate((offset) => {
        const date = new Date(Date.now() + offset * 1000);
        return new Date(date.getTime() - date.getTimezoneOffset() * 60_000)
          .toISOString()
          .slice(0, 19);
      }, seconds);
    await dateInput.fill(await localDate(3600));
    expect(
      await dateInput.evaluate(
        (input: HTMLInputElement) => input.validity.rangeOverflow,
      ),
    ).toBe(true);
    await dateInput.fill(await localDate(600));
    expect(
      await dateInput.evaluate(
        (input: HTMLInputElement) => input.validity.rangeOverflow,
      ),
    ).toBe(false);
    const expirySave = memberPage.waitForRequest('**/api/actions/image-expiry');
    const expiryResponse = memberPage.waitForResponse(
      '**/api/actions/image-expiry',
    );
    await dialog.getByRole('button', { name: 'Save expiry' }).click();
    const submitted = z
      .object({ ids: z.array(z.string()) })
      .parse((await expirySave).postDataJSON());
    expect(submitted.ids).toHaveLength(122);
    expect((await expiryResponse).status()).toBe(200);
    await expect(dialog).toHaveCount(0);
    await expect(memberPage.locator('.image-expiry').first()).toBeVisible();
    await memberPage
      .getByRole('checkbox', { name: /^Select / })
      .first()
      .check();
    await memberPage
      .getByRole('button', { name: 'Select all', exact: true })
      .first()
      .click();
    await expect(memberPage.locator('.bulk-bar')).toContainText('122 selected');
    await memberPage
      .getByRole('button', { name: 'Delete', exact: true })
      .click();
    await memberPage
      .getByRole('dialog')
      .getByRole('button', { name: 'Confirm', exact: true })
      .click();
    await expect(
      memberPage.getByRole('heading', { name: 'No images yet' }),
    ).toBeVisible({ timeout: 30_000 });
    expect(errors).toEqual([]);
  } finally {
    await memberContext.close();
  }
});
