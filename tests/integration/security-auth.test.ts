/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed query and HTTP results. */
import { Buffer } from 'node:buffer';

import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as actionHandler } from '../../apps/web/src/routes/api/actions/[action]/+server';
import { GET as mediaHandler } from '../../apps/web/src/routes/api/media/[id]/+server';
import { POST as browserUploadHandler } from '../../apps/web/src/routes/api/upload/+server';
import { POST as bearerUploadHandler } from '../../apps/web/src/routes/api/v1/images/+server';
import {
  authenticateKey,
  authenticateSession,
  createSession,
  createUser,
  rotateKey,
} from '../../packages/core/auth';
import { id, now } from '../../packages/core/common';
import { randomSecret } from '../../packages/core/crypto';
import { database, type User } from '../../packages/core/db';
import { digest } from '../../packages/core/digest';
import type { Env } from '../../packages/core/env';
import { createLink } from '../../packages/core/links';
import {
  aliases,
  apiKeys,
  deleteTokens,
  images,
  sessions,
  users,
} from '../../packages/core/schema';
import { migrateDatabase } from '../helpers/database';

vi.mock('cloudflare:workers', () => ({ waitUntil: () => {} }));

let mf: Miniflare, env: Env, owner: User, other: User, admin: User;
let ownerKey: string, otherKey: string;
const origin = 'http://localhost';
const deliveryDomainId = id('hst');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);

beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
      r2Buckets: ['BUCKET'],
    }),
  );
  const DB = await mf.getD1Database('DB');
  await migrateDatabase(DB);
  const limit = { limit: () => Promise.resolve({ success: true }) };
  // @ts-expect-error Miniflare R2 proxies use Undici Headers types; the runtime binding is compatible.
  env = {
    DB,
    BUCKET: await mf.getR2Bucket('BUCKET'),
    ENVIRONMENT: 'development',
    APP_ORIGIN: origin,
    TURNSTILE_SITE_KEY: 'test',
    MAX_UPLOAD_BYTES: '10485760',
    LOGIN_LIMIT: limit,
    MUTATION_LIMIT: limit,
    SENSITIVE_LIMIT: limit,
    UPLOAD_LIMIT: limit,
  } as Env;
  const people = await Promise.all([
    createUser(DB, 'Owner', 'user', null),
    createUser(DB, 'Other', 'user', null),
    createUser(DB, 'Administrator', 'admin', null),
  ]);
  [owner, other, admin] = await Promise.all(
    people.map(async (person) => {
      const [user] = await database(DB)
        .select()
        .from(users)
        .where(eq(users.id, person.userId));
      return user;
    }),
  );
  [ownerKey, otherKey] = people.map((person) => person.key);
  await DB.prepare(
    'INSERT INTO delivery_domains (id,hostname,health,createdAt,updatedAt) VALUES (?,?,?,?,?)',
  )
    .bind(deliveryDomainId, 'shots.example.com', 'active', now(), now())
    .run();
});

afterEach(async () => {
  await mf?.dispose();
});

function action(
  name: string,
  input: Record<string, unknown>,
  actor: User | null,
) {
  return actionHandler({
    request: new Request(`${origin}/api/actions/${name}`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    locals: { env, user: actor },
    params: { action: name },
    cookies: { get: () => {}, set: vi.fn(), delete: vi.fn() },
  } as unknown as Parameters<typeof actionHandler>[0]);
}

async function seedImage(person = owner) {
  const imageId = id('img');
  await database(env.DB)
    .insert(images)
    .values({
      id: imageId,
      userId: person.id,
      objectKey: imageId,
      filename: `${person.displayName}.png`,
      mime: 'image/png',
      extension: 'png',
      size: png.length,
      sha256: 'security-fixture',
      width: 1,
      height: 1,
      createdAt: now(),
    });
  await env.BUCKET.put(imageId, png);
  return imageId;
}

function media(imageId: string, actor: User | null, method = 'GET') {
  const url = new URL(`${origin}/api/media/${imageId}?preview&download`);
  return mediaHandler({
    request: new Request(url, {
      method,
      headers: { Range: 'bytes=0-10', 'If-None-Match': '*' },
    }),
    url,
    locals: { env, user: actor },
    params: { id: imageId },
  } as unknown as Parameters<typeof mediaHandler>[0]);
}

function uploadRequest(authorization?: string, retryKey?: string) {
  const form = new FormData();
  form.set('file', new Blob([png], { type: 'image/png' }), 'picture.png');
  const headers = new Headers();
  if (authorization) headers.set('Authorization', authorization);
  if (retryKey) headers.set('Idempotency-Key', retryKey);
  return new Request(`${origin}/api/v1/images`, {
    method: 'POST',
    headers,
    body: form,
  });
}

function bearerUpload(request: Request, actor: User | null = null) {
  return bearerUploadHandler({
    request,
    locals: { env, user: actor },
  } as unknown as Parameters<typeof bearerUploadHandler>[0]);
}

describe('API key credential boundary', () => {
  it('stores only a purpose-separated verifier and rejects substituted secrets', async () => {
    const { key, user } = await authenticateKey(env.DB, ownerKey);
    expect(user.id).toBe(owner.id);
    expect(key.secretHash).toBe(await digest(ownerKey, 'api-key'));
    expect(key.secretHash).not.toBe(ownerKey);
    const substituted = ownerKey.slice(0, -64) + otherKey.slice(-64);
    await expect(authenticateKey(env.DB, substituted)).rejects.toMatchObject({
      status: 401,
      code: 'INVALID_KEY',
    });
    await expect(
      authenticateKey(env.DB, ownerKey.slice(0, -64) + key.secretHash),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      authenticateKey(env.DB, `img_live_${randomSecret(16)}_${randomSecret()}`),
    ).rejects.toMatchObject({ status: 401 });
  });

  it.each(['', 'img_live_', 'Bearer key', ' img_live_key', 'IMG_LIVE_key'])(
    'denies malformed credential %j',
    async (key) => {
      await expect(authenticateKey(env.DB, key)).rejects.toMatchObject({
        status: 401,
        code: 'INVALID_KEY',
      });
    },
  );

  it('revokes the previous key and every browser session atomically on rotation', async () => {
    const created = await createUser(env.DB, 'Rotating', 'user', admin.id);
    const authenticated = await authenticateKey(env.DB, created.key);
    const token = await createSession(
      env.DB,
      created.userId,
      authenticated.key.version,
    );
    expect(await authenticateSession(env.DB, token)).toMatchObject({
      id: created.userId,
    });
    const replacement = await rotateKey(env.DB, created.userId, created.userId);
    await expect(authenticateKey(env.DB, created.key)).rejects.toMatchObject({
      status: 401,
    });
    expect(await authenticateSession(env.DB, token)).toBeNull();
    const current = await authenticateKey(env.DB, replacement);
    expect(current.key.version).toBe(authenticated.key.version + 1);
    const lateToken = await createSession(
      env.DB,
      created.userId,
      authenticated.key.version,
    );
    expect(await authenticateSession(env.DB, lateToken)).toBeNull();
    const newToken = await createSession(
      env.DB,
      created.userId,
      current.key.version,
    );
    expect(await authenticateSession(env.DB, newToken)).toMatchObject({
      id: created.userId,
    });
    const rows = await database(env.DB)
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.userId, created.userId));
    expect(rows).toHaveLength(1);
  });

  it('checks account status and current role on every key authentication', async () => {
    const created = await createUser(env.DB, 'Lifecycle', 'user', admin.id);
    const db = database(env.DB);
    await db
      .update(users)
      .set({ status: 'disabled' })
      .where(eq(users.id, created.userId));
    await expect(authenticateKey(env.DB, created.key)).rejects.toMatchObject({
      status: 401,
    });
    await db
      .update(users)
      .set({ status: 'active', role: 'admin' })
      .where(eq(users.id, created.userId));
    expect((await authenticateKey(env.DB, created.key)).user.role).toBe(
      'admin',
    );
    await db
      .update(users)
      .set({ role: 'user' })
      .where(eq(users.id, created.userId));
    expect((await authenticateKey(env.DB, created.key)).user.role).toBe('user');
    await db.batch([
      db
        .update(users)
        .set({ status: 'deleted' })
        .where(eq(users.id, created.userId)),
      db.delete(apiKeys).where(eq(apiKeys.userId, created.userId)),
    ]);
    await expect(authenticateKey(env.DB, created.key)).rejects.toMatchObject({
      status: 401,
    });
  });

  it('enforces absolute expiry, idle expiry and nonreusable session hashes', async () => {
    const current = await authenticateKey(env.DB, ownerKey);
    for (const changes of [
      { expiresAt: now() - 1 },
      { lastSeenAt: now() - 8 * 86_400 },
    ]) {
      const token = await createSession(env.DB, owner.id, current.key.version);
      const hash = await digest(token, 'session');
      expect(await authenticateSession(env.DB, hash)).toBeNull();
      await database(env.DB)
        .update(sessions)
        .set(changes)
        .where(eq(sessions.hash, hash));
      expect(await authenticateSession(env.DB, token)).toBeNull();
    }
  });
});

const memberActions = [
  'logout',
  'delivery-preference',
  'preferences',
  'sxcu',
  'rotate',
  'image-select-all',
  'image-delete',
  'image-download',
  'image-expiry-options',
  'image-expiry',
  'alias-select-all',
  'alias-create-options',
  'alias-create',
  'alias-delete',
  'alias-copy',
  'alias-expiry-options',
  'alias-expiry',
  'alias-primary',
];
const adminActions = [
  'share-slug-settings',
  'expiry-policy',
  'user-expiry-policy',
  'user-create',
  'user-update',
  'user-reset',
  'user-delete',
  'delivery-domain-save',
  'delivery-domain-details',
  'delivery-domain-members',
  'delivery-domain-validate',
  'delivery-domain-primary',
  'delivery-domain-availability',
  'delivery-domain-remove',
  'reconcile',
  'finding-resolve',
  'settings',
];

describe('route authorization matrix', () => {
  it('keeps anonymous deletion capabilities bound to one image and consumes them on deletion', async () => {
    const firstImage = await seedImage(other);
    const secondImage = await seedImage(other);
    const token = randomSecret();
    await database(env.DB)
      .insert(deleteTokens)
      .values({
        imageId: firstImage,
        hash: await digest(token, 'delete'),
      });
    for (const input of [
      { imageId: firstImage, token: randomSecret() },
      { imageId: secondImage, token },
    ])
      expect((await action('delete-info', input, null)).status).toBe(404);
    const input = { imageId: firstImage, token };
    const info = await action('delete-info', input, null);
    expect(info.status).toBe(200);
    expect(await info.json()).toMatchObject({ filename: 'Other.png' });
    const siteverify = vi
      .spyOn(globalThis, 'fetch')
      .mockImplementation(() =>
        Promise.resolve(Response.json({ success: true })),
      );
    try {
      const deleted = await action(
        'delete-token',
        { ...input, turnstile: 'test' },
        null,
      );
      expect(deleted.status).toBe(200);
      expect((await action('delete-info', input, null)).status).toBe(404);
      expect(
        (await action('delete-token', { ...input, turnstile: 'test' }, null))
          .status,
      ).toBe(404);
      expect(await env.BUCKET.head(firstImage)).toBeNull();
      expect(await env.BUCKET.head(secondImage)).not.toBeNull();
    } finally {
      siteverify.mockRestore();
    }
  });

  it('requires a session for action', async () => {
    for (const name of [...memberActions, ...adminActions]) {
      const response = await action(name, {}, null);
      expect([name, response.status]).toEqual([name, 401]);
      expect(await response.json()).toMatchObject({
        error: { code: 'UNAUTHENTICATED' },
      });
    }
  });

  it('denies member access to privileged action settings and other administrative actions', async () => {
    for (const name of adminActions) {
      const response = await action(name, {}, owner);
      expect([name, response.status]).toEqual([name, 403]);
      expect(await response.json()).toMatchObject({
        error: { code: 'FORBIDDEN' },
      });
    }
  });

  it('requires the session owner to supply their own key when exporting a config', async () => {
    expect((await action('sxcu', { key: otherKey }, owner)).status).toBe(403);
    const response = await action('sxcu', { key: ownerKey }, owner);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      Headers: { Authorization: `Bearer ${ownerKey}` },
    });
  });

  it('ignores forged identity, role, status and quota fields in personal preferences', async () => {
    const created = await createUser(env.DB, 'Preferences', 'user', admin.id);
    const db = database(env.DB);
    const [actor] = await db
      .select()
      .from(users)
      .where(eq(users.id, created.userId));
    const response = await action(
      'preferences',
      {
        displayName: 'Updated preferences',
        expiry: 'never',
        stripImageMetadata: true,
        userId: other.id,
        role: 'admin',
        status: 'deleted',
        quotaBytes: 0,
      },
      actor,
    );
    expect(response.status).toBe(200);
    const [updated] = await db
      .select()
      .from(users)
      .where(eq(users.id, actor.id));
    expect(updated).toMatchObject({
      displayName: 'Updated preferences',
      role: 'user',
      status: 'active',
      quotaBytes: null,
    });
    const [untouched] = await db
      .select()
      .from(users)
      .where(eq(users.id, other.id));
    expect(untouched).toMatchObject({
      displayName: other.displayName,
      role: 'user',
      status: 'active',
    });
  });

  it('rejects forged admin selections and ignores owner query overrides', async () => {
    const mine = await seedImage();
    const theirs = await seedImage(other);
    const mineLink = await createLink(env.DB, owner, {
      imageId: mine,
      deliveryDomainId,
      expiry: 'never',
    });
    const otherLink = await createLink(env.DB, other, {
      imageId: theirs,
      deliveryDomainId,
      expiry: 'never',
    });
    for (const name of ['image-select-all', 'alias-select-all']) {
      expect((await action(name, { admin: true }, owner)).status).toBe(403);
      const response = await action(
        name,
        { admin: false, query: `owner=${other.id}` },
        owner,
      );
      const result = await response.json<{ ids: string[] }>();
      expect(result.ids).toContain(
        name === 'image-select-all' ? mine : mineLink.id,
      );
      expect(result.ids).not.toContain(
        name === 'image-select-all' ? theirs : otherLink.id,
      );
    }
    const response = await action(
      'image-select-all',
      { admin: true, query: `owner=${other.id}` },
      admin,
    );
    const result = await response.json<{ ids: string[] }>();
    expect(result.ids).toContain(theirs);
  });

  it.each(['GET', 'HEAD'])(
    'checks ownership before conditional/range %s media delivery',
    async (method) => {
      const imageId = await seedImage(other);
      expect((await media(imageId, null, method)).status).toBe(401);
      const denied = await media(imageId, owner, method);
      expect(denied.status).toBe(404);
      expect(denied.headers.has('ETag')).toBe(false);
      const allowed = await media(imageId, other, method);
      expect(allowed.status).toBe(304);
      expect(allowed.headers.get('Cache-Control')).toBe('private, no-store');
      expect((await media(imageId, admin, method)).status).toBe(304);
    },
  );

  it('rejects mixed-owner image mutations before changing any selected image', async () => {
    const mine = await seedImage();
    const theirs = await seedImage(other);
    const input = { ids: [mine, theirs], expiry: '1h' };
    for (const name of ['image-delete', 'image-expiry', 'image-expiry-options'])
      expect((await action(name, input, owner)).status).toBe(404);
    const stored = await database(env.DB)
      .select()
      .from(images)
      .where(eq(images.id, mine));
    expect(stored[0]).toMatchObject({ deletedAt: null, expiresAt: null });
    expect(await env.BUCKET.head(mine)).not.toBeNull();
    const download = await action('image-download', input, owner);
    expect(await download.json()).toMatchObject({
      images: [{ id: mine }],
      failed: [{ id: theirs, code: 'NOT_FOUND' }],
    });
    expect(
      (await action('image-expiry', { ids: [mine], expiry: '1h' }, owner))
        .status,
    ).toBe(200);
  });

  it('checks image ownership for new aliases and every selected alias for mutations', async () => {
    const mine = await seedImage();
    const theirs = await seedImage(other);
    const mineLink = await createLink(env.DB, owner, {
      imageId: mine,
      deliveryDomainId,
      expiry: 'never',
    });
    const otherLink = await createLink(env.DB, other, {
      imageId: theirs,
      deliveryDomainId,
      expiry: 'never',
    });
    const input = { ids: [mineLink.id, otherLink.id], expiry: '1h' };
    for (const name of [
      'alias-delete',
      'alias-copy',
      'alias-expiry-options',
      'alias-expiry',
    ])
      expect((await action(name, input, owner)).status).toBe(404);
    expect(
      (await action('alias-primary', { id: otherLink.id }, owner)).status,
    ).toBe(404);
    expect(
      (await action('alias-create-options', { imageId: theirs }, owner)).status,
    ).toBe(404);
    expect(
      (
        await action(
          'alias-create',
          {
            imageId: theirs,
            deliveryDomainId,
            expiry: 'never',
            userId: owner.id,
          },
          owner,
        )
      ).status,
    ).toBe(404);
    const [stored] = await database(env.DB)
      .select()
      .from(aliases)
      .where(eq(aliases.id, mineLink.id));
    expect(stored).toMatchObject({
      disabledAt: null,
      expiresAt: null,
      primary: true,
    });
    expect(
      (
        await action(
          'alias-expiry',
          { ids: [mineLink.id], expiry: '1h' },
          owner,
        )
      ).status,
    ).toBe(200);
  });
});

describe('bearer and browser upload authentication', () => {
  it('rejects duplicate authorization headers even when both contain valid keys', async () => {
    const request = uploadRequest(`Bearer ${ownerKey}`);
    request.headers.append('Authorization', `Bearer ${otherKey}`);
    expect((await bearerUpload(request)).status).toBe(401);
  });

  it('denies disabled, rotated and deleted credentials through the bearer route', async () => {
    const created = await createUser(env.DB, 'API lifecycle', 'user', admin.id);
    const db = database(env.DB);
    await db
      .update(users)
      .set({ status: 'disabled' })
      .where(eq(users.id, created.userId));
    expect(
      (await bearerUpload(uploadRequest(`Bearer ${created.key}`))).status,
    ).toBe(401);
    await db
      .update(users)
      .set({ status: 'active' })
      .where(eq(users.id, created.userId));
    const current = await rotateKey(env.DB, created.userId, admin.id, true);
    expect(
      (await bearerUpload(uploadRequest(`Bearer ${created.key}`))).status,
    ).toBe(401);
    await db.batch([
      db
        .update(users)
        .set({ status: 'deleted' })
        .where(eq(users.id, created.userId)),
      db.delete(apiKeys).where(eq(apiKeys.userId, created.userId)),
    ]);
    expect(
      (await bearerUpload(uploadRequest(`Bearer ${current}`))).status,
    ).toBe(401);
  });

  it('never falls back to a browser session for authorization', async () => {
    for (const authorization of [
      '',
      'Basic key',
      'Bearer',
      'Bearer bad',
      'Bearer a, Bearer b',
      'Bearer a b',
    ]) {
      const response = await bearerUpload(uploadRequest(authorization), owner);
      expect(response.status).toBe(401);
    }
  });

  it('requires a browser session on the browser route even with a valid bearer key', async () => {
    const response = await browserUploadHandler({
      request: uploadRequest(`Bearer ${ownerKey}`),
      locals: { env, user: null },
    } as unknown as Parameters<typeof browserUploadHandler>[0]);
    expect(response.status).toBe(401);
  });

  it('uses the bearer owner rather than a conflicting browser identity and isolates retry keys', async () => {
    const retryKey = randomSecret();
    const first = await bearerUpload(
      uploadRequest(`bearer\t${ownerKey}`, retryKey),
      other,
    );
    expect(first.status).toBe(409);
    const a = await first.json<{ id: string; deleteUrl: string }>();
    const second = await bearerUpload(
      uploadRequest(`Bearer ${otherKey}`, retryKey),
      owner,
    );
    expect(second.status).toBe(409);
    const b = await second.json<{ id: string; deleteUrl: string }>();
    expect(a.id).not.toBe(b.id);
    const [firstImage] = await database(env.DB)
      .select()
      .from(images)
      .where(eq(images.id, a.id));
    const [secondImage] = await database(env.DB)
      .select()
      .from(images)
      .where(eq(images.id, b.id));
    expect(firstImage.userId).toBe(owner.id);
    expect(secondImage.userId).toBe(other.id);
    const replay = await bearerUpload(
      uploadRequest(`Bearer ${ownerKey}`, retryKey),
    );
    expect(await replay.json()).toMatchObject({
      id: a.id,
      deleteUrl: a.deleteUrl,
    });
    expect((await media(a.id, other)).status).toBe(404);
  });
});
