import { createHash } from 'node:crypto';
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';

import * as prompts from '@clack/prompts';
import { getTableName, is } from 'drizzle-orm';
import { SQLiteTable } from 'drizzle-orm/sqlite-core';
import { z } from 'zod';

import * as tables from '../../packages/core/schema.ts';
import {
  type Component,
  components,
  configPath,
  type ProductionConfig,
  readConfig,
  root,
} from '../production-config.ts';
import {
  type Cloudflare,
  databaseSchema,
  SetupFailure,
  type WorkerSettings,
} from './cloudflare.ts';
import { dashboard } from './dashboard.ts';
import { withBindings } from './initialize.ts';
import { type Account, type Answer, selectAccount } from './interaction.ts';
import {
  atomicWrite,
  optionalText,
  setupDirectory,
  type SetupState,
} from './state.ts';

const workerSchema = z.object({ id: z.string(), created_on: z.string() });
const bucketSchema = z.object({ name: z.string(), creation_date: z.string() });
const widgetSchema = z.object({
  sitekey: z.string(),
  name: z.string(),
  domains: z.array(z.string()),
});
const domainSchema = z.object({
  id: z.string(),
  hostname: z.string(),
  service: z.string(),
});
const routeSchema = z.object({
  id: z.string(),
  pattern: z.string(),
  script: z.string().nullable(),
});
const planSchema = z.object({
  accountId: z.string(),
  prefix: z.string(),
  workers: z.array(
    workerSchema.extend({
      fingerprint: z.string(),
      versionId: z.string().optional(),
    }),
  ),
  database: databaseSchema
    .extend({ kind: z.enum(['hearth', 'partial', 'empty', 'other']) })
    .optional(),
  bucket: bucketSchema.optional(),
  widgets: z.array(widgetSchema),
  domains: z.array(domainSchema),
  routes: z.array(routeSchema.extend({ zoneId: z.string() })),
  completed: z.array(z.string()).default([]),
});
export type Plan = z.infer<typeof planSchema>;
type Review = (
  message: string,
  links: string[],
  evidence?: unknown,
) => Promise<void>;
class Declined extends Error {}
const planFile = path.join(setupDirectory, 'uninstall.json');
const expectedTables = new Set<string>(
  Object.values(tables)
    .filter((value) => is(value, SQLiteTable))
    .map((table) => getTableName(table)),
);

function reviewer(answer: Answer): Review {
  const approved = new Set<string>();
  return async (message, links, evidence) => {
    const key = createHash('sha256')
      .update(JSON.stringify([message, links, evidence]))
      .digest('hex');
    if (approved.has(key)) return;
    prompts.note(
      [message, '', 'Inspect in Cloudflare:', ...new Set(links)].join('\n'),
      'Resource inspection required',
    );
    if (
      !(await answer(
        prompts.confirm({
          message:
            'Have you inspected the linked resources and want to proceed as described?',
          initialValue: false,
        }),
      ))
    )
      throw new Declined();
    approved.add(key);
  };
}

function fingerprint(settings: WorkerSettings) {
  const bindings = [...settings.bindings];
  bindings.sort((a, b) => a.name.localeCompare(b.name));
  return createHash('sha256')
    .update(
      JSON.stringify({
        ...settings,
        bindings,
      }),
    )
    .digest('hex');
}

export async function inventory(
  cloudflare: Cloudflare,
  inspectBindings = true,
) {
  const base = `/accounts/${cloudflare.accountId}`;
  const workers = await cloudflare.pages(
    `${base}/workers/scripts`,
    workerSchema,
  );
  const settings = new Map<string, WorkerSettings>();
  // Inspect every Worker: a differently named Worker can share Hearth storage.
  const inspectedWorkers = inspectBindings ? workers : [];
  for (const worker of inspectedWorkers) {
    const current = await cloudflare.worker(worker.id);
    if (!current)
      throw new SetupFailure(
        'Workers changed during discovery. Retry uninstall.',
      );
    settings.set(worker.id, current);
  }
  const databases = await cloudflare.pages(
    `${base}/d1/database`,
    databaseSchema,
  );
  const buckets = await cloudflare.buckets();
  const widgets = await cloudflare.pages(
    `${base}/challenges/widgets`,
    widgetSchema,
  );
  const domains = await cloudflare.api(
    `${base}/workers/domains`,
    z.array(domainSchema),
  );
  if (!domains)
    throw new SetupFailure('Worker domain discovery did not complete.');
  const routes: Plan['routes'] = [];
  const zones = await cloudflare.pages(
    `/zones?account.id=${cloudflare.accountId}`,
    z.object({ id: z.string() }),
  );
  for (const zone of zones) {
    const entries = await cloudflare.pages(
      `/zones/${zone.id}/workers/routes`,
      routeSchema,
    );
    routes.push(...entries.map((route) => ({ ...route, zoneId: zone.id })));
  }
  return { workers, settings, databases, buckets, widgets, domains, routes };
}
type Inventory = Awaited<ReturnType<typeof inventory>>;

export async function hearthDatabase(cloudflare: Cloudflare, id: string) {
  const result = await cloudflare.api(
    `/accounts/${cloudflare.accountId}/d1/database/${encodeURIComponent(id)}/query`,
    z.array(
      z.object({
        success: z.literal(true),
        results: z.array(z.object({ name: z.string() })),
      }),
    ),
    {
      method: 'POST',
      body: {
        sql: "SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*' AND name != 'd1_migrations'",
      },
    },
  );
  if (!result)
    throw new SetupFailure('D1 ownership inspection did not complete.');
  const names = result.flatMap((entry) => entry.results.map((row) => row.name));
  return names.length === expectedTables.size &&
    names.every((name) => expectedTables.has(name))
    ? 'hearth'
    : names.length === 0
      ? 'empty'
      : names.every((name) => expectedTables.has(name))
        ? 'partial'
        : 'other';
}

async function reviewShared(plan: Plan, current: Inventory, review: Review) {
  const own = new Set(plan.workers.map((worker) => worker.id));
  const widgetIds = new Set(plan.widgets.map((widget) => widget.sitekey));
  const forceWorkers = new Set<string>();
  const namespaceOwners = new Map<string, string>();
  for (const name of own) {
    const bindings = current.settings.get(name)?.bindings ?? [];
    for (const binding of bindings) {
      const owner = binding.script_name ?? name;
      if (
        binding.type === 'durable_object_namespace' &&
        binding.namespace_id !== undefined &&
        own.has(owner)
      )
        namespaceOwners.set(String(binding.namespace_id), owner);
    }
  }
  for (const [name, settings] of current.settings) {
    if (
      own.has(name) ||
      settings.bindings.every(
        (binding) =>
          !(
            (plan.database &&
              binding.type === 'd1' &&
              binding.id === plan.database.uuid) ||
            (plan.bucket &&
              binding.type === 'r2_bucket' &&
              binding.bucket_name === plan.bucket.name) ||
            (binding.type === 'plain_text' &&
              binding.text &&
              widgetIds.has(binding.text)) ||
            (binding.service && own.has(binding.service)) ||
            (binding.type === 'durable_object_namespace' &&
              namespaceOwners.has(String(binding.namespace_id)))
          ),
      )
    ) {
      continue;
    }

    await review(
      `Worker ${name} uses a selected resource. Removing the selected storage, widget, service, or Durable Object namespace can break that Worker. It will not itself be deleted.`,
      [
        dashboard(plan.accountId, 'worker', name),
        ...plan.workers.map((worker) =>
          dashboard(plan.accountId, 'worker', worker.id),
        ),
        ...(plan.database
          ? [dashboard(plan.accountId, 'database', plan.database.uuid)]
          : []),
        ...(plan.bucket
          ? [dashboard(plan.accountId, 'bucket', plan.bucket.name)]
          : []),
        ...plan.widgets.map((widget) =>
          dashboard(plan.accountId, 'widget', widget.sitekey),
        ),
      ],
      settings.bindings,
    );
    for (const binding of settings.bindings) {
      if (binding.service && own.has(binding.service))
        forceWorkers.add(binding.service);
      const owner = namespaceOwners.get(String(binding.namespace_id));
      if (owner && binding.type === 'durable_object_namespace')
        forceWorkers.add(owner);
    }
  }
  return forceWorkers;
}

async function discover(
  cloudflare: Cloudflare,
  state: SetupState,
  configs: ProductionConfig[],
  current: Inventory,
  answer: Answer,
  review: Review,
): Promise<Plan> {
  const localNames = new Set(configs.map((config) => config.name));
  const groups = new Map<
    string,
    { workers: string[]; databaseId?: string; bucket?: string }
  >();
  const ownership = new Map<
    string,
    Awaited<ReturnType<typeof hearthDatabase>>
  >();
  const versions = new Map<string, string | undefined>();
  async function databaseKind(id: string) {
    let kind = ownership.get(id);
    if (!kind) {
      kind = await hearthDatabase(cloudflare, id);
      ownership.set(id, kind);
    }
    return kind;
  }
  const candidates = [...current.settings];
  candidates.sort(
    ([a], [b]) =>
      Number(a.endsWith('-maintenance')) - Number(b.endsWith('-maintenance')),
  );
  for (const [name, settings] of candidates) {
    const suffix = /^(.*)-(web|delivery|maintenance)$/.exec(name);
    const db = settings.bindings.find(
      (binding) => binding.name === 'DB' && binding.type === 'd1',
    )?.id;
    const bucket = settings.bindings.find(
      (binding) => binding.name === 'BUCKET' && binding.type === 'r2_bucket',
    )?.bucket_name;
    if (
      (!db || !bucket) &&
      !localNames.has(name) &&
      name !== `${state.prefix}-web`
    )
      continue;
    const version = await cloudflare.activeVersion(name);
    versions.set(name, version);
    const details = version
      ? await cloudflare.api(
          `/accounts/${cloudflare.accountId}/workers/scripts/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`,
          z.object({
            annotations: z.record(z.string(), z.string()).optional(),
            metadata: z
              .object({
                annotations: z.record(z.string(), z.string()).optional(),
              })
              .optional(),
          }),
        )
      : undefined;
    const annotations = details?.annotations ?? details?.metadata?.annotations;
    const tagged = /^Hearth setup [a-f0-9]{64}$/.test(
      annotations?.['workers/message'] ?? '',
    );
    const knownDraft =
      state.accountId === cloudflare.accountId &&
      state.created.webDraft &&
      state.webDraftCreatedOn !== undefined &&
      current.workers.some(
        (worker) =>
          worker.id === name && worker.created_on === state.webDraftCreatedOn,
      ) &&
      name === `${state.prefix}-web` &&
      settings.bindings.every((binding) => binding.type === 'secret_text');
    const local = configs.find((config) => config.name === name);
    const prefix =
      suffix?.[1] ??
      (local
        ? state.prefix
        : (current.databases
            .find((database) => database.uuid === db)
            ?.name.replace(/-production$/, '') ?? name));
    const component: Component | undefined =
      components.find((component) => component === suffix?.[2]) ??
      (local
        ? local.triggers?.crons.length
          ? 'maintenance'
          : local.vars?.TURNSTILE_SITE_KEY
            ? 'web'
            : 'delivery'
        : undefined);
    if (
      !knownDraft &&
      ((local &&
        (local.d1_databases.find((binding) => binding.binding === 'DB')
          ?.database_id !== db ||
          local.r2_buckets.find((binding) => binding.binding === 'BUCKET')
            ?.bucket_name !== bucket)) ||
        (state.accountId === cloudflare.accountId &&
          prefix === state.prefix &&
          state.databaseId &&
          state.databaseId !== db))
    )
      await review(
        `Worker ${name} no longer matches its saved Hearth storage. The review will use its current bindings.`,
        [
          dashboard(cloudflare.accountId, 'worker', name),
          ...(db ? [dashboard(cloudflare.accountId, 'database', db)] : []),
          ...(bucket
            ? [dashboard(cloudflare.accountId, 'bucket', bucket)]
            : []),
        ],
        settings,
      );
    const template = component
      ? await readConfig(
          path.join(
            root,
            component === 'web'
              ? 'apps/web/wrangler.jsonc'
              : `workers/${component}/wrangler.jsonc`,
          ),
        )
      : undefined;
    const production = settings.bindings.some(
      (binding) =>
        binding.name === 'ENVIRONMENT' && binding.text === 'production',
    );
    let recognizable =
      template &&
      (component === 'maintenance'
        ? Boolean(local) ||
          ['web', 'delivery'].every((role) =>
            groups.get(prefix)?.workers.includes(`${prefix}-${role}`),
          )
        : production &&
          settings.bindings.some(
            (binding) =>
              binding.name === 'APP_ORIGIN' &&
              binding.text?.startsWith('https://'),
          )) &&
      (template.ratelimits ?? []).every((limit) =>
        settings.bindings.some(
          (binding) =>
            binding.type === 'ratelimit' &&
            binding.name === limit.name &&
            binding.simple?.limit === limit.simple.limit &&
            binding.simple.period === limit.simple.period,
        ),
      );
    if (!tagged && recognizable && component === 'maintenance') {
      const schedule = await cloudflare.api(
        `/accounts/${cloudflare.accountId}/workers/scripts/${encodeURIComponent(name)}/schedules`,
        z.object({ schedules: z.array(z.object({ cron: z.string() })) }),
      );
      recognizable = schedule?.schedules.some((schedule) =>
        template?.triggers?.crons.includes(schedule.cron),
      );
    }
    if (
      !knownDraft &&
      (!db ||
        !bucket ||
        (!tagged && !recognizable) ||
        (current.databases.some((database) => database.uuid === db)
          ? (await databaseKind(db)) !== 'hearth'
          : !tagged))
    ) {
      if (localNames.has(name) || name.startsWith(`${state.prefix}-`))
        await review(
          `Cannot prove ${name} belongs to Hearth. Confirm its ownership before including this Worker and its current storage bindings in the uninstall review.`,
          [
            dashboard(cloudflare.accountId, 'worker', name),
            ...(db ? [dashboard(cloudflare.accountId, 'database', db)] : []),
            ...(bucket
              ? [dashboard(cloudflare.accountId, 'bucket', bucket)]
              : []),
          ],
          settings,
        );
      else continue;
    }
    const group = groups.get(prefix) ?? { workers: [], databaseId: db, bucket };
    if (
      !knownDraft &&
      ((group.databaseId && group.databaseId !== db) ||
        (group.bucket && group.bucket !== bucket))
    )
      await review(
        `Workers for ${prefix} disagree about their storage. This uninstall removes Worker ${name} and the group's selected D1 ${group.databaseId} and R2 ${group.bucket}. This Worker's other storage bindings will be preserved.`,
        [
          dashboard(cloudflare.accountId, 'worker', name),
          ...(db ? [dashboard(cloudflare.accountId, 'database', db)] : []),
          ...(bucket
            ? [dashboard(cloudflare.accountId, 'bucket', bucket)]
            : []),
        ],
        { db, bucket, group },
      );
    group.databaseId ??= db;
    group.bucket ??= bucket;
    group.workers.push(name);
    groups.set(prefix, group);
  }
  // Recover provisioning that stopped before the first tagged deployment.
  if (
    state.accountId === cloudflare.accountId &&
    (state.created.database || state.created.bucket || state.created.widget)
  ) {
    const group = groups.get(state.prefix) ?? { workers: [] };
    const database = current.databases.find((db) =>
      state.databaseId
        ? db.uuid === state.databaseId
        : db.name === state.databaseName,
    );
    if (database && state.created.database) {
      const kind = await databaseKind(database.uuid);
      if (
        kind === 'other' ||
        (kind !== 'hearth' && database.uuid !== state.databaseId)
      )
        await review(
          `The saved database ${database.name} contains unrelated tables or lacks a saved ownership identity. Its entire contents will be deleted.`,
          [dashboard(cloudflare.accountId, 'database', database.uuid)],
          kind,
        );
      group.databaseId ??= database.uuid;
    }
    if (
      state.created.bucket &&
      current.buckets.some((bucket) => bucket.name === state.bucket)
    )
      group.bucket ??= state.bucket;
    groups.set(state.prefix, group);
  }
  // A fully initialized database can identify an orphaned install without local files.
  const linkedDatabases = new Set<string>();
  for (const group of groups.values())
    if (group.databaseId) linkedDatabases.add(group.databaseId);
  for (const database of current.databases) {
    if (
      linkedDatabases.has(database.uuid) ||
      (await databaseKind(database.uuid)) !== 'hearth'
    )
      continue;
    const prefix = database.name.replace(/-production$/, '');
    if (groups.has(prefix)) {
      await review(
        `Several Hearth databases match ${prefix}. The existing group remains selected; additional database ${database.name} (${database.uuid}) will be preserved.`,
        [dashboard(cloudflare.accountId, 'database', database.uuid)],
        groups.get(prefix),
      );
      continue;
    }
    groups.set(prefix, {
      workers: [],
      databaseId: database.uuid,
      bucket: current.buckets.some((bucket) => bucket.name === database.name)
        ? database.name
        : undefined,
    });
  }
  if (groups.size === 0) {
    const database = current.databases.find(
      (database) =>
        database.uuid === state.databaseId ||
        database.name === state.databaseName ||
        configs.some((config) =>
          config.d1_databases.some(
            (binding) => binding.database_id === database.uuid,
          ),
        ),
    );
    const bucket = current.buckets.find(
      (bucket) =>
        bucket.name === state.bucket ||
        configs.some((config) =>
          config.r2_buckets.some(
            (binding) => binding.bucket_name === bucket.name,
          ),
        ),
    );
    if (database || bucket)
      groups.set(state.prefix, {
        workers: [],
        databaseId: database?.uuid,
        bucket: bucket?.name,
      });
    else {
      await review(
        'No matching Hearth resources were found. Inspect the account before proceeding with local installer-state cleanup. Unmatched resources and production files will be preserved.',
        [dashboard(cloudflare.accountId)],
      );
      return {
        accountId: cloudflare.accountId!,
        prefix: state.prefix,
        workers: [],
        widgets: [],
        domains: [],
        routes: [],
        completed: [],
      };
    }
  }
  const localDatabaseIds = new Set(
    configs.flatMap((config) =>
      config.d1_databases
        .filter((binding) => binding.binding === 'DB')
        .map((binding) => binding.database_id),
    ),
  );
  if (state.databaseId) localDatabaseIds.add(state.databaseId);
  const savedPrefix =
    state.accountId === cloudflare.accountId &&
    Object.values(state.created).some(Boolean)
      ? state.prefix
      : undefined;
  let choices = [...groups].filter(
    ([prefix, group]) =>
      (localDatabaseIds.size === 0 &&
        (!savedPrefix || prefix === savedPrefix)) ||
      (group.databaseId && localDatabaseIds.has(group.databaseId)) ||
      (prefix === state.prefix && !group.databaseId),
  );
  if (choices.length === 0) {
    await review(
      'Saved files do not match a discovered instance. Inspect the account, then select the instance you want to remove.',
      [dashboard(cloudflare.accountId)],
      [...groups],
    );
    choices = [...groups];
  }
  const prefix = await answer(
    prompts.select({
      message: 'Hearth instance to permanently remove',
      initialValue: groups.has(state.prefix) ? state.prefix : undefined,
      options: choices.map(([prefix, group]) => ({
        value: prefix,
        label: prefix,
        hint: [...group.workers, group.bucket, group.databaseId]
          .filter(Boolean)
          .join(', '),
      })),
    }),
  );
  const group = groups.get(prefix)!;
  const foundDatabase = current.databases.find(
    (db) => db.uuid === group.databaseId,
  );
  const kind = foundDatabase
    ? await databaseKind(foundDatabase.uuid)
    : undefined;
  if (kind === 'other')
    await review(
      `D1 database ${foundDatabase!.name} contains unrelated tables. Its entire contents will be deleted.`,
      [dashboard(cloudflare.accountId, 'database', foundDatabase!.uuid)],
      kind,
    );
  const database =
    foundDatabase && kind ? { ...foundDatabase, kind } : undefined;
  const bucket =
    group.bucket &&
    current.buckets.some((bucket) => bucket.name === group.bucket)
      ? await cloudflare.api(
          `/accounts/${cloudflare.accountId}/r2/buckets/${encodeURIComponent(group.bucket)}`,
          bucketSchema,
        )
      : undefined;
  if (
    bucket &&
    group.workers.length === 0 &&
    !(database?.kind === 'hearth' && database.name === bucket.name) &&
    state.bucketCreatedOn !== bucket.creation_date
  )
    await review(
      `Cannot prove ownership of orphaned R2 bucket ${bucket.name}. Its saved creation identity is missing or differs. All contents will be deleted.`,
      [dashboard(cloudflare.accountId, 'bucket', bucket.name)],
      bucket,
    );
  const widgetKeys = new Set(
    group.workers.flatMap((name) =>
      current.settings
        .get(name)!
        .bindings.filter(
          (binding) =>
            binding.name === 'TURNSTILE_SITE_KEY' &&
            binding.type === 'plain_text',
        )
        .map((binding) => binding.text),
    ),
  );
  if (
    state.accountId === cloudflare.accountId &&
    prefix === state.prefix &&
    state.created.widget
  )
    widgetKeys.add(state.turnstile);
  const hosts = new Set(
    group.workers.flatMap((name) =>
      current.settings
        .get(name)!
        .bindings.filter(
          (binding) =>
            binding.name === 'APP_ORIGIN' &&
            binding.text?.startsWith('https://'),
        )
        .map((binding) => new URL(binding.text!).hostname),
    ),
  );
  // The installer names dedicated widgets deterministically, including before web deploys.
  for (const widget of current.widgets) {
    if (!(
      widget.domains.length === 1 &&
      widget.name === `${prefix} (${widget.domains[0]})`
    )) {
      continue;
    }

    widgetKeys.add(widget.sitekey);
    hosts.add(widget.domains[0]);
  }
  if (
    state.accountId === cloudflare.accountId &&
    prefix === state.prefix &&
    state.application
  )
    hosts.add(state.application);
  const widgets = current.widgets.filter((widget) =>
    widgetKeys.has(widget.sitekey),
  );
  for (const widget of widgets)
    if (widget.domains.length !== 1 || !hosts.has(widget.domains[0]))
      await review(
        `Turnstile widget ${widget.sitekey} permits other hostnames and may be shared: ${widget.domains.join(', ')}. Removing it can break login on those sites.`,
        [dashboard(cloudflare.accountId, 'widget', widget.sitekey)],
        widget,
      );
  const plan: Plan = {
    accountId: cloudflare.accountId!,
    prefix,
    workers: current.workers
      .filter((worker) => group.workers.includes(worker.id))
      .map((worker) => ({
        ...worker,
        fingerprint: fingerprint(current.settings.get(worker.id)!),
        versionId: versions.get(worker.id),
      })),
    database,
    bucket,
    widgets,
    domains: current.domains.filter((domain) =>
      group.workers.includes(domain.service),
    ),
    routes: current.routes.filter(
      (route) => route.script && group.workers.includes(route.script),
    ),
    completed: [],
  };
  return plan;
}

export async function emptyBucket(bucket: R2Bucket, signal: AbortSignal) {
  // Start from the first page after each batch; deleting must not invalidate a cursor.
  while (true) {
    signal.throwIfAborted();
    const page = await bucket.list({ limit: 1000 });
    if (page.objects.length === 0) {
      if (page.truncated)
        throw new SetupFailure(
          'R2 returned an incomplete empty page. Retry cleanup.',
        );
      return;
    }
    await bucket.delete(page.objects.map((object) => object.key));
  }
}

async function abortUploads(
  cloudflare: Cloudflare,
  databaseId: string,
  bucket: R2Bucket,
) {
  let after = '';
  while (true) {
    const pages = await cloudflare.api(
      `/accounts/${cloudflare.accountId}/d1/database/${encodeURIComponent(databaseId)}/query`,
      z.array(
        z.object({
          success: z.literal(true),
          results: z.array(z.object({ key: z.string(), uploadId: z.string() })),
        }),
      ),
      {
        method: 'POST',
        body: {
          sql: 'SELECT key, uploadId FROM storage_objects WHERE uploadId IS NOT NULL AND key > ? ORDER BY key LIMIT 1000',
          params: [after],
        },
      },
    );
    if (!pages)
      throw new SetupFailure(
        'Multipart upload discovery did not complete. D1 was preserved.',
      );
    const uploads = pages.flatMap((page) => page.results);
    for (const upload of uploads) {
      cloudflare.controller.signal.throwIfAborted();
      try {
        await bucket.resumeMultipartUpload(upload.key, upload.uploadId).abort();
      } catch (error) {
        // R2 reports already completed/aborted uploads with NoSuchUpload (10024).
        if (!(error instanceof Error) || !/\(10024\)$/.test(error.message))
          throw error;
      }
    }
    if (uploads.length < 1000) return;
    after = uploads.at(-1)!.key;
  }
}

async function storageConfig(plan: Plan) {
  const config = await readConfig(path.join(root, 'apps/web/wrangler.jsonc'));
  return {
    ...config,
    d1_databases: [],
    r2_buckets: [{ binding: 'BUCKET', bucket_name: plan.bucket!.name }],
  };
}

export async function verifyPlan(
  cloudflare: Cloudflare,
  plan: Plan,
  current: Inventory,
  review: Review,
) {
  if (cloudflare.accountId !== plan.accountId)
    throw new SetupFailure('Uninstall account mismatch.');
  const forceWorkers = await reviewShared(plan, current, review);
  if (
    plan.database &&
    current.databases.some((database) => database.uuid === plan.database!.uuid)
  ) {
    const kind = await hearthDatabase(cloudflare, plan.database.uuid);
    if (plan.completed.includes('database') || kind !== plan.database.kind) {
      await review(
        'The selected D1 database changed ownership or schema, or is still present after a previous deletion. All of its current data will be deleted.',
        [dashboard(plan.accountId, 'database', plan.database.uuid)],
        { kind, completed: plan.completed.includes('database') },
      );
      plan.database.kind = kind;
      plan.completed = plan.completed.filter((key) => key !== 'database');
    }
  }
  for (const worker of plan.workers) {
    const found = current.workers.find((item) => item.id === worker.id);
    if (!found) continue;
    const versionId = await cloudflare.activeVersion(worker.id);
    if (
      !plan.completed.includes(`worker:${worker.id}`) &&
      found.created_on === worker.created_on &&
      versionId === worker.versionId &&
      fingerprint(current.settings.get(worker.id)!) === worker.fingerprint
    )
      continue;
    const settings = current.settings.get(worker.id)!;
    await review(
      `Worker ${worker.id} changed since review, or is still present after a previous deletion. Inspect its current deployment before removing it.`,
      [dashboard(plan.accountId, 'worker', worker.id)],
      {
        found,
        settings,
        versionId,
        completed: plan.completed.includes(`worker:${worker.id}`),
      },
    );
    Object.assign(worker, found, {
      versionId,
      fingerprint: fingerprint(settings),
    });
    plan.completed = plan.completed.filter(
      (key) => key !== `worker:${worker.id}`,
    );
  }
  if (
    plan.bucket &&
    current.buckets.some((bucket) => bucket.name === plan.bucket!.name)
  ) {
    const bucket = await cloudflare.api(
      `/accounts/${plan.accountId}/r2/buckets/${encodeURIComponent(plan.bucket.name)}`,
      bucketSchema,
    );
    if (!bucket)
      throw new SetupFailure(
        'R2 metadata could not be read. Retry discovery before deleting resources.',
      );
    if (
      bucket.creation_date !== plan.bucket.creation_date ||
      plan.completed.includes('bucket')
    ) {
      await review(
        `R2 bucket ${bucket.name} was replaced or is still present after a previous deletion. All contents of the current bucket will be deleted.`,
        [dashboard(plan.accountId, 'bucket', bucket.name)],
        bucket,
      );
      Object.assign(plan.bucket, bucket);
      plan.completed = plan.completed.filter((key) => key !== 'bucket');
    }
    const domainsBase = `/accounts/${plan.accountId}/r2/buckets/${encodeURIComponent(bucket.name)}/domains`;
    const managed = await cloudflare.api(
      `${domainsBase}/managed`,
      z.object({ enabled: z.boolean() }),
    );
    const custom = await cloudflare.api(
      `${domainsBase}/custom`,
      z.object({
        domains: z.array(
          z.object({ domain: z.string(), enabled: z.boolean() }),
        ),
      }),
    );
    if (!managed || !custom)
      throw new SetupFailure(
        'R2 public access discovery did not complete. Retry discovery.',
      );
    if (managed.enabled || custom.domains.some((domain) => domain.enabled))
      await review(
        `R2 bucket ${bucket.name} permits public access. Removing it also removes the content served by its public URLs.`,
        [dashboard(plan.accountId, 'bucket', bucket.name)],
        { managed, custom },
      );
    await withBindings(
      cloudflare,
      await storageConfig(plan),
      async ({ BUCKET }) => {
        let cursor: string | undefined;
        const unfamiliar: string[] = [];
        const contentHash = createHash('sha256');
        let count = 0;
        do {
          const page = await BUCKET.list({ limit: 1000, cursor });
          for (const object of page.objects) {
            if (
              /^(?:objects\/usr_[a-f0-9]{32}\/\d{4}\/\d{2}\/img_[a-f0-9]{32}|previews\/usr_[a-f0-9]{32}\/img_[a-f0-9]{32}\/preview_[a-f0-9]{32}\.webp)$/.test(
                object.key,
              )
            )
              continue;
            count++;
            contentHash.update(`${object.key.length}:${object.key}`);
            if (unfamiliar.length < 10) unfamiliar.push(object.key);
          }
          cursor = page.truncated ? page.cursor : undefined;
        } while (cursor);
        if (count > 0)
          await review(
            `R2 bucket ${bucket.name} contains ${count} unrecognized objects and may be shared. All contents will be deleted, including these examples:\n${unfamiliar.join('\n')}`,
            [dashboard(plan.accountId, 'bucket', bucket.name)],
            { bucket, hash: contentHash.digest('hex') },
          );
      },
    );
  }
  for (const widget of plan.widgets) {
    const found = current.widgets.find(
      (item) => item.sitekey === widget.sitekey,
    );
    if (!(
      found &&
      (plan.completed.includes(`widget:${widget.sitekey}`) ||
        found.name !== widget.name ||
        found.domains.length !== widget.domains.length ||
        found.domains.some((domain) => !widget.domains.includes(domain)))
    )) {
      continue;
    }

    await review(
      `Turnstile widget ${widget.sitekey} changed since review. Removing it affects these hostnames: ${found.domains.join(', ')}.`,
      [dashboard(plan.accountId, 'widget', widget.sitekey)],
      found,
    );
    Object.assign(widget, found);
    plan.completed = plan.completed.filter(
      (key) => key !== `widget:${widget.sitekey}`,
    );
  }
  for (const domain of plan.domains) {
    const found = current.domains.find((item) => item.id === domain.id);
    if (!(
      found &&
      (found.service !== domain.service || found.hostname !== domain.hostname)
    )) {
      continue;
    }

    await review(
      `Custom Domain ${found.hostname} changed owner to Worker ${found.service}. Its assignment will be removed.`,
      [dashboard(plan.accountId, 'worker', found.service)],
      found,
    );
    Object.assign(domain, found);
    plan.completed = plan.completed.filter(
      (key) => key !== `domain:${domain.id}`,
    );
  }
  for (const route of plan.routes) {
    const found = current.routes.find(
      (item) => item.zoneId === route.zoneId && item.id === route.id,
    );
    if (!(
      found &&
      (found.script !== route.script || found.pattern !== route.pattern)
    )) {
      continue;
    }

    await review(
      `Route ${found.pattern} changed owner to ${found.script ?? 'no Worker'}. This route will be removed.`,
      [
        dashboard(plan.accountId, 'routes', route.zoneId),
        ...(found.script
          ? [dashboard(plan.accountId, 'worker', found.script)]
          : []),
      ],
      found,
    );
    Object.assign(route, found);
    plan.completed = plan.completed.filter(
      (key) => key !== `route:${route.id}`,
    );
  }
  return forceWorkers;
}

export async function executePlan(
  cloudflare: Cloudflare,
  plan: Plan,
  review: Review,
) {
  const base = `/accounts/${plan.accountId}`;
  const checkpoint = () =>
    atomicWrite(planFile, JSON.stringify(plan, null, 2) + '\n');
  async function remove(key: string, resource: string) {
    if (plan.completed.includes(key)) return;
    cloudflare.controller.signal.throwIfAborted();
    await cloudflare.api(resource, z.unknown(), {
      method: 'DELETE',
      missing: true,
    });
    plan.completed.push(key);
    await checkpoint();
  }
  let stopped = await inventory(cloudflare);
  // Verify producer removal before emptying storage, including an approved replacement.
  for (let attempt = 0; ; attempt++) {
    const forceWorkers = await verifyPlan(cloudflare, plan, stopped, review);
    await checkpoint();
    for (const route of plan.routes)
      await remove(
        `route:${route.id}`,
        `/zones/${route.zoneId}/workers/routes/${route.id}`,
      );
    for (const domain of plan.domains)
      await remove(
        `domain:${domain.id}`,
        `${base}/workers/domains/${domain.id}`,
      );
    const workers = plan.workers.toSorted(
      (a, b) =>
        Number(a.id.endsWith('-maintenance')) -
        Number(b.id.endsWith('-maintenance')),
    );
    for (const worker of workers)
      await remove(
        `worker:${worker.id}`,
        `${base}/workers/scripts/${encodeURIComponent(worker.id)}${forceWorkers.has(worker.id) ? '?force=true' : ''}`,
      );
    stopped = await inventory(cloudflare);
    if (
      stopped.workers.every((worker) =>
        plan.workers.every((target) => target.id !== worker.id),
      ) &&
      stopped.domains.every((domain) =>
        plan.domains.every((target) => target.id !== domain.id),
      ) &&
      stopped.routes.every((route) =>
        plan.routes.every(
          (target) => target.id !== route.id || target.zoneId !== route.zoneId,
        ),
      )
    )
      break;
    if (attempt >= 1)
      throw new SetupFailure(
        'Cloudflare still reports selected Workers, domains, or routes after repeated deletion. Storage was preserved; retry uninstall after checking Cloudflare.',
      );
  }
  await verifyPlan(cloudflare, plan, stopped, review);
  await checkpoint();
  if (plan.bucket && !plan.completed.includes('bucket')) {
    const buckets = await cloudflare.buckets();
    const found = buckets.some((bucket) => bucket.name === plan.bucket!.name);
    if (found)
      await withBindings(
        cloudflare,
        await storageConfig(plan),
        async ({ BUCKET }) => {
          if (
            plan.database?.kind === 'hearth' &&
            stopped.databases.some((db) => db.uuid === plan.database!.uuid)
          )
            await abortUploads(cloudflare, plan.database.uuid, BUCKET);
          await emptyBucket(BUCKET, cloudflare.controller.signal);
        },
      );
    try {
      await remove(
        'bucket',
        `${base}/r2/buckets/${encodeURIComponent(plan.bucket.name)}`,
      );
    } catch (error) {
      if (!(error instanceof SetupFailure)) throw error;
      throw new SetupFailure(
        `${error.message}\nR2 cleanup is incomplete. D1 and the recovery plan were preserved. Check bucket locks and any untracked unfinished multipart uploads in this bucket, then rerun pnpm run setup --uninstall.`,
        error.kind,
        error.dashboard,
      );
    }
  }
  if (plan.database)
    await remove(
      'database',
      `${base}/d1/database/${encodeURIComponent(plan.database.uuid)}`,
    );
  for (const widget of plan.widgets)
    await remove(
      `widget:${widget.sitekey}`,
      `${base}/challenges/widgets/${encodeURIComponent(widget.sitekey)}`,
    );
  const current = await inventory(cloudflare, false);
  if (
    current.workers.some((worker) =>
      plan.workers.some((item) => item.id === worker.id),
    ) ||
    current.databases.some((db) => db.uuid === plan.database?.uuid) ||
    current.buckets.some((bucket) => bucket.name === plan.bucket?.name) ||
    current.widgets.some((widget) =>
      plan.widgets.some((item) => item.sitekey === widget.sitekey),
    ) ||
    current.domains.some(
      (domain) =>
        plan.domains.some((item) => item.id === domain.id) ||
        plan.workers.some((worker) => worker.id === domain.service),
    ) ||
    current.routes.some(
      (route) =>
        plan.routes.some(
          (item) => item.id === route.id && item.zoneId === route.zoneId,
        ) || plan.workers.some((worker) => worker.id === route.script),
    )
  )
    throw new SetupFailure(
      'Cloudflare still reports selected resources. Cleanup is incomplete; rerun uninstall.',
    );
}

async function runUninstall(
  cloudflare: Cloudflare,
  state: SetupState,
  accounts: Account[],
  answer: Answer,
  selectedAccount?: string,
) {
  const review = reviewer(answer);
  const previous = await optionalText(planFile);
  const saved = previous ? planSchema.parse(JSON.parse(previous)) : undefined;
  const configs: ProductionConfig[] = [];
  for (const component of components)
    if (await optionalText(configPath(component)))
      configs.push(await readConfig(configPath(component)));
  const accountIds = new Set(
    [
      selectedAccount,
      saved?.accountId,
      state.accountId,
      ...configs.map((config) => config.account_id),
    ].filter(Boolean),
  );
  if (accountIds.size > 1)
    await review(
      `Saved files disagree about the Cloudflare account. This uninstall will use ${selectedAccount ?? saved?.accountId ?? state.accountId ?? configs.find((config) => config.account_id)?.account_id}. The local installer checkpoint will be cleared after cleanup; production files for other accounts will be preserved.`,
      [...accountIds].map((id) => dashboard(id)),
      [...accountIds],
    );
  const accountId = [...accountIds][0];
  if (accountId && accounts.every((account) => account.id !== accountId))
    throw new SetupFailure(
      'The saved Cloudflare account is inaccessible. Repair authentication before uninstalling.',
    );
  if (saved && selectedAccount && saved.accountId !== selectedAccount)
    throw new SetupFailure(
      `The saved uninstall targets account ${saved.accountId}. Select that account to resume its cleanup.`,
      'configuration',
      dashboard(saved.accountId),
    );
  cloudflare.accountId = accountId ?? (await selectAccount(accounts, answer));
  prompts.log.info('Discovering Hearth resources...');
  const current = await inventory(cloudflare);
  const plan =
    saved ??
    (await discover(cloudflare, state, configs, current, answer, review));
  await verifyPlan(cloudflare, plan, current, review);
  prompts.note(
    [
      `Account: ${plan.accountId}`,
      `Workers (including versions, secrets, assets, schedules and owned Durable Object namespaces): ${plan.workers.map((worker) => worker.id).join(', ') || 'none'}`,
      `Worker Custom Domains: ${plan.domains.map((domain) => domain.hostname).join(', ') || 'none'}`,
      `Worker routes: ${plan.routes.map((route) => route.pattern).join(', ') || 'none'}`,
      `D1 (all data): ${plan.database ? `${plan.database.name} (${plan.database.uuid})` : 'none'}`,
      `R2 (all images and previews): ${plan.bucket?.name ?? 'none'}`,
      `Turnstile: ${plan.widgets.map((widget) => widget.sitekey).join(', ') || 'none'}`,
      '',
      'Inspect in Cloudflare:',
      ...plan.workers.map((worker) =>
        dashboard(plan.accountId, 'worker', worker.id),
      ),
      ...(plan.database
        ? [dashboard(plan.accountId, 'database', plan.database.uuid)]
        : []),
      ...(plan.bucket
        ? [dashboard(plan.accountId, 'bucket', plan.bucket.name)]
        : []),
      ...plan.widgets.map((widget) =>
        dashboard(plan.accountId, 'widget', widget.sitekey),
      ),
      'Matching production files, installer backups, and artifacts/setup will be removed after remote verification.',
      'This permanently deletes your images, accounts, keys, and configuration. Back up anything you need first.',
    ].join('\n'),
    'Uninstall review',
  );
  if (
    !(await answer(
      prompts.confirm({
        message: `Permanently uninstall ${plan.prefix} from account ${plan.accountId}?`,
        initialValue: false,
      }),
    ))
  )
    throw new Declined();
  await atomicWrite(planFile, JSON.stringify(plan, null, 2) + '\n');
  await executePlan(cloudflare, plan, review);
  // Only remove production files for the selected instance, including installer backups.
  for (const component of components) {
    const file = configPath(component);
    const entries = await readdir(path.dirname(file));
    for (const entry of entries) {
      if (
        entry !== path.basename(file) &&
        !/^production\.local\.jsonc\.\d+\.bak$/.test(entry)
      )
        continue;
      const candidate = path.join(path.dirname(file), entry);
      const config = await readConfig(candidate);
      if (config.account_id && config.account_id !== plan.accountId) continue;
      if (
        plan.workers.every((worker) => worker.id !== config.name) &&
        config.d1_databases.every(
          (db) => db.database_id !== plan.database?.uuid,
        )
      )
        continue;
      await rm(candidate);
    }
  }
  prompts.outro(
    'Hearth resources were removed and remote absence verified. Local installer state is being cleared. Goodbye!',
  );
  return true;
}

export async function uninstall(
  cloudflare: Cloudflare,
  state: SetupState,
  accounts: Account[],
  answer: Answer,
  selectedAccount?: string,
) {
  try {
    return await runUninstall(
      cloudflare,
      state,
      accounts,
      answer,
      selectedAccount,
    );
  } catch (error) {
    if (!(error instanceof Declined)) throw error;
    prompts.cancel(
      'Uninstall stopped. No further resources were deleted. Any saved recovery information is preserved.',
    );
    return false;
  }
}
