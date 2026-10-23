import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { expect, it, vi } from 'vitest';
import { getPlatformProxy, unstable_DevEnv } from 'wrangler';

import { readDevelopmentConfig } from '../../cli/development/config';
import { database } from '../../packages/core/db';
import { saveDeliveryDomain } from '../../packages/core/delivery-domains';
import { validateDeliveryDomain } from '../../packages/core/domain-validation';
import type { Env } from '../../packages/core/env';
import { users } from '../../packages/core/schema';
import { migrateDatabase } from '../helpers/database';

it('dispatches the real scheduled handler against shared persistent D1 and R2, respects its lease, and survives restart', async () => {
  const state = await mkdtemp(path.join(tmpdir(), 'hearth-dev-maintenance-'));
  const registry = path.join(state, 'registry');
  vi.stubEnv('WRANGLER_REGISTRY_PATH', registry);
  const config = await readDevelopmentConfig('maintenance');
  const webConfig = await readDevelopmentConfig('web');
  const instance = `maintenance-test-${crypto.randomUUID()}`;
  async function localConfig(component: 'web' | 'maintenance' | 'delivery') {
    const config = await readDevelopmentConfig(component);
    const source: Record<string, unknown> = {
      ...config.source,
      name: `${instance}-${component}`,
      main: path.join(config.directory, String(config.source.main)),
    };
    if (component === 'web') {
      delete source.assets;
      source.durable_objects = {
        bindings: [
          {
            name: 'MAINTENANCE',
            class_name: 'MaintenanceJob',
            script_name: `${instance}-maintenance`,
          },
        ],
      };
    }
    const file = path.join(state, `${component}.json`);
    await writeFile(file, JSON.stringify(source));
    return file;
  }
  const webFile = await localConfig('web');
  const maintenanceFile = await localConfig('maintenance');
  const deliveryFile = await localConfig('delivery');
  const proxy = await getPlatformProxy<
    Pick<Env, 'DB' | 'BUCKET' | 'MAINTENANCE'>
  >({
    configPath: webFile,
    persist: { path: path.join(state, 'v3') },
    remoteBindings: false,
  });
  let worker: Awaited<ReturnType<unstable_DevEnv['startWorker']>> | undefined;
  let delivery: Awaited<ReturnType<unstable_DevEnv['startWorker']>> | undefined;
  try {
    const { DB, BUCKET } = proxy.env;
    await migrateDatabase(DB);
    await DB.prepare(
      "INSERT INTO users(id,displayName,role,createdAt,updatedAt) VALUES('maintenance-test','Test','admin',1,1)",
    ).run();
    await DB.prepare(
      "INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt,expiresAt) VALUES('expired','maintenance-test','original','expired.png','image/png','png',4,'hash',1,1,1,2)",
    ).run();
    await BUCKET.put('original', 'test');
    await BUCKET.put('retained', 'keep');
    const deliveryRuntime = new unstable_DevEnv();
    delivery = await deliveryRuntime.startWorker({
      config: deliveryFile,
      dev: {
        registry,
        persist: state,
        remote: false,
        inspector: false,
        server: { hostname: '127.0.0.1', port: 0 },
        logLevel: 'error',
        watch: false,
        generateTypes: false,
      },
    });
    await delivery.ready;
    const deliveryUrl = await delivery.url;
    const environment = {
      DB,
      BUCKET,
      ENVIRONMENT: 'development',
      APP_ORIGIN: webConfig.vars.APP_ORIGIN,
      LOCAL_DELIVERY_PORT: deliveryUrl.port,
    };
    const [admin] = await database(DB).select().from(users);
    const domain = await saveDeliveryDomain(
      DB,
      admin,
      { hostname: 'shots.localhost', accessMode: 'everyone' },
      environment,
    );
    const validated = await validateDeliveryDomain(
      environment,
      admin,
      domain.id,
    );
    expect(validated.health).toBe('active');
    const start = async () => {
      const runtime = new unstable_DevEnv();
      const started = await runtime.startWorker({
        config: maintenanceFile,
        dev: {
          registry,
          persist: state,
          remote: false,
          inspector: false,
          server: { hostname: '127.0.0.1', port: 0 },
          logLevel: 'error',
          watch: false,
          testScheduled: true,
          generateTypes: false,
        },
      });
      await started.ready;
      return started;
    };
    const trigger = async () => {
      const url = await worker!.url;
      const result = await worker!.fetch(
        `${url.origin}/cdn-cgi/local/scheduled?format=json&cron=${encodeURIComponent(config.triggers!.crons[0])}`,
      );
      expect(await result.json()).toEqual({ outcome: 'ok', noRetry: false });
    };
    await DB.prepare(
      "INSERT INTO maintenance_lock(id,holder,expiresAt) VALUES('cron','test',?)",
    )
      .bind(Math.floor(Date.now() / 1000) + 60)
      .run();
    worker = await start();
    await trigger();
    expect(await BUCKET.head('original')).not.toBeNull();
    const dispatcher = await getPlatformProxy<Pick<Env, 'MAINTENANCE'>>({
      configPath: webFile,
      persist: { path: path.join(state, 'v3') },
      remoteBindings: false,
    });
    try {
      await dispatcher.env.MAINTENANCE.getByName('instance').control(true);
      await DB.prepare(
        "DELETE FROM maintenance_lock WHERE holder='test'",
      ).run();
      await dispatcher.env.MAINTENANCE.getByName('instance').control(false);
      await trigger();
      await vi.waitFor(
        async () => expect(await BUCKET.head('original')).toBeNull(),
        { timeout: 15_000, interval: 100 },
      );
      await vi.waitFor(
        async () =>
          expect(
            await DB.prepare(
              'SELECT count(*) AS count FROM storage_snapshots',
            ).first(),
          ).toEqual({ count: 1 }),
        { timeout: 15_000, interval: 100 },
      );
      await vi.waitFor(
        async () =>
          expect(
            await DB.prepare(
              "SELECT count(*) AS count FROM reconciliation_runs WHERE status='running'",
            ).first(),
          ).toEqual({ count: 0 }),
        { timeout: 15_000, interval: 100 },
      );
      await dispatcher.env.MAINTENANCE.getByName('instance').control(true);
      const expired = await DB.prepare(
        "SELECT deletedAt,purgedAt FROM images WHERE id='expired'",
      ).first<{ deletedAt: number; purgedAt: number }>();
      expect(expired?.deletedAt).toBeGreaterThan(0);
      expect(expired?.purgedAt).toBeGreaterThan(0);
      expect(await BUCKET.head('original')).toBeNull();
      expect(await BUCKET.head('retained')).not.toBeNull();
      expect(
        await DB.prepare(
          'SELECT count(*) AS count FROM storage_snapshots',
        ).first(),
      ).toEqual({ count: 1 });
    } finally {
      await dispatcher.dispose();
    }
    await worker.dispose();
    worker = await start();
    await trigger();
    const resumed = await getPlatformProxy<Pick<Env, 'MAINTENANCE'>>({
      configPath: webFile,
      persist: { path: path.join(state, 'v3') },
      remoteBindings: false,
    });
    try {
      await vi.waitFor(
        async () => {
          const resumedStatus =
            await resumed.env.MAINTENANCE.getByName('instance').status();
          expect(resumedStatus.status).toBe('drained');
        },
        { timeout: 15_000, interval: 100 },
      );
      await resumed.env.MAINTENANCE.getByName('instance').control(false);
    } finally {
      await resumed.dispose();
    }
    await trigger();
    expect(await BUCKET.head('retained')).not.toBeNull();
    await vi.waitFor(
      async () =>
        expect(
          await DB.prepare(
            'SELECT count(*) AS count FROM maintenance_lock',
          ).first(),
        ).toEqual({ count: 0 }),
      { timeout: 15_000, interval: 100 },
    );
  } finally {
    await worker?.dispose();
    await delivery?.dispose();
    await proxy.dispose();
    await rm(state, { recursive: true, force: true });
  }
}, 60_000);
