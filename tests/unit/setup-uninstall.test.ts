import type * as FileSystem from 'node:fs/promises';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import * as prompts from '@clack/prompts';
import { runCommand } from 'citty';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as productionConfig from '../../cli/production-config';
import { Cloudflare, type WorkerSettings } from '../../cli/setup/cloudflare';
import setupCommand from '../../cli/setup/index';
import { withBindings } from '../../cli/setup/initialize';
import * as stateFiles from '../../cli/setup/state';
import { stateSchema } from '../../cli/setup/state';
import { emptyBucket, uninstall } from '../../cli/setup/uninstall';
import manifest from '../../package.json' with { type: 'json' };

vi.mock('@clack/prompts', () => ({
  select: vi.fn(),
  confirm: vi.fn(),
  text: vi.fn(),
  isCancel: vi.fn().mockReturnValue(false),
  note: vi.fn(),
  outro: vi.fn(),
  intro: vi.fn(),
  cancel: vi.fn(),
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  spinner: vi.fn(() => ({ start: vi.fn(), stop: vi.fn() })),
}));
vi.mock('../../cli/setup/initialize', () => ({ withBindings: vi.fn() }));
vi.mock('node:fs/promises', async (original) => ({
  ...(await original<typeof FileSystem>()),
  readdir: vi.fn(),
  rm: vi.fn(),
}));

const accountId = 'a'.repeat(32);
const databaseId = '3a428b1a-0807-4e60-8d70-78649e35bbf7';
const names = ['hearth-web', 'hearth-delivery', 'hearth-maintenance'];
const tableNames = [
  'users',
  'api_keys',
  'user_storage_stats',
  'images',
  'aliases',
  'delivery_domains',
  'delivery_domain_access',
  'delete_tokens',
  'sessions',
  'audit_log',
  'app_settings',
  'storage_objects',
  'upload_receipts',
  'storage_capacity',
  'storage_snapshots',
  'maintenance_lock',
  'reconciliation_runs',
  'reconciliation_findings',
];
const imageKey = `objects/usr_${'a'.repeat(32)}/2026/10/img_${'b'.repeat(32)}`;
const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const ok = (result: unknown) =>
  Promise.resolve(Response.json({ success: true, result }));

function inspectionDecision(proceed: boolean) {
  vi.mocked(prompts.confirm).mockImplementation(({ message }) =>
    Promise.resolve(!message.startsWith('Have you inspected') || proceed),
  );
}

function reviewNotes() {
  return vi
    .mocked(prompts.note)
    .mock.calls.map(([message]) => String(message))
    .join('\n');
}

function fixture() {
  const cloudflare = new Cloudflare({});
  cloudflare.token = 'test-token';
  const workers = new Map<
    string,
    { id: string; created_on: string; bindings: WorkerSettings['bindings'] }
  >(
    names.map((id) => [
      id,
      {
        id,
        created_on: '2026-10-01T00:00:00Z',
        bindings: [
          { name: 'DB', type: 'd1', id: databaseId },
          {
            name: 'BUCKET',
            type: 'r2_bucket',
            bucket_name: 'hearth-production',
          },
          ...(id === 'hearth-maintenance'
            ? []
            : [
                { name: 'ENVIRONMENT', type: 'plain_text', text: 'production' },
                {
                  name: 'APP_ORIGIN',
                  type: 'plain_text',
                  text: 'https://app.example.com',
                },
              ]),
          ...(id === 'hearth-web'
            ? [
                {
                  name: 'TURNSTILE_SITE_KEY',
                  type: 'plain_text',
                  text: 'sitekey',
                },
              ]
            : []),
          ...(id === 'hearth-web'
            ? [
                {
                  name: 'LOGIN_LIMIT',
                  type: 'ratelimit',
                  simple: { limit: 10, period: 60 },
                },
                {
                  name: 'UPLOAD_LIMIT',
                  type: 'ratelimit',
                  simple: { limit: 30, period: 60 },
                },
                {
                  name: 'MUTATION_LIMIT',
                  type: 'ratelimit',
                  simple: { limit: 60, period: 60 },
                },
                {
                  name: 'SENSITIVE_LIMIT',
                  type: 'ratelimit',
                  simple: { limit: 10, period: 60 },
                },
              ]
            : id === 'hearth-delivery'
              ? [
                  {
                    name: 'SHARE_FAILURE_LIMIT',
                    type: 'ratelimit',
                    simple: { limit: 60, period: 60 },
                  },
                ]
              : []),
        ],
      },
    ]),
  );
  const maintenanceNamespace = 'maintenance-namespace';
  workers.get('hearth-maintenance')!.bindings.push({
    name: 'MAINTENANCE',
    type: 'durable_object_namespace',
    class_name: 'MaintenanceJob',
    namespace_id: maintenanceNamespace,
  });
  workers.get('hearth-web')!.bindings.push({
    name: 'MAINTENANCE',
    type: 'durable_object_namespace',
    class_name: 'MaintenanceJob',
    namespace_id: maintenanceNamespace,
    script_name: 'hearth-maintenance',
  });
  const databases = [{ uuid: databaseId, name: 'hearth-production' }];
  const buckets = [
    { name: 'hearth-production', creation_date: '2026-10-01T00:00:00Z' },
  ];
  const widgets = [
    {
      name: 'hearth (app.example.com)',
      sitekey: 'sitekey',
      domains: ['app.example.com'],
    },
  ];
  const domains = [
    { id: 'domain', hostname: 'app.example.com', service: 'hearth-web' },
  ];
  const routes = [
    { id: 'route', pattern: 'img.example.com/*', script: 'hearth-delivery' },
  ];
  const objects = new Set([imageKey]);
  const uploads = new Map<string, string>();
  const bucket = {
    resumeMultipartUpload: vi.fn((key: string) => ({
      abort: vi.fn(() => {
        uploads.delete(key);
        return Promise.resolve();
      }),
    })),
    list: vi.fn(() =>
      Promise.resolve({
        objects: [...objects].map((key) => ({ key })),
        truncated: false,
      }),
    ),
    delete: vi.fn((keys: string[]) => {
      for (const key of keys) objects.delete(key);
      return Promise.resolve();
    }),
  };
  vi.mocked(withBindings).mockImplementation(
    async (_cloudflare, _config, operation) =>
      operation({ BUCKET: bucket as unknown as R2Bucket } as Parameters<
        Parameters<typeof withBindings>[2]
      >[0]),
  );
  const deleted: string[] = [];
  let failDatabase = false;
  let keepWorker = false;
  let tagged = true;
  let publicBucket = false;
  let versionId = 'version';
  let tables = tableNames;
  const fetch = vi.fn((input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(
      typeof input === 'string' || input instanceof URL ? input : input.url,
    );
    const resource = url.pathname
      .replace(`/client/v4/accounts/${accountId}`, '')
      .replace('/client/v4', '');
    if (init?.method === 'DELETE') {
      deleted.push(resource);
      if (resource.startsWith('/workers/scripts/')) {
        const target = resource.split('/').at(-1)!;
        if (!keepWorker && target === 'hearth-maintenance') {
          let referenced = false;
          for (const worker of workers.values()) {
            if (
              worker.id !== target &&
              worker.bindings.some(
                (binding) =>
                  binding.type === 'durable_object_namespace' &&
                  binding.namespace_id === maintenanceNamespace,
              )
            ) {
              referenced = true;
              break;
            }
          }
          if (referenced && url.searchParams.get('force') !== 'true')
            throw new Error(
              'Maintenance namespace still has external bindings',
            );
        }
        if (!keepWorker) workers.delete(target);
      } else if (resource.startsWith('/d1/database/')) {
        if (failDatabase)
          return Promise.resolve(
            Response.json(
              {
                success: false,
                result: null,
                errors: [{ code: 10_000, message: 'permission denied' }],
              },
              { status: 403 },
            ),
          );
        databases.length = 0;
      } else if (resource.startsWith('/r2/buckets/')) {
        if (objects.size > 0) throw new Error('Nonempty bucket deleted');
        if (uploads.size > 0)
          throw new Error('Unfinished multipart uploads remain');
        buckets.length = 0;
      } else if (resource.startsWith('/challenges/widgets/'))
        widgets.length = 0;
      else if (resource.startsWith('/workers/domains/')) domains.length = 0;
      else if (resource.startsWith('/zones/zone/workers/routes/'))
        routes.length = 0;
      else throw new Error(`Unexpected delete ${resource}`);
      return ok(null);
    }
    if (resource === '/workers/scripts')
      return ok(
        Array.from(workers.values(), ({ id, created_on }) => ({
          id,
          created_on,
        })),
      );
    if (resource.endsWith('/settings'))
      return ok({ bindings: workers.get(resource.split('/', 4)[3])!.bindings });
    if (resource.endsWith('/deployments'))
      return ok({
        deployments: [
          { versions: [{ version_id: versionId, percentage: 100 }] },
        ],
      });
    if (resource.endsWith('/versions/version'))
      return ok({
        annotations: tagged
          ? { 'workers/message': `Hearth setup ${'a'.repeat(64)}` }
          : {},
      });
    if (resource.endsWith('/schedules'))
      return ok({ schedules: [{ cron: '*/5 * * * *' }] });
    if (resource === '/d1/database') return ok(databases);
    if (
      resource.endsWith('/query') &&
      typeof init?.body === 'string' &&
      init.body.includes('SELECT key, uploadId')
    )
      return ok([
        {
          success: true,
          results: Array.from(uploads, ([key, uploadId]) => ({
            key,
            uploadId,
          })),
        },
      ]);
    if (resource.endsWith('/query'))
      return ok([{ success: true, results: tables.map((name) => ({ name })) }]);
    if (resource === '/r2/buckets') return ok({ buckets });
    if (resource === '/r2/buckets/hearth-production') return ok(buckets[0]);
    if (resource.endsWith('/domains/managed'))
      return ok({ enabled: publicBucket });
    if (resource.endsWith('/domains/custom')) return ok({ domains: [] });
    if (resource === '/challenges/widgets') return ok(widgets);
    if (resource === '/workers/domains') return ok(domains);
    if (resource === '/zones') return ok([{ id: 'zone' }]);
    if (resource === '/zones/zone/workers/routes') return ok(routes);
    throw new Error(`Unexpected request ${init?.method} ${resource}`);
  });
  vi.stubGlobal('fetch', fetch);
  const run = (savedState = stateSchema.parse({})) =>
    uninstall(
      cloudflare,
      savedState,
      [{ id: accountId, name: 'Account' }],
      async (value) => (await value) as Exclude<Awaited<typeof value>, symbol>,
    );
  return {
    cloudflare,
    workers,
    buckets,
    widgets,
    domains,
    routes,
    objects,
    bucket,
    uploads,
    deleted,
    run,
    fetch,
    failDatabase: () => {
      failDatabase = true;
    },
    repairDatabase: () => {
      failDatabase = false;
    },
    keepWorker: () => {
      keepWorker = true;
    },
    changeSchema: (names = ['other_app']) => {
      tables = names;
    },
    untagged: () => {
      tagged = false;
    },
    replaceCode: () => {
      versionId = 'replacement';
    },
    makeBucketPublic: () => {
      publicBucket = true;
    },
  };
}

beforeEach(() => {
  vi.mocked(prompts.select).mockImplementation(({ options }) =>
    Promise.resolve(
      options.some((option) => option.value === accountId)
        ? accountId
        : 'hearth',
    ),
  );
  vi.mocked(prompts.text).mockResolvedValue(`delete hearth ${accountId}`);
  vi.mocked(prompts.confirm).mockResolvedValue(true);
  vi.mocked(readdir).mockResolvedValue([]);
  vi.mocked(rm).mockResolvedValue();
  vi.spyOn(stateFiles, 'optionalText').mockResolvedValue(undefined);
  vi.spyOn(stateFiles, 'atomicWrite').mockResolvedValue();
});
afterEach(() => {
  if (inputTTY) Object.defineProperty(process.stdin, 'isTTY', inputTTY);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (outputTTY) Object.defineProperty(process.stdout, 'isTTY', outputTTY);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
  vi.clearAllMocks();
  process.exitCode = 0;
});

describe('Hearth uninstall', () => {
  it('discovers an installation without local files and completely removes its resources in safe order', async () => {
    const remote = fixture();
    remote.uploads.set(imageKey, 'unfinished-upload');
    expect(await remote.run()).toBe(true);
    expect(remote.uploads.size).toBe(0);
    expect(remote.deleted).toEqual([
      '/zones/zone/workers/routes/route',
      '/workers/domains/domain',
      ...names.map((name) => `/workers/scripts/${name}`),
      '/r2/buckets/hearth-production',
      `/d1/database/${databaseId}`,
      '/challenges/widgets/sitekey',
    ]);
    expect(remote.objects.size).toBe(0);
    expect(remote.bucket.delete).toHaveBeenCalledWith([imageKey]);
    expect(stateFiles.atomicWrite).toHaveBeenCalledWith(
      expect.stringMatching(/uninstall\.json$/),
      expect.stringContaining(databaseId),
    );
    const writes = vi.mocked(stateFiles.atomicWrite).mock.invocationCallOrder;
    expect(writes[0]).toBeLessThan(
      remote.bucket.delete.mock.invocationCallOrder[0],
    );
    expect(
      remote.fetch.mock.calls.some(
        ([url]) => typeof url === 'string' && url.includes('force=true'),
      ),
    ).toBe(false);
  });

  it('discovers an older manual deployment without installer tags or local configuration', async () => {
    const remote = fixture();
    remote.untagged();
    expect(await remote.run()).toBe(true);
    expect(
      remote.deleted.filter((resource) =>
        resource.startsWith('/workers/scripts/'),
      ),
    ).toHaveLength(3);
  });

  it('cleans saved provisioning after an interrupted migration', async () => {
    const remote = fixture();
    remote.workers.clear();
    remote.domains.length = 0;
    remote.routes.length = 0;
    remote.changeSchema(['users']);
    expect(
      await remote.run(
        stateSchema.parse({
          accountId,
          databaseId,
          bucketCreatedOn: remote.buckets[0].creation_date,
          created: { database: true, bucket: true },
        }),
      ),
    ).toBe(true);
    expect(remote.deleted).toContain('/r2/buckets/hearth-production');
    expect(remote.deleted).toContain(`/d1/database/${databaseId}`);
  });

  it.each([true, false])(
    'requires a matching creation identity for a secret-only Worker draft (match: %s)',
    async (matches) => {
      const remote = fixture();
      remote.untagged();
      remote.workers.delete('hearth-delivery');
      remote.workers.delete('hearth-maintenance');
      remote.workers.get('hearth-web')!.bindings = [
        { name: 'TURNSTILE_SECRET_KEY', type: 'secret_text' },
      ];
      const state = stateSchema.parse({
        accountId,
        databaseId,
        webDraftCreatedOn: matches
          ? remote.workers.get('hearth-web')!.created_on
          : '2020-01-01T00:00:00Z',
        created: { database: true, bucket: true, webDraft: true },
      });
      inspectionDecision(false);
      expect(await remote.run(state)).toBe(matches);
      expect(remote.deleted.includes('/workers/scripts/hearth-web')).toBe(
        matches,
      );
    },
  );

  it('requires fresh approval for code deployed after review', async () => {
    const remote = fixture();
    vi.mocked(prompts.confirm).mockImplementation(({ message }) => {
      if (message.startsWith('Permanently uninstall')) remote.replaceCode();
      return Promise.resolve(!message.startsWith('Have you inspected'));
    });
    expect(await remote.run()).toBe(false);
    expect(remote.deleted.includes('/workers/scripts/hearth-web')).toBe(false);
    expect(reviewNotes()).toContain('changed since review');
    expect(reviewNotes()).toContain(
      `https://dash.cloudflare.com/${accountId}/workers/services/view/hearth-web/production`,
    );
  });

  it('defaults every confirmation to No and allows declining the final review after inspection', async () => {
    const remote = fixture();
    remote.objects.add('other-app/important.txt');
    vi.mocked(prompts.confirm).mockImplementation(({ message }) =>
      Promise.resolve(message.startsWith('Have you inspected')),
    );
    expect(await remote.run()).toBe(false);
    expect(remote.deleted).toEqual([]);
    expect(stateFiles.atomicWrite).not.toHaveBeenCalled();
    expect(
      vi
        .mocked(prompts.confirm)
        .mock.calls.every(([options]) => options.initialValue === false),
    ).toBe(true);
    expect(reviewNotes()).toContain(
      `https://dash.cloudflare.com/${accountId}/r2/default/buckets/hearth-production`,
    );
  });

  it('requires a fresh inspection if unfamiliar bucket contents change after approval', async () => {
    const remote = fixture();
    remote.objects.add('other-app/first.txt');
    let inspections = 0;
    vi.mocked(prompts.confirm).mockImplementation(({ message }) => {
      if (message.startsWith('Permanently uninstall'))
        remote.objects.add('other-app/new.txt');
      return Promise.resolve(
        !message.startsWith('Have you inspected') || ++inspections === 1,
      );
    });
    expect(await remote.run()).toBe(false);
    expect(inspections).toBe(2);
    expect(remote.deleted).toEqual([]);
    expect(reviewNotes()).toContain('other-app/new.txt');
  });

  it('does not reuse shared-resource approvals from a previous uninstall run', async () => {
    const remote = fixture();
    remote.workers.set('another-app', {
      id: 'another-app',
      created_on: 'today',
      bindings: [remote.workers.get('hearth-web')!.bindings[0]],
    });
    remote.failDatabase();
    await expect(remote.run()).rejects.toThrow('permission denied');
    const saved = vi.mocked(stateFiles.atomicWrite).mock.calls.at(-1)![1];
    vi.mocked(stateFiles.optionalText).mockImplementation((file) =>
      Promise.resolve(file.endsWith('uninstall.json') ? saved : undefined),
    );
    remote.repairDatabase();
    remote.deleted.length = 0;
    inspectionDecision(false);
    expect(await remote.run()).toBe(false);
    expect(remote.deleted).toEqual([]);
    expect(
      vi
        .mocked(prompts.confirm)
        .mock.calls.filter(([options]) =>
          options.message.startsWith('Have you inspected'),
        ),
    ).toHaveLength(2);
  });

  it('cleans matching production files and installer backups while preserving other configurations', async () => {
    const remote = fixture();
    const outputs = await productionConfig.renderProduction({
      application: 'app.example.com',
      delivery: ['images.example.com'],
      databaseId,
      bucket: 'hearth-production',
      turnstile: '0x4AAAAAAA_real_sitekey',
      accountId,
    });
    const original = productionConfig.readConfig;
    vi.spyOn(productionConfig, 'readConfig').mockImplementation((file) => {
      const output = outputs.find((output) => file.startsWith(output.path));
      return output
        ? Promise.resolve(
            file.endsWith('.999.bak')
              ? {
                  ...output.config,
                  name: 'another-app',
                  account_id: 'b'.repeat(32),
                }
              : output.config,
          )
        : original(file);
    });
    vi.mocked(stateFiles.optionalText).mockImplementation((file) =>
      Promise.resolve(
        outputs.some((output) => output.path === file) ? '{}' : undefined,
      ),
    );
    vi.mocked(readdir).mockResolvedValue([
      'production.local.jsonc',
      'production.local.jsonc.123.bak',
      'production.local.jsonc.999.bak',
      'personal.bak',
    ] as never);
    expect(await remote.run()).toBe(true);
    for (const output of outputs) {
      expect(rm).toHaveBeenCalledWith(output.path);
      expect(rm).toHaveBeenCalledWith(`${output.path}.123.bak`);
      expect(rm).not.toHaveBeenCalledWith(`${output.path}.999.bak`);
      expect(rm).not.toHaveBeenCalledWith(
        path.join(path.dirname(output.path), 'personal.bak'),
      );
    }
  });

  it.each([
    { kind: 'database', proceed: false },
    { kind: 'bucket', proceed: false },
    { kind: 'widget', proceed: false },
    { kind: 'service', proceed: false },
    { kind: 'service', proceed: true },
    { kind: 'namespace', proceed: true },
  ])(
    'reviews shared $kind and honors proceed: $proceed',
    async ({ kind, proceed }) => {
      const remote = fixture();
      const bindings = remote.workers.get(names[0])!.bindings;
      const binding =
        kind === 'database'
          ? bindings[0]
          : kind === 'bucket'
            ? bindings[1]
            : kind === 'widget'
              ? bindings.find(
                  (binding) => binding.name === 'TURNSTILE_SITE_KEY',
                )!
              : kind === 'namespace'
                ? {
                    name: 'JOBS',
                    type: 'durable_object_namespace',
                    namespace_id: 'maintenance-namespace',
                  }
                : { name: 'APP', type: 'service', service: names[0] };
      remote.workers.set('another-app', {
        id: 'another-app',
        created_on: 'today',
        bindings: [binding],
      });
      inspectionDecision(proceed);
      expect(await remote.run()).toBe(proceed);
      expect(remote.deleted.includes('/workers/scripts/hearth-web')).toBe(
        proceed,
      );
      expect(remote.workers.has('another-app')).toBe(true);
      expect(reviewNotes()).toContain('another-app uses a selected resource');
      expect(reviewNotes()).toContain(
        `https://dash.cloudflare.com/${accountId}/workers/services/view/another-app/production`,
      );
      expect(
        remote.fetch.mock.calls.some(
          ([url]) => typeof url === 'string' && url.includes('force=true'),
        ),
      ).toBe(proceed && ['service', 'namespace'].includes(kind));
    },
  );

  it('refuses unexpected database tables without approval', async () => {
    const remote = fixture();
    remote.changeSchema();
    inspectionDecision(false);
    expect(await remote.run()).toBe(false);
    expect(remote.deleted.includes(`/d1/database/${databaseId}`)).toBe(false);
    expect(reviewNotes()).toContain(
      `https://dash.cloudflare.com/${accountId}/workers/d1/databases/${databaseId}`,
    );
  });

  it('refuses unfamiliar bucket objects without approval', async () => {
    const remote = fixture();
    remote.objects.add('other-app/important.txt');
    inspectionDecision(false);
    expect(await remote.run()).toBe(false);
    expect(remote.objects.has('other-app/important.txt')).toBe(true);
    expect(reviewNotes()).toContain('other-app/important.txt');
    expect(reviewNotes()).toContain(
      `https://dash.cloudflare.com/${accountId}/r2/default/buckets/hearth-production`,
    );
    expect(
      vi
        .mocked(prompts.confirm)
        .mock.calls.filter(([options]) =>
          options.message.startsWith('Have you inspected'),
        ),
    ).toHaveLength(1);
  });

  it('refuses a publicly accessible bucket without approval', async () => {
    const remote = fixture();
    remote.makeBucketPublic();
    inspectionDecision(false);
    expect(await remote.run()).toBe(false);
    expect(remote.deleted.includes('/r2/buckets/hearth-production')).toBe(
      false,
    );
    expect(reviewNotes()).toContain('permits public access');
    expect(reviewNotes()).toContain(
      `https://dash.cloudflare.com/${accountId}/r2/default/buckets/hearth-production`,
    );
  });

  it('refuses an orphaned bucket without saved creation identity or approval', async () => {
    const remote = fixture();
    remote.workers.clear();
    remote.domains.length = 0;
    remote.routes.length = 0;
    remote.changeSchema(['users']);
    inspectionDecision(false);
    expect(
      await remote.run(
        stateSchema.parse({
          accountId,
          databaseId,
          created: { database: true, bucket: true },
        }),
      ),
    ).toBe(false);
    expect(remote.deleted.includes('/r2/buckets/hearth-production')).toBe(
      false,
    );
    expect(reviewNotes()).toContain('Cannot prove ownership');
    expect(reviewNotes()).toContain(
      `https://dash.cloudflare.com/${accountId}/r2/default/buckets/hearth-production`,
    );
  });

  it('refuses widgets serving other hostnames without approval', async () => {
    const remote = fixture();
    remote.widgets[0].domains.push('another.example.com');
    inspectionDecision(false);
    expect(await remote.run()).toBe(false);
    expect(remote.deleted.includes('/challenges/widgets/sitekey')).toBe(false);
    expect(reviewNotes()).toContain('another.example.com');
    expect(reviewNotes()).toContain(
      `https://dash.cloudflare.com/${accountId}/turnstile/widget/sitekey`,
    );
  });

  it('retains the recovery plan on failure and resumes after Workers and R2 are already gone', async () => {
    const remote = fixture();
    remote.failDatabase();
    await expect(remote.run()).rejects.toThrow('permission denied');
    expect(remote.workers.size).toBe(0);
    expect(remote.buckets).toEqual([]);
    expect(remote.widgets).toHaveLength(1);
    expect(rm).not.toHaveBeenCalled();
    const writes = vi.mocked(stateFiles.atomicWrite).mock.calls;
    const saved = writes.at(-1)![1];
    vi.mocked(stateFiles.optionalText).mockImplementation((file) =>
      Promise.resolve(file.endsWith('uninstall.json') ? saved : undefined),
    );
    remote.repairDatabase();
    remote.deleted.length = 0;
    expect(await remote.run()).toBe(true);
    expect(remote.deleted).toEqual([
      `/d1/database/${databaseId}`,
      '/challenges/widgets/sitekey',
    ]);
  });

  it('requires fresh approval for a replacement bucket on resume', async () => {
    const remote = fixture();
    remote.failDatabase();
    await expect(remote.run()).rejects.toThrow('permission denied');
    const saved = vi.mocked(stateFiles.atomicWrite).mock.calls.at(-1)![1];
    vi.mocked(stateFiles.optionalText).mockImplementation((file) =>
      Promise.resolve(file.endsWith('uninstall.json') ? saved : undefined),
    );
    remote.buckets.push({
      name: 'hearth-production',
      creation_date: '2026-10-15T00:00:00Z',
    });
    remote.deleted.length = 0;
    remote.repairDatabase();
    inspectionDecision(false);
    expect(await remote.run()).toBe(false);
    expect(remote.deleted.includes('/r2/buckets/hearth-production')).toBe(
      false,
    );
    expect(reviewNotes()).toContain('was replaced');
  });

  it('does not report success when a deleted Worker still appears remotely', async () => {
    const remote = fixture();
    remote.keepWorker();
    await expect(remote.run()).rejects.toThrow('after repeated deletion');
    expect(remote.bucket.delete).not.toHaveBeenCalled();
    expect(rm).not.toHaveBeenCalled();
  });

  it.each([
    { argument: '--remove', recover: false },
    { argument: '--uninstall', recover: true },
  ])(
    'routes $argument to uninstall without provisioning (recover: $recover)',
    async ({ argument, recover }) => {
      const remote = fixture();
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: true,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: true,
      });
      vi.stubEnv(
        'npm_config_user_agent',
        `pnpm/${manifest.packageManager.split('@', 2)[1].split('+', 1)[0]} node/${process.version}`,
      );
      vi.spyOn(stateFiles, 'loadState').mockResolvedValue(
        stateSchema.parse({}),
      );
      vi.spyOn(stateFiles, 'acquireLock').mockResolvedValue(async () => {});
      vi.spyOn(Cloudflare.prototype, 'identify').mockResolvedValue({
        loggedIn: true,
        authType: 'OAuth Token',
        accounts: [
          { id: accountId, name: 'Account' },
          ...(recover ? [{ id: 'b'.repeat(32), name: 'Other account' }] : []),
        ],
      });
      vi.spyOn(Cloudflare.prototype, 'credentials').mockImplementation(
        function (this: Cloudflare) {
          this.token = 'test-token';
          return Promise.resolve();
        },
      );
      let savedPlan: string | undefined;
      let recovering = false;
      vi.mocked(stateFiles.atomicWrite).mockImplementation((file, content) => {
        if (file.endsWith('uninstall.json')) savedPlan = content;
        return Promise.resolve();
      });
      vi.mocked(stateFiles.optionalText).mockImplementation((file) =>
        Promise.resolve(
          file.endsWith('uninstall.json') ? savedPlan : undefined,
        ),
      );
      if (recover) remote.failDatabase();
      vi.mocked(prompts.select).mockImplementation(({ options }) => {
        if (options.some((option) => option.value === 'retry')) {
          recovering = true;
          return Promise.resolve('account');
        }
        if (options.some((option) => option.value === accountId)) {
          if (recovering) remote.repairDatabase();
          return Promise.resolve(accountId);
        }
        return Promise.resolve('hearth');
      });
      const run = vi.spyOn(Cloudflare.prototype, 'run');
      await runCommand(setupCommand, { rawArgs: [argument] });
      expect(process.exitCode).toBe(0);
      expect(remote.deleted).toContain(`/d1/database/${databaseId}`);
      expect(run).not.toHaveBeenCalled();
      expect(rm).toHaveBeenCalledWith(stateFiles.setupDirectory, {
        recursive: true,
        force: true,
      });
    },
  );
});

it('empties multiple R2 pages in batches, including a retry after partial deletion', async () => {
  const keys = new Set(
    Array.from({ length: 1001 }, (_, index) => `object-${index}`),
  );
  const list = vi.fn(({ limit }: { limit: number }) =>
    Promise.resolve({
      objects: [...keys].slice(0, limit).map((key) => ({ key })),
      truncated: keys.size > limit,
    }),
  );
  const remove = vi.fn((selected: string[]) => {
    for (const key of selected) keys.delete(key);
    return Promise.resolve();
  });
  // One completed page followed by a failed deletion must be safe to resume.
  remove
    .mockImplementationOnce((selected: string[]) => {
      for (const key of selected) keys.delete(key);
      return Promise.resolve();
    })
    .mockRejectedValueOnce(new Error('interrupted'));
  const bucket = { list, delete: remove } as unknown as R2Bucket;
  await expect(
    emptyBucket(bucket, new AbortController().signal),
  ).rejects.toThrow('interrupted');
  expect(keys.size).toBe(1);
  await emptyBucket(bucket, new AbortController().signal);
  expect(keys.size).toBe(0);
});
