import { watch } from 'node:fs';
import { access } from 'node:fs/promises';
import path from 'node:path';

import type { WorkerdStructuredLog } from 'miniflare';
import { unstable_DevEnv } from 'wrangler';

import {
  type Component,
  persistence,
  readDevelopmentConfig,
  type ServerMode,
} from './development-config';
import { createCron, startScheduler } from './development-scheduler';

const component = process.argv[2] as Component;
const mode = process.argv[3] as ServerMode;
let stop: (() => Promise<void>) | undefined;
let scheduler: ReturnType<typeof startScheduler> | undefined;
let cronWatcher: ReturnType<typeof watch> | undefined;
let cronUpdate = Promise.resolve();
let stopping = false;

async function shutdown(code = 0) {
  if (stopping) return;
  stopping = true;
  try {
    cronWatcher?.close();
    await cronUpdate;
    await scheduler?.stop();
    await stop?.();
  } catch (error) {
    console.error(error);
    code = 1;
  }
  // Wrangler's platform proxy is owned by the web process. workerd's native
  // exit hook closes its subprocess after Vite has drained HTTP connections.
  process.exit(code);
}
process.on('message', (message) => {
  if (message === 'shutdown') void shutdown();
  else if (message === 'maintenance' && !stopping) {
    void cronUpdate.then(() => {
      if (!stopping) void scheduler?.run();
    });
  }
});
process.on('disconnect', () => void shutdown());
process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());

try {
  const config = await readDevelopmentConfig(component);
  if (component === 'web' && mode === 'development') {
    process.chdir(config.directory);
    const { startWeb } = await import('../apps/web/development');
    const server = await startWeb(config.dev.port);
    stop = () => server.close();
    if (stopping) await shutdown();
    const response = await fetch(`http://127.0.0.1:${config.dev.port}/login`);
    if (!response.ok)
      throw new Error(
        `Web returned HTTP ${response.status}. Check bindings and run pnpm db:migrate.`,
      );
    await response.body?.cancel();
  } else {
    if (component === 'web') {
      try {
        await access(path.resolve(config.directory, config.main));
      } catch {
        throw new Error(
          'Built web Worker is missing. Run pnpm build before pnpm preview.',
        );
      }
    }
    const runtime = new unstable_DevEnv();
    stop = () => runtime.teardown();
    let ready = false;
    const startupFailure = new Promise<never>((_resolve, reject) => {
      runtime.on('error', (error: unknown) => {
        console.error('Worker runtime failed:', error);
        if (ready) void shutdown(1);
        else
          reject(
            new Error('Worker runtime failed during startup.', {
              cause: error,
            }),
          );
      });
      runtime.on('buildFailed', () => {
        if (!ready)
          reject(
            new Error(
              'Worker build failed. Fix the errors above and restart the server.',
            ),
          );
      });
    });
    const worker = await runtime.startWorker({
      config: config.config,
      dev: {
        server: { hostname: '127.0.0.1', port: config.dev.port },
        persist: persistence,
        remote: false,
        inspector: false,
        watch: true,
        logLevel: 'info',
        generateTypes: false,
        testScheduled: component === 'maintenance',
        structuredLogsHandler: (log: WorkerdStructuredLog) => {
          if (log.level === 'error') console.error(log.message);
          else if (log.level === 'warn') console.warn(`[warn] ${log.message}`);
          else console.log(log.message);
        },
      },
    });
    await Promise.race([worker.ready, startupFailure]);
    ready = true;
    const workerUrl = await worker.url;
    const endpoint = workerUrl.origin;
    if (component === 'web') {
      const response = await fetch(`${endpoint}/login`);
      await response.body?.cancel();
      if (!response.ok)
        throw new Error(
          `Web returned HTTP ${response.status}. Check bindings and run pnpm db:migrate.`,
        );
    } else if (component === 'maintenance') {
      scheduler = startScheduler(config.triggers!.crons, endpoint);
      cronWatcher = watch(config.directory, (_event, filename) => {
        if (filename !== 'wrangler.jsonc' || stopping) return;
        const previousUpdate = cronUpdate;
        cronUpdate = (async () => {
          try {
            await previousUpdate;
            const updated = await readDevelopmentConfig('maintenance');
            for (const cron of updated.triggers!.crons) createCron(cron).stop();
            await scheduler?.stop();
            if (!stopping)
              scheduler = startScheduler(updated.triggers!.crons, endpoint);
          } catch (error) {
            console.error(
              'Unable to reload maintenance cron configuration:',
              error,
            );
          }
        })();
      });
    }
    runtime.on('teardown', () => {
      if (stopping) {
        return;
      }

      console.error('Worker runtime stopped unexpectedly.');
      void shutdown(1);
    });
  }
  if (stopping) {
    await scheduler?.stop();
    await stop?.();
    process.exit(0);
  }
  process.send?.('ready');
} catch (error) {
  console.error(error);
  await shutdown(1);
}
