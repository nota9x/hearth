import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';

export default async function setup() {
  const directory = path.resolve(
    'artifacts/browser-workers',
    crypto.randomUUID(),
  );
  await mkdir(directory, { recursive: true });
  for (const [name, config] of [
    ['web', 'apps/web/wrangler.jsonc'],
    ['delivery', 'workers/delivery/wrangler.jsonc'],
  ]) {
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
  process.env.HEARTH_BROWSER_BUNDLES = directory;
}
