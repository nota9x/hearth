import { readFile } from 'node:fs/promises';

import type { APIRequestContext } from '@playwright/test';
import { z } from 'zod';

import { expect, test } from '../helpers/browser';
import { configureDeliveryDomain } from '../helpers/delivery';

const dummyToken = 'XXXX.DUMMY.TOKEN.XXXX';
const accountSchema = z.object({ userId: z.string(), key: z.string() });
const imageSchema = z.object({ id: z.string(), url: z.string().nullable() });

test('actual web and delivery Workers respect completed credential, account and link revocations', async ({
  proxy,
  playwright,
  request,
  baseURL,
}) => {
  const origin = baseURL!;
  const key = await readFile(process.env.TEST_KEY_FILE!, 'utf8');
  const action = (client: APIRequestContext, name: string, data: unknown) =>
    client.post(`/api/actions/${name}`, { headers: { Origin: origin }, data });
  const login = await action(request, 'login', { key, token: dummyToken });
  expect(login.status()).toBe(200);
  const domain = await configureDeliveryDomain(
    request,
    origin,
    'boundary.localhost',
  );
  const firstResponse = await action(request, 'user-create', {
    displayName: 'Boundary owner',
    role: 'user',
    token: dummyToken,
  });
  expect(firstResponse.status()).toBe(200);
  const owner = accountSchema.parse(await firstResponse.json());
  const secondResponse = await action(request, 'user-create', {
    displayName: 'Boundary attacker',
    role: 'user',
    token: dummyToken,
  });
  expect(secondResponse.status()).toBe(200);
  const attacker = accountSchema.parse(await secondResponse.json());
  const ownerClient = await playwright.request.newContext({
    proxy,
    baseURL: origin,
  });
  const attackerClient = await playwright.request.newContext({
    proxy,
    baseURL: origin,
  });
  const anonymous = await playwright.request.newContext({ proxy });
  const delivery = (
    address: string,
    method = 'GET',
    headers: Record<string, string> = {},
  ) => {
    const target = new URL(address);
    const host = target.host;
    target.hostname = '127.0.0.1';
    return anonymous.fetch(target.href, {
      method,
      headers: { Host: host, ...headers },
    });
  };
  try {
    for (const [client, account] of [
      [ownerClient, owner],
      [attackerClient, attacker],
    ] as const) {
      const response = await action(client, 'login', {
        key: account.key,
        token: dummyToken,
      });
      expect(response.status()).toBe(200);
    }
    const preference = await action(ownerClient, 'delivery-preference', {
      deliveryDomainId: domain.id,
    });
    expect(preference.status()).toBe(200);
    const upload = (credential?: string) =>
      ownerClient.post('/api/v1/images', {
        headers: credential ? { Authorization: `Bearer ${credential}` } : {},
        multipart: {
          file: {
            name: 'boundary.png',
            mimeType: 'image/png',
            buffer: Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
              'base64',
            ),
          },
        },
      });
    const uploaded = await upload(owner.key);
    expect(uploaded.status()).toBe(201);
    const image = imageSchema.parse(await uploaded.json());
    expect(image.url).not.toBeNull();
    const publicResponse = await delivery(image.url!);
    expect(publicResponse.status()).toBe(200);
    const etag = publicResponse.headers().etag;
    const crossUser = await attackerClient.get(`/api/media/${image.id}`);
    expect(crossUser.status()).toBe(404);
    const forbiddenLink = await action(attackerClient, 'alias-create', {
      imageId: image.id,
      deliveryDomainId: domain.id,
      expiry: 'never',
    });
    expect(forbiddenLink.status()).toBe(404);
    const cookieOnly = await upload();
    expect(cookieOnly.status()).toBe(401);
    const foreignOrigin = await ownerClient.post('/api/actions/image-delete', {
      headers: { Origin: 'https://evil.example' },
      data: { ids: [image.id] },
    });
    expect(foreignOrigin.status()).toBe(403);
    for (const path of [
      '/api/%61ctions/image-delete',
      '/api/actions%2fimage-delete',
      '/api/v1/../actions/image-delete',
      '/api/v1/%2e%2e/actions/image-delete',
    ]) {
      const response = await ownerClient.post(path, {
        data: { ids: [image.id] },
      });
      expect(response.status()).toBe(403);
    }
    const rotation = await action(ownerClient, 'rotate', { token: dummyToken });
    expect(rotation.status()).toBe(200);
    const replacement = z
      .object({ key: z.string() })
      .parse(await rotation.json());
    const oldBearer = await upload(owner.key);
    expect(oldBearer.status()).toBe(401);
    const staleCookie = await ownerClient.get(`/api/media/${image.id}`);
    expect(staleCookie.status()).toBe(401);
    const newLogin = await action(ownerClient, 'login', {
      key: replacement.key,
      token: dummyToken,
    });
    expect(newLogin.status()).toBe(200);
    const newMedia = await ownerClient.get(`/api/media/${image.id}`);
    expect(newMedia.status()).toBe(200);
    const disabled = await action(request, 'user-update', {
      userId: owner.userId,
      displayName: 'Boundary owner',
      status: 'disabled',
      quotaBytes: null,
    });
    expect(disabled.status()).toBe(200);
    for (const method of ['GET', 'HEAD']) {
      const response = await delivery(image.url!, method, {
        'If-None-Match': etag,
        Range: 'bytes=0-1',
      });
      expect(response.status()).toBe(404);
      expect(response.headers().etag).toBeUndefined();
    }
    const disabledBearer = await upload(replacement.key);
    expect(disabledBearer.status()).toBe(401);
    const reenabled = await action(request, 'user-update', {
      userId: owner.userId,
      displayName: 'Boundary owner',
      status: 'active',
      quotaBytes: null,
    });
    expect(reenabled.status()).toBe(200);
    const revokedSession = await ownerClient.get(`/api/media/${image.id}`);
    expect(revokedSession.status()).toBe(401);
    const restoredPublic = await delivery(image.url!);
    expect(restoredPublic.status()).toBe(200);
    const deletion = await action(request, 'user-delete', {
      userId: owner.userId,
      token: dummyToken,
    });
    expect(deletion.status()).toBe(200);
    const deletedPublic = await delivery(image.url!, 'GET', {
      'If-None-Match': etag,
    });
    expect(deletedPublic.status()).toBe(404);
    const attackerStillActive = await action(
      attackerClient,
      'image-select-all',
      {
        admin: false,
      },
    );
    expect(attackerStillActive.status()).toBe(200);
  } finally {
    await ownerClient.dispose();
    await attackerClient.dispose();
    await anonymous.dispose();
  }
});
