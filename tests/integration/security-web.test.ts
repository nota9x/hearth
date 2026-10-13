import type { Handle } from '@sveltejs/kit';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { handle } from '../../apps/web/src/hooks.server';
import { load } from '../../apps/web/src/lib/server/dashboard';
import { POST as upload } from '../../apps/web/src/routes/api/v1/images/+server';
import {
  authenticateKey,
  createSession,
  createUser,
} from '../../packages/core/auth';
import { id, now } from '../../packages/core/common';
import { database, type User } from '../../packages/core/db';
import type { Env } from '../../packages/core/env';
import { images } from '../../packages/core/schema';
import { migrateDatabase } from '../helpers/database';
import { workerCompatibility } from '../helpers/workers';

const origin = 'https://app.example.com';
let mf: Miniflare, member: User, other: User;
let env: Pick<
  Env,
  | 'DB'
  | 'APP_ORIGIN'
  | 'ENVIRONMENT'
  | 'TURNSTILE_SITE_KEY'
  | 'MAX_UPLOAD_BYTES'
  | 'UPLOAD_LIMIT'
  | 'LOGIN_LIMIT'
>;
let token: string, ownImage: string, otherImage: string;

beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response(); } }',
      ...workerCompatibility(),
      d1Databases: ['DB'],
    }),
  );
  const DB = await mf.getD1Database('DB');
  await migrateDatabase(DB);
  await createUser(DB, 'Admin', 'admin', null);
  const first = await createUser(DB, 'Member', 'user', null);
  const second = await createUser(DB, 'Other', 'user', null);
  await DB.prepare("UPDATE users SET onboardingStatus='exempt'").run();
  const firstAuth = await authenticateKey(DB, first.key);
  const secondAuth = await authenticateKey(DB, second.key);
  member = firstAuth.user;
  other = secondAuth.user;
  token = await createSession(DB, member.id, 1);
  env = {
    DB,
    APP_ORIGIN: origin,
    ENVIRONMENT: 'production',
    TURNSTILE_SITE_KEY: 'real-site-key',
    MAX_UPLOAD_BYTES: '26214400',
    UPLOAD_LIMIT: { limit: () => Promise.resolve({ success: true }) },
    LOGIN_LIMIT: { limit: () => Promise.resolve({ success: true }) },
  };
  ownImage = id('img');
  otherImage = id('img');
  await database(DB)
    .insert(images)
    .values(
      [member, other].map((user, index) => ({
        id: index === 0 ? ownImage : otherImage,
        userId: user.id,
        objectKey: `original/${user.id}/${index}`,
        filename: index === 0 ? 'own.png' : 'private-other.png',
        mime: 'image/png',
        extension: 'png',
        size: 10,
        sha256: 'a'.repeat(64),
        width: 1,
        height: 1,
        createdAt: now(),
      })),
    );
});
afterEach(async () => {
  await mf?.dispose();
});

function hookInput(path: string, method: string, requestOrigin?: string) {
  const event = {
    url: new URL(path, origin),
    request: new Request(new URL(path, origin), {
      method,
      headers: requestOrigin ? { Origin: requestOrigin } : {},
    }),
    isDataRequest: false,
    cookies: {
      get: (name: string) => (name === '__Host-hearth' ? token : undefined),
    },
    locals: {} as App.Locals,
    platform: { env },
  };
  const resolve = vi.fn(() => Promise.resolve(new Response('allowed')));
  return { event, resolve };
}

function dashboard(
  path: string,
  parameters = new URLSearchParams(),
  user = member,
) {
  return load({
    locals: { env, user },
    params: { path },
    url: new URL(`${origin}/${path}?${parameters}`),
    depends: () => {},
  } as unknown as Parameters<typeof load>[0]);
}

describe('browser authentication trust boundaries', () => {
  it.each(['POST', 'PUT', 'PATCH', 'DELETE'])(
    'rejects untrusted origins for cookie-authenticated %s requests',
    async (method) => {
      for (const path of ['/api/actions/logout', '/api/upload', '/admin']) {
        for (const requestOrigin of [
          undefined,
          'null',
          'https://evil.example',
          `${origin}/`,
          // eslint-disable-next-line unicorn/prefer-https -- An insecure origin must not match the configured HTTPS origin.
          'http://app.example.com',
        ]) {
          const input = hookInput(path, method, requestOrigin);
          const response = await handle(
            input as unknown as Parameters<Handle>[0],
          );
          expect(response.status).toBe(403);
          expect(input.event.locals.user?.id).toBe(member.id);
          expect(input.resolve).not.toHaveBeenCalled();
        }
      }
    },
  );
  it('accepts the canonical origin and keeps authenticated responses uncached', async () => {
    const input = hookInput('/api/actions/logout', 'POST', origin);
    const response = await handle(input as unknown as Parameters<Handle>[0]);
    expect(response.status).toBe(200);
    expect(input.resolve).toHaveBeenCalledOnce();
    expect(input.event.locals.user?.id).toBe(member.id);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  });
  it('does not let the bearer-only origin exemption authenticate through cookies', async () => {
    const input = hookInput('/api/v1/images', 'POST');
    const response = await handle({
      ...input,
      resolve: (event: Parameters<typeof upload>[0]) => upload(event),
    } as unknown as Parameters<Handle>[0]);
    expect(response.status).toBe(401);
    expect(input.event.locals.user?.id).toBe(member.id);
  });
  it('rejects alternate production application hosts before session lookup', async () => {
    const input = hookInput('/api/actions/logout', 'POST', origin);
    input.event.url = new URL('https://evil.example/api/actions/logout');
    const response = await handle(input as unknown as Parameters<Handle>[0]);
    expect(response.status).toBe(421);
    expect(input.event.locals.user).toBeUndefined();
    expect(input.resolve).not.toHaveBeenCalled();
  });
});

describe('server-rendered authorization boundaries', () => {
  it.each([
    'admin',
    'admin/images',
    'admin/links',
    'admin/domains',
    'admin/settings',
    'admin/users',
    'admin/storage',
    'admin/audit-log',
  ])('denies member access to %s before privileged reads', async (path) => {
    await expect(dashboard(path)).rejects.toMatchObject({ status: 403 });
  });
  it("filters forged owner queries and conceals another user's image details", async () => {
    const result = await dashboard(
      'images',
      new URLSearchParams({ owner: other.id }),
    );
    expect(result.images.map((image) => image.id)).toEqual([ownImage]);
    await expect(dashboard(`images/${otherImage}`)).rejects.toMatchObject({
      status: 404,
    });
    const links = await dashboard(
      'links',
      new URLSearchParams({ image: otherImage, owner: other.id }),
    );
    expect(links.linkImage).toBeNull();
    expect(links.links).toEqual([]);
  });
  it('returns credential activity without reusable keys, digests, sessions or domain signing keys', async () => {
    const result = await dashboard('settings');
    expect(result.key?.createdAt).toBeTypeOf('number');
    expect(JSON.stringify(result)).not.toMatch(
      /secretHash|keyId|validationKey|"hash"/,
    );
    expect(JSON.stringify(result)).not.toContain(token);
  });
});
