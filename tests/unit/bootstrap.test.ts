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
const first = vi.fn();
const environment = {
  DB: { prepare: vi.fn(() => ({ first })) },
  BUCKET: {},
};
const dispose = vi.fn();
const config = 'apps/web/wrangler.jsonc';
const cancelled: Extract<
  Awaited<ReturnType<typeof prompts.confirm>>,
  symbol
> = Symbol('cancel') as never;

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
  first.mockReset().mockResolvedValue(null);
  vi.mocked(purgeLocalDatabase).mockReset().mockResolvedValue();
  vi.mocked(execa)
    .mockReset()
    .mockResolvedValue({ exitCode: 0 } as never);
  vi.mocked(prompts.confirm).mockResolvedValue(false);
});

afterEach(() => {
  if (inputTTY) Object.defineProperty(process.stdin, 'isTTY', inputTTY);
  else Reflect.deleteProperty(process.stdin, 'isTTY');
  if (outputTTY) Object.defineProperty(process.stdout, 'isTTY', outputTTY);
  else Reflect.deleteProperty(process.stdout, 'isTTY');
});

it.each([false, cancelled] as const)(
  'keeps an existing local database when reset is declined or cancelled (%s)',
  async (answer) => {
    first.mockResolvedValue({ '1': 1 });
    vi.mocked(prompts.confirm).mockResolvedValue(answer);
    await bootstrap(undefined, config, false);
    expect(prompts.confirm).toHaveBeenCalledWith(
      expect.objectContaining({ initialValue: false }),
    );
    expect(prompts.text).not.toHaveBeenCalled();
    expect(bootstrapLocalAdministrator).not.toHaveBeenCalled();
    expect(purgeLocalDatabase).not.toHaveBeenCalled();
    expect(execa).not.toHaveBeenCalled();
    expect(dispose).toHaveBeenCalledOnce();
    expect(console.log).not.toHaveBeenCalled();
  },
);

it('keeps an existing database when the name prompt is cancelled after confirming reset', async () => {
  first.mockResolvedValue({ '1': 1 });
  vi.mocked(prompts.confirm).mockResolvedValue(true);
  vi.mocked(prompts.text).mockResolvedValue(cancelled);
  await bootstrap(undefined, config, false);
  expect(prompts.confirm).toHaveBeenCalledOnce();
  expect(prompts.text).toHaveBeenCalledOnce();
  expect(purgeLocalDatabase).not.toHaveBeenCalled();
  expect(bootstrapLocalAdministrator).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
  expect(console.log).not.toHaveBeenCalled();
});

it('does not bootstrap or print a key if migrations fail after purge', async () => {
  first.mockResolvedValue({ '1': 1 });
  vi.mocked(prompts.confirm).mockResolvedValue(true);
  vi.mocked(execa).mockResolvedValueOnce({ exitCode: 1 } as never);
  await expect(bootstrap('Owner', config, false)).rejects.toThrow(
    'migrations failed',
  );
  expect(bootstrapLocalAdministrator).not.toHaveBeenCalled();
  expect(dispose).toHaveBeenCalledOnce();
  expect(console.log).not.toHaveBeenCalled();
});

it('never prompts to purge an existing database in non-interactive execution', async () => {
  vi.stubEnv('CI', '1');
  first.mockResolvedValue({ '1': 1 });
  await expect(bootstrap(undefined, config, false)).rejects.toThrow(
    'An administrator already exists',
  );
  expect(prompts.confirm).not.toHaveBeenCalled();
  expect(prompts.text).not.toHaveBeenCalled();
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
