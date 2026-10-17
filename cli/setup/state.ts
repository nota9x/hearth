import { createHash } from 'node:crypto';
import {
  link,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import path from 'node:path';

import { z } from 'zod';

import { type Component, projects, root } from '../production-config';

const deployment = z.object({ fingerprint: z.string(), versionId: z.string() });
export const stateSchema = z.object({
  version: z.literal(1).default(1),
  accountId: z
    .string()
    .regex(/^[a-f0-9]{32}$/)
    .optional(),
  prefix: z.string().default('hearth'),
  application: z.string().optional(),
  delivery: z.array(z.string()).default([]),
  databaseName: z.string().default('hearth-production'),
  bucket: z.string().default('hearth-production'),
  bucketCreatedOn: z.string().optional(),
  webDraftCreatedOn: z.string().optional(),
  databaseId: z.uuid().optional(),
  turnstile: z.string().optional(),
  displayName: z.string().default('Administrator'),
  subdomain: z.string().optional(),
  namespaces: z.record(z.string(), z.string()).default({}),
  bootstrapUserId: z
    .string()
    .regex(/^usr_[a-f0-9]{32}$/)
    .optional(),
  adopted: z.boolean().default(false),
  initialized: z.boolean().default(false),
  created: z
    .object({
      database: z.boolean().default(false),
      bucket: z.boolean().default(false),
      widget: z.boolean().default(false),
      webDraft: z.boolean().default(false),
    })
    .default({
      database: false,
      bucket: false,
      widget: false,
      webDraft: false,
    }),
  migrations: z.record(z.string(), z.string()).default({}),
  buildFingerprint: z.string().optional(),
  deployments: z
    .object({
      web: deployment.optional(),
      delivery: deployment.optional(),
      maintenance: deployment.optional(),
    })
    .default({}),
  probe: z
    .object({
      receiptHash: z.string(),
      ownerId: z.string(),
      attempted: z.boolean().default(false),
      imageId: z.string().optional(),
      url: z.string().optional(),
    })
    .optional(),
});
export type SetupState = z.infer<typeof stateSchema>;
export const setupDirectory = path.join(root, 'artifacts/setup');

export function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}
export async function optionalText(file: string) {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if (isMissing(error)) return;
    throw error;
  }
}
export async function atomicWrite(
  file: string,
  content: string,
  exclusive = false,
) {
  await mkdir(path.dirname(file), { recursive: true });
  const temporary = `${file}.${crypto.randomUUID()}.tmp`;
  try {
    await writeFile(temporary, content, { flag: 'wx', mode: 0o600 });
    if (exclusive) await link(temporary, file);
    else await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}
export async function loadState(
  directory = setupDirectory,
): Promise<SetupState> {
  const text = await optionalText(path.join(directory, 'state.json'));
  return stateSchema.parse(text ? JSON.parse(text) : {});
}
export async function saveState(state: SetupState, directory = setupDirectory) {
  await atomicWrite(
    path.join(directory, 'state.json'),
    JSON.stringify(stateSchema.parse(state), null, 2) + '\n',
  );
}
export async function acquireLock(directory = setupDirectory) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, 'setup.lock');
  const previous = await optionalText(file);
  if (previous) {
    const owner = z
      .object({ pid: z.number().int().positive(), hostname: z.string() })
      .parse(JSON.parse(previous));
    if (owner.hostname !== hostname())
      throw new Error(
        'Another computer owns the setup lock. Finish that installer before retrying.',
      );
    let running = true;
    try {
      process.kill(owner.pid, 0);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'ESRCH')
        running = false;
    }
    if (running)
      throw new Error(
        'Another Hearth installer is running in this checkout. Finish it before retrying.',
      );
    await rm(file);
  }
  const handle = await open(file, 'wx', 0o600);
  await handle.writeFile(
    JSON.stringify({ pid: process.pid, hostname: hostname() }),
  );
  await handle.close();
  return async () => {
    await rm(file, { force: true });
  };
}
export async function migrationFiles() {
  const directory = path.join(root, 'drizzle');
  const entries = await readdir(directory);
  const names = entries.filter((name) => name.endsWith('.sql'));
  names.sort((a, b) => a.localeCompare(b));
  const result: Record<string, string> = {};
  for (const name of names)
    result[name] = createHash('sha256')
      .update(await readFile(path.join(directory, name)))
      .digest('hex');
  return result;
}
export function assertMigrationHistory(
  applied: string[],
  available: Record<string, string>,
  previous: Record<string, string> = {},
) {
  if (applied.some((name) => !Object.hasOwn(available, name)))
    throw new Error(
      'This database uses an unsupported migration history. Do not apply 0000_initial.sql over it. Use a fresh database and the backups/recovery guide.',
    );
  for (const name of applied) {
    const fingerprint = previous[name];
    if (fingerprint !== undefined && fingerprint !== available[name])
      throw new Error(
        `Applied migration ${name} changed locally. Restore the matching source before retrying; migration history will not be rewritten.`,
      );
  }
}
export async function sourceFingerprint(component: Component, config: unknown) {
  const hash = createHash('sha256').update(JSON.stringify(config));
  async function visit(relative: string, directory: boolean) {
    const file = path.join(root, relative);
    if (!directory) {
      const content = await readFile(file);
      hash
        .update(relative)
        .update('\0')
        .update(String(content.length))
        .update('\0')
        .update(content);
      return;
    }
    const entries = await readdir(file, { withFileTypes: true });
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries)
      if (entry.isFile() || entry.isDirectory())
        await visit(`${relative}/${entry.name}`, entry.isDirectory());
  }
  for (const relative of [
    'package.json',
    'pnpm-lock.yaml',
    'tsconfig.json',
    ...(component === 'web'
      ? ['apps/web/package.json', 'apps/web/vite.config.ts']
      : []),
  ]) {
    try {
      await visit(relative, false);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  for (const relative of [
    'packages/core',
    `${projects[component]}/src`,
    ...(component === 'web' ? ['apps/web/static'] : []),
  ])
    await visit(relative, true);
  return hash.digest('hex');
}
