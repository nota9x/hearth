import { afterEach, expect, it, vi } from 'vitest';

import { readDevelopmentConfig } from '../../scripts/development-config';
import {
  createCron,
  startScheduler,
} from '../../scripts/development-scheduler';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

it('uses the configured production cadence at UTC boundaries, dispatches metadata, and stops', async () => {
  const config = await readDevelopmentConfig('maintenance');
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T12:04:59Z'));
  const fetch_ = vi
    .fn()
    .mockResolvedValue(Response.json({ outcome: 'ok', noRetry: false }));
  vi.stubGlobal('fetch', fetch_);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const scheduler = startScheduler(
    config.triggers!.crons,
    'http://127.0.0.1:8789',
  );
  expect(fetch_).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch_).toHaveBeenCalledExactlyOnceWith(
    new URL(
      'http://127.0.0.1:8789/cdn-cgi/local/scheduled?cron=*%2F5+*+*+*+*&time=1791374700000&format=json',
    ),
  );
  await vi.advanceTimersByTimeAsync(299_000);
  expect(fetch_).toHaveBeenCalledTimes(1);
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch_).toHaveBeenCalledTimes(2);
  await scheduler.stop();
  await vi.advanceTimersByTimeAsync(600_000);
  expect(fetch_).toHaveBeenCalledTimes(2);
});

it('skips overlapping dispatches and drains an active execution on shutdown', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T12:04:59Z'));
  let resolveResponse!: (response: Response) => void;
  // Node supports withResolvers; the project targets ES2022 declarations.
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const fetch_ = vi.fn().mockReturnValue(response);
  vi.stubGlobal('fetch', fetch_);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const scheduler = startScheduler(
    ['*/5 * * * *', '*/5 * * * *'],
    'http://127.0.0.1:8789',
  );
  await vi.advanceTimersByTimeAsync(301_000);
  expect(fetch_).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    'Skipped overlapping scheduled event (*/5 * * * *)',
  );
  let drained = false;
  const stopped = (async () => {
    await scheduler.stop();
    drained = true;
  })();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(drained).toBe(false);
  expect(fetch_).toHaveBeenCalledTimes(1);
  resolveResponse(Response.json({ outcome: 'ok' }));
  await stopped;
  expect(drained).toBe(true);
});

it('reports failed scheduled outcomes and continues on the next configured interval', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T12:04:59Z'));
  const fetch_ = vi
    .fn()
    .mockResolvedValueOnce(Response.json({ outcome: 'exception' }))
    .mockResolvedValueOnce(Response.json({ outcome: 'ok' }));
  vi.stubGlobal('fetch', fetch_);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  const scheduler = startScheduler(['*/5 * * * *'], 'http://127.0.0.1:8789');
  await vi.advanceTimersByTimeAsync(301_000);
  expect(error).toHaveBeenCalledWith(
    expect.objectContaining({
      message: 'Scheduled event failed (200): exception',
    }),
  );
  expect(fetch_).toHaveBeenCalledTimes(2);
  await scheduler.stop();
});

it('uses Cloudflare weekday numbering and rejects a development seconds field', () => {
  const cron = createCron('0 3 * * 1');
  expect(cron.nextRun(new Date('2026-10-07T12:00:00Z'))?.toISOString()).toBe(
    '2026-10-11T03:00:00.000Z',
  );
  cron.stop();
  expect(() => createCron('* * * * * *')).toThrow('five-field cron');
});

it('runs manual maintenance immediately, shares the cron overlap guard, and drains on stop', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T12:04:59.123Z'));
  let resolveResponse!: (response: Response) => void;
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
  const response = new Promise<Response>((resolve) => {
    resolveResponse = resolve;
  });
  const fetch_ = vi.fn().mockReturnValue(response);
  vi.stubGlobal('fetch', fetch_);
  const log = vi.spyOn(console, 'log').mockImplementation(() => {});
  const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
  const scheduler = startScheduler(['*/5 * * * *'], 'http://127.0.0.1:8789');
  const run = scheduler.run();
  expect(fetch_).toHaveBeenCalledExactlyOnceWith(
    new URL(
      'http://127.0.0.1:8789/cdn-cgi/local/scheduled?cron=*%2F5+*+*+*+*&time=1791374699123&format=json',
    ),
  );
  void scheduler.run();
  await vi.advanceTimersByTimeAsync(877);
  expect(fetch_).toHaveBeenCalledTimes(1);
  expect(warning).toHaveBeenCalledWith(
    'Skipped overlapping manual event (*/5 * * * *)',
  );
  expect(warning).toHaveBeenCalledWith(
    'Skipped overlapping scheduled event (*/5 * * * *)',
  );
  let drained = false;
  const stopped = (async () => {
    await scheduler.stop();
    drained = true;
  })();
  await Promise.resolve();
  expect(drained).toBe(false);
  resolveResponse(Response.json({ outcome: 'ok' }));
  await run;
  await stopped;
  expect(log).toHaveBeenCalledWith('Manual maintenance completed');
  void scheduler.run();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(fetch_).toHaveBeenCalledTimes(1);
});
