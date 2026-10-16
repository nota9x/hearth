import { readFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';
import { z } from 'zod';

import { hostnameSchema } from '../packages/core/common';
import { isPublicHostname } from '../packages/core/domain-format';
import { type Component, components, projects, root } from './project';

export { type Component, components, projects, root } from './project';
export const configPath = (component: Component) =>
  path.join(root, projects[component], 'production.local.jsonc');
export const publicHostname = hostnameSchema.refine(isPublicHostname, {
  message: 'Use a public hostname without protocol, path, port, or wildcard.',
});
export const bucketName = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/);
export const siteKey = z
  .string()
  .trim()
  .min(10)
  .refine(
    (value) => !/^[123]x000/.test(value),
    'Use a real Turnstile site key.',
  );
export const productionConfigSchema = z.looseObject({
  name: z.string().min(1),
  account_id: z.string().optional(),
  main: z.string(),
  compatibility_date: z.string(),
  compatibility_flags: z.array(z.string()),
  vars: z.record(z.string(), z.string()).optional(),
  routes: z
    .array(
      z.looseObject({
        pattern: z.string(),
        custom_domain: z.boolean().optional(),
      }),
    )
    .optional(),
  d1_databases: z
    .array(
      z.looseObject({
        binding: z.string(),
        database_id: z.string(),
        database_name: z.string(),
        migrations_dir: z.string().optional(),
      }),
    )
    .nonempty(),
  r2_buckets: z
    .array(z.looseObject({ binding: z.string(), bucket_name: z.string() }))
    .nonempty(),
  ratelimits: z
    .array(
      z.looseObject({
        name: z.string(),
        namespace_id: z.string(),
        simple: z.object({ limit: z.number(), period: z.number() }),
      }),
    )
    .optional(),
  triggers: z.object({ crons: z.array(z.string()) }).optional(),
});
export type ProductionConfig = z.infer<typeof productionConfigSchema>;
export async function readConfig(file: string): Promise<ProductionConfig> {
  const parsed = ts.parseConfigFileTextToJson(
    file,
    await readFile(file, 'utf8'),
  );
  if (parsed.error)
    throw new Error(
      `Invalid JSONC in ${file}. Correct it and retry; existing resources are preserved.`,
    );
  return productionConfigSchema.parse(parsed.config);
}
export interface ProductionOptions {
  application: string;
  delivery: string[];
  databaseId: string;
  bucket: string;
  turnstile: string;
  accountId?: string;
  prefix?: string;
  databaseName?: string;
  namespaces?: Record<string, string>;
}
export function validateHostnames(app_: string, delivery: string[]) {
  const app = publicHostname.parse(app_);
  const hosts = [
    ...new Set(delivery.map((value) => publicHostname.parse(value))),
  ];
  if (hosts.includes(app))
    throw new Error('Application and delivery hostnames must be different.');
  return { application: app, delivery: hosts };
}
export async function renderProduction(options: ProductionOptions) {
  const { application, delivery } = validateHostnames(
    options.application,
    options.delivery,
  );
  const databaseId = z.uuid().parse(options.databaseId);
  const bucket = bucketName.parse(options.bucket);
  const turnstile = siteKey.parse(options.turnstile);
  const outputs: {
    component: Component;
    path: string;
    config: ProductionConfig;
    content: string;
  }[] = [];
  for (const component of components) {
    const config = await readConfig(
      path.join(root, projects[component], 'wrangler.jsonc'),
    );
    delete config.dev;
    config.workers_dev = false;
    config.preview_urls = false;
    if (options.accountId) config.account_id = options.accountId;
    if (options.prefix) config.name = `${options.prefix}-${component}`;
    const database = config.d1_databases.find(
      (binding) => binding.binding === 'DB',
    );
    const storage = config.r2_buckets.find(
      (binding) => binding.binding === 'BUCKET',
    );
    if (!database || !storage)
      throw new Error(
        `Missing DB or BUCKET template binding for ${component}.`,
      );
    database.database_id = databaseId;
    database.database_name = options.databaseName ?? 'hearth-production';
    storage.bucket_name = bucket;
    const limiters = config.ratelimits ?? [];
    for (const limiter of limiters) {
      const namespace = options.namespaces?.[limiter.name];
      if (namespace !== undefined) limiter.namespace_id = namespace;
    }
    config.observability = {
      enabled: true,
      head_sampling_rate: 0.1,
      traces: { enabled: true, head_sampling_rate: 0.1 },
    };
    if (component === 'web') {
      config.vars = {
        ENVIRONMENT: 'production',
        APP_ORIGIN: `https://${application}`,
        TURNSTILE_SITE_KEY: turnstile,
        MAX_UPLOAD_BYTES: '26214400',
      };
      config.routes = [{ pattern: application, custom_domain: true }];
    } else if (component === 'delivery') {
      config.vars = {
        ENVIRONMENT: 'production',
        APP_ORIGIN: `https://${application}`,
      };
      config.routes = delivery.map((pattern) => ({
        pattern,
        custom_domain: true,
      }));
    }
    outputs.push({
      component,
      path: configPath(component),
      config,
      content: JSON.stringify(config, null, 2) + '\n',
    });
  }
  return outputs;
}
