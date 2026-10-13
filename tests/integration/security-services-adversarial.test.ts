import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST as actionHandler } from '../../apps/web/src/routes/api/actions/[action]/+server';
import { POST as uploadHandler } from '../../apps/web/src/routes/api/v1/images/+server';
import { createUser } from '../../packages/core/auth';
import { database, type User } from '../../packages/core/db';
import type { Env } from '../../packages/core/env';
import { apiKeys, sessions, users } from '../../packages/core/schema';
import { migrateDatabase } from '../helpers/database';

let mf: Miniflare, env: Env, user: User, key: string;
const origin = 'https://app.example.com';
const allow = { limit: () => Promise.resolve({ success: true }) };
const deny = { limit: () => Promise.resolve({ success: false }) };

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
  const account = await createUser(DB, 'Service boundary', 'user', null);
  key = account.key;
  [user] = await database(DB)
    .select()
    .from(users)
    .where(eq(users.id, account.userId));
  env = {
    DB,
    // @ts-expect-error Miniflare R2 proxies implement the binding with Undici Headers types.
    BUCKET: await mf.getR2Bucket('BUCKET'),
    ENVIRONMENT: 'production',
    APP_ORIGIN: origin,
    TURNSTILE_SECRET_KEY: 'synthetic-production-format-secret',
    TURNSTILE_SITE_KEY: 'synthetic-site-key',
    MAX_UPLOAD_BYTES: '1048576',
    LOGIN_LIMIT: allow,
    MUTATION_LIMIT: allow,
    SENSITIVE_LIMIT: allow,
    UPLOAD_LIMIT: allow,
  };
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

afterEach(async () => {
  await mf?.dispose();
});

function action(name: string, environment = env) {
  const set = vi.fn();
  return {
    set,
    response: actionHandler({
      params: { action: name },
      locals: { env: environment, user },
      request: new Request(`${origin}/api/actions/${name}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Origin: origin },
        body: JSON.stringify({ key, token: 'synthetic-challenge-token' }),
      }),
      cookies: { set, get: vi.fn(), delete: vi.fn() },
    } as unknown as Parameters<typeof actionHandler>[0]),
  };
}

async function authenticationState() {
  const db = database(env.DB);
  return {
    sessions: await db.select().from(sessions),
    keys: await db.select().from(apiKeys),
  };
}

describe('external protection integration fails closed', () => {
  it.each([
    { success: false, hostname: 'app.example.com', action: 'login' },
    { success: true, action: 'login' },
    { success: true, hostname: 'app.example.com' },
    { success: true, hostname: 'evil.example', action: 'login' },
    {
      success: true,
      hostname: 'app.example.com.evil.example',
      action: 'login',
    },
    { success: true, hostname: 'app.example.com', action: 'delete' },
    { success: 'true', hostname: 'app.example.com', action: 'login' },
  ])(
    'does not create a login session for rejected provider result %j',
    async (result) => {
      const before = await authenticationState();
      const fetchMock = vi.fn(() => Promise.resolve(Response.json(result)));
      vi.stubGlobal('fetch', fetchMock);
      const attempt = action('login');
      const response = await attempt.response;
      expect(response.status).toBe(400);
      expect(attempt.set).not.toHaveBeenCalled();
      expect(await authenticationState()).toEqual(before);
      expect(fetchMock).toHaveBeenCalledOnce();
    },
  );

  it('does not create a session after a transport exception or invalid JSON', async () => {
    const before = await authenticationState();
    vi.spyOn(console, 'error').mockImplementation(() => {});
    for (const fetchMock of [
      vi.fn(() => Promise.reject(new Error('Synthetic transport failure'))),
      vi.fn(() =>
        Promise.resolve(new Response('invalid JSON', { status: 503 })),
      ),
    ]) {
      vi.stubGlobal('fetch', fetchMock);
      const attempt = action('login');
      const response = await attempt.response;
      expect(response.status).toBe(503);
      expect(attempt.set).not.toHaveBeenCalled();
      expect(await authenticationState()).toEqual(before);
    }
  });

  it('refuses absent and test production secrets before contacting the provider', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const secret of [undefined, '1x0000000000000000000000000000000AA']) {
      const attempt = action('login', { ...env, TURNSTILE_SECRET_KEY: secret });
      const response = await attempt.response;
      expect(response.status).toBe(503);
      expect(attempt.set).not.toHaveBeenCalled();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('accepts a correctly bound result and sends the token only to siteverify', async () => {
    const fetchMock = vi.fn(() =>
      Promise.resolve(
        Response.json({
          success: true,
          hostname: 'app.example.com',
          action: 'login',
        }),
      ),
    );
    vi.stubGlobal('fetch', fetchMock);
    const attempt = action('login');
    const response = await attempt.response;
    expect(response.status).toBe(200);
    expect(attempt.set).toHaveBeenCalledOnce();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({
          secret: env.TURNSTILE_SECRET_KEY,
          response: 'synthetic-challenge-token',
        }),
      }),
    );
  });

  it('stops login, upload, browser mutation and rotation before side effects on limiter denial', async () => {
    const before = await authenticationState();
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    for (const [name, environment] of [
      ['login', { ...env, LOGIN_LIMIT: deny }],
      ['logout', { ...env, MUTATION_LIMIT: deny }],
      ['rotate', { ...env, SENSITIVE_LIMIT: deny }],
    ] as const) {
      const attempt = action(name, environment);
      const response = await attempt.response;
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(attempt.set).not.toHaveBeenCalled();
    }
    const response = await uploadHandler({
      locals: { env: { ...env, UPLOAD_LIMIT: deny }, user },
      request: new Request(`${origin}/api/v1/images`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}` },
        body: 'must not reach upload parser',
      }),
    } as unknown as Parameters<typeof uploadHandler>[0]);
    expect(response.status).toBe(429);
    expect(fetchMock).not.toHaveBeenCalled();
    const after = await authenticationState();
    expect(after.sessions).toEqual(before.sessions);
    expect(after.keys.map((row) => ({ ...row, lastUsedAt: null }))).toEqual(
      before.keys.map((row) => ({ ...row, lastUsedAt: null })),
    );
    const stored = await env.BUCKET.list();
    expect(stored.objects).toEqual([]);
  });
});
