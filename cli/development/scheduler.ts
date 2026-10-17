import { Cron } from 'croner';
import { z } from 'zod';

const scheduledResult = z.object({ outcome: z.string() });

export function createCron(expression: string) {
  if (expression.trim().split(/\s+/).length !== 5)
    throw new Error(`Expected a Cloudflare five-field cron: ${expression}`);
  return new Cron(expression, {
    timezone: 'UTC',
    alternativeWeekdays: true,
    domAndDow: true,
    paused: true,
  });
}

export function startScheduler(
  crons: string[],
  endpoint: string,
  log: (status: 'INFO' | 'WARN' | 'ERROR', message: string) => void,
  signal?: AbortSignal,
) {
  let running: Promise<void> | undefined;
  const jobs = [...new Set(crons)].map((expression) => ({
    expression,
    job: createCron(expression),
  }));
  let stopped = false;
  function dispatch(expression: string, time: number, manual = false) {
    if (stopped) return;
    if (running) {
      log(
        'WARN',
        `Skipped overlapping ${manual ? 'manual' : 'scheduled'} event (${expression})`,
      );
      return;
    }
    const url = new URL('/cdn-cgi/local/scheduled', endpoint);
    url.search = new URLSearchParams({
      cron: expression,
      time: String(time),
      format: 'json',
    }).toString();
    running = (async () => {
      log(
        'INFO',
        `${manual ? 'Manual maintenance' : `Scheduled ${expression}`} at ${new Date(time).toISOString()}`,
      );
      try {
        const response = await fetch(url, { signal });
        const result = scheduledResult.parse(await response.json());
        if (!response.ok || result.outcome !== 'ok')
          throw new Error(
            `Scheduled event failed (${response.status}): ${result.outcome}`,
          );
        log('INFO', `${manual ? 'Manual' : 'Scheduled'} maintenance completed`);
      } catch (error) {
        log('ERROR', error instanceof Error ? error.message : String(error));
      } finally {
        running = undefined;
      }
    })();
    return running;
  }
  for (const { expression, job } of jobs) {
    job.schedule(() => {
      void dispatch(expression, Math.floor(Date.now() / 60_000) * 60_000);
    });
    job.resume();
    log(
      'INFO',
      `Cron ${expression} (UTC); next run ${job.nextRun()?.toISOString()}`,
    );
  }
  return {
    run: () => dispatch(jobs[0].expression, Date.now(), true),
    async stop() {
      stopped = true;
      for (const { job } of jobs) job.stop();
      await running;
    },
  };
}
