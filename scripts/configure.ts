import { readFile, writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';

import ts from 'typescript';
import { z } from 'zod';

import { hostnameSchema } from '../packages/core/common';
import { isPublicHostname } from '../packages/core/domain-format';

const { values } = parseArgs({
  options: {
    application: { type: 'string' },
    delivery: { type: 'string', multiple: true },
    database: { type: 'string' },
    bucket: { type: 'string' },
    turnstile: { type: 'string' },
  },
});
const app = hostnameSchema.parse(values.application);
const delivery = [
  ...new Set(
    (values.delivery || []).map((value) => hostnameSchema.parse(value)),
  ),
];
if (delivery.includes(app))
  throw new Error('Application and delivery hostnames must be different.');
if ([app, ...delivery].some((hostname) => !isPublicHostname(hostname)))
  throw new Error('Production requires public Cloudflare hostnames.');
const databaseId = z.uuid().parse(values.database);
const bucket = z
  .string()
  .min(3)
  .max(63)
  .regex(/^[a-z0-9][a-z0-9-]+[a-z0-9]$/)
  .parse(values.bucket);
const siteKey = z
  .string()
  .min(10)
  .refine((value) => !/^[123]x000/.test(value), 'Use a real Turnstile site key')
  .parse(values.turnstile);
const configSchema = z.looseObject({
  d1_databases: z
    .array(
      z.looseObject({ database_id: z.string(), database_name: z.string() }),
    )
    .nonempty(),
  r2_buckets: z.array(z.looseObject({ bucket_name: z.string() })).nonempty(),
});
// Generate reviewable deployment files; provisioning and deployment are separate.
const outputs = [];
for (const project of ['apps/web', 'workers/delivery', 'workers/maintenance']) {
  const source = `${project}/wrangler.jsonc`;
  const parsed = ts.parseConfigFileTextToJson(
    source,
    await readFile(source, 'utf8'),
  );
  if (parsed.error) throw new Error(`Invalid JSONC: ${source}`);
  const config = configSchema.parse(parsed.config);
  delete config.dev;
  config.workers_dev = false;
  config.preview_urls = false;
  config.d1_databases[0].database_id = databaseId;
  config.d1_databases[0].database_name = 'hearth-production';
  config.r2_buckets[0].bucket_name = bucket;
  config.observability = { enabled: true, head_sampling_rate: 0.1 };
  if (project === 'apps/web') {
    config.vars = {
      ENVIRONMENT: 'production',
      APP_ORIGIN: `https://${app}`,
      TURNSTILE_SITE_KEY: siteKey,
      MAX_UPLOAD_BYTES: '26214400',
    };
    config.routes = [{ pattern: app, custom_domain: true }];
  } else if (project === 'workers/delivery') {
    config.vars = { APP_ORIGIN: `https://${app}`, ENVIRONMENT: 'production' };
    config.routes = delivery.map((hostname) => ({
      pattern: hostname,
      custom_domain: true,
    }));
  }
  outputs.push({
    path: `${project}/production.local.jsonc`,
    content: JSON.stringify(config, null, 2) + '\n',
  });
}
for (const output of outputs) {
  await writeFile(output.path, output.content, { flag: 'wx' });
  console.log(`Created ${output.path}`);
}
console.log(
  'Add delivery hostnames in Hearth, validate them, and select a primary domain after deploying.',
);
