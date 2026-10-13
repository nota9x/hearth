/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed database results. */
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { createUser } from '../../packages/core/auth';
import { applyMigration, migrateDatabase } from '../helpers/database';

let runtime: Miniflare, DB: D1Database;
beforeEach(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    }),
  );
  DB = await runtime.getD1Database('DB');
});
afterEach(async () => {
  await runtime?.dispose();
});

it('backfills physical accounting without changing completed files, links, receipts, or account quotas', async () => {
  await migrateDatabase(DB, '0014_opposite_eddie_brock.sql');
  const owner = await createUser(DB, 'Existing owner', 'admin', null);
  const migrations = await DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='storage_capacity'",
  ).all();
  expect(migrations.results).toEqual([]);
  for (const [imageId, size, previewKey, deletedAt, purgedAt] of [
    ['active', 10, 'shared-preview', null, null],
    ['other', 20, 'shared-preview', null, null],
    ['pending', 30, null, 1, null],
    ['purged', 40, null, 1, 2],
  ] as const) {
    await DB.prepare(
      "INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,previewKey,previewSize,createdAt,deletedAt,purgedAt) VALUES(?,?,?,'kept.png','image/png','png',?,'hash',1,1,?,?,1,?,?)",
    )
      .bind(
        imageId,
        owner.userId,
        imageId,
        size,
        previewKey,
        previewKey ? 5 : 0,
        deletedAt,
        purgedAt,
      )
      .run();
  }
  await DB.batch([
    DB.prepare(
      "INSERT INTO reconciliation_runs(id,status,startedAt) VALUES('old-scan','completed',1)",
    ),
    DB.prepare(
      "INSERT INTO reconciliation_findings(id,runId,kind,objectKey,details,createdAt) VALUES('old-finding','old-scan','orphan','orphan','old',1),('duplicate-finding','old-scan','orphan','orphan','duplicate',2)",
    ),
    DB.prepare(
      'INSERT INTO upload_receipts(key,userId,response) VALUES(?,?,?)',
    ).bind('existing-receipt', owner.userId, '{"id":"active"}'),
  ]);
  const before = await DB.prepare('SELECT * FROM images ORDER BY id').all();
  const userBefore = await DB.prepare('SELECT * FROM user_storage_stats').all();
  await applyMigration(DB, '0015_vengeful_fixer.sql');
  expect(
    (await DB.prepare('SELECT * FROM images ORDER BY id').all()).results,
  ).toEqual(before.results);
  expect(
    (await DB.prepare('SELECT * FROM user_storage_stats').all()).results,
  ).toEqual(userBefore.results);
  expect(
    await DB.prepare(
      'SELECT limitBytes,persistedBytes,reservedBytes,ready FROM storage_capacity',
    ).first(),
  ).toEqual({
    limitBytes: null,
    persistedBytes: 65,
    reservedBytes: 0,
    ready: 0,
  });
  expect(
    await DB.prepare('SELECT count(*) AS count FROM storage_objects').first(),
  ).toEqual({ count: 4 });
  expect(
    await DB.prepare('SELECT response FROM upload_receipts').first(),
  ).toEqual({ response: '{"id":"active"}' });
  expect(
    await DB.prepare(
      'SELECT count(*) AS count FROM reconciliation_findings WHERE resolvedAt IS NULL',
    ).first(),
  ).toEqual({ count: 1 });
  expect((await DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
    [],
  );
});

it('installs the production migrations with usable credentials and atomic quota accounting', async () => {
  await migrateDatabase(DB);
  const user = await createUser(DB, 'New install', 'admin', null);
  await DB.prepare('UPDATE users SET quotaBytes=5 WHERE id=?')
    .bind(user.userId)
    .run();
  const insert = (id: string) =>
    DB.prepare(
      "INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt) VALUES(?,?,?,'file.png','image/png','png',5,'hash',1,1,1)",
    )
      .bind(id, user.userId, id)
      .run();
  await insert('first');
  await expect(insert('second')).rejects.toThrow('quota_exceeded');
  expect(
    await DB.prepare(
      'SELECT bytes,imageCount FROM user_storage_stats WHERE userId=?',
    )
      .bind(user.userId)
      .first(),
  ).toEqual({ bytes: 5, imageCount: 1 });
  expect((await DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
    [],
  );
});

it('upgrades populated storage and preferences while applying the intentional delivery reset', async () => {
  await migrateDatabase(DB, '0008_image_metadata.sql');
  await DB.batch([
    DB.prepare("INSERT INTO hosts(id,label,createdAt) VALUES('old','old',1)"),
    DB.prepare(
      "INSERT INTO users(id,displayName,role,defaultHostId,defaultExpiry,createdAt,updatedAt) VALUES('owner','Owner','admin','old','7d',1,1)",
    ),
    DB.prepare("INSERT INTO user_storage_stats(userId) VALUES('owner')"),
    DB.prepare(
      "INSERT INTO api_keys(userId,keyId,secretHash,version,createdAt) VALUES('owner','credential','verifier',3,1)",
    ),
    DB.prepare(
      "INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt) VALUES('img','owner','original','kept.png','image/png','png',5,'hash',1,1,100)",
    ),
    DB.prepare(
      "INSERT INTO aliases(id,imageId,hostId,slug,createdAt) VALUES('alias','img','old','existing',1)",
    ),
    DB.prepare(
      "INSERT INTO upload_receipts(key,userId,response) VALUES('receipt','owner','old-url')",
    ),
  ]);
  await applyMigration(DB, '0009_share_slug_configuration.sql');
  expect(
    await DB.prepare("SELECT slug FROM aliases WHERE id='alias'").first(),
  ).toEqual({ slug: 'existing' });
  await DB.prepare(
    "UPDATE app_settings SET value=? WHERE key='shareSlugConfiguration'",
  )
    .bind(JSON.stringify({ defaultLength: 8, automaticFloor: 5 }))
    .run();
  await applyMigration(DB, '0009_share_slug_configuration.sql');
  expect(
    (
      await DB.prepare(
        "SELECT value FROM app_settings WHERE key='shareSlugConfiguration'",
      ).first<{ value: string }>()
    )?.value,
  ).toContain('8');
  for (const file of [
    '0010_link_management.sql',
    '0011_delivery_domains.sql',
    '0012_user_management.sql',
  ])
    await applyMigration(DB, file);
  expect(
    await DB.prepare(
      "SELECT role,defaultExpiry,stripImageMetadata,preferredDeliveryDomainId FROM users WHERE id='owner'",
    ).first(),
  ).toEqual({
    role: 'admin',
    defaultExpiry: '7d',
    stripImageMetadata: 1,
    preferredDeliveryDomainId: null,
  });
  expect(
    await DB.prepare(
      "SELECT keyId,secretHash,version FROM api_keys WHERE userId='owner'",
    ).first(),
  ).toEqual({ keyId: 'credential', secretHash: 'verifier', version: 3 });
  expect(
    await DB.prepare(
      "SELECT objectKey,createdAt,expiresAt,deletedAt FROM images WHERE id='img'",
    ).first(),
  ).toEqual({
    objectKey: 'original',
    createdAt: 100,
    expiresAt: null,
    deletedAt: null,
  });
  expect(
    await DB.prepare(
      "SELECT bytes,imageCount FROM user_storage_stats WHERE userId='owner'",
    ).first(),
  ).toEqual({ bytes: 5, imageCount: 1 });
  expect(
    await DB.prepare('SELECT count(*) AS count FROM aliases').first(),
  ).toEqual({ count: 0 });
  expect(
    await DB.prepare('SELECT count(*) AS count FROM upload_receipts').first(),
  ).toEqual({ count: 0 });
  expect((await DB.prepare('PRAGMA foreign_key_check').all()).results).toEqual(
    [],
  );
});
