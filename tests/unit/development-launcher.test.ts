import { fork } from 'node:child_process';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { portAvailable } from '../../cli/development/ports';

async function launch(scenario: string, mode = 'development') {
  const ports = await Promise.all(
    Array.from({ length: 3 }, async () => {
      const server = createServer();
      await new Promise<void>((resolve) =>
        server.listen(0, '127.0.0.1', resolve),
      );
      const port = (server.address() as { port: number }).port;
      await new Promise<void>((resolve) => server.close(() => resolve()));
      return port;
    }),
  );
  const child = fork(
    fileURLToPath(new URL('../../scripts/cli.mjs', import.meta.url)),
    [
      mode === 'preview' ? 'preview' : 'dev',
      '--web-port',
      String(ports[0]),
      '--delivery-port',
      String(ports[1]),
      '--maintenance-port',
      String(ports[2]),
    ],
    {
      silent: true,
      execArgv: [
        '--import',
        'tsx',
        '--import',
        new URL('../fixtures/development-preload.mjs', import.meta.url).href,
      ],
      env: {
        ...process.env,
        NO_COLOR: '1',
        HEARTH_DEV_TEST_SCENARIO: scenario,
      },
    },
  );
  let stdout = '';
  let stderr = '';
  let stopped = false;
  child.stdout!.on('data', (chunk: Buffer) => {
    stdout += chunk.toString();
    if (!(
      !stopped &&
      ['success', 'early-stop', 'hang'].includes(scenario) &&
      stdout.includes(
        scenario === 'early-stop' ? 'booting web' : 'All services ready',
      )
    )) {
      return;
    }

    stopped = true;
    child.send('stop');
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const timeout = setTimeout(
    () => child.kill(),
    scenario === 'hang' ? 25_000 : 10_000,
  );
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timeout);
  return { stdout, stderr, code };
}

describe('launcher lifecycle', () => {
  it.each(['development', 'preview'])(
    'starts maintenance before web in %s, reports readiness, and drains final stderr on shutdown',
    async (mode) => {
      const { stdout, stderr, code } = await launch('success', mode);
      expect(code).toBe(0);
      expect(stdout).toContain(
        mode === 'preview' ? 'Production Preview' : 'Development Server',
      );
      expect(stdout).toContain(`[${mode === 'preview' ? 'preview' : 'dev'}]`);
      const delivery = stdout.indexOf('[delivery]    READY');
      const maintenance = stdout.indexOf('[maintenance] READY');
      const web = stdout.indexOf('[web]         READY');
      expect(delivery).toBeGreaterThan(stdout.indexOf('booting web'));
      expect(stdout.indexOf('booting web')).toBeGreaterThan(maintenance);
      expect(stdout.indexOf('booting delivery')).toBeGreaterThan(maintenance);
      expect(web).toBeGreaterThan(maintenance);
      for (const component of ['web', 'delivery', 'maintenance']) {
        expect(stderr).toContain(`final diagnostic ${component}`);
        expect(stdout).toContain(`booting ${component}`);
      }
      expect(stdout).toContain('All services stopped');
      expect(stdout).not.toContain('\u{1B}');
    },
  );

  it('retains startup errors and stops siblings with a failure exit code', async () => {
    const { stdout, stderr, code } = await launch('failure');
    expect(code).toBe(7);
    expect(stderr).toContain('startup failure detail');
    expect(stderr).toContain('delivery exited (7)');
    expect(stderr).toContain('final diagnostic web');
    expect(stderr).toContain('final diagnostic maintenance');
    expect(stdout).not.toContain('All services ready');
  });

  it('reflects unexpected exits after readiness and shuts down the environment', async () => {
    const { stdout, stderr, code } = await launch('late-exit');
    expect(code).toBe(7);
    expect(stdout).toContain('All services ready');
    expect(stderr).toContain('delivery exited (7)');
    expect(stdout).toContain('All services stopped');
  });

  it('fails a startup deadline and ignores readiness during shutdown', async () => {
    const { stdout, stderr, code } = await launch('timeout');
    expect(code).toBe(1);
    expect(stderr).toContain('web did not start within 60 seconds');
    expect(stderr).toContain('final diagnostic web');
    expect(stdout).not.toContain('All services ready');
  });
});

it('cancels startup without waiting for the readiness deadline', async () => {
  const { stdout, stderr, code } = await launch('early-stop');
  expect(code).toBe(0);
  expect(stdout).not.toContain('All services ready');
  expect(stderr).toContain('final diagnostic web');
});
it('terminates a hanging service and its descendants after graceful shutdown expires', async () => {
  const { stdout, stderr, code } = await launch('hang');
  expect(code).toBe(1);
  expect(stderr).toContain('process tree was terminated');
  expect(stderr).toContain('final diagnostic delivery');
  const port = /descendant port (\d+)/.exec(stdout);
  expect(port).not.toBeNull();
  expect(await portAvailable(Number(port![1]))).toBe(true);
});
