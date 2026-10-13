import { readFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';
import { z } from 'zod';

export const root = path.resolve(import.meta.dirname, '..');
export const persistence = path.join(root, 'apps/web/.wrangler/state');
export const projects = {
  web: 'apps/web',
  delivery: 'workers/delivery',
  maintenance: 'workers/maintenance',
} as const;
export type ServerMode = 'development' | 'preview';
export type Component = keyof typeof projects;

const schema = z.object({
  main: z.string(),
  vars: z.record(z.string(), z.string()).default({}),
  dev: z.object({ port: z.number().int().min(1).max(65_535) }),
  d1_databases: z
    .array(
      z.object({ binding: z.literal('DB'), database_id: z.string().min(1) }),
    )
    .nonempty(),
  r2_buckets: z
    .array(
      z.object({
        binding: z.literal('BUCKET'),
        bucket_name: z.string().min(1),
      }),
    )
    .nonempty(),
  triggers: z.object({ crons: z.array(z.string()).nonempty() }).optional(),
});

export async function readDevelopmentConfig(component: Component) {
  const directory = path.join(root, projects[component]);
  const config = path.join(directory, 'wrangler.jsonc');
  const parsed = ts.parseConfigFileTextToJson(
    config,
    await readFile(config, 'utf8'),
  );
  if (parsed.error) throw new Error(`Invalid JSONC in ${config}`);
  const result = schema.safeParse(parsed.config);
  if (!result.success)
    throw new Error(
      `Invalid local configuration in ${config}: ${result.error.message}`,
    );
  if (component === 'maintenance' && !result.data.triggers)
    throw new Error(
      `Missing triggers.crons in ${config}. Configure the production maintenance schedule there.`,
    );
  return { directory, config, ...result.data };
}
