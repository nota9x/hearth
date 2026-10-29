import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as prompts from '@clack/prompts';
import { defineCommand } from 'citty';
import { execa } from 'execa';

import {
  bootstrapLocalAdministrator,
  prepareBootstrap,
  purgeLocalDatabase,
} from '../bootstrap-data';
import { reportError, validateOptions } from '../options';

const validateName = (value: string | undefined) =>
  !value?.trim() || value.trim().length > 80
    ? 'Enter a display name containing 1–80 characters.'
    : undefined;

export async function bootstrap(
  name: string | undefined,
  config: string,
  remote: boolean,
) {
  const interactive =
    process.stdin.isTTY && process.stdout.isTTY && !process.env.CI;
  const wrangler = remote ? undefined : await import('wrangler');
  const platform = await wrangler?.getPlatformProxy<{
    DB: D1Database;
    BUCKET: R2Bucket;
  }>({
    configPath: config,
    persist: {
      path: path.join(path.dirname(path.resolve(config)), '.wrangler/state/v3'),
    },
    remoteBindings: false,
    envFiles: [],
  });
  try {
    let reset = false;
    if (
      platform &&
      (await platform.env.DB.prepare('SELECT 1 FROM users LIMIT 1').first())
    ) {
      if (!interactive)
        throw new Error(
          'An administrator already exists. Sign in with the saved key, or rerun pnpm bootstrap in a terminal to reset the local database.',
        );
      prompts.log.warn(
        'An administrator already exists in the local database.',
      );
      const confirmed = await prompts.confirm({
        message:
          'Purge the local database and bootstrap again? This deletes all local accounts, image records, and settings. Local R2 files are kept.',
        initialValue: false,
      });
      if (!confirmed || prompts.isCancel(confirmed)) {
        prompts.cancel('Bootstrap cancelled. The local database was kept.');
        return;
      }
      reset = true;
    }
    if (name === undefined) {
      if (!interactive)
        throw new Error('Provide a display name: pnpm bootstrap "Your name".');
      const answer = await prompts.text({
        message: 'Administrator display name',
        placeholder: 'Your name',
        validate: validateName,
      });
      if (prompts.isCancel(answer)) {
        prompts.cancel('Bootstrap cancelled.');
        return;
      }
      name = answer;
    }
    const invalidName = validateName(name);
    if (invalidName) throw new Error(invalidName);
    name = name.trim();
    const candidate = await prepareBootstrap(name);
    if (platform) {
      if (reset) {
        await purgeLocalDatabase(platform.env.DB);
        const migration = await execa(
          process.execPath,
          [
            path.resolve('node_modules/wrangler/bin/wrangler.js'),
            'd1',
            'migrations',
            'apply',
            'DB',
            '--local',
            '--config',
            config,
          ],
          { reject: false, env: { WRANGLER_WRITE_LOGS: 'false' } },
        );
        if (migration.exitCode !== 0)
          throw new Error(
            'The local database was purged, but migrations failed. Apply migrations with the selected config, then rerun bootstrap.',
            { cause: migration.stderr },
          );
      }
      await bootstrapLocalAdministrator(platform.env, candidate);
    } else {
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
            '--remote',
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
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
    console.log(
      `Administrator created: ${name}\nSave this API key; it will not be shown again:\n${candidate.key.plaintext}`,
    );
  } finally {
    await platform?.dispose();
  }
}
const argumentsDefinition = {
  name: {
    type: 'positional',
    required: false,
    description: 'First administrator display name; prompts when omitted.',
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
        context.args.name,
        context.args.config,
        context.args.remote,
      );
    } catch (error) {
      reportError(error);
    }
  },
});
