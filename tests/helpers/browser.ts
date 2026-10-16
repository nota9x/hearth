import { spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { test as base } from '@playwright/test';
import {
  convertV4MiniflareOptions,
  fetch as localFetch,
  Miniflare,
  Response as LocalResponse,
  type V4FetchHandler,
} from 'miniflare';
import ts from 'typescript';
import { unstable_getMiniflareWorkerOptions } from 'wrangler';

import { createUser } from '../../packages/core/auth';
import { migrateDatabase } from './database';

type AccountMode = 'established' | 'new' | 'bootstrap';

async function start(accountMode: AccountMode) {
  const root = process.cwd();
  const destination = await mkdtemp(nodePath.join(tmpdir(), 'hearth-browser-'));

  interface TestConfig {
    $schema: string;
    main: string;
    assets?: { directory: string };
    vars: Record<string, string>;
    d1_databases: {
      database_name: string;
      database_id: string;
      migrations_dir: string;
    }[];
    r2_buckets: { bucket_name: string }[];
    ratelimits: { simple: { limit: number } }[];
  }

  function serve(name: string) {
    // Drain HTTP request bodies before dispatch: Miniflare's native dev transport
    // resets early-rejected uploads instead of delivering the Worker's response.
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- This HTTP callback handles its own dispatch failures.
    const server = createServer(async (request, response) => {
      try {
        const chunks: Buffer[] = [];
        for await (const chunk of request) chunks.push(chunk as Buffer);
        const headers = Object.fromEntries(
          Object.entries(request.headers).flatMap(([name, value]) =>
            value === undefined
              ? []
              : [[name, Array.isArray(value) ? value.join(', ') : value]],
          ),
        );
        const result = await (name === 'web' ? web : delivery).dispatchFetch(
          `http://${request.headers.host}${request.url}`,
          {
            method: request.method,
            redirect: 'manual',
            headers,
            body: ['GET', 'HEAD'].includes(request.method!)
              ? undefined
              : Buffer.concat(chunks),
          },
        );
        const outgoing = Object.fromEntries(result.headers);
        delete outgoing['set-cookie'];
        let body = Buffer.from(await result.arrayBuffer());
        if (
          name === 'web' &&
          result.headers.get('Content-Type')?.includes('text/html')
        ) {
          // Local widget success fixture; no external browser challenge is loaded.
          const nonce = result.headers
            .get('Content-Security-Policy')
            ?.match(/'nonce-([^']+)'/)?.[1];
          const widget = `<script${nonce ? ` nonce="${nonce}"` : ''}>window.turnstile={render(element,options){queueMicrotask(()=>options.callback("XXXX.DUMMY.TOKEN.XXXX"));return "local-widget"},remove(){}};</script>`;
          body = Buffer.from(
            body.toString().replace('<head>', () => `<head>${widget}`),
          );
          delete outgoing['content-length'];
        }
        response.writeHead(result.status, {
          ...outgoing,
          'Set-Cookie': result.headers.getSetCookie(),
        });
        response.end(body);
      } catch {
        response.writeHead(503);
        response.end('Local test transport failed.');
      }
    });
    server.listen(0, '127.0.0.1');
    return server;
  }
  const webServer = serve('web');
  const deliveryServer = serve('delivery');

  await Promise.all([
    once(webServer, 'listening'),
    once(deliveryServer, 'listening'),
  ]);
  function port(server: ReturnType<typeof createServer>) {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing local listener');
    return String(address.port);
  }
  const webPort = port(webServer),
    deliveryPort = port(deliveryServer);

  for (const [directory, name] of [
    ['apps/web', 'web'],
    ['workers/delivery', 'delivery'],
  ]) {
    const source = nodePath.join(root, directory, 'wrangler.jsonc');
    const parsed = ts.parseConfigFileTextToJson(
      source,
      await readFile(source, 'utf8'),
    );
    if (parsed.error) throw new Error('Invalid local test configuration');
    const config = parsed.config as TestConfig;
    config.main = nodePath.join(root, directory, config.main);
    config.$schema = nodePath.join(
      root,
      'node_modules/wrangler/config-schema.json',
    );
    if (config.assets)
      config.assets.directory = nodePath.join(
        root,
        directory,
        config.assets.directory,
      );
    config.vars.APP_ORIGIN = `http://127.0.0.1:${webPort}`;
    if (name === 'web') config.vars.LOCAL_DELIVERY_PORT = deliveryPort;
    config.d1_databases[0].database_name = 'hearth-adversarial-local';
    config.d1_databases[0].database_id = '00000000-0000-0000-0000-000000007777';
    config.d1_databases[0].migrations_dir = nodePath.join(root, 'drizzle');
    config.r2_buckets[0].bucket_name = 'hearth-adversarial-local';
    // The full browser suite tests functionality; native limiter thresholds are
    // exercised separately with the production delivery configuration in Vitest.
    for (const limiter of config.ratelimits) limiter.simple.limit = 1000;
    await mkdir(nodePath.join(destination, name), { recursive: true });
    await writeFile(
      nodePath.join(destination, name, 'wrangler.jsonc'),
      JSON.stringify(config, null, 2),
    );
  }

  const config = nodePath.join(destination, 'web/wrangler.jsonc');
  const deliveryConfig = nodePath.join(destination, 'delivery/wrangler.jsonc');
  const state = nodePath.join(destination, 'web/.wrangler/state');
  const outbound: V4FetchHandler = (request) => {
    const url = new URL(request.url);
    if (
      url.href ===
        'https://challenges.cloudflare.com/turnstile/v0/siteverify' &&
      request.method === 'POST'
    ) {
      return LocalResponse.json({ success: true });
    }
    if (
      url.origin === `http://127.0.0.1:${deliveryPort}` &&
      url.pathname === '/.well-known/hearth-delivery' &&
      request.method === 'GET'
    ) {
      return localFetch(request.url, {
        headers: request.headers,
        redirect: 'manual',
      });
    }
    return new LocalResponse('External network is disabled in this test.', {
      status: 503,
    });
  };

  function worker(workerConfig: string, name: string) {
    const { workerOptions } = unstable_getMiniflareWorkerOptions(workerConfig);
    // Wrangler already bundled every source module for this local runtime.
    delete workerOptions.modulesRules;
    const script = name === 'web' ? '_worker.js' : 'index.js';
    return new Miniflare(
      convertV4MiniflareOptions({
        ...workerOptions,
        rootPath: nodePath.join(process.env.HEARTH_BROWSER_BUNDLES!, name),
        name: `hearth-adversarial-${name}`,
        modules: true,
        scriptPath: nodePath.join(
          process.env.HEARTH_BROWSER_BUNDLES!,
          name,
          script,
        ),
        resourcePersistencePath: nodePath.join(state, 'v3'),
        unsafeDevRegistryPath: nodePath.join(destination, 'registry'),
        outboundService: outbound,
        cf: false,
        logRequests: false,
      }),
    );
  }

  const proxy = createServer((_request, response) => {
    response.writeHead(403);
    response.end('External network is disabled in this test.');
  });
  proxy.on('connect', (_request, socket) => {
    socket.end('HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n');
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const proxyAddress = proxy.address();
  if (!proxyAddress || typeof proxyAddress === 'string')
    throw new Error('Local deny proxy did not bind.');

  const web = worker(config, 'web');
  let delivery: Miniflare;
  const keyFile = nodePath.join(destination, 'test-key');
  const dispose = async () => {
    for (const server of [webServer, deliveryServer, proxy]) {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    await Promise.all([web.dispose(), delivery?.dispose()]);
    // Only remove the directory allocated by this fixture, after runtime handles close.
    if (nodePath.dirname(destination) !== nodePath.resolve(tmpdir()))
      throw new Error('Unexpected fixture directory');
    await rm(destination, { recursive: true, force: true });
  };
  try {
    // Initialize shared local SQLite storage before a second runtime opens it.
    await web.ready;
    delivery = worker(deliveryConfig, 'delivery');
    await delivery.ready;
    await migrateDatabase(await web.getD1Database('DB'));
    const binding = await web.getD1Database('DB');
    if (accountMode === 'bootstrap') {
      const result = spawnSync(
        process.execPath,
        [
          'scripts/cli.mjs',
          'bootstrap',
          'Bootstrap administrator',
          '--config',
          config,
        ],
        {
          encoding: 'utf8',
          windowsHide: true,
          env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
        },
      );
      const match = result.stdout.match(/img_live_[a-f0-9]{32}_[a-f0-9]{64}/);
      if (!match || result.status !== 0)
        throw new Error('The isolated bootstrap fixture failed.');
      await writeFile(keyFile, match[0], { mode: 0o600 });
    } else {
      const account = await createUser(
        binding,
        'Browser administrator',
        'admin',
        null,
      );
      if (accountMode === 'established')
        await binding
          .prepare("UPDATE users SET onboardingStatus='exempt' WHERE id=?")
          .bind(account.userId)
          .run();
      await writeFile(keyFile, account.key, { mode: 0o600 });
    }
  } catch (error) {
    await dispose();
    throw error;
  }
  return {
    DB: await web.getD1Database('DB'),
    origin: 'http://127.0.0.1:' + webPort,
    variables: {
      TEST_WEB_PORT: webPort,
      TEST_DELIVERY_PORT: deliveryPort,
      TEST_DB_CONFIG: config,
      TEST_DELIVERY_CONFIG: deliveryConfig,
      TEST_KEY_FILE: keyFile,
    },
    proxy: 'http://127.0.0.1:' + proxyAddress.port,
    dispose,
  };
}

export const test = base.extend<{
  hearth: Awaited<ReturnType<typeof start>>;
  accountMode: AccountMode;
}>({
  accountMode: ['established', { option: true }],
  // Playwright requires destructuring for dependency discovery.
  hearth: async ({ accountMode }, use) => {
    const environment = await start(accountMode);
    const previous = Object.fromEntries(
      Object.keys(environment.variables).map((key) => [key, process.env[key]]),
    );
    Object.assign(process.env, environment.variables);
    try {
      await use(environment);
    } finally {
      for (const [key, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      await environment.dispose();
    }
  },
  baseURL: async ({ hearth }, use) => {
    await use(hearth.origin);
  },
  proxy: async ({ hearth }, use) => {
    await use({
      server: hearth.proxy,
      bypass: '127.0.0.1,localhost,*.localhost',
    });
  },
});

export { expect } from '@playwright/test';
