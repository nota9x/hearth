/* eslint-disable playwright/no-conditional-in-test -- Check the disposable directory before recursive cleanup. */
/* eslint-disable unicorn/no-await-expression-member -- Poll native HTTP responses directly in runtime assertions. */
import { cp, mkdtemp, rm, symlink } from 'node:fs/promises';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { execa } from 'execa';
import { getPlatformProxy } from 'wrangler';

import { portAvailable } from '../../cli/development/ports';
import { expect, test } from '../helpers/browser';
import { migrateDatabase } from '../helpers/database';

test('native CLI runtimes preserve local state and release their ports', async () => {
  test.setTimeout(180_000);
  const root = process.cwd();
  const destination = await mkdtemp(path.join(tmpdir(), 'hearth cli-'));
  const ports = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const server = createServer();
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const address = server.address();
      if (!address || typeof address === 'string')
        throw new Error('Missing test listener');
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return address.port;
    }),
  );
  const origin = `http://127.0.0.1:${ports[0]}`;
  try {
    for (const relative of [
      'cli',
      'scripts/cli.mjs',
      'package.json',
      'tsconfig.json',
      'pnpm-workspace.yaml',
      'apps/web',
      'workers',
      'packages/core',
    ]) {
      await cp(path.join(root, relative), path.join(destination, relative), {
        recursive: true,
        filter: (source) =>
          !['node_modules', '.wrangler'].includes(path.basename(source)) &&
          !/^(?:hearth-.*\.local\.jsonc|production\.local\.jsonc|\.dev\.vars.*|\.env.*)$/.test(
            path.basename(source),
          ),
      });
    }
    for (const relative of ['node_modules', 'apps/web/node_modules'])
      await symlink(
        path.join(root, relative),
        path.join(destination, relative),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    const state = path.join(destination, 'apps/web/.wrangler/state/v3');
    const proxy = await getPlatformProxy<{ DB: D1Database; BUCKET: R2Bucket }>({
      configPath: path.join(destination, 'apps/web/wrangler.jsonc'),
      persist: { path: state },
      remoteBindings: false,
    });
    try {
      await migrateDatabase(proxy.env.DB);
      await proxy.env.DB.prepare(
        "INSERT INTO users(id,displayName,role,createdAt,updatedAt) VALUES('cli-test','CLI test','admin',1,1)",
      ).run();
      await proxy.env.BUCKET.put('cli-retained', 'retained across restarts');
    } finally {
      await proxy.dispose();
    }
    for (const mode of ['dev', 'preview']) {
      let output = '';
      const child = execa(
        process.execPath,
        [
          '--import',
          pathToFileURL(path.join(root, 'tests/fixtures/cli-control.mjs')).href,
          path.join(destination, 'scripts/cli.mjs'),
          mode,
          '--web-port',
          String(ports[0]),
          '--delivery-port',
          String(ports[1]),
          '--maintenance-port',
          String(ports[2]),
        ],
        {
          cwd: destination,
          env: { NO_COLOR: '1', WRANGLER_SEND_METRICS: 'false' },
          ipc: true,
          all: true,
          reject: false,
          killDescendants: true,
        },
      );
      child.all.on('data', (chunk: Buffer) => {
        output += chunk.toString();
      });
      try {
        await expect
          .poll(() => output, {
            timeout: 75_000,
            message: 'CLI services should become ready',
          })
          .toContain('All services ready');
        expect((await fetch(`${origin}/login`)).status, output).toBe(200);
        const scheduled = await fetch(
          `http://127.0.0.1:${ports[2]}/cdn-cgi/local/scheduled?format=json&cron=*/5%20*%20*%20*%20*`,
        );
        expect(await scheduled.json()).toMatchObject({
          outcome: 'ok',
        });
      } finally {
        try {
          await child.sendMessage('stop');
        } catch {
          /*
          An exited child is checked below.
          */
        }
        const timeout = setTimeout(() => child.kill(), 20_000);
        const result = await child;
        clearTimeout(timeout);
        expect(result.exitCode, output).toBe(0);
      }
      for (const port of ports)
        expect(await portAvailable(port), output).toBe(true);
    }
    const reopened = await getPlatformProxy<{
      DB: D1Database;
      BUCKET: R2Bucket;
    }>({
      configPath: path.join(destination, 'apps/web/wrangler.jsonc'),
      persist: { path: state },
      remoteBindings: false,
    });
    try {
      // eslint-disable-next-line playwright/no-useless-await -- D1 first() returns a promise, unlike Locator.first().
      const administrator = await reopened.env.DB.prepare(
        "SELECT displayName FROM users WHERE id='cli-test'",
      ).first();
      expect(administrator).toEqual({ displayName: 'CLI test' });
      expect(
        await (await reopened.env.BUCKET.get('cli-retained'))?.text(),
      ).toBe('retained across restarts');
    } finally {
      await reopened.dispose();
    }
  } finally {
    // Remove only the disposable directory allocated by this test.
    if (
      path.dirname(destination) === path.resolve(tmpdir()) &&
      path.basename(destination).startsWith('hearth cli-')
    ) {
      await rm(destination, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 200,
      });
    } else {
      console.error('Unexpected CLI test directory; preserving it.');
    }
  }
});
