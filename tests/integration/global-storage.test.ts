/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed storage operations. */
import { Buffer } from 'node:buffer';

import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { authenticateKey, createUser } from '../../packages/core/auth';
import { id, now } from '../../packages/core/common';
import { checkDeliveryDomain } from '../../packages/core/domain-validation';
import { deleteImage } from '../../packages/core/images';
import {
  beginStorage,
  cleanupStorage,
  deleteStoredObjects,
  StorageWriter,
  writeStoredObject,
} from '../../packages/core/storage';
import {
  recoverStorage,
  scanStorage,
} from '../../packages/core/storage-maintenance';
import { storageWarnings } from '../../packages/core/storage-overview';
import { upload } from '../../packages/core/upload';
import { migrateDatabase } from '../helpers/database';
import { workerBundle, workerCompatibility } from '../helpers/workers';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
let runtime: Miniflare;
let env: Parameters<typeof upload>[2];
let user: Awaited<ReturnType<typeof authenticateKey>>['user'];

function request() {
  const data = new FormData();
  data.set('file', new Blob([png], { type: 'image/png' }), 'pixel.png');
  return new Request('https://app.example.com/api/upload', {
    method: 'POST',
    body: data,
  });
}
async function capacity() {
  return env.DB.prepare(
    'SELECT persistedBytes,reservedBytes,blocked FROM storage_capacity WHERE id=1',
  ).first<{ persistedBytes: number; reservedBytes: number; blocked: number }>();
}
async function limit(bytes: number | null) {
  await env.DB.prepare(
    'UPDATE storage_capacity SET ready=1,multipartVerified=1,limitBytes=? WHERE id=1',
  )
    .bind(bytes)
    .run();
}
async function writer() {
  const key = id('object');
  const token = await beginStorage(env.DB, key, 'original');
  return new StorageWriter(env.DB, env.BUCKET, key, token!);
}

beforeEach(async () => {
  const shared = {
    modules: true,
    scriptPath: workerBundle('upload'),
    ...workerCompatibility('web'),
    d1Databases: { DB: 'storage-shared-db' },
    r2Buckets: { BUCKET: 'storage-shared-bucket' },
    bindings: {
      MAX_UPLOAD_BYTES: '10485760',
      APP_ORIGIN: 'https://app.example.com',
      ENVIRONMENT: 'production',
    },
  };
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        { name: 'upload-a', ...shared },
        { name: 'upload-b', ...shared },
      ],
    }),
  );
  const DB = await runtime.getD1Database('DB', 'upload-a');
  await migrateDatabase(DB);
  env = {
    DB: {
      prepare: DB.prepare.bind(DB),
      batch: DB.batch.bind(DB),
      exec: DB.exec.bind(DB),
      dump: DB.dump.bind(DB),
      withSession: DB.withSession.bind(DB),
    },
    // @ts-expect-error Miniflare uses Undici headers for the native binding proxy.
    BUCKET: await runtime.getR2Bucket('BUCKET', 'upload-a'),
    MAX_UPLOAD_BYTES: '10485760',
    APP_ORIGIN: 'https://app.example.com',
    ENVIRONMENT: 'production',
  };
  const created = await createUser(DB, 'Storage owner', 'admin', null);
  user = (await authenticateKey(DB, created.key)).user;
});
afterEach(async () => {
  await runtime?.dispose();
});

describe('global physical storage admission', () => {
  it('admits an upload exactly at capacity', async () => {
    await limit(png.length);
    await upload(request(), user, env);
    expect(await capacity()).toMatchObject({
      persistedBytes: png.length,
      reservedBytes: 0,
    });
  });
  it('rejects insufficient capacity without retaining objects or metadata', async () => {
    await limit(png.length - 1);
    await expect(upload(request(), user, env)).rejects.toMatchObject({
      status: 413,
      code: 'GLOBAL_STORAGE_LIMIT_EXCEEDED',
    });
    expect((await env.BUCKET.list()).objects).toEqual([]);
    expect(await capacity()).toMatchObject({
      persistedBytes: 0,
      reservedBytes: 0,
    });
    expect(
      await env.DB.prepare('SELECT count(*) AS count FROM images').first(),
    ).toEqual({ count: 0 });
  });
  it('charges actual canonical bytes despite an incorrect client length', async () => {
    await limit(png.length - 1);
    const input = request();
    input.headers.set('Content-Length', '1');
    await expect(upload(input, user, env)).rejects.toMatchObject({
      code: 'GLOBAL_STORAGE_LIMIT_EXCEEDED',
    });
    expect(await capacity()).toMatchObject({
      persistedBytes: 0,
      reservedBytes: 0,
    });
  });
  it('preserves completed storage after a lost D1 response and safely replays the receipt', async () => {
    await limit(png.length);
    const batch = env.DB.batch.bind(env.DB);
    const failure = vi
      .spyOn(env.DB, 'batch')
      .mockImplementation(async (statements) => {
        const result = await batch(statements);
        if (statements.length > 3)
          throw new Error('Lost finalization response');
        return result;
      });
    const input = request();
    input.headers.set('Idempotency-Key', 'a'.repeat(64));
    await expect(upload(input, user, env)).rejects.toMatchObject({
      code: 'SHARE_LINK_UNAVAILABLE',
    });
    expect(failure).toHaveBeenCalled();
    failure.mockRestore();
    expect(await capacity()).toMatchObject({
      persistedBytes: png.length,
      reservedBytes: 0,
    });
    const retry = request();
    retry.headers.set('Idempotency-Key', 'a'.repeat(64));
    await upload(retry, user, env);
    expect(await capacity()).toMatchObject({
      persistedBytes: png.length,
      reservedBytes: 0,
    });
    expect((await env.BUCKET.list()).objects).toHaveLength(1);
  });
  it('allows already reserved bytes to settle after the cap is lowered', async () => {
    await limit(5);
    const operation = await writer();
    const part = await operation.uploadPart(1, new Uint8Array(5));
    await limit(1);
    await operation.complete([part]);
    await env.DB.batch([operation.finalizeStatement()]);
    await expect(
      writeStoredObject(
        env.DB,
        env.BUCKET,
        id('blocked'),
        'probe',
        new Uint8Array(1),
      ),
    ).rejects.toMatchObject({ code: 'GLOBAL_STORAGE_LIMIT_EXCEEDED' });
    expect(await capacity()).toMatchObject({
      persistedBytes: 5,
      reservedBytes: 0,
    });
  });
  it('shares one atomic budget across two Worker instances and multiple users', async () => {
    await limit(png.length * 3);
    const other = await createUser(env.DB, 'Other uploader', 'user', user.id);
    await env.DB.prepare(
      'CREATE TABLE test_storage_barrier(id INTEGER PRIMARY KEY)',
    ).run();
    const workers = await Promise.all([
      runtime.getWorker('upload-a'),
      runtime.getWorker('upload-b'),
    ]);
    const responses = await Promise.all(
      Array.from({ length: 12 }, async (_, index) => {
        const input = request();
        input.headers.set(
          'X-Test-Storage-User',
          index % 2 ? other.userId : user.id,
        );
        input.headers.set('X-Benchmark-R2-Delay-Ms', '100');
        input.headers.set('X-Test-Storage-Barrier', '12');
        return workers[index % 2].fetch(input.url, {
          method: input.method,
          headers: Object.fromEntries(input.headers),
          body: await input.arrayBuffer(),
        });
      }),
    );
    expect(
      responses.filter((response) => response.status === 200),
    ).toHaveLength(3);
    expect(
      responses.filter((response) => response.status === 413),
    ).toHaveLength(9);
    const rejected = responses.filter((response) => response.status === 413);
    for (const response of rejected)
      expect(await response.json()).toMatchObject({
        code: 'GLOBAL_STORAGE_LIMIT_EXCEEDED',
      });
    expect(await capacity()).toMatchObject({
      persistedBytes: png.length * 3,
      reservedBytes: 0,
    });
    expect((await env.BUCKET.list()).objects).toHaveLength(3);
  });
  it('retains a reservation after R2 completion until an idempotent D1 finalization', async () => {
    await limit(5);
    const operation = await writer();
    const part = await operation.uploadPart(
      1,
      new TextEncoder().encode('bytes'),
    );
    await operation.complete([part]);
    expect(await capacity()).toMatchObject({
      persistedBytes: 0,
      reservedBytes: 5,
    });
    await env.DB.batch([operation.finalizeStatement()]);
    await expect(
      env.DB.batch([operation.finalizeStatement()]),
    ).rejects.toThrow();
    await operation.cleanup();
    expect(await capacity()).toMatchObject({
      persistedBytes: 5,
      reservedBytes: 0,
    });
    expect(await env.BUCKET.head(operation.key)).not.toBeNull();
  });
  it('never frees capacity after a failed physical deletion', async () => {
    await limit(png.length);
    await env.DB.prepare('UPDATE users SET quotaBytes=? WHERE id=?')
      .bind(png.length, user.id)
      .run();
    const result = await upload(request(), user, env);
    expect(await storageWarnings(env.DB, user.id)).toEqual({
      personal: 'full',
      instance: 'full',
    });
    await deleteImage(
      env.DB,
      {
        head: env.BUCKET.head.bind(env.BUCKET),
        resumeMultipartUpload: env.BUCKET.resumeMultipartUpload.bind(
          env.BUCKET,
        ),
        delete: () => Promise.reject(new Error('R2 outage')),
      },
      result.id,
      user.id,
    );
    expect(await storageWarnings(env.DB, user.id)).toEqual({
      personal: 'normal',
      instance: 'full',
    });
    expect(await capacity()).toMatchObject({
      persistedBytes: png.length,
      reservedBytes: 0,
    });
    await expect(upload(request(), user, env)).rejects.toMatchObject({
      code: 'GLOBAL_STORAGE_LIMIT_EXCEEDED',
    });
    await deleteImage(env.DB, env.BUCKET, result.id, user.id);
    await deleteImage(env.DB, env.BUCKET, result.id, user.id);
    expect(await storageWarnings(env.DB, user.id)).toEqual({
      personal: 'normal',
      instance: 'normal',
    });
    expect(await capacity()).toMatchObject({
      persistedBytes: 0,
      reservedBytes: 0,
    });
  });
  it('retains uncertain completion and deletion charges until recovery succeeds', async () => {
    await limit(5);
    const operation = await writer();
    await operation.complete([
      await operation.uploadPart(1, new TextEncoder().encode('bytes')),
    ]);
    const failing = {
      head: env.BUCKET.head.bind(env.BUCKET),
      resumeMultipartUpload: env.BUCKET.resumeMultipartUpload.bind(env.BUCKET),
      delete: () => Promise.reject(new Error('R2 outage')),
    };
    await expect(
      cleanupStorage(env.DB, failing, operation.key),
    ).rejects.toThrow();
    expect(await capacity()).toMatchObject({
      persistedBytes: 0,
      reservedBytes: 5,
    });
    await env.DB.prepare('UPDATE storage_objects SET updatedAt=0 WHERE key=?')
      .bind(operation.key)
      .run();
    await recoverStorage(env.DB, env.BUCKET);
    expect(await capacity()).toMatchObject({
      persistedBytes: 0,
      reservedBytes: 0,
    });
    expect(await env.BUCKET.head(operation.key)).toBeNull();
  });
  it('fences a paused writer before releasing its reservation', async () => {
    await limit(5);
    const operation = await writer();
    await operation.uploadPart(1, new TextEncoder().encode('bytes'));
    const row = await env.DB.prepare(
      'SELECT uploadId FROM storage_objects WHERE key=?',
    )
      .bind(operation.key)
      .first<{ uploadId: string }>();
    await env.DB.prepare('UPDATE storage_objects SET updatedAt=0 WHERE key=?')
      .bind(operation.key)
      .run();
    await recoverStorage(env.DB, env.BUCKET);
    await expect(
      env.BUCKET.resumeMultipartUpload(operation.key, row!.uploadId).uploadPart(
        2,
        new Uint8Array(5),
      ),
    ).rejects.toThrow();
    await expect(
      operation.uploadPart(2, new Uint8Array(5)),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCOUNTING_UNAVAILABLE' });
    await expect(
      env.DB.batch([operation.finalizeStatement()]),
    ).rejects.toThrow();
    expect(await capacity()).toMatchObject({
      persistedBytes: 0,
      reservedBytes: 0,
    });
  });
  it('preserves existing objects when lowering the limit and restores unlimited admission', async () => {
    await limit(png.length * 2);
    const first = await upload(request(), user, env);
    await limit(1);
    await expect(upload(request(), user, env)).rejects.toMatchObject({
      code: 'GLOBAL_STORAGE_LIMIT_EXCEEDED',
    });
    expect(
      await env.DB.prepare('SELECT id FROM images WHERE id=?')
        .bind(first.id)
        .first(),
    ).not.toBeNull();
    await limit(null);
    await upload(request(), user, env);
    expect(await capacity()).toMatchObject({
      persistedBytes: png.length * 2,
      reservedBytes: 0,
    });
  });
  it('protects generated and probe objects with the same budget', async () => {
    await limit(5);
    const { writer: operation } = await writeStoredObject(
      env.DB,
      env.BUCKET,
      id('preview'),
      'preview',
      new Uint8Array(5),
    );
    await env.DB.batch([operation.finalizeStatement()]);
    await expect(
      writeStoredObject(
        env.DB,
        env.BUCKET,
        id('probe'),
        'probe',
        new Uint8Array(1),
      ),
    ).rejects.toMatchObject({ code: 'GLOBAL_STORAGE_LIMIT_EXCEEDED' });
    const check = await checkDeliveryDomain(
      { id: 'domain', hostname: 'gallery.localhost', validationKey: 'test' },
      { ...env, ENVIRONMENT: 'development' },
    );
    expect(check).toMatchObject({ outcome: 'inconclusive', stage: 'storage' });
    expect(check.message).toContain('global storage limit');
    await deleteStoredObjects(env.DB, env.BUCKET, [operation.key]);
    expect(await capacity()).toMatchObject({
      persistedBytes: 0,
      reservedBytes: 0,
    });
  });
  it('charges a shared physical preview once and preserves it until the last active image is deleted', async () => {
    await limit(png.length * 2 + 5);
    const first = await upload(request(), user, env);
    const second = await upload(request(), user, env);
    const preview = await writeStoredObject(
      env.DB,
      env.BUCKET,
      id('shared'),
      'preview',
      new Uint8Array(5),
      first.id,
      user.id,
    );
    await env.DB.batch([
      preview.writer.finalizeStatement(),
      env.DB.prepare(
        'UPDATE images SET previewKey=?,previewSize=5 WHERE id IN (?,?)',
      ).bind(preview.writer.key, first.id, second.id),
    ]);
    expect(await capacity()).toMatchObject({
      persistedBytes: png.length * 2 + 5,
    });
    await deleteImage(env.DB, env.BUCKET, first.id, user.id);
    expect(await env.BUCKET.head(preview.writer.key)).not.toBeNull();
    expect(await capacity()).toMatchObject({ persistedBytes: png.length + 5 });
    await deleteImage(env.DB, env.BUCKET, second.id, user.id);
    expect(await env.BUCKET.head(preview.writer.key)).toBeNull();
    expect(await capacity()).toMatchObject({
      persistedBytes: 0,
      reservedBytes: 0,
    });
  });
  it('reclaims pending receipts only after terminal multipart cleanup and fences their old token', async () => {
    await limit(5);
    const key = id('interrupted');
    const token = await beginStorage(
      env.DB,
      key,
      'original',
      null,
      user.id,
      'pending-receipt',
    );
    const oldWriter = new StorageWriter(env.DB, env.BUCKET, key, token!);
    await oldWriter.uploadPart(1, new Uint8Array(5));
    await env.DB.prepare('UPDATE storage_objects SET updatedAt=0 WHERE key=?')
      .bind(key)
      .run();
    await recoverStorage(env.DB, env.BUCKET);
    expect(
      await env.DB.prepare(
        "SELECT key FROM upload_receipts WHERE key='pending-receipt'",
      ).first(),
    ).toBeNull();
    const replacement = await beginStorage(
      env.DB,
      key,
      'original',
      null,
      user.id,
      'pending-receipt',
    );
    expect(replacement).not.toBeNull();
    await expect(
      oldWriter.uploadPart(2, new Uint8Array(5)),
    ).rejects.toMatchObject({ code: 'STORAGE_ACCOUNTING_UNAVAILABLE' });
    expect(await capacity()).toMatchObject({
      persistedBytes: 0,
      reservedBytes: 0,
    });
  });
  it('releases a missing preview charge after physical verification despite its stale active reference', async () => {
    await limit(png.length + 5);
    const image = await upload(request(), user, env);
    const preview = await writeStoredObject(
      env.DB,
      env.BUCKET,
      id('missingpreview'),
      'preview',
      new Uint8Array(5),
      image.id,
      user.id,
    );
    await env.DB.batch([
      preview.writer.finalizeStatement(),
      env.DB.prepare(
        'UPDATE images SET previewKey=?,previewSize=5 WHERE id=?',
      ).bind(preview.writer.key, image.id),
    ]);
    await env.BUCKET.delete(preview.writer.key);
    await deleteStoredObjects(env.DB, env.BUCKET, [preview.writer.key]);
    expect(await capacity()).toMatchObject({
      persistedBytes: png.length,
      reservedBytes: 0,
    });
  });
  it('accounts discovered files conservatively and never derives counters from scan totals', async () => {
    await env.BUCKET.put('existing-file', 'existing');
    await env.DB.prepare(
      'UPDATE storage_capacity SET multipartVerified=1 WHERE id=1',
    ).run();
    const run = id('rec');
    await env.DB.prepare(
      "INSERT INTO reconciliation_runs(id,status,startedAt) VALUES(?,'running',?)",
    )
      .bind(run, now())
      .run();
    await scanStorage(env.DB, env.BUCKET, run);
    await scanStorage(env.DB, env.BUCKET, run);
    expect(await capacity()).toMatchObject({
      persistedBytes: 8,
      reservedBytes: 0,
    });
    expect(
      await env.DB.prepare(
        'SELECT ready FROM storage_capacity WHERE id=1',
      ).first(),
    ).toEqual({ ready: 1 });
    expect(await env.BUCKET.head('existing-file')).not.toBeNull();
    await scanStorage(env.DB, env.BUCKET, run);
    expect(await capacity()).toMatchObject({ persistedBytes: 8 });
  });
  it('fails closed until capped storage has a verified baseline', async () => {
    await env.DB.prepare(
      'UPDATE storage_capacity SET limitBytes=1000 WHERE id=1',
    ).run();
    await expect(upload(request(), user, env)).rejects.toMatchObject({
      code: 'STORAGE_ACCOUNTING_UNAVAILABLE',
    });
    expect((await env.BUCKET.list()).objects).toEqual([]);
  });
  it('keeps unfinished reservations after an ambiguous abort and retries cleanup', async () => {
    await limit(5);
    const operation = await writer();
    await operation.uploadPart(1, new Uint8Array(5));
    await expect(
      cleanupStorage(
        env.DB,
        {
          head: env.BUCKET.head.bind(env.BUCKET),
          delete: env.BUCKET.delete.bind(env.BUCKET),
          resumeMultipartUpload: () => ({
            abort: () => Promise.reject(new Error('timeout')),
          }),
        },
        operation.key,
      ),
    ).rejects.toThrow();
    expect(await capacity()).toMatchObject({ reservedBytes: 5 });
    await operation.cleanup();
    expect(await capacity()).toMatchObject({ reservedBytes: 0 });
  });
  it('records failed scans and preserves their cursor for retry', async () => {
    const run = id('rec');
    await env.DB.prepare(
      "INSERT INTO reconciliation_runs(id,status,startedAt,cursor) VALUES(?,'running',?,'saved-cursor')",
    )
      .bind(run, now())
      .run();
    const bucket = {
      ...env.BUCKET,
      list: vi.fn(() => Promise.reject(new Error('R2 outage'))),
    };
    await expect(scanStorage(env.DB, bucket, run)).rejects.toThrow('R2 outage');
    expect(
      await env.DB.prepare(
        'SELECT status,cursor FROM reconciliation_runs WHERE id=?',
      )
        .bind(run)
        .first(),
    ).toEqual({ status: 'failed', cursor: 'saved-cursor' });
  });
  it.each(['physical-size', 'ledger'])(
    'detects %s discrepancies, retains conservative charges, and closes admission',
    async (kind) => {
      await limit(1000);
      const image = await upload(request(), user, env);
      const record = await env.DB.prepare(
        'SELECT objectKey FROM images WHERE id=?',
      )
        .bind(image.id)
        .first<{ objectKey: string }>();
      if (kind === 'physical-size')
        await env.BUCKET.put(record!.objectKey, new Uint8Array(png.length + 1));
      else
        await env.DB.prepare(
          'UPDATE storage_capacity SET persistedBytes=999 WHERE id=1',
        ).run();
      const run = id('rec');
      await env.DB.prepare(
        "INSERT INTO reconciliation_runs(id,status,startedAt) VALUES(?,'running',?)",
      )
        .bind(run, now())
        .run();
      await scanStorage(env.DB, env.BUCKET, run);
      await scanStorage(env.DB, env.BUCKET, run);
      expect(await capacity()).toMatchObject({
        blocked: 1,
        persistedBytes: kind === 'physical-size' ? png.length + 1 : 999,
      });
      expect(
        await env.DB.prepare(
          'SELECT kind FROM reconciliation_findings WHERE kind=?',
        )
          .bind(kind)
          .first(),
      ).toEqual({ kind });
      await expect(upload(request(), user, env)).rejects.toMatchObject({
        code: 'STORAGE_ACCOUNTING_UNAVAILABLE',
      });
    },
  );
  it('resumes overlapping scan pages without duplicate observations, accounting, findings, or completion events', async () => {
    const bucket = {
      ...env.BUCKET,
      head: env.BUCKET.head.bind(env.BUCKET),
      list: (options?: R2ListOptions) =>
        env.BUCKET.list({ ...options, limit: 2 }),
    };
    await Promise.all(
      Array.from({ length: 3 }, (_, index) =>
        env.BUCKET.put(`baseline-${String(index).padStart(3, '0')}`, 'x'),
      ),
    );
    await env.DB.prepare(
      'UPDATE storage_capacity SET multipartVerified=1 WHERE id=1',
    ).run();
    const run = id('rec');
    await env.DB.prepare(
      "INSERT INTO reconciliation_runs(id,status,startedAt) VALUES(?,'running',?)",
    )
      .bind(run, now())
      .run();
    await Promise.all([
      scanStorage(env.DB, bucket, run),
      scanStorage(env.DB, bucket, run),
    ]);
    expect(
      await env.DB.prepare(
        'SELECT objectCount,status FROM reconciliation_runs WHERE id=?',
      )
        .bind(run)
        .first(),
    ).toEqual({ objectCount: 2, status: 'running' });
    await scanStorage(env.DB, bucket, run);
    await Promise.all([
      scanStorage(env.DB, bucket, run),
      scanStorage(env.DB, bucket, run),
    ]);
    await Promise.all([
      scanStorage(env.DB, bucket, run),
      scanStorage(env.DB, bucket, run),
    ]);
    expect(
      await env.DB.prepare(
        'SELECT objectCount,bytes,status FROM reconciliation_runs WHERE id=?',
      )
        .bind(run)
        .first(),
    ).toEqual({ objectCount: 3, bytes: 3, status: 'completed' });
    expect(await capacity()).toMatchObject({
      persistedBytes: 3,
      reservedBytes: 0,
    });
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count FROM reconciliation_findings',
      ).first(),
    ).toEqual({ count: 3 });
    expect(
      await env.DB.prepare(
        "SELECT count(*) AS count FROM audit_log WHERE action='storage.reconciliation_completed'",
      ).first(),
    ).toEqual({ count: 1 });
  });
});
