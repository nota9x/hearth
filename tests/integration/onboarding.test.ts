/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed query and HTTP results. */
import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { load as dashboardLoad } from '../../apps/web/src/lib/server/dashboard';
import { POST } from '../../apps/web/src/routes/api/actions/[action]/+server';
import { load as onboardingLoad } from '../../apps/web/src/routes/onboarding/+page.server';
import { createUser } from '../../packages/core/auth';
import { now } from '../../packages/core/common';
import { database, type User } from '../../packages/core/db';
import type { Env } from '../../packages/core/env';
import {
  advanceOnboarding,
  armOnboardingUpload,
  finishOnboarding,
  hasBootstrapSetup,
  skipOnboardingUpload,
} from '../../packages/core/onboarding';
import { apiKeys, auditLog, users } from '../../packages/core/schema';
import { applyMigration, migrateDatabase } from '../helpers/database';

let runtime: Miniflare, env: Env, user: User, key: string;
beforeEach(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ['DB'],
      r2Buckets: ['BUCKET'],
    }),
  );
  const DB = await runtime.getD1Database('DB');
  await migrateDatabase(DB);
  const limit = { limit: () => Promise.resolve({ success: true }) };
  env = {
    DB,
    BUCKET: await runtime.getR2Bucket('BUCKET'),
    ENVIRONMENT: 'development',
    APP_ORIGIN: 'http://localhost',
    TURNSTILE_SITE_KEY: 'test',
    MAX_UPLOAD_BYTES: '10485760',
    LOGIN_LIMIT: limit,
    MUTATION_LIMIT: limit,
    SENSITIVE_LIMIT: limit,
    UPLOAD_LIMIT: limit,
  } as unknown as Env;
  const created = await createUser(DB, 'New member', 'user', null);
  key = created.key;
  user = await current(created.userId);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ success: true }))),
  );
});
afterEach(async () => {
  vi.unstubAllGlobals();
  await runtime.dispose();
});
async function current(userId = user.id) {
  const [row] = await database(env.DB)
    .select()
    .from(users)
    .where(eq(users.id, userId));
  return row;
}
function rpc(
  name: string,
  input: Record<string, unknown> = {},
  actor: User | null = user,
) {
  return POST({
    request: new Request(`http://localhost/api/actions/${name}`, {
      method: 'POST',
      body: JSON.stringify(input),
    }),
    locals: { env, user: actor },
    params: { action: name },
    cookies: { get: () => {}, set: vi.fn(), delete: vi.fn() },
  } as unknown as Parameters<typeof POST>[0]);
}
function pageLoad(actor = user, query = '') {
  return onboardingLoad({
    locals: { env, user: actor },
    url: new URL(`http://localhost/onboarding${query}`),
    depends: vi.fn(),
  } as unknown as Parameters<typeof onboardingLoad>[0]);
}

describe('onboarding lifecycle', () => {
  it('enrolls provisioned members and administrators without inferring bootstrap identity', async () => {
    expect(user.onboardingStatus).toBe('pending');
    const administrator = await createUser(
      env.DB,
      'Administrator',
      'admin',
      null,
    );
    const admin = await current(administrator.userId);
    expect(admin.onboardingStatus).toBe('pending');
    expect(hasBootstrapSetup(admin)).toBe(false);
    const created = await rpc(
      'user-create',
      { displayName: 'Provisioned', role: 'user', token: 'challenge' },
      admin,
    );
    expect(created.status).toBe(200);
    const result: { userId: string } = await created.json();
    expect((await current(result.userId)).onboardingStatus).toBe('pending');
  });
  it('returns a login destination without returning the raw key', async () => {
    const response = await rpc('login', { key, token: 'challenge' }, null);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      userId: user.id,
      destination: '/onboarding',
    });
    await finishOnboarding(env.DB, user, 'skipped');
    const returning = await rpc('login', { key, token: 'challenge' }, null);
    expect(await returning.json()).toEqual({
      ok: true,
      userId: user.id,
      destination: '/',
    });
  });
  it('redirects pending dashboard requests before running dashboard queries', async () => {
    await expect(
      dashboardLoad({
        locals: { env, user },
        params: { path: 'settings' },
        depends: vi.fn(),
        url: new URL('http://localhost/settings'),
      } as unknown as Parameters<typeof dashboardLoad>[0]),
    ).rejects.toMatchObject({ status: 303, location: '/onboarding' });
  });
  it('resumes the furthest saved step without regressing concurrent progress', async () => {
    await Promise.all([
      advanceOnboarding(env.DB, user, 4),
      advanceOnboarding(env.DB, user, 2),
    ]);
    expect((await current()).onboardingStep).toBe(4);
    const page = await pageLoad(await current());
    expect(page).toMatchObject({
      startStep: 4,
      revisit: false,
      bootstrap: false,
    });
  });
  it('makes terminal transitions idempotent and preserves them during revisits', async () => {
    await Promise.all([
      finishOnboarding(env.DB, user, 'completed'),
      finishOnboarding(env.DB, user, 'skipped'),
    ]);
    const terminal = await current();
    expect(['completed', 'skipped']).toContain(terminal.onboardingStatus);
    await advanceOnboarding(env.DB, terminal, 2);
    await finishOnboarding(env.DB, terminal, 'skipped');
    expect((await current()).onboardingStatus).toBe(terminal.onboardingStatus);
    const events = await database(env.DB).select().from(auditLog);
    expect(
      events.filter((event) => event.action.startsWith('onboarding.')),
    ).toHaveLength(1);
    expect(await pageLoad(terminal, '?revisit=1')).toMatchObject({
      startStep: 0,
      revisit: true,
    });
  });
  it('retains the completed screen on refresh and allows exempt users to revisit', async () => {
    await finishOnboarding(env.DB, user, 'completed');
    expect(await pageLoad(await current())).toMatchObject({ startStep: 7 });
    await env.DB.prepare(
      "UPDATE users SET onboardingStatus='exempt' WHERE id=?",
    )
      .bind(user.id)
      .run();
    expect(await pageLoad(await current(), '?revisit=1')).toMatchObject({
      startStep: 0,
      revisit: true,
    });
  });
  it('arms once against the current upload count and persists a skipped attempt', async () => {
    await env.DB.prepare('UPDATE users SET uploadCount=4 WHERE id=?')
      .bind(user.id)
      .run();
    expect(await armOnboardingUpload(env.DB, user)).toEqual({
      status: 'waiting',
      imageId: null,
    });
    await env.DB.prepare('UPDATE users SET uploadCount=5 WHERE id=?')
      .bind(user.id)
      .run();
    await armOnboardingUpload(env.DB, await current());
    expect(await current()).toMatchObject({
      onboardingUploadBaseline: 4,
      onboardingUploadStatus: 'waiting',
    });
    await skipOnboardingUpload(env.DB, await current());
    expect(await current()).toMatchObject({
      onboardingUploadStatus: 'skipped',
      onboardingUploadImageId: null,
    });
    await armOnboardingUpload(env.DB, await current());
    expect(await current()).toMatchObject({
      onboardingUploadBaseline: 5,
      onboardingUploadStatus: 'waiting',
    });
    const events = await database(env.DB).select().from(auditLog);
    expect(
      events.filter((event) => event.action === 'onboarding.upload_started'),
    ).toHaveLength(2);
    expect(
      events.filter((event) => event.action === 'onboarding.upload_skipped'),
    ).toHaveLength(1);
  });
  it('records an unverified milestone as skipped when setup is completed directly', async () => {
    await finishOnboarding(env.DB, user, 'completed');
    expect(await current()).toMatchObject({
      onboardingStatus: 'completed',
      onboardingUploadStatus: 'skipped',
    });
    await armOnboardingUpload(env.DB, await current());
    expect((await current()).onboardingUploadStatus).toBe('waiting');
  });
  it('rejects unauthorized and invalid lifecycle changes and rolls back failed audits', async () => {
    expect((await rpc('onboarding-skip', {}, null)).status).toBe(401);
    expect((await rpc('onboarding-progress', { step: 99 })).status).toBe(400);
    expect((await rpc('onboarding-progress', { step: 1 })).status).toBe(403);
    await env.DB.prepare(
      "CREATE TRIGGER reject_onboarding_audit BEFORE INSERT ON audit_log WHEN NEW.action LIKE 'onboarding.%' BEGIN SELECT RAISE(ABORT,'test_failure'); END",
    ).run();
    await expect(finishOnboarding(env.DB, user, 'completed')).rejects.toThrow(
      'test_failure',
    );
    expect((await current()).onboardingStatus).toBe('pending');
  });
  it('keeps pending progress intact during optional revisits and restricts bootstrap setup by current role', async () => {
    await advanceOnboarding(env.DB, user, 4);
    expect(await pageLoad(await current(), '?revisit=1')).toMatchObject({
      startStep: 0,
      revisit: true,
    });
    expect((await current()).onboardingStep).toBe(4);
    await env.DB.prepare('UPDATE users SET bootstrapAdministrator=1 WHERE id=?')
      .bind(user.id)
      .run();
    expect(hasBootstrapSetup(await current())).toBe(false);
    await env.DB.prepare("UPDATE users SET role='admin' WHERE id=?")
      .bind(user.id)
      .run();
    expect(hasBootstrapSetup(await current())).toBe(true);
  });
});

describe('shared settings and credentials', () => {
  it('normalizes the name without overwriting preferences from another session', async () => {
    await rpc('preferences', { expiry: '7d', stripImageMetadata: false });
    expect(
      (await rpc('preferences', { displayName: '  A new name  ' })).status,
    ).toBe(200);
    expect(await current()).toMatchObject({
      displayName: 'A new name',
      defaultExpiry: '7d',
      stripImageMetadata: false,
    });
  });
  it('validates only submitted expiry and preserves administrator restrictions', async () => {
    await env.DB.prepare('UPDATE users SET expiryPolicy=? WHERE id=?')
      .bind(
        JSON.stringify({ requireExpiry: true, maxLifetimeSeconds: 3600 }),
        user.id,
      )
      .run();
    const restricted = await current();
    expect(
      (await rpc('preferences', { displayName: 'Allowed name' }, restricted))
        .status,
    ).toBe(200);
    expect(
      (await rpc('preferences', { expiry: 'never' }, restricted)).status,
    ).toBe(400);
    expect(
      (await rpc('preferences', { expiry: '1800s' }, restricted)).status,
    ).toBe(200);
    expect((await current()).defaultExpiry).toBe('1800s');
  });
  it('downloads the existing SXCU using the current key without issuing credentials', async () => {
    const before = await database(env.DB).select().from(apiKeys);
    const response = await rpc('sxcu', { key });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      RequestURL: 'http://localhost/api/v1/images',
      Headers: { Authorization: `Bearer ${key}` },
      Body: 'MultipartFormData',
      FileFormName: 'file',
    });
    const after = await database(env.DB).select().from(apiKeys);
    expect(after.map(({ lastUsedAt: _lastUsedAt, ...value }) => value)).toEqual(
      before.map(({ lastUsedAt: _lastUsedAt, ...value }) => value),
    );
    expect(JSON.stringify(after)).not.toContain(key);
    expect(JSON.stringify(await pageLoad())).not.toContain(key);
  });
  it('shows only usable authorized domains and never guesses a replacement', async () => {
    const timestamp = now();
    await env.DB.batch([
      env.DB.prepare(
        "INSERT INTO delivery_domains(id,hostname,health,accessMode,createdAt,updatedAt) VALUES('visible','visible.example.com','active','everyone',?,?)",
      ).bind(timestamp, timestamp),
      env.DB.prepare(
        "INSERT INTO delivery_domains(id,hostname,health,accessMode,createdAt,updatedAt) VALUES('restricted','restricted.example.com','active','administrators',?,?)",
      ).bind(timestamp, timestamp),
    ]);
    expect(await pageLoad()).toMatchObject({
      available: [{ id: 'visible' }],
      setupDomains: [],
      selection: { domain: null },
    });
    expect((await current()).preferredDeliveryDomainId).toBeNull();
  });
});

it('adds onboarding without rebuilding users or losing database invariants', async () => {
  const old = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default {fetch(){return new Response("ok")}}',
      d1Databases: ['DB'],
    }),
  );
  try {
    const DB = await old.getD1Database('DB');
    await migrateDatabase(DB, '0012_user_management.sql');
    await DB.batch([
      DB.prepare(
        "INSERT INTO users(id,displayName,role,defaultExpiry,createdAt,updatedAt) VALUES('initial','Initial','admin','7d',1,1)",
      ),
      DB.prepare(
        "INSERT INTO audit_log(id,action,targetId,metadata,createdAt) VALUES('bootstrap','admin.bootstrapped','initial','{}',1)",
      ),
    ]);
    const invariants = await DB.prepare(
      "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
    ).all();
    await applyMigration(DB, '0013_onboarding.sql');
    await applyMigration(DB, '0014_opposite_eddie_brock.sql');
    expect(
      await DB.prepare(
        "SELECT onboardingStatus,onboardingStep,bootstrapAdministrator,defaultExpiry FROM users WHERE id='initial'",
      ).first(),
    ).toEqual({
      onboardingStatus: 'exempt',
      onboardingStep: 0,
      bootstrapAdministrator: 1,
      defaultExpiry: '7d',
    });
    expect(
      await DB.prepare(
        "SELECT onboardingUploadBaseline,onboardingUploadStatus,onboardingUploadImageId FROM users WHERE id='initial'",
      ).first(),
    ).toEqual({
      onboardingUploadBaseline: null,
      onboardingUploadStatus: null,
      onboardingUploadImageId: null,
    });
    expect(
      await DB.prepare(
        "SELECT name,sql FROM sqlite_master WHERE type='trigger' ORDER BY name",
      ).all(),
    ).toMatchObject({ results: invariants.results });
    await expect(
      DB.prepare("UPDATE users SET status='disabled' WHERE id='initial'").run(),
    ).rejects.toThrow('last_admin');
    expect(
      (await DB.prepare('PRAGMA foreign_key_check').all()).results,
    ).toEqual([]);
  } finally {
    await old.dispose();
  }
});
