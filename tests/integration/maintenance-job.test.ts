/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed binding operations. */
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { createUser } from '../../packages/core/auth';
import { id, now } from '../../packages/core/common';
import { migrateDatabase } from '../helpers/database';
import { workerBundle, workerCompatibility } from '../helpers/workers';

let runtime: Miniflare;
let DB: D1Database;
let bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
let runId: string;

beforeEach(async () => {
  const shared = {
    ...workerCompatibility('maintenance'),
    modules: true,
    d1Databases: { DB: 'maintenance-job-db' },
    r2Buckets: { BUCKET: 'maintenance-job-bucket' },
  };
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      workers: [
        {
          name: 'caller',
          ...shared,
          durableObjects: {
            MAINTENANCE: {
              className: 'TestMaintenanceJob',
              scriptName: 'maintenance',
              useSQLite: true,
            },
          },
          script: `export default {
            async fetch(request, env) {
              const stub=env.MAINTENANCE.getByName('instance');
              const command=new URL(request.url).pathname.slice(1);
              if(command==='status') return Response.json(await stub.status());
              if(command==='alarm') return Response.json(await stub.recoveryAlarm());
              if(command==='pause'||command==='resume') await stub.control(command==='pause');
              if(command==='fault') await stub.fault(await request.text());
              if(command==='poke') await stub.poke();
              if(command==='wake') await stub.wake();
              if(command==='start') await stub.start(await request.text());
              return new Response('started');
            }
          }`,
        },
        {
          name: 'maintenance',
          ...shared,
          scriptPath: workerBundle('maintenance-fault'),
          durableObjects: {
            MAINTENANCE: { className: 'TestMaintenanceJob', useSQLite: true },
          },
        },
      ],
    }),
  );
  DB = await runtime.getD1Database('DB', 'caller');
  bucket = await runtime.getR2Bucket('BUCKET', 'caller');
  await migrateDatabase(DB);
  runId = id('rec');
  await DB.prepare(
    "INSERT INTO reconciliation_runs(id,status,startedAt) VALUES(?,'running',?)",
  )
    .bind(runId, now())
    .run();
});

afterEach(async () => {
  await runtime?.dispose();
});

function start() {
  return command('start', runId);
}

async function completed() {
  await vi.waitFor(
    async () => {
      expect(
        await DB.prepare('SELECT status FROM reconciliation_runs WHERE id=?')
          .bind(runId)
          .first(),
      ).toEqual({ status: 'completed' });
    },
    { timeout: 15_000, interval: 100 },
  );
}

async function command(name: string, body = '') {
  return runtime.dispatchFetch(`https://caller.test/${name}`, {
    method: 'POST',
    body,
  });
}
async function status() {
  const result = await (await command('status')).json();
  return result as {
    status: string;
    stage: string;
    failures: number;
  };
}

it('honors pause with pending alarms and cron wakeups, drains, and resumes the same scan', async () => {
  await command('pause');
  await Promise.all([start(), command('wake'), start()]);
  expect((await status()).status).toBe('drained');
  expect(
    await DB.prepare('SELECT objectCount FROM reconciliation_runs WHERE id=?')
      .bind(runId)
      .first(),
  ).toEqual({ objectCount: 0 });
  expect(await (await command('alarm')).json()).toBeNull();
  await command('resume');
  await completed();
  await command('pause');
  expect((await status()).status).toBe('drained');
});

it('automatically retries temporary R2 failure and survives D1 outages independently of native alarm retries', async () => {
  await command('fault', 'storage');
  await start();
  await vi.waitFor(
    async () => expect((await status()).status).toBe('retrying'),
    { timeout: 10_000 },
  );
  expect(
    await DB.prepare('SELECT status,cursor FROM reconciliation_runs WHERE id=?')
      .bind(runId)
      .first(),
  ).toEqual({ status: 'running', cursor: null });
  await completed();
  await command('pause');
  await DB.prepare(
    "UPDATE reconciliation_runs SET status='running',attempt=attempt+1,phase='objects',cursor=NULL,metadataCursor=NULL WHERE id=?",
  )
    .bind(runId)
    .run();
  await command('fault', 'database');
  await command('resume');
  for (let failures = 1; failures <= 24; failures++) {
    await vi.waitFor(
      async () =>
        expect((await status()).failures).toBeGreaterThanOrEqual(failures),
      { timeout: 10_000 },
    );
    if (failures < 24) await command('poke');
  }
  expect((await status()).status).toBe('failed');
  expect(await (await command('alarm')).json()).toBeGreaterThan(Date.now());
  await command('fault', '');
  await command('poke');
  await vi.waitFor(
    async () =>
      expect(
        await DB.prepare('SELECT status FROM reconciliation_runs WHERE id=?')
          .bind(runId)
          .first(),
      ).toEqual({ status: 'failed' }),
    { timeout: 10_000 },
  );
  await DB.prepare(
    "UPDATE reconciliation_runs SET status='running',attempt=attempt+1,error=NULL WHERE id=?",
  )
    .bind(runId)
    .run();
  await start();
  await completed();
  expect(
    await DB.prepare(
      "SELECT count(*) AS count FROM audit_log WHERE action='storage.reconciliation_completed' AND targetId=?",
    )
      .bind(runId)
      .first(),
  ).toEqual({ count: 2 });
});

it('reclaims its own lease after release fails', async () => {
  await command('fault', 'release');
  await start();
  await vi.waitFor(
    async () => expect((await status()).status).toBe('retrying'),
    { timeout: 10_000 },
  );
  expect(
    await DB.prepare('SELECT count(*) AS count FROM maintenance_lock').first(),
  ).toEqual({ count: 1 });
  await completed();
  await command('pause');
  expect(
    await DB.prepare('SELECT count(*) AS count FROM maintenance_lock').first(),
  ).toEqual({ count: 0 });
});

it('retains committed progress when the continuation alarm fails and duplicate deliveries arrive', async () => {
  await command('pause');
  await DB.prepare(
    'UPDATE reconciliation_runs SET routineDone=attempt WHERE id=?',
  )
    .bind(runId)
    .run();
  await bucket.put('orphan', 'keep');
  // Fault only the next prompt continuation, after a D1 page checkpoint.
  await command('fault', 'schedule');
  await command('resume');
  await start();
  await vi.waitFor(
    async () => expect((await status()).status).toBe('retrying'),
    { timeout: 10_000 },
  );
  expect(
    await DB.prepare('SELECT objectCount FROM reconciliation_runs WHERE id=?')
      .bind(runId)
      .first(),
  ).toEqual({ objectCount: 1 });
  await completed();
  await Promise.all([start(), command('wake'), start()]);
  expect(
    await DB.prepare(
      "SELECT count(*) AS count FROM audit_log WHERE action='storage.reconciliation_completed' AND targetId=?",
    )
      .bind(runId)
      .first(),
  ).toEqual({ count: 1 });
  expect(await bucket.head('orphan')).not.toBeNull();
});

it('runs full maintenance and completes multiple scan pages after the caller returns, without cron', async () => {
  const owner = await createUser(DB, 'Owner', 'admin', null);
  await DB.prepare(
    "INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt,expiresAt) VALUES('expired',?,'expired','expired.png','image/png','png',4,'hash',1,1,1,2)",
  )
    .bind(owner.userId)
    .run();
  await bucket.put('expired', 'test');
  await Promise.all(
    Array.from({ length: 105 }, (_, index) =>
      bucket.put(`orphan-${String(index).padStart(3, '0')}`, 'keep'),
    ),
  );
  await start();
  await completed();
  expect(await bucket.head('expired')).toBeNull();
  const expired = await DB.prepare(
    "SELECT purgedAt FROM images WHERE id='expired'",
  ).first<{ purgedAt: number }>();
  expect(expired?.purgedAt).toBeGreaterThan(0);
  expect(
    await DB.prepare(
      'SELECT objectCount,bytes FROM reconciliation_runs WHERE id=?',
    )
      .bind(runId)
      .first(),
  ).toEqual({ objectCount: 105, bytes: 420 });
  expect(
    await DB.prepare(
      'SELECT count(*) AS count FROM reconciliation_findings WHERE runId=?',
    )
      .bind(runId)
      .first(),
  ).toEqual({ count: 105 });
  expect((await bucket.list()).objects).toHaveLength(105);
});

it('waits for the cron lease, coalesces duplicate starts, and resumes without cron', async () => {
  await DB.prepare(
    "INSERT INTO maintenance_lock(id,holder,expiresAt) VALUES('cron','other',?)",
  )
    .bind(now() + 60)
    .run();
  await Promise.all([start(), start()]);
  await vi.waitFor(
    async () =>
      expect(await status()).toMatchObject({
        stage: 'waiting-for-lease',
        status: 'running',
      }),
    { timeout: 10_000 },
  );
  expect(
    await DB.prepare('SELECT phase FROM reconciliation_runs WHERE id=?')
      .bind(runId)
      .first(),
  ).toEqual({ phase: 'objects' });
  await DB.prepare("DELETE FROM maintenance_lock WHERE holder='other'").run();
  await completed();
  expect(
    await DB.prepare('SELECT count(*) AS count FROM maintenance_lock').first(),
  ).toEqual({ count: 0 });
  expect(
    await DB.prepare(
      "SELECT count(*) AS count FROM audit_log WHERE action='storage.reconciliation_completed'",
    ).first(),
  ).toEqual({ count: 1 });
});
