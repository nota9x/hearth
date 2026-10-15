import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { AUDIT_LIMIT } from '../../packages/core/audit-search';
import { searchAuditLog } from '../../packages/core/audit-search-query';
import { database, type User } from '../../packages/core/db';
import {
  auditLog,
  deliveryDomains,
  images,
  users,
} from '../../packages/core/schema';
import { migrateDatabase } from '../helpers/database';

let mf: Miniflare,
  searchBinding: D1Database,
  retentionBinding: D1Database,
  admin: User;
const at = (value: string) => Date.parse(value) / 1000;
beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['SEARCH', 'RETENTION'],
    }),
  );
  searchBinding = await mf.getD1Database('SEARCH');
  await migrateDatabase(searchBinding);
  const db = database(searchBinding);
  await db.insert(users).values({
    id: 'usr_actor',
    displayName: 'Current Investigator',
    role: 'admin',
    createdAt: 1,
    updatedAt: 1,
  });
  [admin] = await db.select().from(users);
  await db.insert(deliveryDomains).values({
    id: 'hst_legacy',
    hostname: 'legacy-shots.example.com',
    createdAt: 1,
    updatedAt: 1,
    health: 'active',
  });
  await db.insert(images).values({
    id: 'img_legacy',
    userId: admin.id,
    objectKey: 'legacy',
    filename: 'Legacy evidence.png',
    mime: 'image/png',
    extension: 'png',
    size: 1,
    sha256: 'hash',
    width: 1,
    height: 1,
    createdAt: 1,
  });
  const rows = Array.from({ length: 120 }, (_, index) => ({
    id: `event-${index}`,
    actorId: admin.id,
    targetId: `deleted-host-${index}`,
    action: index % 2 ? 'domain.updated' : 'image.deleted',
    createdAt: at('2026-09-20T12:00:00Z') + Math.floor(index / 2),
    metadata: JSON.stringify({
      version: 1,
      actorName: 'Former Investigator',
      actorIp: '203.0.113.42',
      targetName: `Vacation ${index}`,
      changes: [{ field: 'defaultExpiry', before: '7d', after: '30d' }],
      context: {
        reason: 'Investigated 100%_literal',
        access: ['Named grantee'],
        token: 'hidden-secret',
        owner: { token: 'nested-secret' },
      },
    }),
  }));
  for (let offset = 0; offset < rows.length; offset += 10)
    await db.insert(auditLog).values(rows.slice(offset, offset + 10));
  await db.insert(auditLog).values([
    {
      id: 'legacy',
      actorId: admin.id,
      action: 'domain.deleted',
      targetId: 'hst_legacy',
      metadata: '{broken',
      createdAt: at('2026-09-19T00:00:00Z'),
    },
    {
      id: 'legacy-image',
      actorId: null,
      action: 'image.expiry',
      targetId: 'img_legacy',
      metadata: '{"expiresAt":12345}',
      createdAt: at('2026-09-18T23:59:59Z'),
    },
    {
      id: 'boundary',
      actorId: null,
      action: 'auth.login',
      targetId: null,
      metadata:
        '{"changes":[null,"invalid",{"field":"token","after":"change-secret"}]}',
      createdAt: at('2026-09-21T00:00:00Z'),
    },
  ]);
});
afterEach(async () => {
  await mf?.dispose();
});
const search = (query = '') =>
  searchAuditLog(database(searchBinding), admin, new URLSearchParams(query));

describe('database-backed audit search', () => {
  it('finds snapshot/current names, canonical/friendly actions, resources, and safe details', async () => {
    for (const query of [
      'Former Investigator',
      'Current Investigator',
      '203.0.113.42',
      'usr_actor',
      'domain.updated',
      'Delivery domain configured',
      'Vacation 119',
      'Named grantee',
      'defaultExpiry',
      '30d',
      '100%_literal',
    ]) {
      const result = await search(`q=${encodeURIComponent(query)}`);
      expect(result.pagination.total).toBeGreaterThan(0);
      expect(result.logs.length).toBeLessThanOrEqual(50);
    }
    const host = await search('q=legacy-shots');
    expect(host.logs.map((log) => log.id)).toEqual(['legacy']);
    const image = await search('q=Legacy+evidence');
    expect(image.logs.map((log) => log.id)).toEqual(['legacy-image']);
    const oldMetadata = await search('q=12345');
    expect(oldMetadata.logs.map((log) => log.id)).toEqual(['legacy-image']);
    const friendly = await search('q=Signed+in');
    expect(friendly.logs.map((log) => log.id)).toEqual(['boundary']);
  });
  it('combines filters and treats wildcard / SQL syntax literally', async () => {
    const result = await search(
      'actor=former&action=domain.updated&target=Vacation&date=custom&from=2026-09-20&to=2026-09-20',
    );
    expect(result.pagination.total).toBe(60);
    expect(result.logs.every((log) => log.action === 'domain.updated')).toBe(
      true,
    );
    for (const q of [
      "' OR 1=1 --",
      'hidden-secret',
      'nested-secret',
      'change-secret',
      '%missing_',
    ]) {
      const none = await search(`q=${encodeURIComponent(q)}`);
      expect(none.pagination.total).toBe(0);
    }
    const queryResult1 = await search('action=nonexistent');
    expect(queryResult1.pagination.total).toBe(0);
    const queryResult2 = await search('actor=someone-else');
    expect(queryResult2.pagination.total).toBe(0);
  });
  it('uses local inclusive calendar dates and exclusive end boundaries', async () => {
    const queryResult3 = await search(
      'date=custom&from=2026-09-19&to=2026-09-20&tz=UTC',
    );
    expect(queryResult3.pagination.total).toBe(121);
    const queryResult4 = await search('q=2026-09-20&tz=UTC');
    expect(queryResult4.pagination.total).toBe(120);
    const queryResult5 = await search('q=2026-09-20&tz=America%2FNew_York');
    expect(queryResult5.pagination.total).toBe(121);
    const queryResult6 = await search(
      'date=custom&from=not-a-date&to=2026-09-20&tz=invalid',
    );
    expect(queryResult6.pagination.total).toBe(123);
  });
  it('paginates 50 rows with exact totals, clamping, and stable timestamp ties', async () => {
    const first = await search();
    const second = await search('page=2');
    const last = await search('page=999999');
    expect(first.logs).toHaveLength(50);
    expect(second.logs).toHaveLength(50);
    expect(last.logs).toHaveLength(23);
    expect(last.pagination).toMatchObject({ page: 3, pages: 3, total: 123 });
    expect(first.logs.slice(0, 3).map((log) => log.id)).toEqual([
      'boundary',
      'event-119',
      'event-118',
    ]);
    const combined = [...first.logs, ...second.logs, ...last.logs].map(
      (log) => log.id,
    );
    expect(new Set(combined).size).toBe(123);
    const queryResult7 = await search('page=-3');
    expect(queryResult7.pagination.page).toBe(1);
    const queryResult8 = await search('page=Infinity');
    expect(queryResult8.pagination.page).toBe(1);
    const queryResult9 = await search('page=2.9');
    expect(queryResult9.pagination.page).toBe(2);
    const empty = await search('q=nonexistent&page=200');
    expect(empty.pagination).toMatchObject({ page: 1, pages: 1, total: 0 });
    expect(empty.logs).toEqual([]);
    const queryResult10 = await search('sort=oldest');
    expect(queryResult10.logs[0].id).toBe('legacy-image');
    const queryResult11 = await search('sort=action');
    expect(queryResult11.logs[0].action).toBe('auth.login');
    const queryResult12 = await search('sort=untrusted');
    expect(queryResult12.sort).toBe('newest');
  });
  it('refuses unauthorized access before querying counts, options, or results', async () => {
    await expect(
      searchAuditLog(
        database(searchBinding),
        null,
        new URLSearchParams('q=secret'),
      ),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      searchAuditLog(
        database(searchBinding),
        { ...admin, role: 'user' },
        new URLSearchParams('page=200'),
      ),
    ).rejects.toMatchObject({ status: 403 });
  });
});

describe('SQL audit retention', () => {
  it('enforces the cap for bulk inserts, ties, old timestamps, and rollback', async () => {
    retentionBinding = await mf.getD1Database('RETENTION');
    await migrateDatabase(retentionBinding);

    await retentionBinding
      .prepare(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<10005) INSERT INTO audit_log(id,action,createdAt) SELECT 'seed-'||x,'test.seed',x FROM n",
      )
      .run();
    const db = database(retentionBinding);
    const initial = await retentionBinding
      .prepare(
        'SELECT count(*) AS count, min(createdAt) AS oldest FROM audit_log',
      )
      .first();
    expect(initial).toEqual({ count: AUDIT_LIMIT, oldest: 6 });
    await retentionBinding
      .prepare(
        "WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<100) INSERT INTO audit_log(id,action,createdAt) SELECT 'new-'||x,'test.new',20000 FROM n",
      )
      .run();
    const current = await retentionBinding
      .prepare(
        'SELECT count(*) AS count, min(createdAt) AS oldest FROM audit_log',
      )
      .first();
    expect(current).toEqual({ count: AUDIT_LIMIT, oldest: 106 });
    await db
      .insert(auditLog)
      .values({ id: 'old-arrival', action: 'test.old', createdAt: 0 });
    expect(
      await db.select().from(auditLog).where(eq(auditLog.id, 'old-arrival')),
    ).toEqual([]);
    const result = await searchAuditLog(
      db,
      admin,
      new URLSearchParams('page=200'),
    );
    expect(result.pagination.pages).toBe(200);
    expect(result.logs).toHaveLength(50);
    const newest = await searchAuditLog(db, admin, new URLSearchParams());
    expect(newest.logs[0].id).toBe('new-100');
    await expect(
      retentionBinding.batch([
        retentionBinding.prepare(
          "INSERT INTO audit_log(id,action,createdAt) VALUES('rolled-back','test',30000)",
        ),
        retentionBinding.prepare(
          "INSERT INTO audit_log(id,action,createdAt) VALUES('new-1','duplicate',30000)",
        ),
      ]),
    ).rejects.toThrow();
    expect(
      await db.select().from(auditLog).where(eq(auditLog.id, 'seed-106')),
    ).toHaveLength(1);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.id, 'rolled-back')),
    ).toEqual([]);
    await retentionBinding
      .prepare('UPDATE audit_log SET createdAt=20000')
      .run();
    await db
      .insert(auditLog)
      .values({ id: 'tie-new', action: 'test.tie', createdAt: 20_000 });
    expect(
      await db.select().from(auditLog).where(eq(auditLog.id, 'seed-106')),
    ).toEqual([]);
    expect(
      await db.select().from(auditLog).where(eq(auditLog.id, 'seed-107')),
    ).toHaveLength(1);
  });
});
