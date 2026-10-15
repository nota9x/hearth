/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed database results. */
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, expect, it } from 'vitest';

import { createUser } from '../../packages/core/auth';
import { migrateDatabase } from '../helpers/database';

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

it('installs the production migrations with usable credentials and atomic quota accounting', async () => {
  await migrateDatabase(DB);
  expect(await DB.prepare('SELECT * FROM storage_capacity').first()).toEqual({
    id: 1,
    limitBytes: null,
    persistedBytes: 0,
    reservedBytes: 0,
    ready: 0,
    multipartVerified: 0,
    blocked: 0,
  });
  expect(
    await DB.prepare('SELECT value FROM app_settings WHERE key=?')
      .bind('shareSlugConfiguration')
      .first(),
  ).toEqual({ value: '{"defaultLength":5,"automaticFloor":3}' });
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
