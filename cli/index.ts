/* eslint-disable unicorn/no-await-expression-member -- Lazy command registration loads only the requested module. */
import { defineCommand, runMain } from 'citty';

import manifest from '../package.json' with { type: 'json' };
import { serverCommand } from './development/command.ts';

const argv = process.argv.slice(2);
const separator = argv.indexOf('--');
const rawArguments = separator === -1 ? argv : argv.slice(0, separator);
const forwarded = separator === -1 ? [] : argv.slice(separator + 1);

if (forwarded.length > 0 && !['dev', 'preview'].includes(rawArguments[0])) {
  console.error(
    'Native tool argument groups are supported only by dev and preview.',
  );
  process.exitCode = 1;
} else
  await runMain(
    defineCommand({
      meta: {
        name: 'hearth',
        version: manifest.version,
        description: 'Develop, preview, install, and manage Hearth.',
      },
      subCommands: {
        dev: () => serverCommand('development', forwarded),
        preview: () => serverCommand('preview', forwarded),
        setup: async () => {
          const module = await import('./setup/index.ts');
          return module.default;
        },
        configure: async () =>
          (await import('./commands/configure.ts')).default,
        bootstrap: async () =>
          (await import('./commands/bootstrap.ts')).default,
        storage: defineCommand({
          meta: { name: 'storage', description: 'Manage storage accounting.' },
          subCommands: {
            initialize: async () =>
              (await import('./commands/storage-initialize.ts')).default,
          },
        }),
      },
    }),
    { rawArgs: rawArguments },
  );
