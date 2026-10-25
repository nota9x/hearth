import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import path from 'node:path';

import { execa } from 'execa';
import { describe, expect, it, onTestFinished } from 'vitest';

import { root } from '../../cli/development/config';
import {
  findDevelopmentServer,
  portAvailable,
  stopDevelopmentServer,
} from '../../cli/development/ports';

// Exercise native Windows discovery and termination against an owned, disposable
// process tree. These processes listen only; they never start Vite or touch D1/R2.
describe('development port handling', () => {
  it('detects occupied ports and releases a probe without retaining a listener', async () => {
    const server = createServer();
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Expected TCP address');
    expect(await portAvailable(address.port)).toBe(false);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(await portAvailable(address.port)).toBe(true);
    expect(await portAvailable(address.port)).toBe(true);
  });

  it.runIf(process.platform === 'win32').each(['development', 'preview'])(
    'identifies only Hearth %s servers and terminates the selected process tree',
    async (mode) => {
      const servicePath = path.join(root, 'cli/development/tool-process.mjs');
      const launcherPath =
        mode === 'development'
          ? 'scripts/cli.mjs'
          : path.join(root, 'scripts/cli.mjs');
      const listener =
        "import { createServer } from 'node:net'; const server = createServer(); server.listen(0, '127.0.0.1', () => process.send(server.address().port));";
      const parent = `import { spawn } from 'node:child_process'; const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(listener)}, ${JSON.stringify(servicePath)}], { stdio: ['ignore', 'ignore', 'inherit', 'ipc'], windowsHide: true }); child.on('message', (port) => process.send(port));`;
      const child = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          parent,
          launcherPath,
          mode === 'preview' ? 'preview' : 'dev',
        ],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'], windowsHide: true },
      );
      onTestFinished(async () => {
        if (child.exitCode === null)
          await execa('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            reject: false,
          });
      });
      let stderr = '';
      child.stderr!.on('data', (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      const port = await new Promise<number>((resolve, reject) => {
        child.once('error', reject);
        child.once('exit', (code) =>
          reject(new Error(`Listener exited (${code}): ${stderr}`)),
        );
        child.once('message', (message) => resolve(Number(message)));
      });
      expect(await portAvailable(port)).toBe(false);
      expect(await findDevelopmentServer(port)).toBe(child.pid);
      await stopDevelopmentServer(child.pid!, port);
      expect(await portAvailable(port)).toBe(true);
      const unrelated = createServer();
      await new Promise<void>((resolve) =>
        unrelated.listen(port, '127.0.0.1', resolve),
      );
      try {
        expect(await findDevelopmentServer(port)).toBeUndefined();
      } finally {
        await new Promise<void>((resolve) => unrelated.close(() => resolve()));
      }
    },
  );
});
