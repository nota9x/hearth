import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { defineCommand } from 'citty';
import { execa } from 'execa';

import { prepareBootstrap } from '../bootstrap-data';
import { reportError, validateOptions } from '../options';

export async function bootstrap(name: string, config: string, remote: boolean) {
  if (!name.trim() || name.length > 80)
    throw new Error('Display name must contain 1�80 characters.');
  const candidate = await prepareBootstrap(name);
  const directory = await mkdtemp(path.join(tmpdir(), 'hearth-bootstrap-'));
  try {
    const file = path.join(directory, 'bootstrap.sql');
    await writeFile(file, candidate.sql, { mode: 0o600 });
    const result = await execa(
      process.execPath,
      [
        path.resolve('node_modules/wrangler/bin/wrangler.js'),
        'd1',
        'execute',
        'DB',
        remote ? '--remote' : '--local',
        '--config',
        config,
        '--file',
        file,
        '--yes',
      ],
      {
        reject: false,
        env: { WRANGLER_WRITE_LOGS: 'false' },
      },
    );
    if (result.exitCode !== 0)
      throw new Error(
        'Bootstrap refused or failed. Check migrations and existing administrators. No credentials were logged.',
      );
    console.log(
      `Administrator created: ${name}\nSave this API key; it will not be shown again:\n${candidate.key.plaintext}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
const argumentsDefinition = {
  name: {
    type: 'positional',
    description: 'First administrator display name.',
  },
  remote: {
    type: 'boolean',
    default: false,
    description: 'Initialize the remote database.',
  },
  config: {
    type: 'string',
    default: 'apps/web/wrangler.jsonc',
    description: 'Wrangler configuration path.',
  },
} as const;
export default defineCommand({
  meta: {
    name: 'bootstrap',
    description: 'Create the first administrator on an empty database.',
  },
  args: argumentsDefinition,
  async run(context) {
    try {
      validateOptions(context.rawArgs, argumentsDefinition);
      await bootstrap(
        context.args.name!,
        context.args.config,
        context.args.remote,
      );
    } catch (error) {
      reportError(error);
    }
  },
});
