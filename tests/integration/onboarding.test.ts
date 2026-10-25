/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed query and HTTP results. */
import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { POST } from '../../apps/web/src/routes/api/actions/[action]/+server';
import { load as onboardingLoad } from '../../apps/web/src/routes/onboarding/+page.server';
import { createUser } from '../../packages/core/auth';
import { now } from '../../packages/core/common';
import { database, type User } from '../../packages/core/db';
import type { Env } from '../../packages/core/env';
import {
  advanceOnboarding,
  finishOnboarding,
  hasBootstrapSetup,
} from '../../packages/core/onboarding';
import { auditLog, settings, users } from '../../packages/core/schema';
import { migrateDatabase } from '../helpers/database';

let runtime: Miniflare, env: Env, user: User;
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
  user = await current(created.userId);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json({ success: true }))),
  );
});
afterEach(async () => {
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
    await database(env.DB)
      .insert(settings)
      .values({ key: 'restrictDisplayNameChanges', value: 'true' });
    expect(
      (await rpc('preferences', { displayName: 'Onboarding bypass' })).status,
    ).toBe(403);
    await Promise.all([
      finishOnboarding(env.DB, user, 'completed'),
      finishOnboarding(env.DB, user, 'skipped'),
    ]);
    const terminal = await current();
    expect(['completed', 'skipped']).toContain(terminal.onboardingStatus);
    await advanceOnboarding(env.DB, terminal, 2);
    await finishOnboarding(env.DB, terminal, 'skipped');
    expect((await current()).onboardingStatus).toBe(terminal.onboardingStatus);
    expect((await current()).displayName).toBe(user.displayName);
    const events = await database(env.DB).select().from(auditLog);
    expect(
      events.filter((event) => event.action.startsWith('onboarding.')),
    ).toHaveLength(1);
    expect(await pageLoad(terminal, '?revisit=1')).toMatchObject({
      startStep: 0,
      revisit: true,
    });
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
    const db = database(env.DB);
    for (const scenario of [
      { global: true, override: 'inherit', allowed: false },
      { global: true, override: 'allow', allowed: true },
      { global: false, override: 'restrict', allowed: false },
      { global: false, override: 'inherit', allowed: true },
    ] as const) {
      await db
        .insert(settings)
        .values({
          key: 'restrictDisplayNameChanges',
          value: String(scenario.global),
        })
        .onConflictDoUpdate({
          target: settings.key,
          set: { value: String(scenario.global) },
        });
      await db
        .update(users)
        .set({ displayNamePolicy: scenario.override })
        .where(eq(users.id, user.id));
      const before = await current();
      const response = await rpc('preferences', {
        displayName: `${before.displayName} renamed`,
        stripImageMetadata: !before.stripImageMetadata,
        displayNamePolicy: 'allow',
        restrictDisplayNameChanges: false,
      });
      expect(response.status).toBe(scenario.allowed ? 200 : 403);
      expect(await response.json()).toEqual(
        scenario.allowed
          ? { ok: true }
          : {
              error: {
                code: 'FORBIDDEN',
                message:
                  'Display name changes are disabled by your administrator.',
              },
            },
      );
      const after = await current();
      expect(after).toMatchObject(
        scenario.allowed
          ? {
              displayName: `${before.displayName} renamed`,
              stripImageMetadata: !before.stripImageMetadata,
            }
          : before,
      );
      expect(
        (
          await rpc('preferences', {
            displayName: `  ${after.displayName}  `,
            stripImageMetadata: true,
          })
        ).status,
      ).toBe(200);
      expect(
        (await rpc('preferences', { stripImageMetadata: false })).status,
      ).toBe(200);
      expect((await current()).displayNamePolicy).toBe(scenario.override);
    }
    await db
      .update(users)
      .set({ role: 'admin', displayNamePolicy: 'restrict' })
      .where(eq(users.id, user.id));
    await db
      .update(settings)
      .set({ value: 'true' })
      .where(eq(settings.key, 'restrictDisplayNameChanges'));
    expect(
      (await rpc('preferences', { displayName: 'Administrator name' })).status,
    ).toBe(200);
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
