/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed D1 and R2 operations. */
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { initializeStorage } from '../../cli/commands/storage-initialize';
import { createUser } from '../../packages/core/auth';
import { migrateDatabase } from '../helpers/database';

const spawn = vi.hoisted(() => vi.fn());
vi.mock('execa', () => ({ execa: spawn }));

let runtime: Miniflare, DB: D1Database;
let bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
const options = {
  config: 'apps/web/wrangler.jsonc',
  endpoint: 'https://test.r2.cloudflarestorage.com',
  profile: 'test',
};

beforeEach(async () => {
  spawn.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default { fetch() { return new Response(); } }',
      d1Databases: ['DB'],
      r2Buckets: ['BUCKET'],
    }),
  );
  DB = await runtime.getD1Database('DB');
  bucket = await runtime.getR2Bucket('BUCKET');
  await migrateDatabase(DB);
  const owner = await createUser(DB, 'Storage owner', 'admin', null);
  await bucket.put('completed', 'keep');
  await DB.batch([
    DB.prepare(
      "INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt) VALUES('image',?,'completed','kept.png','image/png','png',4,'hash',1,1,1)",
    ).bind(owner.userId),
    DB.prepare(
      "INSERT INTO storage_objects(key,kind,state,token,uploadId,reservedBytes,updatedAt) VALUES('tracked','original','uploading','writer','current',5,1)",
    ),
    DB.prepare(
      'UPDATE storage_capacity SET ready=1,multipartVerified=1 WHERE id=1',
    ),
  ]);
});

afterEach(async () => {
  await runtime?.dispose();
});

async function capacity() {
  return DB.prepare(
    'SELECT ready,multipartVerified,blocked,reservedBytes FROM storage_capacity WHERE id=1',
  ).first();
}

function commands(verifyDeletion = true) {
  const uploads = new Map([
    ['current', 'tracked'],
    ['stale', 'tracked'],
    ['old', "old's upload"],
  ]);
  spawn.mockImplementation(async (command: string, arguments_: string[]) => {
    if (command !== 'aws') {
      // Execute the CLI's SQL against migrated D1 instead of matching its text.
      const sql = arguments_[arguments_.indexOf('--command') + 1];
      const statements = sql.split(';').filter((part) => part.trim());
      const results = await DB.batch(
        statements.map((part) => DB.prepare(part)),
      );
      return { exitCode: 0, stdout: JSON.stringify(results), stderr: '' };
    }
    if (arguments_.includes('list-multipart-uploads')) {
      const preflight =
        arguments_[arguments_.indexOf('--max-uploads') + 1] === '1';
      const nextPage = arguments_.includes('--key-marker');
      const result = preflight
        ? {}
        : nextPage
          ? { Uploads: [{ Key: "old's upload", UploadId: 'old' }] }
          : {
              Uploads: [
                { Key: 'tracked', UploadId: 'current' },
                { Key: 'tracked', UploadId: 'stale' },
              ],
              IsTruncated: true,
              NextKeyMarker: 'tracked',
              NextUploadIdMarker: 'stale',
            };
      return { exitCode: 0, stdout: JSON.stringify(result), stderr: '' };
    }
    const uploadId = arguments_[arguments_.indexOf('--upload-id') + 1];
    if (arguments_.includes('abort-multipart-upload')) {
      expect(await capacity()).toMatchObject({
        ready: 0,
        multipartVerified: 0,
        blocked: 1,
        reservedBytes: 5,
      });
      if (verifyDeletion) uploads.delete(uploadId);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (arguments_.includes('list-parts'))
      return uploads.has(uploadId)
        ? { exitCode: 0, stdout: '{"Parts":[{}]}', stderr: '' }
        : { exitCode: 1, stdout: '', stderr: 'NoSuchUpload' };
    throw new Error(`Unexpected external command: ${arguments_.join(' ')}`);
  });
  return uploads;
}

it.each([false, true])(
  'preserves tracked uploads and completed images, queues a baseline, and retains discrepancy blocking=%s',
  async (discrepancy) => {
    if (discrepancy) {
      await DB.prepare(
        "INSERT INTO reconciliation_runs(id,status,startedAt,completedAt) VALUES('old-scan','completed',1,2)",
      ).run();
      await DB.prepare(
        "INSERT INTO reconciliation_findings(id,runId,kind,details,createdAt) VALUES('finding','old-scan','ledger','review',1)",
      ).run();
    }
    const uploads = commands();
    await initializeStorage(options);
    expect([...uploads]).toEqual([['current', 'tracked']]);
    expect(await capacity()).toEqual({
      ready: 0,
      multipartVerified: 1,
      blocked: discrepancy ? 1 : 0,
      reservedBytes: 5,
    });
    expect(
      await DB.prepare(
        "SELECT status FROM reconciliation_runs WHERE status='running'",
      ).all(),
    ).toMatchObject({
      results: [{ status: 'running' }],
    });
    expect(
      await DB.prepare('SELECT action FROM audit_log WHERE action=?')
        .bind('storage.initialized')
        .all(),
    ).toMatchObject({
      results: [{ action: 'storage.initialized' }],
    });
    expect(
      await DB.prepare('SELECT objectKey,deletedAt FROM images').first(),
    ).toEqual({
      objectKey: 'completed',
      deletedAt: null,
    });
    expect(await (await bucket.get('completed'))!.text()).toBe('keep');
  },
);

it('keeps admission paused without a success audit or baseline when multipart deletion cannot be verified', async () => {
  commands(false);
  await expect(initializeStorage(options)).rejects.toThrow('still present');
  expect(await capacity()).toEqual({
    ready: 0,
    multipartVerified: 0,
    blocked: 1,
    reservedBytes: 5,
  });
  expect(
    (await DB.prepare('SELECT * FROM reconciliation_runs').all()).results,
  ).toEqual([]);
  expect(
    (
      await DB.prepare(
        "SELECT id FROM audit_log WHERE action='storage.initialized'",
      ).all()
    ).results,
  ).toEqual([]);
  expect(await (await bucket.get('completed'))!.text()).toBe('keep');
});
