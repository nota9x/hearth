/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed operation results. */
/* eslint-disable unicorn/prefer-await -- Attach rejection handlers before advancing timers or cancelling child processes. */
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

import * as prompts from '@clack/prompts';
import { runCommand } from 'citty';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import * as productionConfig from '../../cli/production-config';
import {
  renderProduction,
  root,
  validateHostnames,
} from '../../cli/production-config';
import {
  Cloudflare,
  redact,
  retryTransient,
  SetupFailure,
  workerDomainSchema,
} from '../../cli/setup/cloudflare';
import setupCommand, {
  assertHearthTables,
  inspectConfig,
  reconcileDeployment,
} from '../../cli/setup/index';
import { withBindings } from '../../cli/setup/initialize';
import * as setupState from '../../cli/setup/state';
import {
  acquireLock,
  assertMigrationHistory,
  atomicWrite,
  loadState,
  saveState,
  setupDirectory,
  sourceFingerprint,
  stateSchema,
} from '../../cli/setup/state';
import manifest from '../../package.json' with { type: 'json' };

const directories: string[] = [];
afterEach(async () => {
  process.exitCode = 0;
  for (const directory of directories.splice(0))
    await rm(directory, { recursive: true, force: true });
});
async function temporary() {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'hearth setup & (test)-'),
  );
  directories.push(directory);
  return directory;
}
const options = {
  application: 'app.example.com',
  delivery: ['images.example.com'],
  databaseId: '3a428b1a-0807-4e60-8d70-78649e35bbf7',
  bucket: 'hearth-production',
  turnstile: '0x4AAAAAAA_real_sitekey',
  accountId: 'a'.repeat(32),
};
const fixture = path.join(root, 'tests/fixtures/setup-process.mjs');
function mockSetupTerminal() {
  const stdin = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const stdout = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
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
    `pnpm/${manifest.packageManager.split('@', 2)[1].split('+', 1)[0]} npm/? node/v24.19.0 win32 x64`,
  );
  vi.mocked(prompts.spinner).mockReturnValue({
    start: vi.fn(),
    stop: vi.fn(),
    message: vi.fn(),
    cancel: vi.fn(),
    error: vi.fn(),
    clear: vi.fn(),
    isCancelled: false,
  });
  return () => {
    if (stdin) Object.defineProperty(process.stdin, 'isTTY', stdin);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (stdout) Object.defineProperty(process.stdout, 'isTTY', stdout);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
  };
}

it.each(['bucket', 'database'])(
  'refuses %s resource adoption during fresh setup before provisioning or writes',
  async (kind) => {
    const restoreTerminal = mockSetupTerminal();
    vi.spyOn(setupState, 'loadState').mockResolvedValue(stateSchema.parse({}));
    vi.spyOn(setupState, 'optionalText').mockResolvedValue(undefined);
    vi.spyOn(setupState, 'saveState').mockResolvedValue();
    vi.spyOn(setupState, 'acquireLock').mockResolvedValue(() =>
      Promise.resolve(),
    );
    vi.spyOn(Cloudflare.prototype, 'identify').mockResolvedValue({
      loggedIn: true,
      authType: 'OAuth Token',
      accounts: [{ id: options.accountId, name: 'Account' }],
    });
    vi.spyOn(Cloudflare.prototype, 'credentials').mockResolvedValue();
    vi.spyOn(Cloudflare.prototype, 'pages').mockResolvedValue([
      { id: 'zone', name: 'example.com', status: 'active' },
    ]);
    vi.spyOn(Cloudflare.prototype, 'json').mockResolvedValue(
      kind === 'database'
        ? [{ name: 'hearth-production', uuid: options.databaseId }]
        : [],
    );
    vi.spyOn(Cloudflare.prototype, 'buckets').mockResolvedValue([
      { name: 'hearth-production' },
    ]);
    const run = vi.spyOn(Cloudflare.prototype, 'run').mockResolvedValue('');
    vi.mocked(prompts.text)
      .mockReset()
      .mockResolvedValueOnce(options.application)
      .mockResolvedValueOnce(options.delivery[0]);
    vi.mocked(prompts.select)
      .mockReset()
      .mockResolvedValueOnce(options.accountId)
      .mockResolvedValueOnce('cancel');
    vi.mocked(prompts.log.warn).mockClear();
    try {
      await runCommand(setupCommand, { rawArgs: [] });
      expect(run).not.toHaveBeenCalled();
      expect(prompts.log.warn).toHaveBeenCalledWith(
        expect.stringMatching(/new dedicated|creation provenance/i),
      );
      expect(process.exitCode).toBe(130);
    } finally {
      restoreTerminal();
    }
  },
);
const platform = vi.hoisted(() => ({ open: vi.fn() }));
vi.mock('wrangler', () => ({ getPlatformProxy: platform.open }));
vi.mock('@clack/prompts', async (importOriginal) => {
  const actual = await importOriginal<typeof prompts>();
  return {
    ...actual,
    intro: vi.fn(),
    cancel: vi.fn(),
    select: vi.fn(),
    text: vi.fn(),
    password: vi.fn(),
    confirm: vi.fn(),
    note: vi.fn(),
    spinner: vi.fn(),
    log: { ...actual.log, info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
});

it('generates matching private production bindings and retains migration/runtime requirements', async () => {
  const outputs = await renderProduction({
    ...options,
    namespaces: { LOGIN_LIMIT: '123456' },
  });
  expect(
    inspectConfig(
      Object.fromEntries(
        outputs.map((output) => [output.component, output.config]),
      ),
    ),
  ).toMatchObject(options);
  for (const output of outputs) {
    expect(output.config).toMatchObject({
      account_id: options.accountId,
      workers_dev: false,
      preview_urls: false,
      observability: { traces: { enabled: true } },
    });
    expect(output.config.d1_databases[0].database_id).toBe(options.databaseId);
    expect(output.config.r2_buckets[0].bucket_name).toBe(options.bucket);
  }
  expect(outputs[0].config.d1_databases[0].migrations_dir).toBe(
    '../../drizzle',
  );
  expect(outputs[0].config.ratelimits?.[0].namespace_id).toBe('123456');
  expect(outputs[2].config.triggers?.crons).toEqual(['*/5 * * * *']);
});
it('binds custom instances to their own maintenance Worker and rejects mismatches', async () => {
  const outputs = await renderProduction({ ...options, prefix: 'photos' });
  const configs = Object.fromEntries(
    outputs.map((output) => [output.component, output.config]),
  );
  expect(configs.web.durable_objects?.bindings).toEqual([
    {
      name: 'MAINTENANCE',
      class_name: 'MaintenanceJob',
      script_name: 'photos-maintenance',
    },
  ]);
  expect(() => inspectConfig(configs)).not.toThrow();
  configs.web.durable_objects!.bindings[0].script_name = 'hearth-maintenance';
  expect(() => inspectConfig(configs)).toThrow('private MAINTENANCE binding');
});
it('rejects application/delivery overlap and mismatched resource bindings before mutations', async () => {
  expect(() =>
    validateHostnames('app.example.com', ['app.example.com']),
  ).toThrow('different');
  const outputs = await renderProduction(options);
  outputs[1].config.r2_buckets[0].bucket_name = 'another-bucket';
  expect(() =>
    inspectConfig({ web: outputs[0].config, delivery: outputs[1].config }),
  ).toThrow('disagree');
  outputs[2].config.triggers = { crons: [] };
  expect(() => inspectConfig({ maintenance: outputs[2].config })).toThrow(
    'Maintenance is paused',
  );
});
it('keeps checkpoints credential-free and resumes resource/deployment observations', async () => {
  const directory = await temporary();
  const state = stateSchema.parse({
    ...options,
    prefix: 'hearth',
    databaseId: options.databaseId,
    provisionedDatabaseId: options.databaseId,
    provisionedBucket: {
      name: options.bucket,
      createdOn: '2026-10-19T00:00:00Z',
    },
    deployments: { delivery: { fingerprint: 'hash', versionId: 'version' } },
    token: 'do-not-save',
    plaintext: 'do-not-save',
  });
  await saveState(state, directory);
  expect(await loadState(directory)).toMatchObject({
    databaseId: options.databaseId,
    provisionedDatabaseId: options.databaseId,
    provisionedBucket: {
      name: options.bucket,
      createdOn: '2026-10-19T00:00:00Z',
    },
    deployments: state.deployments,
  });
  expect(
    await readFile(path.join(directory, 'state.json'), 'utf8'),
  ).not.toContain('do-not-save');
});
it('publishes new configuration exclusively and preserves an existing file', async () => {
  const file = path.join(await temporary(), 'production.local.jsonc');
  await atomicWrite(file, 'original', true);
  await expect(atomicWrite(file, 'replacement', true)).rejects.toThrow();
  expect(await readFile(file, 'utf8')).toBe('original');
});
it('prevents simultaneous installers and releases its lock', async () => {
  const directory = await temporary();
  const release = await acquireLock(directory);
  await expect(acquireLock(directory)).rejects.toThrow('running');
  await release();
  await (
    await acquireLock(directory)
  )();
});
it('refuses removed migration history and changes to an applied migration', () => {
  expect(() =>
    assertMigrationHistory(['0000_remarkable_jane_foster.sql'], {
      '0000_initial.sql': 'hash',
    }),
  ).toThrow('unsupported');
  expect(() =>
    assertMigrationHistory(
      ['0000_initial.sql'],
      { '0000_initial.sql': 'new' },
      { '0000_initial.sql': 'old' },
    ),
  ).toThrow('changed');
  expect(() =>
    assertMigrationHistory(['0000_initial.sql'], {
      '0000_initial.sql': 'hash',
    }),
  ).not.toThrow();
});
it('does not mistake an unrelated users table and common migration filename for Hearth', () => {
  expect(() =>
    assertHearthTables(['users', 'd1_migrations'], ['0000_initial.sql']),
  ).toThrow('complete compatible');
  expect(() =>
    assertHearthTables(['d1_migrations'], ['0000_initial.sql']),
  ).toThrow('complete compatible');
  expect(() => assertHearthTables(['d1_migrations'], [])).not.toThrow();
});
it('bounds transient retries and never automatically retries a permission failure', async () => {
  vi.useFakeTimers();
  const operation = vi
    .fn()
    .mockRejectedValue(new SetupFailure('offline', 'transient'));
  const result = retryTransient(operation).catch((error: unknown) => error);
  await vi.runAllTimersAsync();
  expect(await result).toBeInstanceOf(SetupFailure);
  expect(operation).toHaveBeenCalledTimes(3);
  const forbidden = vi
    .fn()
    .mockRejectedValue(new SetupFailure('forbidden', 'permission'));
  await expect(retryTransient(forbidden)).rejects.toThrow('forbidden');
  expect(forbidden).toHaveBeenCalledTimes(1);
});
it('redacts known credentials, bearer headers, Hearth keys and private query values', () => {
  const key = `img_live_${'a'.repeat(32)}_${'b'.repeat(64)}`;
  const output = redact(
    `Bearer arbitrary-token ${key} secret=hidden ?signature=proof&token=private supplied-secret`,
    ['supplied-secret'],
  );
  for (const value of [
    'arbitrary-token',
    key,
    'hidden',
    'proof',
    'private',
    'supplied-secret',
  ])
    expect(output).not.toContain(value);
});
it('passes a secret through stdin without shell expansion, arguments, or disk logging', async () => {
  const executable = path.join(await temporary(), 'process & helper.mjs');
  await copyFile(fixture, executable);
  const cloudflare = new Cloudflare({}, executable);
  const diagnostics = vi.spyOn(cloudflare, 'diagnostic').mockResolvedValue();
  const secret = 'a secret with spaces & $(not-a-command)';
  const output = JSON.parse(
    await cloudflare.run(['echo'], { input: secret, sensitive: true }),
  ) as { input: string; args: string[]; diskLogs: string };
  expect(output).toEqual({
    input: secret,
    args: ['echo', '--env-file', cloudflare.envFile],
    diskLogs: 'false',
  });
  expect(diagnostics).not.toHaveBeenCalled();
});
it('suppresses all secret-bearing output when a subprocess fails', async () => {
  const cloudflare = new Cloudflare({}, fixture);
  const diagnostics = vi.spyOn(cloudflare, 'diagnostic').mockResolvedValue();
  const failure = await cloudflare
    .run(['fail'], { input: 'unknown-sensitive-response', sensitive: true })
    .catch((error: unknown) => error);
  expect(failure).toBeInstanceOf(SetupFailure);
  expect(String(failure)).not.toContain('unknown-sensitive-response');
  expect(diagnostics).not.toHaveBeenCalled();
});
it('removes parent-shell token overrides from the actual child process while preserving the shell', async () => {
  vi.stubEnv('CLOUDFLARE_API_TOKEN', 'parent-only-token');
  vi.stubEnv('CF_API_TOKEN', 'legacy-parent-token');
  const cloudflare = new Cloudflare(process.env, fixture);
  cloudflare.browserAuthentication();
  const output: unknown = JSON.parse(
    await cloudflare.run(['environment'], { sensitive: true }),
  );
  expect(output).toMatchObject({ apiToken: null, legacyToken: null });
  expect(process.env.CLOUDFLARE_API_TOKEN).toBe('parent-only-token');
  cloudflare.useToken('replacement-child-token');
  const replacement: unknown = JSON.parse(
    await cloudflare.run(['environment'], { sensitive: true }),
  );
  expect(replacement).toMatchObject({
    apiToken: 'replacement-child-token',
    legacyToken: null,
  });
  expect(process.env.CLOUDFLARE_API_TOKEN).toBe('parent-only-token');
});
it('cancels a subprocess and its descendant without leaving a helper running', async () => {
  const file = path.join(await temporary(), 'pid');
  const cloudflare = new Cloudflare({}, fixture);
  const result = cloudflare
    .run(['wait', file])
    .catch((error: unknown) => error);
  let child = 0;
  for (let attempt = 0; !child && attempt < 40; attempt++) {
    try {
      child = Number(await readFile(file, 'utf8'));
    } catch {
      await setTimeout(50);
    }
  }
  expect(child).toBeGreaterThan(0);
  cloudflare.controller.abort();
  expect(await result).toBeInstanceOf(SetupFailure);
  expect(() => process.kill(child, 0)).toThrow();
});
it.each(['native', 'script'])(
  'builds with a %s package-manager executable',
  async (kind) => {
    const script = path.join(await temporary(), 'package manager.mjs');
    const native = kind === 'native';
    await writeFile(
      script,
      `#!/usr/bin/env node\nprocess.stdout.write(JSON.stringify(process.argv.slice(${native ? 1 : 2})));\nprocess.exit(0);\n`,
      { mode: 0o700 },
    );
    const cloudflare = new Cloudflare({
      ...process.env,
      npm_execpath: native ? process.execPath : script,
      NODE_OPTIONS: native
        ? `--import=${pathToFileURL(script).href}`
        : undefined,
    });
    const diagnostic = vi.spyOn(cloudflare, 'diagnostic').mockResolvedValue();
    await cloudflare.build();
    expect(diagnostic).toHaveBeenCalledExactlyOnceWith(
      'build',
      `${JSON.stringify([native ? path.join(root, 'run') : 'run', 'build'])}\n`,
    );
  },
);
it('paginates R2 inventories using cursors rather than parsing bucket tables', async () => {
  const cloudflare = new Cloudflare({});
  cloudflare.token = 'token';
  cloudflare.accountId = options.accountId;
  const request = vi
    .fn()
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        result: { buckets: [{ name: 'first' }] },
        result_info: { cursor: 'next-page' },
      }),
    )
    .mockResolvedValueOnce(
      Response.json({
        success: true,
        result: { buckets: [{ name: 'target' }] },
        errors: null,
        result_info: null,
      }),
    );
  vi.stubGlobal('fetch', request);
  expect(await cloudflare.buckets()).toEqual([
    { name: 'first' },
    { name: 'target' },
  ]);
  expect(String(request.mock.calls[1][0])).toContain('cursor=next-page');
});
it('preserves permission errors from the Cloudflare API', async () => {
  const cloudflare = new Cloudflare({});
  cloudflare.token = 'token';
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json(
        {
          success: false,
          result: null,
          result_info: null,
          errors: [{ code: 10_000, message: 'Permission denied' }],
        },
        { status: 403 },
      ),
    ),
  );
  await expect(
    cloudflare.api(
      '/accounts/account/workers/domains',
      z.array(workerDomainSchema),
    ),
  ).rejects.toMatchObject({
    kind: 'permission',
    message: 'Cloudflare 403: 10000: Permission denied.',
  });
});
it('checks both R2 public-access mechanisms before reusing a bucket', async () => {
  const cloudflare = new Cloudflare({});
  vi.spyOn(cloudflare, 'api')
    .mockResolvedValueOnce({ enabled: false })
    .mockResolvedValueOnce({
      domains: [{ domain: 'unsafe.example.com', enabled: true }],
    });
  await expect(cloudflare.assertPrivate('bucket')).rejects.toThrow(
    'public access',
  );
});

it('uses the creation response identity and rejects ambiguous D1 creation without resource adoption', async () => {
  const cloudflare = new Cloudflare({});
  cloudflare.accountId = options.accountId;
  vi.spyOn(cloudflare, 'api')
    .mockResolvedValueOnce({
      name: 'hearth-production',
      uuid: options.databaseId,
    })
    .mockRejectedValueOnce(new SetupFailure('lost response', 'transient'));
  const list = vi.spyOn(cloudflare, 'json');
  expect(await cloudflare.createDatabase('hearth-production')).toEqual({
    name: 'hearth-production',
    uuid: options.databaseId,
  });
  await expect(cloudflare.createDatabase('another')).rejects.toThrow(
    'lost response',
  );
  expect(list).not.toHaveBeenCalled();
});

it.each(['failure', 'cancellation'])(
  'disposes remote bindings and restores the parent environment after %s',
  async (mode) => {
    await mkdir(setupDirectory, { recursive: true });
    vi.stubEnv('CLOUDFLARE_API_TOKEN', 'original-parent-token');
    const cloudflare = new Cloudflare({});
    cloudflare.token = 'in-memory-preview-auth';
    cloudflare.accountId = options.accountId;
    const dispose = vi.fn().mockResolvedValue(undefined);
    platform.open.mockResolvedValueOnce({ env: {}, dispose });
    const config = (await renderProduction(options))[0].config;
    const failure = new SetupFailure('initialization failed');
    await expect(
      withBindings(cloudflare, config, () => {
        expect(process.env.CLOUDFLARE_API_TOKEN).toBe(cloudflare.token);
        if (mode === 'cancellation') cloudflare.controller.abort();
        return Promise.reject(failure);
      }),
    ).rejects.toBe(failure);
    expect(dispose).toHaveBeenCalledTimes(1);
    expect(process.env.CLOUDFLARE_API_TOKEN).toBe('original-parent-token');
    expect(
      await readFile(path.join(setupDirectory, 'bindings.local.jsonc'), 'utf8'),
    ).not.toContain(cloudflare.token);
  },
);

it('refuses to provision over a missing saved production database', async () => {
  const restoreTerminal = mockSetupTerminal();
  const web = (await renderProduction(options))[0];
  vi.spyOn(setupState, 'loadState').mockResolvedValue(
    stateSchema.parse({
      ...options,
      databaseName: 'hearth-production',
    }),
  );
  vi.spyOn(setupState, 'optionalText').mockImplementation((file) =>
    Promise.resolve(file === web.path ? web.content : undefined),
  );
  vi.spyOn(productionConfig, 'readConfig').mockResolvedValue(web.config);
  vi.spyOn(setupState, 'saveState').mockResolvedValue();
  vi.spyOn(setupState, 'acquireLock').mockResolvedValue(() =>
    Promise.resolve(),
  );
  vi.spyOn(Cloudflare.prototype, 'identify').mockResolvedValue({
    loggedIn: true,
    authType: 'OAuth Token',
    accounts: [{ id: options.accountId, name: 'Account' }],
  });
  vi.spyOn(Cloudflare.prototype, 'credentials').mockResolvedValue();
  vi.spyOn(Cloudflare.prototype, 'pages').mockResolvedValue([
    { id: 'zone', name: 'example.com', status: 'active' },
  ]);
  const discovery = vi
    .spyOn(Cloudflare.prototype, 'json')
    .mockResolvedValue([]);
  const run = vi.spyOn(Cloudflare.prototype, 'run').mockResolvedValue('');
  vi.mocked(prompts.text)
    .mockReset()
    .mockResolvedValueOnce(options.application)
    .mockResolvedValueOnce(options.delivery[0]);
  vi.mocked(prompts.select)
    .mockReset()
    .mockResolvedValueOnce(options.accountId)
    .mockResolvedValueOnce('cancel');
  vi.mocked(prompts.log.warn).mockClear();
  try {
    await runCommand(setupCommand, { rawArgs: [] });
    expect(discovery).toHaveBeenCalledExactlyOnceWith(
      ['d1', 'list', '--json'],
      expect.anything(),
    );
    expect(run).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(130);
  } finally {
    restoreTerminal();
  }
});

it.each([
  { phase: 'initial', method: 'browser' },
  { phase: 'initial', method: 'token' },
  { phase: 'expired', method: 'browser' },
])(
  'repairs $phase authentication using $method and resumes discovery',
  async ({ phase, method }) => {
    const restoreTerminal = mockSetupTerminal();
    vi.spyOn(setupState, 'loadState').mockResolvedValue(stateSchema.parse({}));
    vi.spyOn(setupState, 'optionalText').mockResolvedValue(undefined);
    vi.spyOn(setupState, 'saveState').mockResolvedValue();
    const release = vi.fn().mockResolvedValue(undefined);
    vi.spyOn(setupState, 'acquireLock').mockResolvedValue(release);
    const identify = vi
      .spyOn(Cloudflare.prototype, 'identify')
      .mockResolvedValue({
        loggedIn: true,
        authType: 'OAuth Token',
        accounts: [{ id: options.accountId, name: 'Account' }],
      });
    if (phase === 'initial')
      identify.mockRejectedValueOnce(
        new SetupFailure('not logged in', 'authentication'),
      );
    else
      identify
        .mockResolvedValueOnce({
          loggedIn: true,
          authType: 'OAuth Token',
          accounts: [{ id: options.accountId, name: 'Account' }],
        })
        .mockRejectedValueOnce(new SetupFailure('expired', 'authentication'));
    const login = vi.spyOn(Cloudflare.prototype, 'run').mockResolvedValue('');
    const useToken = vi.spyOn(Cloudflare.prototype, 'useToken');
    vi.spyOn(Cloudflare.prototype, 'credentials').mockResolvedValue();
    const discovery = vi
      .spyOn(Cloudflare.prototype, 'pages')
      .mockResolvedValue([]);
    if (phase === 'expired')
      discovery.mockRejectedValueOnce(
        new SetupFailure('expired', 'authentication'),
      );
    vi.mocked(prompts.select).mockReset();
    if (phase === 'expired')
      vi.mocked(prompts.select).mockResolvedValueOnce(options.accountId);
    vi.mocked(prompts.select).mockResolvedValueOnce(method);
    if (phase === 'initial')
      vi.mocked(prompts.select).mockResolvedValueOnce(options.accountId);
    vi.mocked(prompts.select).mockResolvedValueOnce('cancel');
    vi.mocked(prompts.password).mockResolvedValue('test-scoped-token');
    try {
      await runCommand(setupCommand, { rawArgs: [] });
      expect(login.mock.calls).toEqual(
        method === 'browser' ? [[['login'], { interactive: true }]] : [],
      );
      expect(useToken.mock.calls).toEqual(
        method === 'token' ? [['test-scoped-token']] : [],
      );
      expect(discovery).toHaveBeenLastCalledWith(
        `/zones?account.id=${options.accountId}`,
        expect.anything(),
      );
      expect(release).toHaveBeenCalledTimes(1);
      expect(process.exitCode).toBe(130);
    } finally {
      restoreTerminal();
    }
  },
);

it.each(['unused', 'another-worker'])(
  'checks %s hostnames with default Wrangler OAuth without DNS record access',
  async (owner) => {
    const restoreTerminal = mockSetupTerminal();
    vi.spyOn(setupState, 'loadState').mockResolvedValue(stateSchema.parse({}));
    vi.spyOn(setupState, 'optionalText').mockResolvedValue(undefined);
    vi.spyOn(setupState, 'saveState').mockResolvedValue();
    vi.spyOn(setupState, 'acquireLock').mockResolvedValue(() =>
      Promise.resolve(),
    );
    vi.spyOn(Cloudflare.prototype, 'identify').mockResolvedValue({
      loggedIn: true,
      authType: 'OAuth Token',
      accounts: [{ id: options.accountId, name: 'Account' }],
      tokenPermissions: ['zone:read', 'workers:write', 'workers_scripts:write'],
    });
    vi.spyOn(Cloudflare.prototype, 'credentials').mockResolvedValue();
    const pages = vi
      .spyOn(Cloudflare.prototype, 'pages')
      .mockResolvedValue([
        { id: 'zone', name: 'example.com', status: 'active' },
      ]);
    vi.spyOn(Cloudflare.prototype, 'json').mockImplementation((arguments_) =>
      Promise.resolve(
        arguments_[0] === 'd1'
          ? []
          : [
              {
                sitekey: options.turnstile,
                name: 'Hearth login',
                domains: [options.application],
                mode: 'managed',
              },
            ],
      ),
    );
    vi.spyOn(Cloudflare.prototype, 'buckets').mockResolvedValue([]);
    vi.spyOn(Cloudflare.prototype, 'worker').mockResolvedValue(undefined);
    const domains =
      owner === 'unused'
        ? []
        : [
            {
              hostname: options.application,
              service: owner,
            },
            {
              hostname: options.delivery[0],
              service: owner,
            },
          ];
    vi.spyOn(Cloudflare.prototype, 'api').mockImplementation((resource) =>
      Promise.resolve(
        resource.endsWith('/workers/domains')
          ? domains
          : { subdomain: 'hearth-test' },
      ),
    );
    const run = vi.spyOn(Cloudflare.prototype, 'run').mockResolvedValue('');
    vi.mocked(prompts.text)
      .mockReset()
      .mockResolvedValueOnce(options.application)
      .mockResolvedValueOnce(options.delivery[0])
      .mockResolvedValueOnce('Administrator');
    vi.mocked(prompts.select)
      .mockReset()
      .mockResolvedValueOnce(options.accountId)
      .mockResolvedValueOnce('cancel');
    vi.mocked(prompts.confirm).mockReset().mockResolvedValue(false);
    vi.mocked(prompts.note).mockClear();
    vi.mocked(prompts.log.warn).mockClear();
    try {
      await runCommand(setupCommand, { rawArgs: [] });
      expect(pages).toHaveBeenCalledExactlyOnceWith(
        `/zones?account.id=${options.accountId}`,
        expect.anything(),
      );
      expect(prompts.confirm).not.toHaveBeenCalled();
      expect(run).not.toHaveBeenCalled();
      expect(
        vi.mocked(prompts.note).mock.calls.map(([, title]) => title),
      ).toEqual(owner === 'another-worker' ? [] : ['Installation review']);
      expect(process.exitCode).toBe(130);
    } finally {
      restoreTerminal();
    }
  },
);

it('keeps Wrangler deployment interactive so real DNS conflicts require a choice', async () => {
  const cloudflare = new Cloudflare({});
  const run = vi
    .spyOn(cloudflare, 'run')
    .mockRejectedValue(new SetupFailure('cancelled'));
  await expect(
    cloudflare.deploy(
      'production.local.jsonc',
      `hearth-test-${crypto.randomUUID()}`,
      'hash',
    ),
  ).rejects.toThrow('cancelled');
  expect(run).toHaveBeenCalledWith(
    expect.arrayContaining(['deploy']),
    expect.objectContaining({ interactive: true }),
  );
});

async function deployment() {
  const config = (await renderProduction(options))[1].config;
  const settings = {
    bindings: [
      { name: 'DB', type: 'd1', id: options.databaseId },
      { name: 'BUCKET', type: 'r2_bucket', bucket_name: options.bucket },
      ...Object.entries(config.vars ?? {}).map(([name, value]) => ({
        name,
        type: 'plain_text',
        text: value,
      })),
      ...(config.ratelimits ?? []).map((limit) => ({
        ...limit,
        type: 'ratelimit',
      })),
    ],
    compatibility_date: config.compatibility_date,
    compatibility_flags: config.compatibility_flags,
  };
  const state = stateSchema.parse({});
  const cloudflare = new Cloudflare({});
  cloudflare.accountId = options.accountId;
  vi.spyOn(cloudflare, 'activeVersion').mockResolvedValue('existing');
  vi.spyOn(cloudflare, 'worker').mockResolvedValue(settings);
  const run = vi.spyOn(cloudflare, 'run').mockResolvedValue('');
  const deploy = vi.spyOn(cloudflare, 'deploy').mockResolvedValue('new');
  const api = vi
    .spyOn(cloudflare, 'api')
    .mockImplementation((resource) =>
      Promise.resolve(
        resource.endsWith('/subdomain')
          ? { enabled: false, previews_enabled: false }
          : [{ hostname: 'images.example.com', service: config.name }],
      ),
    );
  return { config, settings, state, cloudflare, run, deploy, api };
}
describe('deployment recovery', () => {
  it('repairs a missing domain without uploading the already active code again', async () => {
    const { config, state, cloudflare, run, deploy, api } = await deployment();
    state.deployments.delivery = {
      fingerprint: await sourceFingerprint('delivery', config),
      versionId: 'existing',
    };
    api.mockResolvedValueOnce([]);
    await reconcileDeployment(
      cloudflare,
      'delivery',
      config,
      state,
      async () => {},
    );
    expect(run).toHaveBeenCalledWith(
      ['triggers', 'deploy'],
      expect.objectContaining({ interactive: true }),
    );
    expect(deploy).not.toHaveBeenCalled();
  });
  it('recovers a deployment whose success checkpoint was lost', async () => {
    const { config, state, cloudflare, deploy, api } = await deployment();
    api.mockResolvedValueOnce({
      annotations: {
        'workers/message': `Hearth setup ${await sourceFingerprint('delivery', config)}`,
      },
    });
    await reconcileDeployment(
      cloudflare,
      'delivery',
      config,
      state,
      async () => {},
    );
    expect(deploy).not.toHaveBeenCalled();
    expect(state.deployments.delivery?.versionId).toBe('existing');
  });
});
