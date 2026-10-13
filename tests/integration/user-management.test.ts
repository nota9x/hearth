/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed query results directly. */
import { eq, sql } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { load } from '../../apps/web/src/routes/[...path]/+page.server';
import {
  presentAuditCollection,
  recentUserAudit,
} from '../../packages/core/audit-collection';
import { searchAuditLog } from '../../packages/core/audit-search-query';
import { database, type User } from '../../packages/core/db';
import type { Env } from '../../packages/core/env';
import { imageCollection } from '../../packages/core/image-collection';
import {
  auditLog,
  images,
  storageStats,
  users,
} from '../../packages/core/schema';
import { userDetails, userPage } from '../../packages/core/user-management';
import { usersURL } from '../../packages/core/user-search';
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
  await db.insert(auditLog).values(
    Array.from({ length: 8 }, (_, n) => ({
      id: `event-${n}`,
      actorId: uid(4),
      targetId: uid(n === 0 ? 999 : 5),
      action: 'auth.login',
      createdAt: timestamp + n,
      metadata:
        n === 0
          ? '{bad'
          : JSON.stringify({
              actorName: 'Alice Example',
              targetName: 'Historical target',
              context: { token: 'secret', reason: 'Safe reason' },
            }),
    })),
  );
  await db.insert(auditLog).values([
    {
      id: 'other-actor',
      actorId: uid(5),
      targetId: uid(4),
      action: 'user.updated',
      createdAt: timestamp + 100,
    },
    {
      id: 'system',
      actorId: null,
      targetId: uid(4),
      action: 'image.deleted',
      createdAt: timestamp + 101,
    },
  ]);
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
  it('paginates current accounts with stable boundaries and clamps invalid pages', async () => {
    const first = await list(),
      second = await list('page=2'),
      last = await list('page=999');
    expect(first.pagination).toMatchObject({
      total: 74,
      size: 24,
      pages: 4,
      page: 1,
    });
    expect(first.members).toHaveLength(24);
    expect(
      new Set([...first.members, ...second.members].map((row) => row.user.id))
        .size,
    ).toBe(48);
    expect(last.pagination.page).toBe(4);
    expect(last.members).toHaveLength(2);
    expect((await list('page=-2')).pagination.page).toBe(1);
    expect(first.members[0].user.id).toBe(uid(74));
  });
  it('matches names and identifiers case-insensitively without wildcard or SQL expansion', async () => {
    expect((await list('q=ALICE')).members.map((row) => row.user.id)).toEqual([
      uid(5),
      uid(4),
    ]);
    expect(
      (await list(`q=${uid(4).toUpperCase()}`)).members.map(
        (row) => row.user.id,
      ),
    ).toEqual([uid(4)]);
    expect(
      (await list('q=100%25_literal')).members.map((row) => row.user.id),
    ).toEqual([uid(6)]);
    expect((await list("q=' OR 1=1 --")).pagination.total).toBe(0);
    expect((await list('q=missing')).members).toEqual([]);
  });
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
  it('sorts by every supported field and includes previews in usage', async () => {
    expect((await list('sort=oldest')).members[0].user.id).toBe(uid(0));
    expect((await list('sort=name')).members[0].user.id).toBe(uid(6));
    for (const sort of ['images', 'storage'])
      expect((await list(`sort=${sort}`)).members[0]).toMatchObject({
        user: { id: uid(6) },
        bytes: 10_500,
        imageCount: 50,
      });
    expect((await list('sort=unknown')).sort).toBe('newest');
  });
  it('handles absent stats and returns no credential secrets', async () => {
    await database(binding)
      .delete(storageStats)
      .where(eq(storageStats.userId, uid(74)));
    const member = await userDetails(database(binding), admin, uid(74));
    expect(member).toMatchObject({
      bytes: 0,
      imageCount: 0,
      keyLastUsed: null,
    });
    expect(JSON.stringify(member)).not.toMatch(/secretHash|keyId/);
    expect(await userDetails(database(binding), admin, uid(999))).toBeNull();
  });
  it('clamps a final page after an account stops matching', async () => {
    const db = database(binding);
    await db.run(
      sql`WITH RECURSIVE n(x) AS (VALUES(0) UNION ALL SELECT x+1 FROM n WHERE x<24) INSERT INTO users(id,displayName,createdAt,updatedAt) SELECT 'bounds-'||x,'Bounds fixture '||x,x,x FROM n`,
    );
    try {
      expect(
        (await list('q=Bounds&status=active&page=2')).pagination,
      ).toMatchObject({ total: 25, page: 2, pages: 2 });
      await db
        .update(users)
        .set({ status: 'disabled' })
        .where(eq(users.id, 'bounds-24'));
      expect(
        (await list('q=Bounds&status=active&page=2')).pagination,
      ).toMatchObject({ total: 24, page: 1, pages: 1 });
      expect((await list('q=Bounds&page=2')).pagination.page).toBe(2);
      await db
        .update(users)
        .set({ status: 'deleted' })
        .where(eq(users.id, 'bounds-24'));
      const after = await list('q=Bounds&page=2');
      expect(after.pagination).toMatchObject({ total: 24, page: 1, pages: 1 });
      expect(after.members).toHaveLength(24);
    } finally {
      await db.delete(users).where(sql`instr(${users.id},'bounds-')=1`);
    }
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
  it('preserves list URL state while excluding embedded pagination', () => {
    const current = new URL(
      `http://localhost/admin/users/${uid(4)}?q=Alice&status=active&sort=storage&page=2&imagePage=3`,
    );
    expect(usersURL(current)).toBe(
      '/admin/users?q=Alice&status=active&sort=storage&page=2',
    );
    expect(usersURL(current, uid(5))).toContain(
      `/admin/users/${uid(5)}?q=Alice`,
    );
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
  it('excludes tombstoned images and clamps image bounds', async () => {
    await database(binding)
      .update(images)
      .set({ deletedAt: 1 })
      .where(eq(images.id, 'img_00000000000000000000000000000000'));
    const result = await collection('page=999', uid(4));
    expect(result.pagination).toMatchObject({ page: 2, total: 12 });
    expect(result.images.map((image) => image.id)).not.toContain(
      'img_00000000000000000000000000000000',
    );
  });
  it('selects recent actor activity, excludes target-only and same-name events, and keeps safe presentation', async () => {
    const result = await recentUserAudit(database(binding), admin, uid(4));
    expect(result).toHaveLength(5);
    expect(result[0].id).toBe('event-7');
    expect(result.every((log) => log.actorId === uid(4))).toBe(true);
    expect(result[0].actorHref).toBe(`/admin/users/${uid(4)}`);
    expect(JSON.stringify(result)).not.toContain('secret');
    const all = await searchAuditLog(
      database(binding),
      admin,
      new URLSearchParams(`actorId=${uid(4)}&actor=Alice`),
    );
    expect(all.pagination.total).toBe(8);
    expect(await recentUserAudit(database(binding), admin, uid(2))).toEqual([]);
    const missing = await presentAuditCollection(database(binding), [
      {
        id: 'missing',
        actorId: uid(999),
        targetId: uid(999),
        action: 'legacy',
        metadata: '{bad',
        createdAt: 1,
      },
    ]);
    expect(missing[0]).toMatchObject({ actorHref: null, targetHref: null });
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
  it('loads eight preview images and paginates profiles without skipping images', async () => {
    const [owner] = await database(binding)
      .select()
      .from(users)
      .where(eq(users.id, uid(4)));
    for (const path of ['', 'admin']) {
      const overview = await dashboard(path, '', path ? admin : owner);
      expect(overview.images).toHaveLength(8);
      expect(overview.imagePagination.size).toBe(8);
    }
    const first = await dashboard(`admin/users/${uid(4)}`);
    const second = await dashboard(`admin/users/${uid(4)}`, 'imagePage=2');
    expect(first.memberImages!.images).toHaveLength(8);
    expect(second.memberImages!.images).toHaveLength(5);
    expect(
      new Set([...first.images, ...second.images].map((image) => image.id))
        .size,
    ).toBe(13);
    expect(second.memberImages!.pagination).toMatchObject({
      page: 2,
      size: 8,
      offset: 8,
    });
    const full = await dashboard('admin/images');
    expect(full.imagePagination.size).toBe(24);
  });
  it('keeps overview collections scoped and renders disabled/deleted identities safely', async () => {
    const result = await dashboard(
      `admin/users/${uid(4)}`,
      'imagePage=2&q=not-an-image&owner=' + uid(5),
    );
    expect(result).toMatchObject({
      member: { user: { id: uid(4) } },
      memberImages: { pagination: { page: 2, total: 13 } },
      stats: { bytes: 0, imageCount: 0 },
      uploads: 0,
      activeLinks: 0,
    });
    for (const n of [1, 2])
      expect(await dashboard(`admin/users/${uid(n)}`)).toMatchObject({
        member: { user: { id: uid(n) } },
        memberImages: { images: [] },
      });
  });
  it('rejects missing users and unauthorized dashboard routes', async () => {
    await expect(dashboard(`admin/users/${uid(999)}`)).rejects.toMatchObject({
      status: 404,
    });
    for (const path of [
      'admin/users',
      `admin/users/${uid(4)}`,
      'admin/images',
      'admin/audit-log',
    ])
      await expect(
        dashboard(path, `owner=${uid(4)}&actorId=${uid(4)}`, regular),
      ).rejects.toMatchObject({ status: 403 });
  });
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
