import { beforeEach, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  spawn: vi.fn(),
  values: {
    config: 'apps/web/wrangler.jsonc',
    endpoint: 'https://test.r2.cloudflarestorage.com',
    profile: 'test',
  },
}));
vi.mock('execa', () => ({ execa: fixture.spawn }));

beforeEach(() => {
  vi.resetModules();
  fixture.spawn.mockReset();
  vi.spyOn(console, 'log').mockImplementation(() => {});
});

it('pauses admission, aborts only untracked multipart uploads, verifies absence, and queues the baseline', async () => {
  let inventory = 0;
  const sql: string[] = [];
  const aborted: string[] = [];
  fixture.spawn.mockImplementation((command: string, arguments_: string[]) => {
    if (command !== 'aws') {
      const statement = arguments_[arguments_.indexOf('--command') + 1];
      sql.push(statement);
      return {
        exitCode: 0,
        stdout: JSON.stringify([
          {
            results: statement.includes("key='tracked'")
              ? [{ key: 'tracked' }]
              : [],
          },
        ]),
        stderr: '',
      };
    }
    if (arguments_.includes('list-multipart-uploads'))
      return {
        exitCode: 0,
        stdout: JSON.stringify(
          inventory++ === 0
            ? {}
            : {
                Uploads: [
                  { Key: 'tracked', UploadId: 'safe' },
                  { Key: 'untracked', UploadId: 'old' },
                ],
                IsTruncated: false,
              },
        ),
        stderr: '',
      };
    if (arguments_.includes('abort-multipart-upload')) {
      aborted.push(arguments_[arguments_.indexOf('--key') + 1]);
      return { exitCode: 0, stdout: '', stderr: '' };
    }
    if (arguments_.includes('list-parts'))
      return {
        exitCode: 1,
        stdout: '',
        stderr: 'An error occurred (NoSuchUpload)',
      };
    throw new Error('Unexpected command');
  });
  const { initializeStorage } =
    await import('../../cli/commands/storage-initialize');
  await initializeStorage(fixture.values);
  expect(aborted).toEqual(['untracked']);
  expect(sql[0]).toMatch(/\bready\s*=\s*0\b/i);
  expect(sql[0]).toMatch(/\bmultipartVerified\s*=\s*0\b/i);
  expect(sql[0]).toMatch(/\bblocked\s*=\s*1\b/i);
  expect(sql.at(-1)).toMatch(/\bmultipartVerified\s*=\s*1\b/i);
  expect(sql.at(-1)).toContain('reconciliation_runs');
  expect(
    sql.some((statement) => statement.includes('DELETE FROM images')),
  ).toBe(false);
});

it('keeps admission paused when multipart deletion cannot be verified', async () => {
  let inventory = 0;
  const sql: string[] = [];
  fixture.spawn.mockImplementation((command: string, arguments_: string[]) => {
    if (command !== 'aws') {
      sql.push(arguments_[arguments_.indexOf('--command') + 1]);
      return { exitCode: 0, stdout: '[{"results":[]}]', stderr: '' };
    }
    return {
      exitCode: 0,
      stderr: '',
      stdout: arguments_.includes('list-multipart-uploads')
        ? JSON.stringify(
            inventory++ === 0
              ? {}
              : { Uploads: [{ Key: 'old', UploadId: 'old' }] },
          )
        : arguments_.includes('list-parts')
          ? '{"Parts":[{}]}'
          : '',
    };
  });
  const { initializeStorage } =
    await import('../../cli/commands/storage-initialize');
  await expect(initializeStorage(fixture.values)).rejects.toThrow(
    'still present',
  );
  expect(
    sql.some((statement) => statement.includes('multipartVerified=1')),
  ).toBe(false);
  expect(sql[0]).toContain('blocked=1');
});
