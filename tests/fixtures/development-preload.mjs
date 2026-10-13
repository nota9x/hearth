import childProcess from 'node:child_process';
import { EventEmitter } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

if (
  ['development.ts', 'preview.ts'].some((entry) =>
    process.argv[1]?.endsWith(entry),
  )
) {
  const fork = childProcess.fork;
  const services = [];
  let booted = 0;
  childProcess.fork = (_module, arguments_, options) => {
    const child = fork(
      fileURLToPath(new URL('development-service.mjs', import.meta.url)),
      arguments_,
      options,
    );
    services.push(child);
    child.on('message', (message) => {
      if (message === 'booted' && ++booted === 3)
        for (const service of services) service.send('begin');
    });
    return child;
  };
  net.createServer = () => {
    // eslint-disable-next-line unicorn/prefer-event-target -- Model Node's port probe API without reserving development ports.
    const probe = new EventEmitter();
    probe.listen = (_port, _host, callback) => queueMicrotask(callback);
    probe.close = (callback) => callback();
    return probe;
  };
  const timeout = setTimeout;
  // eslint-disable-next-line unicorn/no-global-object-property-assignment -- Exercise the launcher's 60-second deadline with a short fixture clock.
  globalThis.setTimeout = (callback, delay, ...arguments_) =>
    timeout(
      callback,
      delay === 60_000 && process.env.HEARTH_DEV_TEST_SCENARIO === 'timeout'
        ? 1500
        : delay,
      ...arguments_,
    );
  syncBuiltinESMExports();
  process.on('message', () => process.emit('SIGTERM'));
}
