import { afterEach, expect, it, vi } from 'vitest';

import { readDevelopmentConfig } from '../../cli/development/config';
import { startScheduler } from '../../cli/development/scheduler';

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
    .mockImplementation(() =>
      Promise.resolve(Response.json({ outcome: 'ok', noRetry: false })),
    );
  vi.stubGlobal('fetch', fetch_);
  const log = vi.fn();
  const scheduler = startScheduler(
    config.triggers!.crons,
    'http://127.0.0.1:8789',
    log,
  );
  expect(fetch_).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);
  expect(fetch_).toHaveBeenCalledExactlyOnceWith(
    new URL(
      'http://127.0.0.1:8789/cdn-cgi/local/scheduled?cron=*%2F5+*+*+*+*&time=1791374700000&format=json',
    ),
    { signal: undefined },
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
  const { promise: response, resolve: resolveResponse } =
    Promise.withResolvers<Response>();
  const fetch_ = vi.fn().mockReturnValue(response);
  vi.stubGlobal('fetch', fetch_);
  const log = vi.fn();
  const scheduler = startScheduler(
    ['*/5 * * * *', '*/5 * * * *'],
    'http://127.0.0.1:8789',
    log,
  );
  await vi.advanceTimersByTimeAsync(301_000);
  expect(fetch_).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(
    'WARN',
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
  const log = vi.fn();
  const scheduler = startScheduler(
    ['*/5 * * * *'],
    'http://127.0.0.1:8789',
    log,
  );
  await vi.advanceTimersByTimeAsync(301_000);
  expect(log).toHaveBeenCalledWith(
    'ERROR',
    'Scheduled event failed (200): exception',
  );
  expect(fetch_).toHaveBeenCalledTimes(2);
  await scheduler.stop();
});

it('runs manual maintenance immediately, shares the cron overlap guard, and drains on stop', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-07T12:04:59.123Z'));
  const { promise: response, resolve: resolveResponse } =
    Promise.withResolvers<Response>();
  const fetch_ = vi.fn().mockReturnValue(response);
  vi.stubGlobal('fetch', fetch_);
  const log = vi.fn();
  const scheduler = startScheduler(
    ['*/5 * * * *'],
    'http://127.0.0.1:8789',
    log,
  );
  const run = scheduler.run();
  expect(fetch_).toHaveBeenCalledExactlyOnceWith(
    new URL(
      'http://127.0.0.1:8789/cdn-cgi/local/scheduled?cron=*%2F5+*+*+*+*&time=1791374699123&format=json',
    ),
    { signal: undefined },
  );
  void scheduler.run();
  await vi.advanceTimersByTimeAsync(877);
  expect(fetch_).toHaveBeenCalledTimes(1);
  expect(log).toHaveBeenCalledWith(
    'WARN',
    'Skipped overlapping manual event (*/5 * * * *)',
  );
  expect(log).toHaveBeenCalledWith(
    'WARN',
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
  expect(log).toHaveBeenCalledWith('INFO', 'Manual maintenance completed');
  void scheduler.run();
  await vi.advanceTimersByTimeAsync(300_000);
  expect(fetch_).toHaveBeenCalledTimes(1);
});

it('releases an active maintenance drain when its supervisor cancels the request', async () => {
  const controller = new AbortController();
  const fetch_ = vi.fn(
    (_url: URL, options: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        options.signal!.addEventListener(
          'abort',
          () => reject(new Error('Maintenance request cancelled')),
          { once: true },
        );
      }),
  );
  vi.stubGlobal('fetch', fetch_);
  const log = vi.fn();
  const scheduler = startScheduler(
    ['*/5 * * * *'],
    'http://127.0.0.1:8789',
    log,
    controller.signal,
  );
  const running = scheduler.run();
  const stopped = scheduler.stop();
  controller.abort(new Error('Shutdown deadline expired'));
  await Promise.all([running, stopped]);
  expect(fetch_).toHaveBeenCalledExactlyOnceWith(expect.any(URL), {
    signal: controller.signal,
  });
  void scheduler.run();
  expect(fetch_).toHaveBeenCalledTimes(1);
});
