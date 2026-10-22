import * as prompts from '@clack/prompts';
import { execa } from 'execa';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { getPlatformProxy } from 'wrangler';

import type * as bootstrapData from '../../cli/bootstrap-data';
import {
  bootstrapLocalAdministrator,
  purgeLocalDatabase,
} from '../../cli/bootstrap-data';
import { bootstrap } from '../../cli/commands/bootstrap';

vi.mock('@clack/prompts', () => ({
  text: vi.fn(),
  confirm: vi.fn(),
  isCancel: (value: unknown) => typeof value === 'symbol',
  cancel: vi.fn(),
  log: { warn: vi.fn() },
}));
vi.mock('execa', () => ({ execa: vi.fn() }));
vi.mock('wrangler', () => ({ getPlatformProxy: vi.fn() }));
vi.mock('../../cli/bootstrap-data', async (importOriginal) => ({
  ...(await importOriginal<typeof bootstrapData>()),
  bootstrapLocalAdministrator: vi.fn(),
  purgeLocalDatabase: vi.fn(),
}));

const inputTTY = Object.getOwnPropertyDescriptor(process.stdin, 'isTTY');
const outputTTY = Object.getOwnPropertyDescriptor(process.stdout, 'isTTY');
const environment = { DB: {}, BUCKET: {} };
const dispose = vi.fn();
const config = 'apps/web/wrangler.jsonc';
const cancelled: Extract<
  Awaited<ReturnType<typeof prompts.confirm>>,
  symbol
> = Symbol('cancel') as never;
const duplicate = new Error(
  'D1_ERROR: administrator_already_exists: SQLITE_CONSTRAINT (extended: SQLITE_CONSTRAINT_TRIGGER)',
);

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv('CI', '');
  Object.defineProperty(process.stdin, 'isTTY', {
    configurable: true,
    value: true,
  });
  Object.defineProperty(process.stdout, 'isTTY', {
    configurable: true,
    value: true,
  });
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.mocked(getPlatformProxy).mockResolvedValue({
    env: environment,
    dispose,
  } as unknown as Awaited<ReturnType<typeof getPlatformProxy>>);
  vi.mocked(bootstrapLocalAdministrator).mockReset().mockResolvedValue();
  vi.mocked(purgeLocalDatabase).mockReset().mockResolvedValue();
  vi.mocked(execa)
    .mockReset()
    .mockResolvedValue({ exitCode: 0 } as never);
  vi.mocked(prompts.confirm).mockResolvedValue(false);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  if (inputTTY) Object.defineProperty(process.stdin, 'isTTY', inputTTY);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (outputTTY) Object.defineProperty(process.stdout, 'isTTY', outputTTY);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
});

it.each([false, cancelled] as const)(
  'keeps an existing local database when reset is declined or cancelled (%s)',
  async (answer) => {
    vi.mocked(bootstrapLocalAdministrator).mockRejectedValueOnce(duplicate);
    vi.mocked(prompts.confirm).mockResolvedValue(answer);
    await bootstrap('Owner', config, false);
    expect(prompts.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: false }),
    );
    expect(purgeLocalDatabase).not.toHaveBeenCalled();
    expect(execa).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  },
);

it('does not retry bootstrap or print a key if migrations fail after purge', async () => {
  vi.mocked(bootstrapLocalAdministrator).mockRejectedValueOnce(duplicate);
  vi.mocked(prompts.confirm).mockResolvedValue(true);
  vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1 } as never);
  await expect(bootstrap('Owner', config, false)).rejects.toThrow(
    'migrations failed',
  );
  expect(bootstrapLocalAdministrator).toHaveBeenCalledOnce();
  expect(dispose).toHaveBeenCalledOnce();
  expect(console.log).not.toHaveBeenCalled();
});

it('never prompts to purge an existing database in non-interactive execution', async () => {
  vi.stubEnv('CI', '1');
  vi.mocked(bootstrapLocalAdministrator).mockRejectedValueOnce(duplicate);
  await expect(bootstrap('Owner', config, false)).rejects.toThrow(
    'An administrator already exists',
  );
  expect(prompts.confirm).not.toHaveBeenCalled();
  expect(purgeLocalDatabase).not.toHaveBeenCalled();
});

it('does not offer to purge on unrelated database errors', async () => {
  vi.mocked(bootstrapLocalAdministrator).mockRejectedValueOnce(
    new Error('Database unavailable'),
  );
  await expect(bootstrap('Owner', config, false)).rejects.toThrow(
    'Database unavailable',
  );
  expect(prompts.confirm).not.toHaveBeenCalled();
  expect(purgeLocalDatabase).not.toHaveBeenCalled();
});

it('never offers a purge for remote bootstrap failures', async () => {
  vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1 } as never);
  await expect(bootstrap('Owner', config, true)).rejects.toThrow(
    'Bootstrap refused or failed',
  );
  expect(prompts.confirm).not.toHaveBeenCalled();
  expect(getPlatformProxy).not.toHaveBeenCalled();
  expect(purgeLocalDatabase).not.toHaveBeenCalled();
});
