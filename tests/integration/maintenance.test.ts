/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed request and binding results. */
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUser } from '../../packages/core/auth';
import { deleteImage } from '../../packages/core/images';
import {
  type DeliveryEnvironment,
  resolvePublicShare,
} from '../../packages/core/public-share';
import { observeStoredObject } from '../../packages/core/storage';
import { maintain } from '../../workers/maintenance/src/index';
import { migrateDatabase } from '../helpers/database';

let runtime: Miniflare;
let env: Parameters<typeof maintain>[0];
let owner: string;

beforeEach(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
      r2Buckets: ['BUCKET'],
    }),
  );
  const DB = await runtime.getD1Database('DB');
  await migrateDatabase(DB);
  env = {
    DB,
    // @ts-expect-error Miniflare uses Undici Headers for its otherwise compatible R2 proxy.
    BUCKET: await runtime.getR2Bucket('BUCKET'),
  };
  owner = (await createUser(DB, 'Maintenance owner', 'admin', null)).userId;
  await DB.prepare(
    "INSERT INTO delivery_domains(id,hostname,health,createdAt,updatedAt) VALUES('host','shots.example.com','active',1,1)",
  ).run();
});
afterEach(async () => {
  await runtime?.dispose();
});

async function image(id = 'image') {
  await env.DB.prepare(
    "INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt) VALUES(?,?,?, ?,'image/png','png',5,'hash',1,1,1)",
  )
    .bind(id, owner, id, `${id}.png`)
    .run();
  await env.BUCKET.put(id, 'bytes');
  await observeStoredObject(env.DB, id, 5, 'original', id, owner);
  return id;
}
const row = (id = 'image') =>
  env.DB.prepare('SELECT deletedAt,purgedAt,previewKey FROM images WHERE id=?')
    .bind(id)
    .first();
const locks = () =>
  env.DB.prepare('SELECT count(*) AS count FROM maintenance_lock').first();

describe('maintenance recovery and integrity', () => {
  it('skips previews at global capacity and accounts their exact output once space is added', async () => {
    await image();
    await env.DB.prepare(
      'UPDATE storage_capacity SET ready=1,multipartVerified=1,limitBytes=5 WHERE id=1',
    ).run();
    const IMAGES = {
      input: () => ({
        transform: () => ({
          output: () =>
            Promise.resolve({ response: () => new Response('small') }),
        }),
      }),
    } as unknown as NonNullable<typeof env.IMAGES>;
    await maintain({ ...env, IMAGES });
    expect(await row()).toMatchObject({ previewKey: null });
    expect((await env.BUCKET.list({ prefix: 'previews/' })).objects).toEqual(
      [],
    );
    expect(
      await env.DB.prepare(
        'SELECT persistedBytes,reservedBytes FROM storage_capacity',
      ).first(),
    ).toEqual({ persistedBytes: 5, reservedBytes: 0 });
    await env.DB.prepare(
      'UPDATE storage_capacity SET limitBytes=10 WHERE id=1',
    ).run();
    await maintain({ ...env, IMAGES });
    expect(
      (await env.BUCKET.list({ prefix: 'previews/' })).objects,
    ).toHaveLength(1);
    expect(
      await env.DB.prepare(
        'SELECT persistedBytes,reservedBytes FROM storage_capacity',
      ).first(),
    ).toEqual({ persistedBytes: 10, reservedBytes: 0 });
    await maintain({ ...env, IMAGES });
    expect(
      await env.DB.prepare(
        'SELECT persistedBytes,reservedBytes FROM storage_capacity',
      ).first(),
    ).toEqual({ persistedBytes: 10, reservedBytes: 0 });
  });
  it('keeps failed purges unavailable, retries original and preview cleanup, and accounts only once', async () => {
    await image();
    await env.BUCKET.put('preview', 'small');
    await env.DB.prepare(
      "UPDATE images SET previewKey='preview',previewSize=5 WHERE id='image'",
    ).run();
    await env.DB.prepare(
      "INSERT INTO aliases(id,imageId,deliveryDomainId,slug,createdAt) VALUES('link','image','host','hello',1)",
    ).run();
    await deleteImage(
      env.DB,
      {
        delete: () => Promise.reject(new Error('R2 outage')),
        head: env.BUCKET.head.bind(env.BUCKET),
        resumeMultipartUpload: env.BUCKET.resumeMultipartUpload.bind(
          env.BUCKET,
        ),
      },
      'image',
      owner,
    );
    expect(await row()).toMatchObject({
      deletedAt: expect.any(Number) as unknown,
      purgedAt: null,
    });
    expect(await env.BUCKET.head('image')).not.toBeNull();
    const response = await resolvePublicShare(
      new Request('https://shots.example.com/hello', {
        headers: { Range: 'bytes=0-1', 'If-None-Match': '"etag"' },
      }),
      {
        ...env,
        ENVIRONMENT: 'development',
        APP_ORIGIN: 'https://app.example.com',
      } as DeliveryEnvironment,
    );
    expect(response.status).toBe(404);
    await maintain(env);
    await maintain(env);
    expect(await env.BUCKET.head('image')).toBeNull();
    expect(await env.BUCKET.head('preview')).toBeNull();
    expect(await row()).toMatchObject({
      purgedAt: expect.any(Number) as unknown,
    });
    expect(
      await env.DB.prepare(
        'SELECT bytes,previewBytes,imageCount FROM user_storage_stats WHERE userId=?',
      )
        .bind(owner)
        .first(),
    ).toEqual({ bytes: 0, previewBytes: 0, imageCount: 0 });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM audit_log WHERE action='image.deleted'",
      ).first(),
    ).toEqual({ count: 1 });
  });

  it('cannot attach a generated preview after its image is tombstoned', async () => {
    await image();
    const IMAGES = {
      input: () => ({
        transform: () => ({
          output: async () => {
            await deleteImage(env.DB, env.BUCKET, 'image', owner);
            return { response: () => new Response('generated preview') };
          },
        }),
      }),
    } as unknown as NonNullable<typeof env.IMAGES>;
    await maintain({ ...env, IMAGES });
    expect(await row()).toMatchObject({
      deletedAt: expect.any(Number) as unknown,
      previewKey: null,
    });
    expect((await env.BUCKET.list({ prefix: 'previews/' })).objects).toEqual(
      [],
    );
    expect(await env.BUCKET.head('image')).toBeNull();
  });

  it('respects an active lease and releases its own lease after a failed execution', async () => {
    await image();
    await env.DB.prepare(
      "UPDATE images SET expiresAt=1 WHERE id='image'",
    ).run();
    await env.DB.prepare(
      "INSERT INTO maintenance_lock(id,holder,expiresAt) VALUES('cron','other',?)",
    )
      .bind(Math.floor(Date.now() / 1000) + 3600)
      .run();
    await maintain(env);
    expect(await row()).toMatchObject({ deletedAt: null });
    await env.DB.prepare(
      "DELETE FROM maintenance_lock WHERE holder='other'",
    ).run();
    const prepare = env.DB.prepare.bind(env.DB);
    const DB = {
      ...env.DB,
      prepare(query: string) {
        if (query.startsWith('delete from "sessions"'))
          throw new Error('D1 unavailable');
        return prepare(query);
      },
    } as D1Database;
    await expect(maintain({ ...env, DB })).rejects.toThrow('D1 unavailable');
    expect(await locks()).toEqual({ count: 0 });
    await maintain(env);
    expect(await row()).toMatchObject({
      purgedAt: expect.any(Number) as unknown,
    });
    expect(await locks()).toEqual({ count: 0 });
  });

  it('reports orphan, missing-original and accounting findings without repairing or deleting data', async () => {
    await image('kept');
    await image('missing');
    await env.BUCKET.delete('missing');
    await env.BUCKET.put('orphan', 'unreferenced');
    const uploaded = (await env.BUCKET.head('orphan'))!.uploaded;
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(uploaded.getTime() + 7200 * 1000);
    await env.DB.prepare(
      'UPDATE user_storage_stats SET bytes=999 WHERE userId=?',
    )
      .bind(owner)
      .run();
    await env.DB.prepare(
      "INSERT INTO reconciliation_runs(id,status,startedAt) VALUES('run','running',?)",
    )
      .bind(Math.floor(Date.now() / 1000))
      .run();
    await maintain(env);
    await maintain(env);
    const findings = await env.DB.prepare(
      "SELECT kind,objectKey,imageId FROM reconciliation_findings WHERE runId='run'",
    ).all();
    expect(findings.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'orphan', objectKey: 'orphan' }),
        expect.objectContaining({ kind: 'missing', imageId: 'missing' }),
        expect.objectContaining({ kind: 'accounting' }),
      ]),
    );
    expect(await env.BUCKET.head('orphan')).not.toBeNull();
    expect(await env.BUCKET.head('kept')).not.toBeNull();
    expect(
      await env.DB.prepare(
        'SELECT bytes FROM user_storage_stats WHERE userId=?',
      )
        .bind(owner)
        .first(),
    ).toEqual({ bytes: 999 });
    expect(await row('missing')).toMatchObject({ deletedAt: null });
    expect(
      await env.DB.prepare(
        "SELECT status FROM reconciliation_runs WHERE id='run'",
      ).first(),
    ).toEqual({ status: 'completed' });
  });
});
