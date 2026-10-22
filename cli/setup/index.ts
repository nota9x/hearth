/* eslint-disable unicorn/no-await-expression-member -- Inspect structured command results immediately at the step that requests them. */
/* eslint-disable unicorn/no-top-level-side-effects -- Citty constructs the exported command definition. */
import { randomInt } from 'node:crypto';
import { access, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout } from 'node:timers/promises';
import { styleText } from 'node:util';

import * as prompts from '@clack/prompts';
import { defineCommand } from 'citty';
import { execa } from 'execa';
import { z } from 'zod';

import manifest from '../../package.json' with { type: 'json' };
import { id, now } from '../../packages/core/common';
import { prepareBootstrap } from '../bootstrap-data';
import { validateOptions } from '../options';
import {
  bucketName,
  type Component,
  components,
  configPath,
  type ProductionConfig,
  publicHostname,
  readConfig,
  renderProduction,
  root,
  validateHostnames,
} from '../production-config';
import {
  Cloudflare,
  databaseSchema,
  redact,
  retryTransient,
  SetupFailure,
  type Widget,
  widgetSchema,
  workerDomainSchema,
  type WorkerSettings,
} from './cloudflare';
import { dashboard } from './dashboard';
import {
  administrator,
  initializeDomains,
  initializeFreshStorage,
  verifyBrowserLogin,
  verifyUpload,
  withBindings,
} from './initialize';
import { recoveryOptions, selectAccount } from './interaction';
import {
  acquireLock,
  assertMigrationHistory,
  atomicWrite,
  isMissing,
  loadState,
  migrationFiles,
  optionalText,
  saveState,
  setupDirectory,
  type SetupState,
  sourceFingerprint,
} from './state';

class Cancelled extends Error {
  constructor() {
    super('Setup cancelled');
    this.name = 'SetupCancelled';
  }
}
class EditSetup extends Error {}
async function answer<T>(value: Promise<T>): Promise<Exclude<T, symbol>> {
  const result = await value;
  if (prompts.isCancel(result)) throw new Cancelled();
  return result as Exclude<T, symbol>;
}
const prefixSchema = z.string().regex(/^[a-z][a-z0-9-]{1,38}[a-z0-9]$/);
const validation = (schema: z.ZodType, value: string | undefined) => {
  const result = schema.safeParse(value);
  return result.success ? undefined : result.error.issues[0].message;
};
const text = (
  message: string,
  initialValue: string,
  schema: z.ZodType = z.string().trim().min(1),
) =>
  answer(
    prompts.text({
      message,
      initialValue,
      validate: (value) => validation(schema, value),
    }),
  );
const confirmed = (message: string, initialValue = false) =>
  answer(prompts.confirm({ message, initialValue }));

export function inspectConfig(
  configs: Partial<Record<Component, ProductionConfig>>,
) {
  const entries = Object.entries(configs) as [Component, ProductionConfig][];
  if (entries.length === 0) return;
  const databaseIds = new Set<string>();
  const buckets = new Set<string>();
  const origins = new Set<string>();
  const accounts = new Set<string>();
  for (const [component, config] of entries) {
    const database = config.d1_databases.find(
      (binding) => binding.binding === 'DB',
    );
    const bucket = config.r2_buckets.find(
      (binding) => binding.binding === 'BUCKET',
    );
    if (
      !database ||
      !bucket ||
      config.workers_dev !== false ||
      config.preview_urls !== false
    )
      throw new SetupFailure(
        `${configPath(component)} must use DB/BUCKET bindings and disable workers_dev and preview_urls. Review it and retry.`,
      );
    databaseIds.add(database.database_id);
    buckets.add(bucket.bucket_name);
    if (config.account_id) accounts.add(config.account_id);
    if (component !== 'maintenance') {
      if (config.vars?.ENVIRONMENT !== 'production' || !config.vars.APP_ORIGIN)
        throw new SetupFailure(
          `${component} requires ENVIRONMENT=production and APP_ORIGIN.`,
        );
      const origin = new URL(config.vars.APP_ORIGIN);
      if (
        origin.protocol !== 'https:' ||
        origin.origin !== config.vars.APP_ORIGIN
      )
        throw new SetupFailure(
          'Production APP_ORIGIN must be a canonical HTTPS origin.',
        );
      origins.add(origin.origin);
    }
    if ((config.routes ?? []).some((route) => route.custom_domain !== true))
      throw new SetupFailure(
        'Setup supports exact Worker Custom Domains. Preserve/review any custom routing manually before continuing.',
      );
    if (component === 'web' && database.migrations_dir !== '../../drizzle')
      throw new SetupFailure(
        'The web DB binding must retain migrations_dir="../../drizzle".',
      );
    if (component === 'maintenance' && !config.triggers?.crons.length)
      throw new SetupFailure(
        'Maintenance is paused or has no cron schedule. Complete the documented update/maintenance procedure and restore its schedule before retrying setup.',
      );
  }
  if (
    databaseIds.size !== 1 ||
    buckets.size !== 1 ||
    origins.size > 1 ||
    accounts.size > 1
  )
    throw new SetupFailure(
      'Production files disagree about the account, DB, BUCKET, or APP_ORIGIN. Correct the mismatch before retrying; no resources were changed.',
    );
  const origin = origins.values().next().value;
  const web = configs.web;
  const maintenance = configs.maintenance;
  for (const [component, config] of entries) {
    if (component === 'delivery') continue;
    const binding = config.durable_objects?.bindings.find(
      (binding) => binding.name === 'MAINTENANCE',
    );
    if (
      binding?.class_name !== 'MaintenanceJob' ||
      (component === 'web'
        ? !binding.script_name ||
          (maintenance && binding.script_name !== maintenance.name)
        : binding.script_name !== undefined ||
          config.exports?.MaintenanceJob?.storage !== 'sqlite')
    )
      throw new SetupFailure(
        `${component} requires the private MAINTENANCE binding to its maintenance Worker's SQLite MaintenanceJob class. Update the production configuration before retrying.`,
      );
  }
  if (
    web &&
    (web.routes ?? []).every((route) => `https://${route.pattern}` !== origin)
  )
    throw new SetupFailure('The web Custom Domain must match APP_ORIGIN.');
  return {
    accountId: accounts.values().next().value,
    databaseId: [...databaseIds][0],
    bucket: [...buckets][0],
    application: origin ? new URL(origin).hostname : undefined,
    delivery: configs.delivery?.routes?.map((route) => route.pattern) ?? [],
    turnstile: web?.vars?.TURNSTILE_SITE_KEY,
    databaseName: entries[0][1].d1_databases.find(
      (binding) => binding.binding === 'DB',
    )?.database_name,
  };
}

export function matchesSettings(
  config: ProductionConfig,
  settings: WorkerSettings,
) {
  const db = config.d1_databases.find((binding) => binding.binding === 'DB');
  const bucket = config.r2_buckets.find(
    (binding) => binding.binding === 'BUCKET',
  );
  return (
    settings.bindings.some(
      (binding) => binding.name === 'DB' && binding.id === db?.database_id,
    ) &&
    settings.bindings.some(
      (binding) =>
        binding.name === 'BUCKET' &&
        binding.bucket_name === bucket?.bucket_name,
    ) &&
    Object.entries(config.vars ?? {}).every(([name, value]) =>
      settings.bindings.some(
        (binding) => binding.name === name && binding.text === value,
      ),
    ) &&
    (config.ratelimits ?? []).every((limit) =>
      settings.bindings.some(
        (binding) =>
          binding.name === limit.name &&
          String(binding.namespace_id) === limit.namespace_id &&
          binding.simple?.limit === limit.simple.limit &&
          binding.simple.period === limit.simple.period,
      ),
    ) &&
    (config.durable_objects?.bindings ?? []).every((expected) =>
      settings.bindings.some(
        (binding) =>
          binding.type === 'durable_object_namespace' &&
          binding.name === expected.name &&
          binding.class_name === expected.class_name &&
          (binding.script_name ?? config.name) ===
            (expected.script_name ?? config.name),
      ),
    ) &&
    settings.compatibility_date === config.compatibility_date &&
    (settings.compatibility_flags ?? []).length ===
      config.compatibility_flags.length &&
    config.compatibility_flags.every((flag) =>
      settings.compatibility_flags?.includes(flag),
    )
  );
}

export function assertHearthTables(tables: string[], applied: string[]) {
  const appTables = tables.filter((name) => name !== 'd1_migrations');
  if (appTables.length === 0 && applied.length === 0) return;
  const required = [
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
  if (
    !applied.includes('0000_initial.sql') ||
    required.some((name) => !tables.includes(name))
  )
    throw new SetupFailure(
      'This database is not empty or a complete compatible Hearth installation. Select a fresh D1 database; existing tables are preserved.',
    );
}

export async function reconcileDeployment(
  cloudflare: Cloudflare,
  component: Component,
  config: ProductionConfig,
  state: SetupState,
  checkpoint: () => Promise<void>,
) {
  const fingerprint = await sourceFingerprint(component, config);
  const current = await cloudflare.activeVersion(config.name);
  const settings = current ? await cloudflare.worker(config.name) : undefined;
  const previous = state.deployments[component];
  let codeMatches =
    !!current &&
    previous?.versionId === current &&
    previous.fingerprint === fingerprint;
  if (current && !codeMatches) {
    const version = await cloudflare.api(
      `/accounts/${cloudflare.accountId}/workers/scripts/${config.name}/versions/${current}`,
      z.looseObject({
        annotations: z.record(z.string(), z.string()).optional(),
        metadata: z
          .looseObject({
            annotations: z.record(z.string(), z.string()).optional(),
          })
          .optional(),
      }),
    );
    const annotations = version?.annotations ?? version?.metadata?.annotations;
    codeMatches =
      annotations?.['workers/message'] === `Hearth setup ${fingerprint}`;
  }
  if (codeMatches && settings && matchesSettings(config, settings)) {
    try {
      await verifyRemoteConfig(cloudflare, component, config);
    } catch (error) {
      if (!(error instanceof SetupFailure) || error.kind !== 'configuration')
        throw error;
      await cloudflare.run(['triggers', 'deploy'], {
        config: configPath(component),
        interactive: true,
      });
    }
    state.deployments[component] = { fingerprint, versionId: current! };
  } else {
    const versionId = await cloudflare.deploy(
      configPath(component),
      config.name,
      fingerprint,
    );
    state.deployments[component] = { fingerprint, versionId };
  }
  await checkpoint();
  await verifyRemoteConfig(cloudflare, component, config);
}

async function verifyRemoteConfig(
  cloudflare: Cloudflare,
  component: Component,
  config: ProductionConfig,
) {
  const settings = await cloudflare.worker(config.name);
  if (!settings || !matchesSettings(config, settings))
    throw new SetupFailure(
      `${component} remote bindings/runtime settings do not match the reviewed configuration. Retry to repair this Worker.`,
    );
  const domains = await cloudflare.api(
    `/accounts/${cloudflare.accountId}/workers/domains?service=${encodeURIComponent(config.name)}`,
    z.array(workerDomainSchema),
  );
  if (
    (config.routes ?? []).some(
      (route) =>
        !domains?.some(
          (domain) =>
            domain.hostname === route.pattern && domain.service === config.name,
        ),
    )
  )
    throw new SetupFailure(
      `${component} code deployed, but its Custom Domain is not attached yet. Resolve DNS/zone permission conflicts and retry.`,
    );
  const subdomain = await cloudflare.api(
    `/accounts/${cloudflare.accountId}/workers/scripts/${config.name}/subdomain`,
    z.object({
      enabled: z.boolean(),
      previews_enabled: z.boolean().optional(),
    }),
  );
  if (subdomain?.enabled || subdomain?.previews_enabled)
    throw new SetupFailure(
      `${component} still exposes workers.dev or preview URLs. Retry to apply the reviewed private routing settings.`,
    );
  if (component !== 'maintenance') return;
  const schedules = await cloudflare.api(
    `/accounts/${cloudflare.accountId}/workers/scripts/${config.name}/schedules`,
    z.object({ schedules: z.array(z.object({ cron: z.string() })) }),
  );
  const expected = config.triggers?.crons ?? [];
  if (
    !schedules ||
    schedules.schedules.length !== expected.length ||
    schedules.schedules.some((entry) => !expected.includes(entry.cron))
  )
    throw new SetupFailure(
      'Maintenance cron does not match the production configuration. Retry trigger deployment.',
    );
}

async function openBrowser(url: string) {
  const command =
    process.platform === 'win32'
      ? 'rundll32.exe'
      : process.platform === 'darwin'
        ? 'open'
        : 'xdg-open';
  const arguments_ =
    process.platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  try {
    await execa(command, arguments_, {
      shell: false,
      reject: false,
      stdio: 'ignore',
      timeout: 10_000,
    });
  } catch {
    // The displayed login URL remains usable when a browser cannot be opened.
  }
}

async function runSetup(advanced: boolean, remove = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new SetupFailure(
      'Guided setup requires an interactive terminal. Run pnpm run setup in your terminal; manual deployment remains documented.',
    );
  const cloudflare = new Cloudflare();
  const state = await loadState();
  const unlock = await acquireLock();
  const stop = () => cloudflare.controller.abort();
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  const checkpoint = () => saveState(state);
  let removed = false;
  let key: string | undefined;
  let candidate: Awaited<ReturnType<typeof prepareBootstrap>> | undefined;
  let identity: Awaited<ReturnType<Cloudflare['identify']>> | undefined;
  let accountChoice: string | undefined;
  const colors =
    process.stdout.hasColors?.() &&
    process.env.NO_COLOR === undefined &&
    process.env.NODE_DISABLE_COLORS === undefined &&
    process.env.FORCE_COLOR !== '0';
  const badge = colors
    ? '\u{1B}[1;38;2;22;19;17;48;2;196;113;74m hearth \u{1B}[0m'
    : ' hearth ';
  const paint = (format: Parameters<typeof styleText>[0], text: string) =>
    colors ? styleText(format, text, { validateStream: false }) : text;
  prompts.intro(
    `${badge}  ${paint('bold', remove ? 'Cloudflare Uninstall' : 'Cloudflare Setup')}`,
  );
  prompts.log.info(
    remove
      ? 'Discover and remove your Hearth installation.'
      : "Welcome! Let's get you set up.",
  );
  prompts.log.info(
    `${paint(['bold', 'yellow'], 'hearth')}  ${paint('dim', 'Copyright (C) 2026')}  ${paint(['bold', 'cyan'], 'a9x Development')}`,
  );

  async function authenticate(reconnect = false) {
    if (!reconnect) {
      try {
        identity = await cloudflare.identify();
        await cloudflare.credentials();
        return;
      } catch (error) {
        if (error instanceof SetupFailure && error.kind === 'transient')
          throw error;
        prompts.log.info(
          'Log in with Wrangler or choose advanced API options to connect to Cloudflare.',
        );
      }
    }
    while (true) {
      const method = await answer(
        prompts.select({
          message: 'Connect to Cloudflare',
          options: [
            {
              value: 'browser',
              label: 'Log in with Wrangler',
              hint: 'Uses Wrangler OAuth',
            },
            {
              value: 'device',
              label: 'Device login',
              hint: 'For SSH, containers, or blocked callbacks',
            },
            {
              value: 'token',
              label: 'Advanced API options',
              hint: 'Use a scoped API token; kept in memory',
            },
            { value: 'retry', label: 'Retry existing credentials' },
            { value: 'cancel', label: 'Save progress and exit' },
          ],
        }),
      );
      if (method === 'cancel') throw new Cancelled();
      if (method === 'token') {
        const token = await answer(
          prompts.password({
            message: 'Cloudflare API token',
            validate: (value) =>
              value?.trim() ? undefined : 'Enter a scoped API token.',
          }),
        );
        cloudflare.useToken(token.trim());
      } else if (method !== 'retry') {
        cloudflare.browserAuthentication();
        try {
          await cloudflare.run(
            ['login', ...(method === 'device' ? ['--device'] : [])],
            { interactive: true },
          );
        } catch {
          prompts.log.warn(
            'Login did not complete. You can retry or choose another authentication method.',
          );
          continue;
        }
      }
      try {
        identity = await cloudflare.identify();
        await cloudflare.credentials();
        if (
          !reconnect &&
          state.accountId &&
          identity.accounts.every((account) => account.id !== state.accountId)
        ) {
          prompts.log.warn(
            'These credentials cannot reach the saved account. Authenticate with access to that account.',
          );
          continue;
        }
        return;
      } catch {
        prompts.log.warn(
          'Cloudflare could not verify these credentials. Check account access and try again.',
        );
      }
    }
  }

  async function chooseAccount() {
    if (!identity) await authenticate();
    return selectAccount(
      identity!.accounts,
      answer,
      cloudflare.accountId ?? state.accountId,
      async () => {
        await authenticate(true);
        return identity!.accounts;
      },
    );
  }

  async function step<T>(
    label: string,
    operation: () => Promise<T>,
    readOnly = false,
    interactive = false,
  ): Promise<T> {
    let refreshedAuthentication = false;
    while (true) {
      cloudflare.controller.signal.throwIfAborted();
      const spinner = interactive ? undefined : prompts.spinner();
      spinner?.start(label);
      try {
        const value = await (readOnly
          ? retryTransient(operation, cloudflare.controller.signal)
          : operation());
        spinner?.stop(label);
        return value;
      } catch (error) {
        spinner?.stop(`${label} failed`);
        if (cloudflare.controller.signal.aborted || error instanceof Cancelled)
          throw new Cancelled();
        const message =
          error instanceof Error
            ? redact(error.message, cloudflare.secrets)
            : 'This step could not complete.';
        prompts.log.warn(message);
        if (error instanceof SetupFailure && error.dashboard)
          prompts.log.info(error.dashboard);
        if (
          !refreshedAuthentication &&
          error instanceof SetupFailure &&
          error.kind === 'authentication'
        ) {
          refreshedAuthentication = true;
          await authenticate();
          continue;
        }
        const choice = await answer(
          prompts.select({
            message:
              'This step failed. Completed work is preserved. What would you like to do?',
            options: [
              ...recoveryOptions,
              { value: 'edit', label: 'Review setup inputs' },
              { value: 'cancel', label: 'Save progress and exit' },
            ],
          }),
        );
        if (choice === 'cancel') throw new Cancelled();
        if (choice === 'edit') throw new EditSetup();
        if (choice === 'account') {
          accountChoice = await chooseAccount();
          throw new EditSetup();
        }
      }
    }
  }

  async function turnstileSecret() {
    let secret: string | undefined;
    try {
      const details = await cloudflare.json(
        ['turnstile', 'widget', 'get', state.turnstile!, '--json'],
        widgetSchema,
        { sensitive: true },
      );
      if (
        details.sitekey !== state.turnstile ||
        !details.domains.includes(state.application!) ||
        details.mode !== 'managed'
      )
        throw new SetupFailure(
          'The selected widget does not match the reviewed hostname and mode.',
        );
      secret = details.secret;
    } catch (error) {
      if (cloudflare.controller.signal.aborted) throw new Cancelled();
      prompts.log.warn(
        'Cloudflare could not retrieve the selected widget’s secret. You can enter its existing secret from the Turnstile Dashboard.',
      );
      if (!(await confirmed('Enter this widget’s secret securely instead?')))
        throw error;
    }
    if (!secret?.trim())
      secret = await answer(
        prompts.password({
          message: `Secret for Turnstile widget ${state.turnstile}`,
          validate: (value) =>
            value?.trim() ? undefined : 'Enter the matching widget secret.',
        }),
      );
    cloudflare.secrets.add(secret);
    return secret;
  }

  try {
    const manager = cloudflare.environment.npm_config_user_agent;
    const version = manifest.packageManager.split('@', 2)[1].split('+', 1)[0];
    if (manager?.split(' ', 1)[0] !== `pnpm/${version}`)
      throw new SetupFailure(
        [
          `Run setup through pnpm ${version}, as declared in package.json (detected: ${manager?.split(' ', 1)[0] ?? 'unknown'}).`,
          `Direct pnpm installation: from outside this repository, run pnpm self-update ${version}.`,
          `If installed with npm, run npm install --global pnpm@${version}.`,
          'To switch to Corepack, first uninstall your existing global pnpm with its original installer (npm uninstall --global pnpm for npm installs; remove standalone pnpm/pnpx binaries from PATH). Then run:',
          '  npm install --global corepack@latest',
          '  corepack enable pnpm',
          '  corepack install',
          'Run corepack install from this repository to use package.json, then retry pnpm run setup.',
        ].join('\n'),
      );
    const installed: unknown = JSON.parse(
      await readFile(
        path.join(root, 'node_modules/wrangler/package.json'),
        'utf8',
      ),
    );
    if (
      !z
        .object({ version: z.literal(manifest.devDependencies.wrangler) })
        .safeParse(installed).success
    ) {
      if (
        !(await confirmed(
          'Restore the tested Wrangler version with pnpm install --frozen-lockfile?',
          true,
        ))
      )
        throw new Cancelled();
      const managerPath = cloudflare.environment.npm_execpath;
      if (!managerPath)
        throw new SetupFailure(
          'Run pnpm install --frozen-lockfile, then retry setup.',
        );
      const result = await execa(
        managerPath,
        ['install', '--frozen-lockfile'],
        {
          stdio: 'inherit',
          reject: false,
          cancelSignal: cloudflare.controller.signal,
          killDescendants: true,
        },
      );
      if (result.exitCode !== 0)
        throw new SetupFailure(
          'The locked dependency installation failed. Correct the package-manager error before retrying.',
        );
    }
    await step('Connect to Cloudflare', () => authenticate(), true, true);
    accountChoice = await chooseAccount();
    if (
      !remove &&
      (await optionalText(path.join(setupDirectory, 'uninstall.json')))
    )
      throw new SetupFailure(
        'An uninstall is pending. Finish it with pnpm run setup --uninstall before installing again.',
      );
    while (true) {
      try {
        if (remove) {
          const { uninstall } = await import('./uninstall');
          removed = await uninstall(
            cloudflare,
            state,
            identity!.accounts,
            answer,
            accountChoice,
          );
          return;
        }
        const configs: Partial<Record<Component, ProductionConfig>> = {};
        const originals: Partial<Record<Component, string>> = {};
        await step('Read production configuration', async () => {
          for (const component of components) {
            const original = await optionalText(configPath(component));
            if (original === undefined) {
              continue;
            }

            configs[component] = await readConfig(configPath(component));
            originals[component] = original;
          }
        });
        if (!identity)
          throw new SetupFailure('Cloudflare identity could not be verified.');
        const existing = inspectConfig(configs);
        const accountId =
          accountChoice ?? existing?.accountId ?? state.accountId;
        if (
          accountId &&
          identity.accounts.every((account) => account.id !== accountId)
        )
          throw new SetupFailure(
            'The production account is unavailable to these credentials. Repair authentication to access it.',
            'authentication',
          );
        const selectedAccount: string = accountChoice;
        if (
          (existing?.accountId && existing.accountId !== selectedAccount) ||
          (state.accountId &&
            state.accountId !== selectedAccount &&
            (state.databaseId || state.created.bucket || state.created.widget))
        )
          throw new SetupFailure(
            'Existing configuration belongs to another account. Use its account or a separate checkout for a new instance.',
          );
        state.accountId = selectedAccount;
        cloudflare.accountId = selectedAccount;
        if (existing) {
          if (state.databaseId && state.databaseId !== existing.databaseId)
            throw new SetupFailure(
              'Saved setup and production files reference different databases. Review the files before adopting a different instance.',
            );
          state.databaseId = existing.databaseId;
          state.bucket = existing.bucket;
          state.application = existing.application ?? state.application;
          if (existing.delivery.length > 0) state.delivery = existing.delivery;
          state.turnstile = existing.turnstile ?? state.turnstile;
          state.databaseName = existing.databaseName ?? state.databaseName;
        }
        const zones = await step(
          'Discover active Cloudflare zones',
          () =>
            cloudflare.pages(
              `/zones?account.id=${state.accountId}`,
              z.object({
                id: z.string(),
                name: z.string(),
                status: z.string(),
              }),
            ),
          true,
        );
        const activeZones = zones.filter((zone) => zone.status === 'active');
        if (activeZones.length === 0)
          throw new SetupFailure(
            'No active zone is available in this account. Add/activate your domain in Cloudflare, or select the correct account.',
            'configuration',
            dashboard(state.accountId, 'domains'),
          );
        const defaultZone = activeZones[0].name;
        state.application = await text(
          'Application hostname',
          state.application ?? `app.${defaultZone}`,
          publicHostname,
        );
        const hostList = await text(
          'Image delivery hostname' + (advanced ? 's (comma separated)' : ''),
          state.delivery.join(', ') || `images.${defaultZone}`,
        );
        state.delivery = hostList
          .split(',')
          .map((value) => value.trim())
          .filter(Boolean);
        const hosts = validateHostnames(state.application, state.delivery);
        state.application = hosts.application;
        state.delivery = hosts.delivery;
        if (advanced) {
          state.prefix = await text(
            'Worker name prefix',
            state.prefix,
            prefixSchema,
          );
          const databaseName = await text(
            'D1 database name',
            state.databaseName,
          );
          if (databaseName !== state.databaseName) {
            if (existing)
              throw new SetupFailure(
                'Production files already identify an instance. Use a separate checkout for a fresh database; existing Workers will not be retargeted.',
              );
            state.databaseId = undefined;
            state.created.database = false;
            state.provisionedDatabaseId = undefined;
          }
          state.databaseName = databaseName;
          const bucket = await text(
            'Dedicated private R2 bucket',
            state.bucket,
            bucketName,
          );
          if (bucket !== state.bucket) {
            if (existing)
              throw new SetupFailure(
                'Production files already identify an instance. Use a separate checkout for a different bucket; existing Workers will not be retargeted.',
              );
            state.created.bucket = false;
            state.provisionedBucket = undefined;
            state.bucketCreatedOn = undefined;
          }
          state.bucket = bucket;
        }
        for (const hostname of [state.application, ...state.delivery]) {
          if (
            activeZones.every(
              (zone) =>
                !(hostname === zone.name || hostname.endsWith(`.${zone.name}`)),
            )
          )
            throw new SetupFailure(
              `${hostname} does not belong to an active zone in the selected account. Correct the hostname or activate the zone.`,
              'configuration',
              dashboard(state.accountId, 'domains'),
            );
        }
        await checkpoint();
        const names = Object.fromEntries(
          components.map((component) => [
            component,
            configs[component]?.name ?? `${state.prefix}-${component}`,
          ]),
        ) as Record<Component, string>;
        const databases = await step(
          'Discover D1 databases',
          () =>
            cloudflare.json(['d1', 'list', '--json'], z.array(databaseSchema)),
          true,
        );
        if (
          state.databaseId &&
          databases.every((database) => database.uuid !== state.databaseId)
        )
          throw new SetupFailure(
            `The configured D1 database "${state.databaseName}" (${state.databaseId}) from ${existing ? 'the production.local.jsonc files' : 'artifacts/setup/state.json'} is missing or inaccessible in Cloudflare account ${state.accountId}.\nChoose "Change account" to check the account, verify its access permissions, or restore the database from backup. Retrying keeps the same database ID.\n${existing ? 'For a fresh installation, use a separate clean checkout with distinct Worker, database, and bucket names; existing production files will not be retargeted.' : `For a fresh installation, choose "Show advanced resource choices" and change "D1 database name" from "${state.databaseName}" to a new unused name. Changing the name clears the saved database ID.`}`,
          );
        if (
          !existing &&
          databases.some((database) => database.name === state.databaseName) &&
          (!state.databaseId ||
            state.provisionedDatabaseId !== state.databaseId)
        )
          throw new SetupFailure(
            'Fresh installations require a new dedicated D1 database. Creation provenance is unavailable; choose a new unused database name.',
          );
        if (state.databaseId)
          state.databaseName = databases.find(
            (database) => database.uuid === state.databaseId,
          )!.name;
        const buckets = await step(
          'Discover R2 buckets',
          () => cloudflare.buckets(),
          true,
        );
        const bucketExists = buckets.some(
          (bucket) => bucket.name === state.bucket,
        );
        if (
          !existing &&
          bucketExists &&
          state.provisionedBucket?.name !== state.bucket
        )
          throw new SetupFailure(
            'Fresh installations require a new dedicated R2 bucket, even if an existing bucket appears empty. Choose a new unused bucket name; setup cannot recover creation provenance.',
          );
        const widgets = await step(
          'Discover Turnstile widgets',
          () =>
            cloudflare.json(
              ['turnstile', 'widget', 'list', '--json'],
              z.array(widgetSchema),
              { sensitive: true },
            ),
          true,
        );
        let widget: Widget | undefined = state.turnstile
          ? widgets.find((item) => item.sitekey === state.turnstile)
          : undefined;
        if (!advanced && widget === undefined && state.turnstile !== undefined)
          throw new SetupFailure(
            'The configured Turnstile widget is missing or inaccessible. Restore access or select a replacement through advanced setup.',
          );
        const matchingWidgets = widgets.filter(
          (item) =>
            item.mode === 'managed' &&
            item.domains.includes(state.application!),
        );
        if (widget === undefined && matchingWidgets.length === 1)
          widget = matchingWidgets[0];
        if (advanced || (widget === undefined && matchingWidgets.length > 1)) {
          const selected = await answer(
            prompts.select({
              message: 'Turnstile widget',
              initialValue: widget?.sitekey ?? 'new',
              options: [
                { value: 'new', label: 'Create a dedicated managed widget' },
                ...widgets.map((item) => ({
                  value: item.sitekey,
                  label: item.name,
                  hint: item.domains.join(', '),
                })),
              ],
            }),
          );
          widget = widgets.find((item) => item.sitekey === selected);
        }
        if (
          widget &&
          (widget.mode !== 'managed' ||
            !widget.domains.includes(state.application) ||
            (widget.clearance_level &&
              widget.clearance_level !== 'no_clearance'))
        )
          throw new SetupFailure(
            'The selected widget must be Managed, accept the application hostname, and use no_clearance. Preserve shared widget settings; create a dedicated widget or correct the selection.',
          );
        state.turnstile = widget?.sitekey;
        const workers: Partial<Record<Component, WorkerSettings>> = {};
        await step(
          'Inspect existing Workers',
          async () => {
            for (const component of components) {
              const worker = await cloudflare.worker(names[component]);
              if (!worker) continue;
              workers[component] = worker;
              const db = worker.bindings.find(
                (binding) => binding.name === 'DB',
              );
              const bucket = worker.bindings.find(
                (binding) => binding.name === 'BUCKET',
              );
              const ownDraft =
                component === 'web' &&
                worker.bindings.every(
                  (binding) => binding.type === 'secret_text',
                ) &&
                state.created.webDraft;
              if (
                !ownDraft &&
                (db?.id !== state.databaseId ||
                  bucket?.bucket_name !== state.bucket)
              )
                throw new SetupFailure(
                  `${names[component]} is already used by a different configuration. Choose a different Worker prefix in advanced setup; it will not be overwritten.`,
                );
            }
          },
          true,
        );
        const domains =
          (await step(
            'Inspect Worker Custom Domains',
            () =>
              cloudflare.api(
                `/accounts/${state.accountId}/workers/domains`,
                z.array(workerDomainSchema),
              ),
            true,
          )) ?? [];
        for (const hostname of [state.application, ...state.delivery]) {
          const assigned = domains.find(
            (domain) => domain.hostname === hostname,
          );
          const target =
            hostname === state.application ? names.web : names.delivery;
          if (assigned && assigned.service !== target)
            throw new SetupFailure(
              `${hostname} already belongs to Worker ${assigned.service}. Choose another hostname or move it explicitly in Cloudflare.`,
              'configuration',
              dashboard(state.accountId, 'workers'),
            );
        }
        if (bucketExists)
          await step(
            'Verify R2 is private',
            () => cloudflare.assertPrivate(state.bucket),
            true,
          );
        let applied: string[] = [];
        let users = 0;
        const migrations = await migrationFiles();
        const discovery = path.join(setupDirectory, 'discovery.local.jsonc');
        if (state.databaseId) {
          await atomicWrite(
            discovery,
            JSON.stringify({
              account_id: state.accountId,
              d1_databases: [
                {
                  binding: 'DB',
                  database_id: state.databaseId,
                  database_name: state.databaseName,
                },
              ],
            }),
          );
          await step(
            'Inspect database compatibility',
            async () => {
              const tables = await cloudflare.sql(
                discovery,
                "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%'",
              );
              const tableNames = tables.map((table) => String(table.name));
              if (tableNames.includes('d1_migrations'))
                applied = (
                  await cloudflare.sql(
                    discovery,
                    'SELECT name FROM d1_migrations ORDER BY id',
                  )
                ).map((row) => String(row.name));
              assertMigrationHistory(applied, migrations, state.migrations);
              assertHearthTables(tableNames, applied);
              if (tableNames.includes('users'))
                users = Number(
                  (
                    await cloudflare.sql(
                      discovery,
                      'SELECT count(*) AS count FROM users',
                    )
                  )[0]?.count ?? 0,
                );
              if (users && !state.created.database) state.adopted = true;
              if (
                users &&
                Object.keys(migrations).some((name) => !applied.includes(name))
              )
                throw new SetupFailure(
                  'This live instance requires pending migrations. Follow docs/operations/updating.md and its maintenance window, then retry setup.',
                );
            },
            true,
          );
        }
        if (!bucketExists && users > 0)
          throw new SetupFailure(
            'This live instance’s configured bucket is missing or inaccessible in the default jurisdiction. Restore its access/data or follow the recovery guide; setup will not replace it with empty storage.',
          );
        if (!users)
          state.displayName = await text(
            'First administrator display name',
            state.displayName,
            z.string().trim().min(1).max(80),
          );
        const subdomain = await step(
          'Inspect Workers account onboarding',
          () =>
            cloudflare.api(
              `/accounts/${state.accountId}/workers/subdomain`,
              z.object({ subdomain: z.string() }),
              { missing: true },
            ),
          true,
        );
        state.subdomain =
          subdomain?.subdomain ??
          state.subdomain ??
          `hearth-${state.accountId.slice(0, 8)}`;
        if (advanced && !subdomain)
          state.subdomain = await text(
            'Account workers.dev subdomain (temporary binding access)',
            state.subdomain,
            prefixSchema,
          );
        await checkpoint();
        prompts.note(
          [
            `Account: ${identity.accounts.find((account) => account.id === state.accountId)?.name} (${state.accountId})`,
            `Application: https://${state.application}`,
            `Delivery: ${state.delivery.join(', ')}`,
            `D1: ${state.databaseName} · ${state.databaseId ? 'reuse ' + state.databaseId : 'create'}`,
            `R2: ${state.bucket} · ${bucketExists ? 'reuse private bucket' : 'create private bucket'}`,
            `Turnstile: ${widget ? 'reuse ' + widget.name : 'create dedicated managed widget'}`,
            `Workers: ${components.map((component) => `${names[component]} (${Object.hasOwn(workers, component) ? 'reviewed update/reuse' : 'create'})`).join(', ')}`,
            subdomain
              ? ''
              : `Register account subdomain: ${state.subdomain}.workers.dev; production alternative URLs stay disabled.`,
            users
              ? 'Preserve administrator keys, existing domain policies, and existing secrets.'
              : 'Apply migrations and create the first administrator after credential handoff.',
            'Run a tiny image upload/delivery/deletion check. Configuration and progress stay outside Git.',
          ]
            .filter(Boolean)
            .join('\n'),
          'Installation review',
        );
        const review = await answer(
          prompts.select({
            message: 'Ready to apply this configuration?',
            options: [
              { value: 'install', label: 'Install / resume' },
              { value: 'edit', label: 'Edit inputs' },
              { value: 'cancel', label: 'Cancel' },
            ],
          }),
        );
        if (review === 'cancel') throw new Cancelled();
        if (review === 'edit') continue;
        if (!subdomain)
          await step('Initialize Workers account subdomain', async () => {
            const current = await cloudflare.api(
              `/accounts/${state.accountId}/workers/subdomain`,
              z.object({ subdomain: z.string() }),
              { missing: true },
            );
            if (!current)
              await cloudflare.api(
                `/accounts/${state.accountId}/workers/subdomain`,
                z.object({ subdomain: z.string() }),
                { body: { subdomain: state.subdomain } },
              );
          });
        await step('Provision D1', async () => {
          const current = await cloudflare.json(
            ['d1', 'list', '--json'],
            z.array(databaseSchema),
          );
          let database = current.find((item) =>
            state.databaseId
              ? item.uuid === state.databaseId
              : item.name === state.databaseName,
          );
          if (!database) {
            state.created.database = true;
            await checkpoint();
            database = await cloudflare.createDatabase(state.databaseName);
            state.provisionedDatabaseId = database.uuid;
          }
          if (!database)
            throw new SetupFailure(
              'D1 creation could not be verified. Retry to rediscover the database before creating anything else.',
            );
          state.databaseId = database.uuid;
          await checkpoint();
        });
        await step('Provision private R2', async () => {
          let createdNow = false;
          if (
            (await cloudflare.buckets()).every(
              (bucket) => bucket.name !== state.bucket,
            )
          ) {
            state.created.bucket = true;
            await checkpoint();
            await cloudflare.run([
              'r2',
              'bucket',
              'create',
              state.bucket,
              '--no-update-config',
            ]);
            createdNow = true;
          }
          const metadata = await cloudflare.api(
            `/accounts/${state.accountId}/r2/buckets/${encodeURIComponent(state.bucket)}`,
            z.object({ creation_date: z.string() }),
          );
          if (
            !metadata ||
            (state.bucketCreatedOn &&
              state.bucketCreatedOn !== metadata.creation_date) ||
            (state.provisionedBucket &&
              (state.provisionedBucket.name !== state.bucket ||
                state.provisionedBucket.createdOn !== metadata?.creation_date))
          )
            throw new SetupFailure(
              'The selected R2 bucket changed since setup. Review its ownership before continuing.',
            );
          if (createdNow) {
            // This block is reached only after successful creation in this invocation.
            state.provisionedBucket = {
              name: state.bucket,
              createdOn: metadata.creation_date,
            };
          }
          state.bucketCreatedOn = metadata.creation_date;
          await checkpoint();
          await cloudflare.assertPrivate(state.bucket);
        });
        await step('Provision Turnstile', async () => {
          if (state.turnstile) {
            return;
          }

          const current = await cloudflare.json(
            ['turnstile', 'widget', 'list', '--json'],
            z.array(widgetSchema),
            { sensitive: true },
          );
          const matches = current.filter(
            (item) =>
              item.name === `${state.prefix} (${state.application})` &&
              item.domains.includes(state.application!),
          );
          if (matches.length > 1)
            throw new SetupFailure(
              'Several matching widgets exist. Select the intended widget through advanced setup; another will not be created.',
            );
          widget =
            matches[0] ??
            (await cloudflare.json(
              [
                'turnstile',
                'widget',
                'create',
                `${state.prefix} (${state.application})`,
                '--domain',
                state.application!,
                '--mode',
                'managed',
                '--clearance-level',
                'no_clearance',
                '--json',
              ],
              widgetSchema,
              { sensitive: true },
            ));
          state.turnstile = widget.sitekey;
          state.created.widget = !matches[0];
          if (widget.secret) cloudflare.secrets.add(widget.secret);
          await checkpoint();
        });
        const outputs = await renderProduction({
          application: state.application,
          delivery: state.delivery,
          accountId: state.accountId,
          databaseId: state.databaseId!,
          databaseName: state.databaseName,
          bucket: state.bucket,
          turnstile: state.turnstile!,
          prefix: state.prefix,
          namespaces: state.namespaces,
        });
        for (const config of Object.values(configs)) {
          const limiters = config.ratelimits ?? [];
          for (const limiter of limiters)
            state.namespaces[limiter.name] = limiter.namespace_id;
        }
        for (const output of outputs) {
          const limiters = output.config.ratelimits ?? [];
          for (const limiter of limiters) {
            let namespace = state.namespaces[limiter.name];
            if (namespace === undefined) {
              do {
                namespace = String(randomInt(1, 2 ** 48));
              } while (Object.values(state.namespaces).includes(namespace));
              state.namespaces[limiter.name] = namespace;
            }
            limiter.namespace_id = namespace;
          }
        }
        await checkpoint();
        if (
          users === 0 &&
          (state.provisionedDatabaseId !== state.databaseId ||
            state.provisionedBucket?.name !== state.bucket ||
            state.provisionedBucket.createdOn !== state.bucketCreatedOn)
        )
          throw new SetupFailure(
            'Fresh storage creation cannot be verified. Use new dedicated resource names. Existing or restored storage requires the recovery workflow; accounting will not be reset.',
          );
        await step(
          'Save production configuration',
          async () => {
            for (const output of outputs) {
              const current = configs[output.component];
              let config = output.config;
              if (current) {
                config = { ...current, account_id: state.accountId };
                const requested =
                  output.component === 'web'
                    ? [state.application]
                    : state.delivery;
                if (output.component !== 'maintenance') {
                  config.vars = {
                    ...current.vars,
                    APP_ORIGIN: `https://${state.application}`,
                    ...(output.component === 'web' && {
                      TURNSTILE_SITE_KEY: state.turnstile!,
                    }),
                  };
                  const routes = current.routes ?? [];
                  config.routes = [
                    ...routes,
                    ...requested
                      .filter((pattern) =>
                        routes.every((route) => route.pattern !== pattern),
                      )
                      .map((pattern) => ({
                        pattern: pattern!,
                        custom_domain: true,
                      })),
                  ];
                }
                config.d1_databases = current.d1_databases.map((binding) =>
                  binding.binding === 'DB'
                    ? {
                        ...binding,
                        database_id: state.databaseId!,
                        database_name: state.databaseName,
                      }
                    : binding,
                );
                config.r2_buckets = current.r2_buckets.map((binding) =>
                  binding.binding === 'BUCKET'
                    ? { ...binding, bucket_name: state.bucket }
                    : binding,
                );
              }
              const bindings = config.durable_objects?.bindings ?? [];
              if (
                output.component === 'web' ||
                output.component === 'maintenance'
              ) {
                config.durable_objects = {
                  bindings: [
                    ...bindings.filter(
                      (binding) => binding.name !== 'MAINTENANCE',
                    ),
                    {
                      name: 'MAINTENANCE',
                      class_name: 'MaintenanceJob',
                      ...(output.component === 'web' && {
                        script_name: names.maintenance,
                      }),
                    },
                  ],
                };
              }
              if (output.component === 'maintenance')
                config.exports = {
                  ...config.exports,
                  MaintenanceJob: { type: 'durable-object', storage: 'sqlite' },
                };
              const content = JSON.stringify(config, null, 2) + '\n';
              const present = await optionalText(output.path);
              if (
                present !== undefined &&
                JSON.stringify(current) !== JSON.stringify(config)
              ) {
                const candidatePath = output.path.replace(
                  'production.local.jsonc',
                  'production.candidate.local.jsonc',
                );
                await atomicWrite(candidatePath, content);
                prompts.log.info(
                  `Review ${candidatePath}. Existing unknown settings are retained; approved replacement normalizes JSONC formatting.`,
                );
                const changed = Object.keys(config).filter(
                  (field) =>
                    JSON.stringify(current?.[field]) !==
                    JSON.stringify(config[field]),
                );
                prompts.log.info(`Changed fields: ${changed.join(', ')}`);
                if (
                  !(await confirmed(
                    `Back up and replace ${output.path} with the reviewed candidate?`,
                  ))
                )
                  throw new Cancelled();
                if (
                  (await optionalText(output.path)) !==
                  originals[output.component]
                )
                  throw new SetupFailure(
                    'The configuration changed during review. Retry to read its latest contents.',
                  );
                await atomicWrite(
                  `${output.path}.${Date.now()}.bak`,
                  present,
                  true,
                );
                await atomicWrite(output.path, content);
              } else if (present === undefined)
                await atomicWrite(output.path, content, true);
              configs[output.component] = config;
            }
          },
          false,
          true,
        );
        const web = configs.web!;
        const buildFingerprint = await sourceFingerprint('web', web);
        let built = false;
        try {
          await access(
            path.join(root, 'apps/web/.svelte-kit/cloudflare/_worker.js'),
          );
          built = state.buildFingerprint === buildFingerprint;
        } catch (error) {
          if (!isMissing(error)) throw error;
        }
        if (!built)
          await step('Build Hearth', async () => {
            await cloudflare.build();
            state.buildFingerprint = buildFingerprint;
            await checkpoint();
          });
        for (const component of [
          'delivery',
          'maintenance',
          'web',
        ] as Component[])
          await step(`Check ${component} bundle`, () =>
            cloudflare.run(['deploy', '--dry-run'], {
              config: configPath(component),
            }),
          );
        await step('Apply D1 migrations', async () => {
          const currentTables = await cloudflare.sql(
            configPath('web'),
            "SELECT name FROM sqlite_master WHERE type='table' AND name='d1_migrations'",
          );
          const current =
            currentTables.length > 0
              ? (
                  await cloudflare.sql(
                    configPath('web'),
                    'SELECT name FROM d1_migrations ORDER BY id',
                  )
                ).map((row) => String(row.name))
              : [];
          assertMigrationHistory(current, migrations, state.migrations);
          if (Object.keys(migrations).some((name) => !current.includes(name)))
            await cloudflare.run(
              ['d1', 'migrations', 'apply', 'DB', '--remote'],
              { config: configPath('web') },
            );
          const verified = new Set(
            (
              await cloudflare.sql(
                configPath('web'),
                'SELECT name FROM d1_migrations ORDER BY id',
              )
            ).map((row) => String(row.name)),
          );
          if (Object.keys(migrations).some((name) => !verified.has(name)))
            throw new SetupFailure(
              'Some migrations remain unapplied. Correct the failure and retry.',
            );
          state.migrations = migrations;
          await checkpoint();
        });
        if (
          state.provisionedDatabaseId === state.databaseId &&
          state.provisionedBucket?.name === state.bucket &&
          state.provisionedBucket.createdOn === state.bucketCreatedOn
        )
          await step('Initialize dedicated storage accounting', () =>
            withBindings(cloudflare, web, (environment) =>
              initializeFreshStorage(environment.DB),
            ),
          );
        await step(
          'Initialize administrator',
          async () => {
            await withBindings(cloudflare, web, async (environment) => {
              const count = await environment.DB.prepare(
                'SELECT count(*) AS count FROM users',
              ).first<{ count: number }>();
              if (!count?.count) {
                if (!candidate) {
                  state.bootstrapUserId ??= id('usr');
                  await checkpoint();
                  candidate = await prepareBootstrap(
                    state.displayName,
                    state.bootstrapUserId,
                  );
                  cloudflare.secrets.add(candidate.key.plaintext);
                  cloudflare.secrets.add(candidate.key.secretHash);
                  prompts.note(
                    candidate.key.plaintext,
                    'Save this first-administrator login/API key in your password manager',
                  );
                  if (
                    !(await confirmed(
                      'I saved this administrator key. Create the account now.',
                    ))
                  )
                    throw new Cancelled();
                }
                await environment.DB.batch(
                  candidate.statements.map((sql) =>
                    environment.DB.prepare(sql),
                  ),
                );
                key = candidate.key.plaintext;
              }
              if (!key && candidate) {
                key = candidate.key.plaintext;
                candidate = undefined;
              }
              if (!key) {
                key = await answer(
                  prompts.password({
                    message: 'Saved Hearth administrator key',
                    validate: (value) =>
                      value?.trim()
                        ? undefined
                        : 'Enter the saved key. Setup never resets it.',
                  }),
                );
                cloudflare.secrets.add(key);
              }
              try {
                await administrator(environment, key);
              } catch (error) {
                key = undefined;
                throw error;
              }
            });
          },
          false,
          true,
        );
        await step(
          'Configure Turnstile secret',
          async () => {
            const worker = await cloudflare.worker(web.name);
            const secrets = worker
              ? await cloudflare.json(
                  ['secret', 'list', '--format', 'json'],
                  z.array(z.object({ name: z.string() })),
                  { config: configPath('web') },
                )
              : [];
            if (
              secrets.some((secret) => secret.name === 'TURNSTILE_SECRET_KEY')
            )
              return;
            if (!worker) {
              state.created.webDraft = true;
              await checkpoint();
            }
            const secret = await turnstileSecret();
            await cloudflare.run(['secret', 'put', 'TURNSTILE_SECRET_KEY'], {
              config: configPath('web'),
              input: secret,
              sensitive: true,
            });
            const verified = await cloudflare.json(
              ['secret', 'list', '--format', 'json'],
              z.array(z.object({ name: z.string() })),
              { config: configPath('web') },
            );
            if (
              verified.every((secret) => secret.name !== 'TURNSTILE_SECRET_KEY')
            )
              throw new SetupFailure(
                'The Turnstile secret binding could not be verified. Retry without replacing existing secrets.',
              );
            if (worker) return;
            const drafts = await cloudflare.pages(
              `/accounts/${state.accountId}/workers/scripts`,
              z.object({ id: z.string(), created_on: z.string() }),
            );
            state.webDraftCreatedOn = drafts.find(
              (draft) => draft.id === web.name,
            )?.created_on;
            if (!state.webDraftCreatedOn)
              throw new SetupFailure(
                'The new web Worker draft could not be identified. Retry setup to inspect it.',
              );
            await checkpoint();
          },
          false,
          true,
        );
        for (const component of [
          'delivery',
          'maintenance',
          'web',
        ] as Component[])
          await step(
            `Deploy and verify ${component}`,
            () =>
              reconcileDeployment(
                cloudflare,
                component,
                configs[component]!,
                state,
                checkpoint,
              ),
            false,
            true,
          );
        await step('Validate delivery domains and private storage', () =>
          withBindings(cloudflare, web, async (environment) => {
            const deadline = Date.now() + 5 * 60_000;
            while (true) {
              try {
                await initializeDomains(
                  environment,
                  key!,
                  state.delivery,
                  !state.adopted && !state.initialized,
                );
                state.initialized = true;
                await checkpoint();
                return;
              } catch (error) {
                if (
                  !(error instanceof SetupFailure) ||
                  !/resolve|DNS|HTTPS|TLS|hostname.*answer/i.test(
                    error.message,
                  ) ||
                  Date.now() >= deadline
                )
                  throw error;
                await setTimeout(10_000, undefined, {
                  signal: cloudflare.controller.signal,
                });
              }
            }
          }),
        );
        await step('Verify upload, public delivery, and deletion', () =>
          withBindings(cloudflare, web, (environment) =>
            verifyUpload(environment, key!, state, checkpoint),
          ),
        );
        const since = now();
        prompts.log.info(
          `Verify browser login at https://${state.application}/login. Complete the real Turnstile challenge using your saved Hearth key.`,
        );
        await openBrowser(`https://${state.application}/login`);
        let loginVerified = false;
        while (
          await confirmed(
            'I signed in successfully. Check the new session now.',
            true,
          )
        ) {
          loginVerified = await step(
            'Verify deployed browser authentication',
            () =>
              withBindings(cloudflare, web, (environment) =>
                verifyBrowserLogin(environment, key!, since),
              ),
            true,
          );
          // eslint-disable-next-line unicorn/no-break-in-nested-loop -- Finish only the login check; the outer setup loop owns repair and review.
          if (loginVerified) break;
          prompts.log.warn(
            'No new session was found. Confirm the hostname, widget, and saved key. Existing secrets have been preserved.',
          );
          if (
            await confirmed(
              'Replace TURNSTILE_SECRET_KEY with the selected widget’s secret?',
            )
          ) {
            await step(
              'Repair Turnstile secret',
              async () => {
                const secret = await turnstileSecret();
                await cloudflare.run(
                  ['secret', 'put', 'TURNSTILE_SECRET_KEY'],
                  {
                    config: configPath('web'),
                    input: secret,
                    sensitive: true,
                  },
                );
              },
              false,
              true,
            );
          }
        }
        prompts.log.info(
          `Maintenance cron is configured; its first invocation can take up to 15 minutes to propagate. Check ${dashboard(state.accountId, 'observability', names.maintenance)}`,
        );
        prompts.note(
          `Application: https://${state.application}\nDelivery: ${state.delivery.map((hostname) => `https://${hostname}`).join(', ')}\nResume: pnpm run setup\nDiagnostics: ${cloudflare.diagnostics}`,
          'Your Hearth instance',
        );
        prompts.outro(
          loginVerified
            ? 'Hearth is deployed and functional checks passed. Scheduled execution still needs its first event.'
            : 'Hearth is deployed. Browser login verification remains pending; rerun setup to finish it.',
        );
        return;
      } catch (error) {
        if (error instanceof EditSetup) continue;
        if (error instanceof Cancelled || cloudflare.controller.signal.aborted)
          throw new Cancelled();
        prompts.log.warn(
          error instanceof Error
            ? redact(error.message, cloudflare.secrets)
            : 'The configuration needs attention.',
        );
        if (error instanceof SetupFailure && error.dashboard)
          prompts.log.info(error.dashboard);
        const next = await answer(
          prompts.select({
            message: `${remove ? 'Uninstall' : 'Setup'} failed. Completed work is preserved. What would you like to do?`,
            options: [
              ...recoveryOptions,
              ...(remove
                ? []
                : [
                    {
                      value: 'advanced',
                      label: 'Show advanced resource choices',
                    },
                  ]),
              { value: 'cancel', label: 'Save progress and exit' },
            ],
          }),
        );
        if (next === 'cancel') throw new Cancelled();
        if (next === 'account') accountChoice = await chooseAccount();
        else if (next === 'advanced') advanced = true;
      }
    }
  } finally {
    cloudflare.controller.abort();
    process.removeListener('SIGINT', stop);
    process.removeListener('SIGTERM', stop);
    try {
      if (!remove) await checkpoint();
    } finally {
      await unlock();
      if (removed) await rm(setupDirectory, { recursive: true, force: true });
    }
  }
}

const setupArguments = {
  uninstall: {
    type: 'boolean',
    alias: 'remove',
    default: false,
    description:
      'Discover, review, and permanently remove this Hearth instance.',
  },
  advanced: {
    type: 'boolean',
    default: false,
    description:
      'Show resource naming, widget selection, and additional hostnames.',
  },
} as const;

export default defineCommand({
  meta: {
    name: 'setup',
    description:
      'Provision, initialize, deploy, and verify Hearth on Cloudflare.',
  },
  args: setupArguments,
  async run({ args, rawArgs }) {
    try {
      validateOptions(rawArgs, setupArguments);
    } catch (error) {
      prompts.log.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
      return;
    }
    try {
      await runSetup(args.advanced, args.uninstall);
    } catch (error) {
      if (error instanceof Cancelled) {
        prompts.cancel(
          args.uninstall
            ? 'Uninstall cancelled. Rerun pnpm run setup --uninstall to rediscover and resume cleanup.'
            : 'Setup cancelled. Completed work is preserved; resume with pnpm run setup.',
        );
        process.exitCode = 130;
      } else {
        prompts.log.error(
          error instanceof SetupFailure
            ? args.uninstall
              ? `Uninstall incomplete. ${error.message}\nRecovery information was preserved. Rerun pnpm run setup --uninstall after resolving the error.`
              : error.message
            : args.uninstall
              ? 'Uninstall incomplete. Local recovery information was preserved. Rerun pnpm run setup --uninstall to resume cleanup.'
              : 'Setup stopped safely. Review production configuration and local tooling, then rerun pnpm run setup. Completed Cloudflare resources were preserved.',
        );
        process.exitCode = 1;
      }
    }
  },
});
