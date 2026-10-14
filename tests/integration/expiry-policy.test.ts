/* eslint-disable unicorn/no-await-expression-member -- Assertions read completed response and policy values directly. */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

import { eq, sql } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { POST as actionRoute } from '../../apps/web/src/routes/api/actions/[action]/+server';
import { POST as webUpload } from '../../apps/web/src/routes/api/upload/+server';
import { POST as apiUpload } from '../../apps/web/src/routes/api/v1/images/+server';
import { presentAudit } from '../../packages/core/audit-presentation';
import { createUser } from '../../packages/core/auth';
import { id, now } from '../../packages/core/common';
import { database, type User } from '../../packages/core/db';
import type { Env } from '../../packages/core/env';
import { unrestrictedExpiryPolicy } from '../../packages/core/expiry-policy';
import { getEffectiveExpiryPolicy } from '../../packages/core/expiry-policy-store';
import {
  changeImageExpiry,
  imageExpiryOptions,
} from '../../packages/core/images';
import {
  auditLog,
  deliveryDomains,
  images,
  settings,
  users,
} from '../../packages/core/schema';
import { sharexConfig } from '../../packages/core/sharex';
import { upload } from '../../packages/core/upload';
import { migrateDatabase } from '../helpers/database';

vi.mock('cloudflare:workers', () => ({ waitUntil: () => {} }));

const unrestricted = unrestrictedExpiryPolicy;

let mf: Miniflare, env: Env, admin: User, member: User, memberKey: string;
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
  // @ts-expect-error Miniflare's R2 binding proxy uses Undici Headers types.
  env = {
    DB,
    BUCKET: await mf.getR2Bucket('BUCKET'),
    ASSETS: { fetch: vi.fn() },
    ENVIRONMENT: 'development',
    APP_ORIGIN: 'http://localhost',
    TURNSTILE_SITE_KEY: 'test',
    MAX_UPLOAD_BYTES: '10485760',
    LOGIN_LIMIT: limit,
    MUTATION_LIMIT: limit,
    SENSITIVE_LIMIT: limit,
    UPLOAD_LIMIT: limit,
  } as Env;
  const first = await createUser(DB, 'Administrator', 'admin', null);
  const second = await createUser(DB, 'Member', 'user', first.userId);
  memberKey = second.key;
  const db = database(DB);
  const deliveryDomainId = id('hst');
  await db.insert(deliveryDomains).values({
    id: deliveryDomainId,
    hostname: 'photos.example.com',
    createdAt: now(),
    updatedAt: now(),
    health: 'active',
  });
  await db.update(users).set({ preferredDeliveryDomainId: deliveryDomainId });
  [admin] = await db.select().from(users).where(eq(users.id, first.userId));
  [member] = await db.select().from(users).where(eq(users.id, second.userId));
});
beforeEach(async () => {
  await database(env.DB)
    .delete(settings)
    .where(eq(settings.key, 'expiryPolicy'));
  await database(env.DB).update(users).set({
    expiryPolicy: null,
    defaultExpiry: 'never',
    stripImageMetadata: true,
  });
});
afterEach(async () => {
  await mf?.dispose();
});

async function setPolicy(
  requireExpiry: boolean,
  maxLifetimeSeconds: number | null,
) {
  await database(env.DB)
    .insert(settings)
    .values({
      key: 'expiryPolicy',
      value: JSON.stringify({ requireExpiry, maxLifetimeSeconds }),
    });
}
async function seed(count = 1, owner = member, timestamp = now()) {
  const ids = Array.from({ length: count }, () => id('img'));
  await env.DB.prepare(
    `INSERT INTO images (id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt)
    SELECT value, ?, value, 'Policy.png', 'image/png', 'png', 1, 'test', 1, 1, ? FROM json_each(?)`,
  )
    .bind(owner.id, timestamp, JSON.stringify(ids))
    .run();
  return ids;
}
async function action(
  name: string,
  input: Record<string, unknown>,
  actor: User = admin,
) {
  return actionRoute({
    request: new Request(`http://localhost/api/actions/${name}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    }),
    locals: { env, user: actor },
    params: { action: name },
  } as Parameters<typeof actionRoute>[0]);
}
function uploadRequest(token?: string, field = 'expiry', key?: string) {
  const form = new FormData();
  form.append(
    'file',
    new Blob([
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
        'base64',
      ),
    ]),
    'Policy.png',
  );
  if (token !== undefined) form.append(field, token);
  return new Request('http://localhost/api/v1/images', {
    method: 'POST',
    headers: key
      ? { Authorization: `Bearer ${memberKey}`, 'Idempotency-Key': key }
      : { Authorization: `Bearer ${memberKey}` },
    body: form,
  });
}

describe('expiry enforcement and administration', () => {
  it.each(['browser', 'API'])(
    'enforces persisted metadata preferences for %s uploads',
    async (method) => {
      const bytes = await readFile('tests/fixtures/metadata/private.png');
      const db = database(env.DB);
      for (const enabled of [true, false]) {
        await action(
          'preferences',
          {
            displayName: member.displayName,
            expiry: 'never',
            stripImageMetadata: enabled,
          },
          member,
        );
        const [current] = await db
          .select()
          .from(users)
          .where(eq(users.id, member.id));
        const form = new FormData();
        form.append('file', new Blob([bytes]), 'Metadata.png');
        const request = new Request(
          `http://localhost/api/${method === 'API' ? 'v1/images' : 'upload'}?stripImageMetadata=false`,
          {
            method: 'POST',
            body: form,
            headers: {
              Authorization: `Bearer ${memberKey}`,
              'X-Strip-Image-Metadata': 'false',
            },
          },
        );
        const route = method === 'API' ? apiUpload : webUpload;
        const response = await route({
          request,
          locals: { env, user: current },
        } as Parameters<typeof route>[0]);
        expect(response.status).toBe(201);
        const result = z
          .object({ id: z.string() })
          .parse(await response.json());
        const [row] = await db
          .select()
          .from(images)
          .where(eq(images.id, result.id));
        const object = await env.BUCKET.get(row.objectKey);
        const stored = Buffer.from(await object!.arrayBuffer());
        expect(stored.includes(Buffer.from('Private'))).toBe(!enabled);
        expect(enabled || stored.equals(bytes)).toBe(true);
      }
    },
  );
  it('enforces both upload handlers and returns ShareX-readable errors without leaking R2 originals', async () => {
    await setPolicy(true, 3600);
    const originalObjects = (await env.BUCKET.list()).objects.length;
    for (const handler of [webUpload, apiUpload]) {
      const response = await handler({
        request: uploadRequest(),
        locals: { env, user: member },
      } as Parameters<typeof handler>[0]);
      expect(response.status).toBe(400);
      const result: unknown = await response.json();
      expect(result).toMatchObject({ error: { code: 'EXPIRY_REQUIRED' } });
      expect(JSON.stringify(result)).toContain('Settings');
    }
    expect((await env.BUCKET.list()).objects).toHaveLength(originalObjects);
    expect(sharexConfig(env.APP_ORIGIN, memberKey).ErrorMessage).toBe(
      '{json:error.message}',
    );
    const beyond = await apiUpload({
      request: uploadRequest('7d'),
      locals: { env, user: null },
    } as Parameters<typeof apiUpload>[0]);
    expect(beyond.status).toBe(400);
    expect(await beyond.json()).toMatchObject({
      error: { code: 'EXPIRY_TOO_LONG' },
    });
    const allowed = await apiUpload({
      request: uploadRequest('1h', 'retention'),
      locals: { env, user: null },
    } as Parameters<typeof apiUpload>[0]);
    expect(allowed.status).toBe(201);
  });
  it('replays successful receipts even when the policy changes and exempts admin uploads', async () => {
    const key = 'a'.repeat(64);
    const initial = await upload(
      uploadRequest(undefined, 'expiry', key),
      member,
      env,
    );
    await setPolicy(true, 60);
    expect(
      await upload(uploadRequest(undefined, 'expiry', key), member, env),
    ).toEqual(initial);
    expect((await upload(uploadRequest(), admin, env)).expiresAt).toBeNull();
  });
  it('validates default preferences and prevents members from changing policy', async () => {
    await setPolicy(false, 3600);
    const invalid = await action(
      'preferences',
      {
        displayName: 'Member',
        expiry: 'never',
        expiryPolicy: unrestricted,
        stripImageMetadata: true,
      },
      member,
    );
    expect(invalid.status).toBe(400);
    expect(
      (
        await action(
          'preferences',
          { displayName: 'Member', expiry: '1800s', stripImageMetadata: true },
          member,
        )
      ).status,
    ).toBe(200);
    for (const name of ['expiry-policy', 'user-expiry-policy'])
      expect(
        (
          await action(
            name,
            { policy: unrestricted, userId: member.id },
            member,
          )
        ).status,
      ).toBe(403);
    expect(
      (await getEffectiveExpiryPolicy(env.DB, member)).maxLifetimeSeconds,
    ).toBe(3600);
  });
  it('atomically changes a large selection, deduplicates IDs, and retains per-image audits', async () => {
    const ids = await seed(500);
    const response = await action(
      'image-expiry',
      { ids: [...ids, ids[0]], expiry: '6h' },
      member,
    );
    expect(response.status).toBe(200);
    const selected = JSON.stringify(ids);
    const rows = await database(env.DB)
      .select()
      .from(images)
      .where(sql`${images.id} IN (SELECT value FROM json_each(${selected}))`);
    expect(rows.every((image) => image.expiresAt !== null)).toBe(true);
    const logs = await database(env.DB)
      .select()
      .from(auditLog)
      .where(
        sql`${auditLog.targetId} IN (SELECT value FROM json_each(${selected}))`,
      );
    expect(logs).toHaveLength(500);
    expect(presentAudit(logs[0]).target).toBe('Policy.png');
  });
  it('uses original creation time and rejects the entire selection when any expiry is invalid', async () => {
    await setPolicy(true, 3600);
    const recent = await seed();
    const old = await seed(1, member, now() - 3500);
    expect(
      (
        await action(
          'image-expiry',
          { ids: [...recent, ...old], expiry: '1h' },
          member,
        )
      ).status,
    ).toBe(400);
    for (const imageId of [...recent, ...old]) {
      const [row] = await database(env.DB)
        .select()
        .from(images)
        .where(eq(images.id, imageId));
      expect(row.expiresAt).toBeNull();
    }
    const options = await imageExpiryOptions(env.DB, member, [
      ...recent,
      ...old,
    ]);
    expect(options.choices).toEqual([['custom', 'Custom date']]);
    expect(options.deadline).toBeLessThanOrEqual(now() + 100);
    const expiredDeadline = await seed(1, member, now() - 3600);
    expect(
      (await imageExpiryOptions(env.DB, member, expiredDeadline)).choices,
    ).toEqual([]);
  });
  it('authorizes the whole selection and lets admins edit mixed-owner images without restrictions', async () => {
    await setPolicy(true, 60);
    const own = await seed();
    const other = await seed(1, admin);
    expect(
      (
        await action(
          'image-expiry',
          { ids: [...own, ...other], expiry: 'never' },
          member,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await action(
          'image-expiry',
          { ids: [...own, ...other], expiry: 'never' },
          admin,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await action(
          'image-expiry',
          { ids: [...own, id('img')], expiry: '30d' },
          admin,
        )
      ).status,
    ).toBe(404);
  });
  it('rolls back all changes and audit events when a database statement fails', async () => {
    const ids = await seed(2);
    await env.DB.prepare(
      `CREATE TRIGGER reject_expiry_test BEFORE UPDATE OF expiresAt ON images WHEN NEW.id = '${ids[1]}' BEGIN SELECT RAISE(ABORT,'test_failure'); END`,
    ).run();
    try {
      await expect(
        changeImageExpiry(env.DB, member, ids, '1h'),
      ).rejects.toThrow();
      const rows = await database(env.DB)
        .select()
        .from(images)
        .where(
          sql`${images.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
        );
      expect(rows.every((row) => row.expiresAt === null)).toBe(true);
      expect(
        await database(env.DB)
          .select()
          .from(auditLog)
          .where(
            sql`${auditLog.targetId} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
          ),
      ).toHaveLength(0);
    } finally {
      await env.DB.prepare('DROP TRIGGER reject_expiry_test').run();
    }
  });
  it('rejects a deletion race before either bulk statement writes', async () => {
    const ids = await seed(2);
    const DB = env.DB;
    const racing: D1Database = {
      prepare: DB.prepare.bind(DB),
      exec: DB.exec.bind(DB),
      dump: DB.dump.bind(DB),
      withSession: DB.withSession.bind(DB),
      async batch<T>(statements: D1PreparedStatement[]) {
        await database(DB)
          .update(images)
          .set({ deletedAt: now() })
          .where(eq(images.id, ids[1]));
        return DB.batch<T>(statements);
      },
    };
    await expect(
      changeImageExpiry(racing, member, ids, '1h'),
    ).rejects.toMatchObject({ code: 'SELECTION_CHANGED' });
    const rows = await database(DB)
      .select()
      .from(images)
      .where(
        sql`${images.id} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
      );
    expect(rows.every((row) => row.expiresAt === null)).toBe(true);
    expect(
      await database(DB)
        .select()
        .from(auditLog)
        .where(
          sql`${auditLog.targetId} IN (SELECT value FROM json_each(${JSON.stringify(ids)}))`,
        ),
    ).toHaveLength(0);
  });
  it('enforces overrides on actual uploads and accepts an existing image exactly at its deadline', async () => {
    await setPolicy(true, 3600);
    await database(env.DB)
      .update(users)
      .set({ expiryPolicy: { maxLifetimeSeconds: 60 } })
      .where(eq(users.id, member.id));
    await expect(
      upload(uploadRequest('1h'), member, env),
    ).rejects.toMatchObject({ code: 'EXPIRY_TOO_LONG' });
    await database(env.DB)
      .update(users)
      .set({ expiryPolicy: { requireExpiry: false, maxLifetimeSeconds: null } })
      .where(eq(users.id, member.id));
    expect((await upload(uploadRequest(), member, env)).expiresAt).toBeNull();
    await database(env.DB)
      .update(users)
      .set({ expiryPolicy: null })
      .where(eq(users.id, member.id));
    const timestamp = now() - 1200;
    const ids = await seed(1, member, timestamp);
    const deadline = new Date((timestamp + 3600) * 1000).toISOString();
    expect(
      (
        await action(
          'image-expiry',
          { ids, expiry: 'custom', expiresAt: deadline },
          member,
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await action(
          'image-expiry',
          {
            ids,
            expiry: 'custom',
            expiresAt: new Date((timestamp + 3601) * 1000).toISOString(),
          },
          member,
        )
      ).status,
    ).toBe(400);
    const [row] = await database(env.DB)
      .select()
      .from(images)
      .where(eq(images.id, ids[0]));
    expect(row.expiresAt).toBe(timestamp + 3600);
  });
});
