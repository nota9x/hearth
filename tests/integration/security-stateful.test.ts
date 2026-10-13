/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed HTTP and query results. */
import { Buffer } from 'node:buffer';

import type { Handle } from '@sveltejs/kit/hooks';
import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handle } from '../../apps/web/src/hooks.server';
import { POST as actionHandler } from '../../apps/web/src/routes/api/actions/[action]/+server';
import { GET as mediaHandler } from '../../apps/web/src/routes/api/media/[id]/+server';
import { POST as browserUploadHandler } from '../../apps/web/src/routes/api/upload/+server';
import { POST as bearerUploadHandler } from '../../apps/web/src/routes/api/v1/images/+server';
import {
  authenticateKey,
  authenticateSession,
  createSession,
  createUser,
} from '../../packages/core/auth';
import { id, now } from '../../packages/core/common';
import { database } from '../../packages/core/db';
import { digest } from '../../packages/core/digest';
import type { Env } from '../../packages/core/env';
import {
  aliases,
  apiKeys,
  images,
  sessions,
  users,
} from '../../packages/core/schema';
import { migrateDatabase } from '../helpers/database';

const cloudflare = vi.hoisted(() => ({ env: {} }));
vi.mock('cloudflare:workers', () => ({
  env: cloudflare.env,
  waitUntil: () => {},
}));

const origin = 'https://app.example.com';
const cookieName = 'hearth-local';
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
type CookieJar = Map<string, string>;
type Account = Awaited<ReturnType<typeof createUser>>;
let mf: Miniflare, env: Env;
let owner: Account, other: Account, administrator: Account;
const domainId = id('hst');

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
    ENVIRONMENT: 'test',
    APP_ORIGIN: origin,
    TURNSTILE_SITE_KEY: 'test',
    TURNSTILE_SECRET_KEY: 'isolated-test-secret',
    MAX_UPLOAD_BYTES: '10485760',
    LOGIN_LIMIT: limit,
    MUTATION_LIMIT: limit,
    SENSITIVE_LIMIT: limit,
    UPLOAD_LIMIT: limit,
  } as Env;
  await DB.prepare(
    'INSERT INTO delivery_domains (id,hostname,health,isPrimary,createdAt,updatedAt) VALUES (?,?,?,?,?,?)',
  )
    .bind(domainId, 'shots.example.com', 'active', 1, now(), now())
    .run();
});

beforeEach(async () => {
  [owner, other, administrator] = await Promise.all([
    createUser(env.DB, 'Owner', 'user', null),
    createUser(env.DB, 'Other', 'user', null),
    createUser(env.DB, 'Administrator', 'admin', null),
  ]);
  vi.spyOn(globalThis, 'fetch').mockImplementation((input) => {
    if (input !== 'https://challenges.cloudflare.com/turnstile/v0/siteverify')
      throw new Error('Unexpected external request in isolated fixture.');
    return Promise.resolve(Response.json({ success: true }));
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

afterEach(async () => {
  await mf?.dispose();
});

function dispatch(
  request: Request,
  jar: CookieJar = new Map(),
  bindings = env,
) {
  Object.assign(cloudflare.env, bindings);
  const event = {
    request,
    url: new URL(request.url),
    locals: {} as App.Locals,
    isDataRequest: false,
    params: {},
    cookies: {
      get: (name: string) => jar.get(name),
      set: (name: string, value: string) => jar.set(name, value),
      delete: (name: string) => jar.delete(name),
    },
  };
  return handle({
    event,
    resolve: (resolved: typeof event) => {
      const path = resolved.url.pathname;
      if (path.startsWith('/api/actions/')) {
        resolved.params = { action: path.slice('/api/actions/'.length) };
        return actionHandler(
          resolved as unknown as Parameters<typeof actionHandler>[0],
        );
      }
      if (path.startsWith('/api/media/')) {
        resolved.params = { id: path.slice('/api/media/'.length) };
        return mediaHandler(
          resolved as unknown as Parameters<typeof mediaHandler>[0],
        );
      }
      if (path === '/api/v1/images')
        return bearerUploadHandler(
          resolved as unknown as Parameters<typeof bearerUploadHandler>[0],
        );
      if (path === '/api/upload')
        return browserUploadHandler(
          resolved as unknown as Parameters<typeof browserUploadHandler>[0],
        );
      throw new Error(`Unexpected fixture route: ${path}`);
    },
  } as unknown as Parameters<Handle>[0]);
}

function action(
  name: string,
  input: unknown,
  jar: CookieJar = new Map(),
  bindings = env,
) {
  return dispatch(
    new Request(`${origin}/api/actions/${name}`, {
      method: 'POST',
      headers: { Origin: origin, 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    jar,
    bindings,
  );
}

async function login(account: Account) {
  const jar: CookieJar = new Map();
  const response = await action(
    'login',
    { key: account.key, token: 'challenge' },
    jar,
  );
  expect(response.status).toBe(200);
  expect(jar.get(cookieName)).toMatch(/^[a-f0-9]{64}$/);
  return jar;
}

function media(imageId: string, jar: CookieJar) {
  return dispatch(new Request(`${origin}/api/media/${imageId}`), jar);
}

async function seedImage(account: Account) {
  const imageId = id('img');
  await database(env.DB)
    .insert(images)
    .values({
      id: imageId,
      userId: account.userId,
      objectKey: imageId,
      filename: `${account.userId}.png`,
      mime: 'image/png',
      extension: 'png',
      size: png.length,
      sha256: 'stateful-fixture',
      width: 1,
      height: 1,
      createdAt: now(),
    });
  await env.BUCKET.put(imageId, png);
  return imageId;
}

function uploadRequest(authorization?: string) {
  const form = new FormData();
  form.set('file', new Blob([png], { type: 'image/png' }), 'picture.png');
  const headers = new Headers({ Origin: origin });
  if (authorization !== undefined) headers.set('Authorization', authorization);
  return new Request(`${origin}/api/v1/images`, {
    method: 'POST',
    headers,
    body: form,
  });
}

async function updateAccount(account: Account, status: 'active' | 'disabled') {
  const adminJar = await login(administrator);
  return action(
    'user-update',
    {
      userId: account.userId,
      displayName: 'Updated account',
      status,
      quotaBytes: null,
    },
    adminJar,
  );
}

function pausedSessionBinding() {
  let notifyArrival!: () => void;
  let resume!: () => void;
  const arrived = {
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- The repository targets ES2022 library types.
    promise: new Promise<void>((resolve) => {
      notifyArrival = resolve;
    }),
    resolve: () => notifyArrival(),
  };
  const release = {
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- The repository targets ES2022 library types.
    promise: new Promise<void>((resolve) => {
      resume = resolve;
    }),
    resolve: () => resume(),
  };
  let calls = 0;
  const DB = new Proxy(env.DB, {
    get(target, property) {
      if (property === 'batch')
        return async (...arguments_: Parameters<D1Database['batch']>) => {
          calls++;
          arrived.resolve();
          await release.promise;
          return target.batch(...arguments_);
        };
      const value: unknown = Reflect.get(target, property);
      return typeof value === 'function'
        ? (value.bind(target) as unknown)
        : value;
    },
  });
  return { env: { ...env, DB }, arrived, release, calls: () => calls };
}

describe('stateful authentication through hook and handlers', () => {
  it('does not revive sessions after administrator disable, re-enable, or account deletion', async () => {
    const ownJar = await login(owner);
    const otherJar = await login(other);
    const ownImage = await seedImage(owner);
    const otherImage = await seedImage(other);
    expect((await updateAccount(owner, 'disabled')).status).toBe(200);
    expect((await media(ownImage, ownJar)).status).toBe(401);
    expect((await dispatch(uploadRequest(`Bearer ${owner.key}`))).status).toBe(
      401,
    );
    expect((await media(otherImage, otherJar)).status).toBe(200);
    expect((await updateAccount(owner, 'active')).status).toBe(200);
    expect((await media(ownImage, ownJar)).status).toBe(401);
    const fresh = await login(owner);
    expect((await media(ownImage, fresh)).status).toBe(200);
    const adminJar = await login(administrator);
    expect(
      (
        await action(
          'user-delete',
          { userId: owner.userId, token: 'challenge' },
          adminJar,
        )
      ).status,
    ).toBe(200);
    expect((await media(ownImage, fresh)).status).toBe(401);
    expect((await media(ownImage, adminJar)).status).toBe(404);
    expect((await dispatch(uploadRequest(`Bearer ${owner.key}`))).status).toBe(
      401,
    );
    expect((await updateAccount(owner, 'active')).status).toBe(404);
    expect((await media(otherImage, otherJar)).status).toBe(200);
    expect(await env.BUCKET.head(otherImage)).not.toBeNull();
  });

  it('rejects disabled and deleted users even when session, key version, and expiry remain valid', async () => {
    const authenticated = await authenticateKey(env.DB, owner.key);
    const token = await createSession(
      env.DB,
      owner.userId,
      authenticated.key.version,
    );
    const jar = new Map([[cookieName, token]]);
    const mine = await seedImage(owner);
    const db = database(env.DB);
    for (const status of ['disabled', 'deleted'] as const) {
      await db.update(users).set({ status }).where(eq(users.id, owner.userId));
      expect(await authenticateSession(env.DB, token)).toBeNull();
      expect((await media(mine, jar)).status).toBe(401);
      expect(
        await db
          .select()
          .from(sessions)
          .where(eq(sessions.userId, owner.userId)),
      ).toHaveLength(1);
      expect(
        await db.select().from(apiKeys).where(eq(apiKeys.userId, owner.userId)),
      ).toHaveLength(1);
    }
  });

  it('reads current roles on each request without upgrading a member key to another owner', async () => {
    const jar = await login(owner);
    const theirs = await seedImage(other);
    expect((await media(theirs, jar)).status).toBe(404);
    expect(
      (await action('settings', { siteName: 'Denied member' }, jar)).status,
    ).toBe(403);
    await database(env.DB)
      .update(users)
      .set({ role: 'admin' })
      .where(eq(users.id, owner.userId));
    expect((await media(theirs, jar)).status).toBe(200);
    expect(
      (await action('settings', { siteName: 'Allowed administrator' }, jar))
        .status,
    ).toBe(200);
    await database(env.DB)
      .update(users)
      .set({ role: 'user' })
      .where(eq(users.id, owner.userId));
    expect(
      (await action('settings', { siteName: 'Denied again' }, jar)).status,
    ).toBe(403);
    expect(
      (
        await action(
          'alias-create',
          { imageId: theirs, deliveryDomainId: domainId, expiry: 'never' },
          jar,
        )
      ).status,
    ).toBe(404);
    expect((await authenticateKey(env.DB, owner.key)).user).toMatchObject({
      id: owner.userId,
      role: 'user',
    });
  });

  it('enforces expiry at the exact idle and absolute deadline without refreshing denied sessions', async () => {
    const timestamp = now();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(timestamp * 1000);
    const idle = await login(owner);
    const absolute = await login(owner);
    const mine = await seedImage(owner);
    const idleHash = await digest(idle.get(cookieName)!, 'session');
    const absoluteHash = await digest(absolute.get(cookieName)!, 'session');
    clock.mockReturnValue((timestamp + 7 * 86_400) * 1000);
    expect((await media(mine, idle)).status).toBe(401);
    const [denied] = await database(env.DB)
      .select()
      .from(sessions)
      .where(eq(sessions.hash, idleHash));
    expect(denied.lastSeenAt).toBe(timestamp);
    await database(env.DB)
      .update(sessions)
      .set({ lastSeenAt: timestamp + 30 * 86_400 - 1 })
      .where(eq(sessions.hash, absoluteHash));
    clock.mockReturnValue((timestamp + 30 * 86_400) * 1000);
    expect((await media(mine, absolute)).status).toBe(401);
    const fresh = await login(owner);
    expect((await media(mine, fresh)).status).toBe(200);
    expect((await media(mine, idle)).status).toBe(401);
  });

  it('denies a login cookie issued after a completed rotation with the old verified key version', async () => {
    const jar = await login(owner);
    const mine = await seedImage(owner);
    const gate = pausedSessionBinding();
    const lateJar: CookieJar = new Map();
    const pending = action(
      'login',
      { key: owner.key, token: 'challenge' },
      lateJar,
      gate.env,
    );
    await gate.arrived.promise;
    try {
      expect(gate.calls()).toBe(1);
      const rotated = await action('rotate', { token: 'challenge' }, jar);
      expect(rotated.status).toBe(200);
      const { key } = await rotated.json<{ key: string }>();
      gate.release.resolve();
      expect((await pending).status).toBe(200);
      expect(lateJar.has(cookieName)).toBe(true);
      expect((await media(mine, lateJar)).status).toBe(401);
      expect(
        (await action('image-delete', { ids: [mine] }, lateJar)).status,
      ).toBe(401);
      expect((await media(mine, await login({ ...owner, key }))).status).toBe(
        200,
      );
    } finally {
      gate.release.resolve();
      await pending;
    }
  });

  it('denies an in-flight login issued after disablement and removes it on re-enable', async () => {
    const mine = await seedImage(owner);
    const gate = pausedSessionBinding();
    const lateJar: CookieJar = new Map();
    const pending = action(
      'login',
      { key: owner.key, token: 'challenge' },
      lateJar,
      gate.env,
    );
    await gate.arrived.promise;
    try {
      expect((await updateAccount(owner, 'disabled')).status).toBe(200);
      gate.release.resolve();
      expect((await pending).status).toBe(200);
      expect((await media(mine, lateJar)).status).toBe(401);
      expect((await updateAccount(owner, 'active')).status).toBe(200);
      expect((await media(mine, lateJar)).status).toBe(401);
      expect((await media(mine, await login(owner))).status).toBe(200);
    } finally {
      gate.release.resolve();
      await pending;
    }
  });
});

describe('stateful mechanism and related-resource boundaries', () => {
  it('keeps foreign image and alias operations unauthorized across deletion, expiry, and duplicate bulk identifiers', async () => {
    const ownerJar = await login(owner);
    const otherJar = await login(other);
    const mine = await seedImage(owner);
    const theirs = await seedImage(other);
    const makeLink = async (imageId: string, jar: CookieJar) => {
      const response = await action(
        'alias-create',
        { imageId, deliveryDomainId: domainId, expiry: 'never' },
        jar,
      );
      expect(response.status).toBe(200);
      return response.json<{ id: string }>();
    };
    const ownLink = await makeLink(mine, ownerJar);
    const foreignLink = await makeLink(theirs, otherJar);
    const ownSecond = await makeLink(mine, ownerJar);
    expect(
      (await action('alias-primary', { id: ownSecond.id }, ownerJar)).status,
    ).toBe(200);
    for (const ids of [
      [mine, mine, theirs],
      [theirs, mine, theirs],
    ]) {
      expect(
        (await action('image-expiry', { ids, expiry: '1h' }, ownerJar)).status,
      ).toBe(404);
      expect((await action('image-delete', { ids }, ownerJar)).status).toBe(
        404,
      );
    }
    for (const ids of [
      [ownLink.id, foreignLink.id, ownLink.id],
      [foreignLink.id, ownSecond.id],
    ]) {
      expect(
        (await action('alias-expiry', { ids, expiry: '1h' }, ownerJar)).status,
      ).toBe(404);
      expect((await action('alias-delete', { ids }, ownerJar)).status).toBe(
        404,
      );
      expect((await action('alias-copy', { ids }, ownerJar)).status).toBe(404);
    }
    expect(
      (
        await action(
          'alias-delete',
          { ids: [ownSecond.id, ownSecond.id] },
          ownerJar,
        )
      ).status,
    ).toBe(200);
    expect(
      (await action('alias-primary', { id: ownSecond.id }, ownerJar)).status,
    ).toBe(409);
    expect(
      (await action('alias-primary', { id: foreignLink.id }, ownerJar)).status,
    ).toBe(404);
    expect(
      (
        await action(
          'image-expiry',
          { ids: [mine, mine], expiry: '1h' },
          ownerJar,
        )
      ).status,
    ).toBe(200);
    expect(
      (await action('image-delete', { ids: [mine, mine] }, ownerJar)).status,
    ).toBe(200);
    expect((await media(mine, ownerJar)).status).toBe(404);
    const removedLinks = await action(
      'alias-copy',
      { ids: [ownLink.id, ownSecond.id] },
      ownerJar,
    );
    expect(removedLinks.status).toBe(200);
    expect(await removedLinks.json()).toEqual({ links: [] });
    expect(
      (
        await action(
          'alias-expiry',
          { ids: [ownLink.id], expiry: 'never' },
          ownerJar,
        )
      ).status,
    ).toBe(409);
    expect(
      (
        await action(
          'alias-create',
          { imageId: mine, deliveryDomainId: domainId, expiry: 'never' },
          ownerJar,
        )
      ).status,
    ).toBe(404);
    const [foreignImage] = await database(env.DB)
      .select()
      .from(images)
      .where(eq(images.id, theirs));
    const [foreignAlias] = await database(env.DB)
      .select()
      .from(aliases)
      .where(eq(aliases.id, foreignLink.id));
    expect(foreignImage).toMatchObject({
      userId: other.userId,
      expiresAt: null,
      deletedAt: null,
    });
    expect(foreignAlias).toMatchObject({
      disabledAt: null,
      expiresAt: null,
      primary: true,
    });
    expect((await media(theirs, otherJar)).status).toBe(200);
    expect(await env.BUCKET.head(mine)).toBeNull();
    expect(await env.BUCKET.head(theirs)).not.toBeNull();
  });

  it('rejects a deterministic ambiguous-selection corpus without mutating either owner', async () => {
    const ownerJar = await login(owner);
    const mine = await seedImage(owner);
    const theirs = await seedImage(other);
    const corpus = [
      `{"ids":["${mine}"],"ids":["${theirs}"]}`,
      `{"ids":["${mine}"],"__proto__":{"role":"admin"},"admin":true,"userId":"${other.userId}","ids":["${mine}","${theirs}"]}`,
      `{"ids":"${mine},${theirs}"}`,
      `{"ids":{"0":"${mine}","1":"${theirs}","length":2}}`,
      `{"ids":[["${mine}"],"${theirs}"]}`,
      `{"ids":["${mine}",null]}`,
      `[{"ids":["${theirs}"]}]`,
      `{"ids":["${theirs}"],"role":"admin"}`,
    ];
    for (const body of corpus) {
      const response = await dispatch(
        new Request(`${origin}/api/actions/image-delete`, {
          method: 'POST',
          headers: { Origin: origin, 'Content-Type': 'text/plain' },
          body,
        }),
        ownerJar,
      );
      expect([400, 404]).toContain(response.status);
      expect(await env.BUCKET.head(mine)).not.toBeNull();
      expect(await env.BUCKET.head(theirs)).not.toBeNull();
    }
    const valid = await action('image-delete', { ids: [mine] }, ownerJar);
    expect(valid.status).toBe(200);
    expect(await env.BUCKET.head(mine)).toBeNull();
    expect(await env.BUCKET.head(theirs)).not.toBeNull();
  });

  it('never treats normalized, truncated, or combined bearer credentials as a cookie fallback', async () => {
    const otherJar = await login(other);
    const corpus = [
      `Bearer ${owner.key}, Bearer ${other.key}`,
      `Bearer ${owner.key}\t${other.key}`,
      `Bearer\u{00A0}${owner.key.slice(0, -1)}`,
      `Bearer ${owner.key}%20`,
      `Bearer %69${owner.key.slice(1)}`,
      `Bearer ${owner.key.toUpperCase()}`,
      `Bearer ${owner.key.slice(0, 47)}`,
      `Bearer ${owner.key}${'a'.repeat(1024)}`,
      `Basic ${owner.key}`,
      `Bearer ${owner.key} Bearer`,
    ];
    const before = await database(env.DB)
      .select({ id: images.id })
      .from(images);
    for (const value of corpus) {
      const request = uploadRequest(value);
      expect(request.headers.get('Authorization')).toBe(value);
      const response = await dispatch(request, otherJar);
      expect(response.status).toBe(401);
    }
    const request = uploadRequest(`Bearer ${owner.key}`);
    request.headers.append('Authorization', `Bearer ${owner.key}`);
    expect(request.headers.get('Authorization')).toBe(
      `Bearer ${owner.key}, Bearer ${owner.key}`,
    );
    expect((await dispatch(request, otherJar)).status).toBe(401);
    expect(
      await database(env.DB).select({ id: images.id }).from(images),
    ).toEqual(before);
    const legitimate = await dispatch(
      uploadRequest(`bEaReR\t${owner.key}`),
      otherJar,
    );
    expect(legitimate.status).toBe(201);
    const { id: imageId } = await legitimate.json<{ id: string }>();
    const [stored] = await database(env.DB)
      .select()
      .from(images)
      .where(eq(images.id, imageId));
    expect(stored.userId).toBe(owner.userId);
    expect((await media(imageId, otherJar)).status).toBe(404);
  });
});
