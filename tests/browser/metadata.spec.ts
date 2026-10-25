/* eslint-disable unicorn/no-await-expression-member, unicorn/consistent-function-scoping -- Browser decoding helpers must execute inside page.evaluate. */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import nodePath from 'node:path';

import { z } from 'zod';

import { expect, test } from '../helpers/browser';
import { configureDeliveryDomain } from '../helpers/delivery';

test('metadata preferences preserve original bytes and browser-decoded pixels', async ({
  hearth,
  proxy,
  request,
  browser,
  baseURL,
}) => {
  test.setTimeout(180_000);
  const key = await readFile(process.env.TEST_KEY_FILE!, 'utf8');
  const headers = { Origin: baseURL! };
  const login = await request.post('/api/actions/login', {
    headers,
    data: { key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
  });
  expect(login.status()).toBe(200);
  await configureDeliveryDomain(
    request,
    baseURL!,
    `metadata-123456789.localhost`,
    true,
  );
  const created = await request.post('/api/actions/user-create', {
    headers,
    data: {
      displayName: `Metadata member 123456789`,
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
  const context = await browser.newContext({ proxy, baseURL });
  const memberPage = await context.newPage();
  const errors: string[] = [];
  memberPage.on('pageerror', (error) => {
    errors.push(error.message);
  });
  try {
    const memberLogin = await context.request.post('/api/actions/login', {
      headers,
      data: { key: member.key, token: 'XXXX.DUMMY.TOKEN.XXXX' },
    });
    expect(memberLogin.status()).toBe(200);

    await memberPage.goto('/settings');
    const toggle = memberPage.getByRole('switch', {
      name: 'Strip image metadata',
    });
    await expect(toggle).toBeChecked();
    await expect(
      memberPage.getByText(
        'Remove unnecessary embedded details from future uploads.',
      ),
    ).toBeVisible();

    async function save(enabled: boolean) {
      await toggle.setChecked(enabled);
      const saving = memberPage.waitForResponse('**/api/actions/preferences');
      await memberPage
        .getByRole('button', { name: 'Save preferences' })
        .click();
      expect((await saving).status()).toBe(200);
      await memberPage.reload();
      await expect(toggle).toBeChecked({ checked: enabled });
    }
    async function apiUpload(name: string, bytes: Buffer) {
      const response = await context.request.post('/api/v1/images', {
        headers: { Authorization: `Bearer ${member.key}` },
        multipart: { file: { name, mimeType: 'image/png', buffer: bytes } },
      });
      expect(response.status(), await response.text()).toBe(201);
      return z
        .object({ id: z.string(), size: z.number() })
        .parse(await response.json());
    }
    async function original(id: string) {
      const response = await context.request.get(`/api/media/${id}?download`);
      expect(response.status()).toBe(200);
      return response.body();
    }
    const bytes = await readFile('tests/fixtures/metadata/private.png');
    const first = await apiUpload('Default metadata.png', bytes);
    const sanitized = await original(first.id);
    expect(sanitized.includes(Buffer.from('Private'))).toBe(false);
    expect(first.size).toBe(sanitized.length);
    await save(false);
    const preserved = await apiUpload('Preserved metadata.png', bytes);
    expect(await original(preserved.id)).toEqual(bytes);
    await save(true);
    expect(await original(first.id)).toEqual(sanitized);
    expect(await original(preserved.id)).toEqual(bytes);

    await memberPage.goto('/images');
    const web = memberPage.waitForResponse('**/api/upload');
    await memberPage
      .locator('input[type=file]')
      .first()
      .setInputFiles(nodePath.resolve('tests/fixtures/metadata/private.png'));
    const webResponse = await web;
    expect(webResponse.status()).toBe(201);
    const webImage = z
      .object({ id: z.string() })
      .parse(await webResponse.json());
    expect(await original(webImage.id)).toEqual(sanitized);
    for (const name of [
      ...Array.from(
        { length: 8 },
        (_, index) => `orientation-${index + 1}.jpg`,
      ),
      'private.png',
      'private.webp',
      'private.avif',
      'orientation-7.png',
      'orientation-7.webp',
      ...Array.from(
        { length: 7 },
        (_, index) => `orientation-${index + 2}.avif`,
      ),
    ]) {
      const input = await readFile(`tests/fixtures/metadata/${name}`);
      const uploaded = await apiUpload(name, input);
      const output = await original(uploaded.id);
      const render = await memberPage.evaluate(
        async ({ before, after }) => {
          async function decode(base64: string) {
            const image = new Image();
            image.src = `data:application/octet-stream;base64,${base64}`;
            await image.decode();
            const canvas = document.createElement('canvas');
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            const context_ = canvas.getContext('2d')!;
            context_.drawImage(image, 0, 0);
            const pixels = context_.getImageData(
              0,
              0,
              canvas.width,
              canvas.height,
            ).data;
            return {
              width: canvas.width,
              height: canvas.height,
              digest: [
                ...new Uint8Array(
                  await crypto.subtle.digest('SHA-256', pixels),
                ),
              ],
            };
          }
          return { before: await decode(before), after: await decode(after) };
        },
        { before: input.toString('base64'), after: output.toString('base64') },
      );
      expect(render.after, name).toEqual(render.before);
      expect(output.includes(Buffer.from('Private'))).toBe(false);
    }
    const malformed = Buffer.from(bytes);
    malformed[29] ^= 1;
    const failure = await context.request.post('/api/v1/images', {
      headers: { Authorization: `Bearer ${member.key}` },
      multipart: {
        file: { name: 'Bad.png', mimeType: 'image/png', buffer: malformed },
      },
    });
    expect(failure.status()).toBe(400);
    expect(errors).toEqual([]);
  } finally {
    await context.close();
  }
});
