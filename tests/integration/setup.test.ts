/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed database operations. */
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  bootstrapLocalAdministrator,
  prepareBootstrap,
} from '../../cli/bootstrap-data';
import { SetupFailure } from '../../cli/setup/cloudflare';
import { assertHearthTables } from '../../cli/setup/index';
import {
  administrator,
  initializeDomains,
  initializeFreshStorage,
  type SetupBindings,
  verifyBrowserLogin,
  verifyUpload,
} from '../../cli/setup/initialize';
import { stateSchema } from '../../cli/setup/state';
import { authenticateKey, createSession } from '../../packages/core/auth';
import { now } from '../../packages/core/common';
import {
  domainDetails,
  setPrimaryDeliveryDomain,
} from '../../packages/core/delivery-domains';
import { writeStoredObject } from '../../packages/core/storage';
import { upload } from '../../packages/core/upload';
import { migrateDatabase } from '../helpers/database';
import { workerBundle, workerCompatibility } from '../helpers/workers';

let runtime: Miniflare;
let environment: SetupBindings;
let bootstrap: Awaited<ReturnType<typeof prepareBootstrap>>;
beforeEach(async () => {
  runtime = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: workerBundle('delivery'),
      ...workerCompatibility('delivery'),
      bindings: {
        ENVIRONMENT: 'production',
        APP_ORIGIN: 'https://app.example.com',
      },
      d1Databases: ['DB'],
      r2Buckets: ['BUCKET'],
      ratelimits: {
        SHARE_FAILURE_LIMIT: {
          namespace_id: '4105',
          simple: { limit: 60, period: 60 },
        },
      },
    }),
  );
  const DB = await runtime.getD1Database('DB');
  await migrateDatabase(DB);
  environment = {
    DB,
    // @ts-expect-error Miniflare R2 proxies use Undici Headers; runtime binding operations are compatible.
    BUCKET: await runtime.getR2Bucket('BUCKET'),
    APP_ORIGIN: 'https://app.example.com',
    ENVIRONMENT: 'production',
  };
  bootstrap = await prepareBootstrap("Owner's Hearth");
});
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await runtime?.dispose();
});
async function createAdministrator() {
  const tables = await environment.DB.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
  ).all<{ name: string }>();
  assertHearthTables(
    tables.results.map((table) => table.name),
    ['0000_initial.sql'],
  );
  await environment.DB.batch(
    bootstrap.statements.map((sql) => environment.DB.prepare(sql)),
  );
}
const checkpoint = () => Promise.resolve();

it('requires a fresh, unexpired session using the current administrator credential version', async () => {
  await createAdministrator();
  const since = now();
  expect(
    await verifyBrowserLogin(environment, bootstrap.key.plaintext, since),
  ).toBe(false);
  await createSession(environment.DB, bootstrap.userId, 1);
  expect(
    await verifyBrowserLogin(environment, bootstrap.key.plaintext, since),
  ).toBe(true);
  await environment.DB.prepare('UPDATE sessions SET createdAt=?')
    .bind(since - 1)
    .run();
  expect(
    await verifyBrowserLogin(environment, bootstrap.key.plaintext, since),
  ).toBe(false);
  await environment.DB.prepare('UPDATE sessions SET createdAt=?,version=2')
    .bind(since)
    .run();
  expect(
    await verifyBrowserLogin(environment, bootstrap.key.plaintext, since),
  ).toBe(false);
});

async function delivery(input: string | URL | Request, init?: RequestInit) {
  const url = input instanceof Request ? input.url : String(input);
  const response = await runtime.dispatchFetch(url, {
    method: init?.method,
    headers: Object.fromEntries(new Headers(init?.headers)),
  });
  return new Response(
    response.status === 304 ? null : await response.arrayBuffer(),
    { status: response.status, headers: Object.fromEntries(response.headers) },
  );
}
async function enableDomains() {
  vi.stubGlobal(
    'fetch',
    async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      return url.hostname === 'cloudflare-dns.com'
        ? Response.json({
            Status: 0,
            Answer: [{ type: 1, data: '104.16.0.1' }],
          })
        : delivery(input, init);
    },
  );
  await initializeDomains(environment, bootstrap.key.plaintext, [
    'images.example.com',
  ]);
}
async function uploadRequest(
  input: string | URL | Request,
  init?: RequestInit,
) {
  const url = new URL(input instanceof Request ? input.url : String(input));
  if (url.origin !== environment.APP_ORIGIN) return delivery(input, init);
  const actor = await administrator(environment, bootstrap.key.plaintext);
  const result = await upload(
    new Request(url, init),
    actor,
    { ...environment, MAX_UPLOAD_BYTES: '26214400' },
    'bearer',
  );
  return Response.json(result, { status: result.url ? 201 : 409 });
}

it('bootstraps usable credentials, statistics, and a safe success audit atomically', async () => {
  await createAdministrator();
  const { user } = await authenticateKey(
    environment.DB,
    bootstrap.key.plaintext,
  );
  expect(user).toMatchObject({
    id: bootstrap.userId,
    role: 'admin',
    bootstrapAdministrator: true,
  });
  expect(
    await environment.DB.prepare(
      'SELECT userId FROM user_storage_stats',
    ).first(),
  ).toEqual({ userId: bootstrap.userId });
  const audit = await environment.DB.prepare(
    "SELECT action,metadata FROM audit_log WHERE action='admin.bootstrapped'",
  ).all();
  expect(audit.results).toHaveLength(1);
  expect(JSON.stringify(audit.results)).not.toContain(bootstrap.key.plaintext);
  expect(bootstrap.sql).not.toContain(bootstrap.key.plaintext);
});

it('initializes accounting with the first local administrator and rolls back a refused bootstrap', async () => {
  await bootstrapLocalAdministrator(environment, bootstrap);
  expect(
    await environment.DB.prepare(
      'SELECT ready,multipartVerified FROM storage_capacity',
    ).first(),
  ).toEqual({ ready: 1, multipartVerified: 1 });
  await environment.DB.prepare(
    'UPDATE storage_capacity SET ready=0,multipartVerified=0 WHERE id=1',
  ).run();
  await expect(
    bootstrapLocalAdministrator(environment, await prepareBootstrap('Other')),
  ).rejects.toThrow();
  expect(
    await environment.DB.prepare(
      'SELECT ready,multipartVerified FROM storage_capacity',
    ).first(),
  ).toEqual({ ready: 0, multipartVerified: 0 });
});

it('refuses duplicate/concurrent bootstrap without replacing the first credential or adding audit events', async () => {
  const other = await prepareBootstrap('Other owner');
  const results = await Promise.allSettled(
    [bootstrap, other].map((candidate) =>
      environment.DB.batch(
        candidate.statements.map((sql) => environment.DB.prepare(sql)),
      ),
    ),
  );
  expect(
    results.filter((result) => result.status === 'fulfilled'),
  ).toHaveLength(1);
  expect(
    await environment.DB.prepare('SELECT count(*) AS count FROM users').first(),
  ).toEqual({ count: 1 });
  expect(
    await environment.DB.prepare(
      'SELECT count(*) AS count FROM api_keys',
    ).first(),
  ).toEqual({ count: 1 });
  expect(
    await environment.DB.prepare(
      "SELECT count(*) AS count FROM audit_log WHERE action='admin.bootstrapped'",
    ).first(),
  ).toEqual({ count: 1 });
  const winner = results[0].status === 'fulfilled' ? bootstrap : other;
  expect(
    (await authenticateKey(environment.DB, winner.key.plaintext)).user.id,
  ).toBe(winner.userId);
});
it('creates and validates delivery through the real Worker/R2 probe before selecting it as primary', async () => {
  await createAdministrator();
  await enableDomains();
  expect(
    await environment.DB.prepare(
      'SELECT hostname,health,isPrimary FROM delivery_domains',
    ).first(),
  ).toEqual({ hostname: 'images.example.com', health: 'active', isPrimary: 1 });
  await enableDomains();
  expect(
    await environment.DB.prepare(
      'SELECT count(*) AS count FROM delivery_domains',
    ).first(),
  ).toEqual({ count: 1 });
});
it('preserves existing primary/access policy and refuses to silently enable disabled delivery', async () => {
  await createAdministrator();
  await enableDomains();
  await environment.DB.prepare(
    "UPDATE delivery_domains SET accessMode='administrators',isPrimary=0,enabled=0",
  ).run();
  await expect(enableDomains()).rejects.toThrow('disabled');
  expect(
    await environment.DB.prepare(
      'SELECT accessMode,enabled FROM delivery_domains',
    ).first(),
  ).toEqual({ accessMode: 'administrators', enabled: 0 });
});
it('verifies the deployed upload/delivery contracts and cleans only its synthetic image', async () => {
  await createAdministrator();
  await enableDomains();
  const state = stateSchema.parse({});
  await verifyUpload(
    environment,
    bootstrap.key.plaintext,
    state,
    checkpoint,
    uploadRequest,
  );
  expect(state.probe).toBeUndefined();
  expect(
    await environment.DB.prepare(
      'SELECT count(*) AS count FROM images WHERE deletedAt IS NOT NULL AND purgedAt IS NOT NULL',
    ).first(),
  ).toEqual({ count: 1 });
  expect((await environment.BUCKET.list()).objects).toHaveLength(0);
});
it('reconciles a committed upload after its HTTP response was lost without uploading another copy', async () => {
  await createAdministrator();
  await enableDomains();
  const state = stateSchema.parse({});
  const request = vi
    .fn(uploadRequest)
    .mockImplementationOnce(async (input, init) => {
      await uploadRequest(input, init);
      throw new TypeError('network disconnected');
    });
  await expect(
    verifyUpload(
      environment,
      bootstrap.key.plaintext,
      state,
      checkpoint,
      request,
    ),
  ).rejects.toBeInstanceOf(SetupFailure);
  expect(state.probe?.receiptHash).toBeDefined();
  await verifyUpload(
    environment,
    bootstrap.key.plaintext,
    state,
    checkpoint,
    request,
  );
  expect(
    request.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(1);
  expect(
    await environment.DB.prepare(
      'SELECT count(*) AS count FROM images',
    ).first(),
  ).toEqual({ count: 1 });
  expect(state.probe).toBeUndefined();
});

it('retries a lost pre-commit upload using the same in-memory idempotency key', async () => {
  await createAdministrator();
  await enableDomains();
  const state = stateSchema.parse({});
  const request = vi
    .fn(uploadRequest)
    .mockRejectedValueOnce(new TypeError('network disconnected'));
  await expect(
    verifyUpload(
      environment,
      bootstrap.key.plaintext,
      state,
      checkpoint,
      request,
    ),
  ).rejects.toThrow('response was lost');
  await verifyUpload(
    environment,
    bootstrap.key.plaintext,
    state,
    checkpoint,
    request,
  );
  const posts = request.mock.calls.filter(
    ([, init]) => init?.method === 'POST',
  );
  expect(posts).toHaveLength(2);
  expect(new Headers(posts[0][1]?.headers).get('Idempotency-Key')).toBe(
    new Headers(posts[1][1]?.headers).get('Idempotency-Key'),
  );
  expect(
    await environment.DB.prepare(
      'SELECT count(*) AS count FROM images',
    ).first(),
  ).toEqual({ count: 1 });
});

it('preserves an uncertain interrupted upload with no receipt instead of uploading another copy', async () => {
  await createAdministrator();
  await enableDomains();
  const state = stateSchema.parse({
    probe: {
      ownerId: bootstrap.userId,
      receiptHash: 'f'.repeat(64),
      attempted: true,
    },
  });
  const request = vi.fn(uploadRequest);
  await expect(
    verifyUpload(
      environment,
      bootstrap.key.plaintext,
      state,
      checkpoint,
      request,
    ),
  ).rejects.toThrow('cannot be proven');
  expect(request).not.toHaveBeenCalled();
  expect(state.probe?.receiptHash).toBe('f'.repeat(64));
});
it('repairs a saved-without-link verification image after delivery selection is corrected', async () => {
  await createAdministrator();
  await enableDomains();
  await environment.DB.prepare('UPDATE delivery_domains SET isPrimary=0').run();
  const state = stateSchema.parse({});
  const request = vi.fn(uploadRequest);
  await expect(
    verifyUpload(
      environment,
      bootstrap.key.plaintext,
      state,
      checkpoint,
      request,
    ),
  ).rejects.toThrow('default');
  const actor = await administrator(environment, bootstrap.key.plaintext);
  const domainId = (await environment.DB.prepare(
    'SELECT id FROM delivery_domains',
  ).first<{ id: string }>())!.id;
  const domain = await domainDetails(environment.DB, actor, domainId);
  await setPrimaryDeliveryDomain(
    environment.DB,
    actor,
    domain.id,
    domain.revision,
  );
  await verifyUpload(
    environment,
    bootstrap.key.plaintext,
    state,
    checkpoint,
    request,
  );
  expect(
    request.mock.calls.filter(([, init]) => init?.method === 'POST'),
  ).toHaveLength(1);
  expect(
    await environment.DB.prepare(
      'SELECT count(*) AS count FROM images',
    ).first(),
  ).toEqual({ count: 1 });
});

it('initializes trusted fresh accounting before writes and never resets an upgraded or restored ledger', async () => {
  await initializeFreshStorage(environment.DB);
  expect(
    await environment.DB.prepare(
      'SELECT ready,multipartVerified,persistedBytes,reservedBytes FROM storage_capacity',
    ).first(),
  ).toEqual({
    ready: 1,
    multipartVerified: 1,
    persistedBytes: 0,
    reservedBytes: 0,
  });
  await environment.DB.prepare(
    'UPDATE storage_capacity SET limitBytes=5 WHERE id=1',
  ).run();
  const first = await writeStoredObject(
    environment.DB,
    environment.BUCKET,
    'first-write',
    'probe',
    new Uint8Array(5),
  );
  await first.writer.finalizeStatement().run();
  expect(
    await environment.DB.prepare(
      'SELECT persistedBytes,reservedBytes,ready FROM storage_capacity',
    ).first(),
  ).toEqual({ persistedBytes: 5, reservedBytes: 0, ready: 1 });
  await environment.DB.prepare(
    'UPDATE storage_capacity SET persistedBytes=123,reservedBytes=45,limitBytes=200 WHERE id=1',
  ).run();
  await initializeFreshStorage(environment.DB);
  expect(
    await environment.DB.prepare(
      'SELECT ready,persistedBytes,reservedBytes,limitBytes FROM storage_capacity',
    ).first(),
  ).toEqual({
    ready: 1,
    persistedBytes: 123,
    reservedBytes: 45,
    limitBytes: 200,
  });
  await environment.DB.prepare(
    'UPDATE storage_capacity SET ready=0 WHERE id=1',
  ).run();
  await expect(initializeFreshStorage(environment.DB)).rejects.toThrow(
    'could not be initialized safely',
  );
});
