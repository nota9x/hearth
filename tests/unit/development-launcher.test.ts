import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

async function launch(scenario: string, mode = 'development') {
  const child = fork(
    fileURLToPath(new URL(`../../scripts/${mode}.ts`, import.meta.url)),
    [],
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
      scenario === 'success' &&
      !stopped &&
      stdout.includes('All services ready')
    )) {
      return;
    }

    stopped = true;
    child.send('stop');
  });
  child.stderr!.on('data', (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  const timeout = setTimeout(() => child.kill(), 10_000);
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  clearTimeout(timeout);
  return { stdout, stderr, code };
}

describe('launcher lifecycle', () => {
  it.each(['development', 'preview'])(
    'starts %s concurrently, reports staggered readiness, and drains final stderr on shutdown',
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
      expect(maintenance).toBeGreaterThan(delivery);
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
    expect(code).toBe(1);
    expect(stderr).toContain('startup failure detail');
    expect(stderr).toContain('delivery exited (1)');
    expect(stderr).toContain('final diagnostic web');
    expect(stderr).toContain('final diagnostic maintenance');
    expect(stdout).not.toContain('All services ready');
  });

  it('reflects unexpected exits after readiness and shuts down the environment', async () => {
    const { stdout, stderr, code } = await launch('late-exit');
    expect(code).toBe(1);
    expect(stdout).toContain('All services ready');
    expect(stderr).toContain('delivery exited (1)');
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
