/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed query results directly. */
import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { load } from '../../apps/web/src/routes/[...path]/+page.server';
import { recentUserAudit } from '../../packages/core/audit-collection';
import { database, type User } from '../../packages/core/db';
import type { Env } from '../../packages/core/env';
import { imageCollection } from '../../packages/core/image-collection';
import { storageStats, users } from '../../packages/core/schema';
import { userDetails, userPage } from '../../packages/core/user-management';
import { migrateDatabase } from '../helpers/database';

let mf: Miniflare, binding: D1Database, admin: User, regular: User;
const uid = (n: number) => `usr_${n.toString(16).padStart(32, '0')}`;
const env = () =>
  ({
    DB: binding,
    ENVIRONMENT: 'development',
    APP_ORIGIN: 'http://localhost',
    LOCAL_DELIVERY_PORT: '8788',
    TURNSTILE_SITE_KEY: 'test',
  }) as Env;
const list = (query = '') =>
  userPage(database(binding), admin, new URLSearchParams(query));
const collection = (query = '', owner?: string) =>
  imageCollection(
    database(binding),
    env(),
    new URLSearchParams(query),
    owner,
    6,
  );
beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    }),
  );
  binding = await mf.getD1Database('DB');
  await migrateDatabase(binding);
  const db = database(binding);
  const timestamp = Date.parse('2026-10-01T12:00:00Z') / 1000;
  await binding.batch([
    ...Array.from({ length: 75 }, (_, n) =>
      binding
        .prepare(
          "INSERT INTO users(id,displayName,role,onboardingStatus,createdAt,updatedAt) VALUES(?,?,?,'exempt',?,?)",
        )
        .bind(
          uid(n),
          n === 4 || n === 5
            ? 'Alice Example'
            : n === 6
              ? '100%_literal'
              : `Member ${n}`,
          n === 0 || n === 3 ? 'admin' : 'user',
          timestamp + n,
          timestamp,
        ),
    ),
    ...Array.from({ length: 75 }, (_, n) =>
      binding
        .prepare('INSERT INTO user_storage_stats(userId) VALUES(?)')
        .bind(uid(n)),
    ),
    ...Array.from({ length: 14 }, (_, n) =>
      binding
        .prepare(
          "INSERT INTO images(id,userId,objectKey,filename,extension,mime,size,width,height,sha256,createdAt) VALUES(?,?,?,?,'png','image/png',20,1,1,'hash',?)",
        )
        .bind(
          `img_${n.toString(16).padStart(32, '0')}`,
          uid(n === 13 ? 5 : 4),
          `object-${n}`,
          `Owned ${n}.png`,
          timestamp + n,
        ),
    ),
  ]);
  await db
    .update(users)
    .set({ status: 'disabled' })
    .where(eq(users.id, uid(1)));
  await db
    .update(users)
    .set({ status: 'deleted' })
    .where(eq(users.id, uid(2)));
  await db
    .update(storageStats)
    .set({ bytes: 10_000, previewBytes: 500, imageCount: 50 })
    .where(eq(storageStats.userId, uid(6)));
  [admin] = await db
    .select()
    .from(users)
    .where(eq(users.id, uid(0)));
  [regular] = await db
    .select()
    .from(users)
    .where(eq(users.id, uid(4)));
});
afterEach(async () => {
  await mf?.dispose();
});

describe('administrative user queries', () => {
  it('composes status, role, joined dates, search, sorting and pagination', async () => {
    expect(
      (await list('status=deleted')).members.map((row) => row.user.id),
    ).toEqual([uid(2)]);
    expect(
      (await list('status=disabled')).members.map((row) => row.user.id),
    ).toEqual([uid(1)]);
    expect((await list('status=all')).pagination.total).toBe(75);
    expect((await list('role=admin')).pagination.total).toBe(2);
    const combined = await list(
      'q=Member&status=active&role=user&sort=oldest&date=custom&from=2026-10-01&to=2026-10-01&tz=UTC&page=2',
    );
    expect(combined.pagination.page).toBe(2);
    expect(combined.members).toHaveLength(24);
    expect(
      combined.members.every(
        (row) =>
          row.user.status === 'active' &&
          row.user.role === 'user' &&
          row.user.displayName.startsWith('Member'),
      ),
    ).toBe(true);
    expect(
      (await list('date=custom&from=2025-01-01&to=2025-01-01')).pagination
        .total,
    ).toBe(0);
  });
  it('requires administrator access before reads', async () => {
    await expect(
      userPage(database(binding), regular, new URLSearchParams()),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      userDetails(database(binding), regular, uid(4)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      recentUserAudit(database(binding), regular, uid(4)),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      userPage(database(binding), null, new URLSearchParams()),
    ).rejects.toMatchObject({ status: 401 });
  });
});
describe('scoped user resources', () => {
  it('paginates only owned images and ignores competing owner parameters in trusted scopes', async () => {
    for (const page of [1, 2, 3]) {
      const result = await collection(`page=${page}&owner=${uid(5)}`, uid(4));
      expect(result.pagination.total).toBe(13);
      expect(result.images.every((image) => image.ownerId === uid(4))).toBe(
        true,
      );
    }
    expect((await collection(`owner=${uid(5)}`)).images).toHaveLength(1);
    expect((await collection('', uid(1))).images).toEqual([]);
    expect((await collection('', uid(2))).images).toEqual([]);
  });
});

async function dashboard(
  path: string,
  query = '',
  actor: User | null = admin,
  db = binding,
) {
  const event: Partial<Parameters<typeof load>[0]> = {
    locals: { user: actor, env: { ...env(), DB: db } },
    params: { path },
    url: new URL(`http://localhost/${path}?${query}`),
    depends: vi.fn(),
  };
  return load(event as Parameters<typeof load>[0]);
}
describe('user page loaders', () => {
  it('shows partial failures without discarding the user identity', async () => {
    const original = binding.prepare.bind(binding);
    const failed = {
      batch: binding.batch.bind(binding),
      exec: binding.exec.bind(binding),
      withSession: binding.withSession.bind(binding),
      dump: binding.dump.bind(binding),
      prepare: (query: string) => {
        if (/\bimages\b/.test(query)) throw new Error('Collection unavailable');
        return original(query);
      },
    };
    expect(
      await dashboard(`admin/users/${uid(4)}`, '', admin, failed),
    ).toMatchObject({
      member: { user: { id: uid(4) } },
      memberImages: null,
    });
  });
});
