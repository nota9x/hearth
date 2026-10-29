import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import * as prompts from '@clack/prompts';
import { runCommand } from 'citty';
import { execa } from 'execa';
import { expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';

import bootstrapCommand from '../../cli/commands/bootstrap';
import { authenticateKey } from '../../packages/core/auth';

vi.mock('@clack/prompts', () => ({
  text: vi.fn().mockResolvedValue('New local owner'),
  confirm: vi.fn().mockResolvedValue(true),
  isCancel: (value: unknown) => typeof value === 'symbol',
  cancel: vi.fn(),
  log: { warn: vi.fn() },
}));

it('resets local credentials through the command while preserving R2 and requiring accounting recovery', async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), 'hearth-bootstrap-test-'),
  );
  const config = path.join(directory, 'wrangler.jsonc');
  const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
  const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
  try {
    vi.stubEnv('CI', '');
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
    const output = vi.spyOn(console, 'log').mockImplementation(() => {});
    await writeFile(
      config,
      JSON.stringify({
        name: 'hearth-bootstrap-test',
        compatibility_date: '2026-09-17',
        d1_databases: [
          {
            binding: 'DB',
            database_name: 'hearth-bootstrap-test',
            database_id: '00000000-0000-0000-0000-000000000001',
            migrations_dir: path.resolve('drizzle'),
          },
        ],
        r2_buckets: [
          { binding: 'BUCKET', bucket_name: 'hearth-bootstrap-test' },
        ],
      }),
    );
    await execa(process.execPath, [
      path.resolve('node_modules/wrangler/bin/wrangler.js'),
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--config',
      config,
    ]);
    await runCommand(bootstrapCommand, {
      rawArgs: ['Original owner', '--config', config],
    });
    const originalKey = String(output.mock.calls[0][0]).split('\n').at(-1)!;
    const bindingOptions = {
      configPath: config,
      persist: { path: path.join(directory, '.wrangler/state/v3') },
      remoteBindings: false,
      envFiles: [],
    };
    const original = await getPlatformProxy<{ BUCKET: R2Bucket }>(
      bindingOptions,
    );
    try {
      await original.env.BUCKET.put('retained', 'preserve me');
    } finally {
      await original.dispose();
    }
    await runCommand(bootstrapCommand, { rawArgs: ['--config', config] });
    expect(process.exitCode || 0).toBe(0);
    expect(prompts.text).toHaveBeenCalledOnce();
    expect(prompts.confirm).toHaveBeenCalledOnce();
    expect(vi.mocked(prompts.confirm).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(prompts.text).mock.invocationCallOrder[0],
    );

    const platform = await getPlatformProxy<{
      DB: D1Database;
      BUCKET: R2Bucket;
    }>(bindingOptions);
    try {
      const users = await platform.env.DB.prepare(
        'SELECT displayName FROM users',
      ).all();
      expect(users.results).toEqual([{ displayName: 'New local owner' }]);
      const replacementKey = String(output.mock.calls[1][0])
        .split('\n')
        .at(-1)!;
      const { user } = await authenticateKey(platform.env.DB, replacementKey);
      expect(user.displayName).toBe('New local owner');
      await expect(
        authenticateKey(platform.env.DB, originalKey),
      ).rejects.toThrow();
      expect(await platform.env.BUCKET.get('retained')).not.toBeNull();
      const capacity = await platform.env.DB.prepare(
        'SELECT ready,multipartVerified FROM storage_capacity',
      ).first();
      expect(capacity).toEqual({ ready: 0, multipartVerified: 0 });
    } finally {
      await platform.dispose();
    }
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.exitCode = 0;
    if (inputTTY) Object.defineProperty(process.stdin, 'isTTY', inputTTY);
    else Reflect.deleteProperty(process.stdin, 'isTTY');
    if (outputTTY) Object.defineProperty(process.stdout, 'isTTY', outputTTY);
    else Reflect.deleteProperty(process.stdout, 'isTTY');
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);
