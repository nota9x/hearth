import childProcess from 'node:child_process';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';

if (
  process.argv[1]?.endsWith('scripts/cli.mjs') ||
  process.argv[1]?.endsWith(String.raw`scripts\cli.mjs`)
) {
  const access = fs.access;
  fs.access = (file, ...options) =>
    String(file)
      .replaceAll('\\', '/')
      .endsWith('.svelte-kit/cloudflare/_worker.js')
      ? Promise.resolve()
      : access(file, ...options);
  const spawn = childProcess.spawn;
  childProcess.spawn = (command, arguments_, options) => {
    const index = arguments_.findIndex((argument) =>
      /(?:vite[\\/]bin[\\/]vite|wrangler-dist[\\/]cli)\.js$/.test(argument),
    );
    if (index !== -1) {
      const component = arguments_.includes('dev')
        ? options.cwd.replaceAll('\\', '/').split('/').at(-1)
        : 'web';
      arguments_ = [
        ...arguments_.slice(0, index),
        fileURLToPath(new URL('development-service.mjs', import.meta.url)),
        component,
        ...arguments_.slice(index + 1),
      ];
    }
    return spawn(command, arguments_, options);
  };
  const timeout = AbortSignal.timeout;
  AbortSignal.timeout = (duration) =>
    timeout(
      duration === 60_000 && process.env.HEARTH_DEV_TEST_SCENARIO === 'timeout'
        ? 1500
        : duration,
    );
  syncBuiltinESMExports();
  process.on('message', () => process.emit('SIGTERM'));
  process.channel?.unref();
}
