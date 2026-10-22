import { spawnSync } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';
import type { TestProject } from 'vitest/node';

export default async function setup(project: TestProject) {
  const directory = path.resolve('artifacts/test-workers', crypto.randomUUID());
  await mkdir(directory, { recursive: true });
  const web = ts.parseConfigFileTextToJson(
    'apps/web/wrangler.jsonc',
    await readFile('apps/web/wrangler.jsonc', 'utf8'),
  ).config as { compatibility_date: string; compatibility_flags: string[] };
  const uploadConfig = path.join(directory, 'upload.json');
  await writeFile(
    uploadConfig,
    JSON.stringify({
      name: 'upload-test',
      main: path.resolve('tests/fixtures/upload-worker.ts'),
      compatibility_date: web.compatibility_date,
      compatibility_flags: web.compatibility_flags,
    }),
  );
  const faultConfig = path.join(directory, 'maintenance-fault.json');
  await writeFile(
    faultConfig,
    JSON.stringify({
      name: 'maintenance-fault',
      main: path.resolve('tests/fixtures/maintenance-worker.ts'),
      compatibility_date: web.compatibility_date,
      compatibility_flags: web.compatibility_flags,
      durable_objects: {
        bindings: [{ name: 'MAINTENANCE', class_name: 'TestMaintenanceJob' }],
      },
      exports: {
        TestMaintenanceJob: { type: 'durable-object', storage: 'sqlite' },
      },
    }),
  );
  for (const [name, config] of [
    ['delivery', 'workers/delivery/wrangler.jsonc'],
    ['upload', uploadConfig],
    ['maintenance-fault', faultConfig],
  ] as const) {
    const result = spawnSync(
      process.execPath,
      [
        path.resolve('node_modules/wrangler/bin/wrangler.js'),
        'deploy',
        '--dry-run',
        '--config',
        config,
        '--outdir',
        path.join(directory, name),
      ],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
      },
    );
    if (result.status !== 0) throw new Error(result.stdout + result.stderr);
  }
  project.provide('workerBundles', directory);
}
