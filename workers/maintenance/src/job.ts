import { DurableObject } from 'cloudflare:workers';

import { id, now } from '../../../packages/core/common';
import type { Env } from '../../../packages/core/env';
import { scanStorage } from '../../../packages/core/storage-maintenance';
import { BudgetExceeded, maintenanceBudget } from './budget';
import {
  type Environment,
  routineStages,
  runMaintenance,
  withMaintenanceLease,
} from './maintenance';

interface State {
  stage: string;
  progress?: number;
  waitingSince?: number;
  routineAt?: number;
  routine?: { index: number; more: boolean; runId?: string; attempt?: number };
  scanTurn?: boolean;
  failures: number;
  retryAt?: number;
  error?: string;
  failedStage?: string;
  lastFailure?: { at: number; stage: string; message: string };
  terminal?: boolean;
  failedRun?: { id: string; attempt: number };
  backlog?: {
    previews: number;
    purges: number;
    deferred: number;
    recovery: number;
  };
}
const initial = (): State => ({ stage: 'idle', failures: 0 });
const coordinator = 'instance';
interface ControlAudit {
  id: string;
  actorId: string | null;
  action: string;
  targetId: string | null;
  metadata: string;
  createdAt: number;
}

export class MaintenanceJob extends DurableObject<
  Environment & Pick<Env, 'MAINTENANCE'>
> {
  private active?: Promise<void>;

  private async flushAudits() {
    const entries = await this.ctx.storage.list<ControlAudit>({
      prefix: 'audit:',
      limit: 20,
    });
    if (entries.size === 0) return;
    await this.env.DB.batch(
      Array.from(entries.values(), (event) =>
        this.env.DB.prepare(
          'INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) VALUES(?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING',
        ).bind(
          event.id,
          event.actorId,
          event.action,
          event.targetId,
          event.metadata,
          event.createdAt,
        ),
      ),
    );
    await this.ctx.storage.delete(Array.from(entries, ([key]) => key));
  }

  private async execute() {
    if (await this.ctx.storage.get<boolean>('paused')) return;
    // Independent of D1 and native retries: a crash/outage already has a durable watchdog alarm.
    await this.ctx.storage.setAlarm(Date.now() + 300_000);
    const state = (await this.ctx.storage.get<State>('state')) ?? initial();
    await this.ctx.storage.transaction(async (storage) => {
      if (!(await storage.get('resumeRequested'))) {
        return;
      }

      state.terminal = false;
      state.failures = 0;
      state.retryAt = undefined;
      state.error = undefined;
      await storage.delete('resumeRequested');
    });
    const inspectRun = await this.ctx.storage.transaction(async (storage) => {
      const requested = await storage.get<boolean>('inspectRun');
      await storage.delete('inspectRun');
      return requested;
    });
    if (!inspectRun && state.retryAt && state.retryAt > Date.now()) {
      await this.schedule(state.retryAt);
      return;
    }
    const budget = maintenanceBudget(this.env.DB, this.env.BUCKET);
    const env = { ...this.env, DB: budget.DB, BUCKET: budget.BUCKET };
    try {
      const acquired = await withMaintenanceLease(
        env,
        async () => {
          state.waitingSince = undefined;
          let run = await env.DB.prepare(
            "SELECT id,attempt,routineDone,phase FROM reconciliation_runs WHERE status='running' LIMIT 1",
          ).first<{
            id: string;
            attempt: number;
            routineDone: number;
            phase: string;
          }>();
          const newAttempt =
            run &&
            (state.failedRun
              ? run.id !== state.failedRun.id ||
                run.attempt > state.failedRun.attempt
              : inspectRun);
          if (inspectRun && newAttempt && state.terminal) {
            state.terminal = false;
            state.failures = 0;
            state.retryAt = undefined;
            state.routine = undefined;
          }
          if (state.terminal) {
            if (run)
              await env.DB.prepare(
                "UPDATE reconciliation_runs SET status='failed',error=?,updatedAt=? WHERE id=? AND status='running'",
              )
                .bind(state.error, now(), run.id)
                .run();
            state.retryAt = undefined;
            return;
          }
          if (state.retryAt && state.retryAt > Date.now()) return;
          if (run) state.failedRun = { id: run.id, attempt: run.attempt };
          if (!run) {
            const due = new Date();
            due.setUTCHours(3, 0, 0, 0);
            if (due.getTime() > Date.now())
              due.setUTCDate(due.getUTCDate() - 1);
            const recent = await env.DB.prepare(
              'SELECT id FROM reconciliation_runs WHERE startedAt>=? LIMIT 1',
            )
              .bind(due.getTime() / 1000)
              .first();
            if (!recent) {
              const runId = id('rec');
              await env.DB.batch([
                env.DB.prepare(
                  "INSERT INTO reconciliation_runs(id,status,startedAt,updatedAt) SELECT ?,'running',?,? WHERE NOT EXISTS(SELECT 1 FROM reconciliation_runs WHERE status='running') ON CONFLICT DO NOTHING",
                ).bind(runId, now(), now()),
                env.DB.prepare(
                  "INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT ?,NULL,'storage.reconciliation',?,?,? WHERE changes()>0",
                ).bind(
                  id('evt'),
                  runId,
                  JSON.stringify({
                    version: 2,
                    actorName: 'System',
                    changes: [],
                    targetName: 'Storage scan',
                    context: { reason: 'Scheduled maintenance' },
                  }),
                  now(),
                ),
              ]);
              run = await env.DB.prepare(
                "SELECT id,attempt,routineDone,phase FROM reconciliation_runs WHERE status='running' LIMIT 1",
              ).first<NonNullable<typeof run>>();
            }
          }
          if (Date.now() >= budget.deadline) {
            state.stage = 'yielding';
            return;
          }
          if (run?.attempt === 1 && run.routineDone === 0 && !state.routine) {
            const legacy = await this.env.MAINTENANCE.getByName(
              run.id,
            ).legacyMaintenanceDone();
            if (
              legacy ||
              (await this.ctx.storage.get<boolean>(`legacy:${run.id}`))
            ) {
              await env.DB.prepare(
                'UPDATE reconciliation_runs SET routineDone=1 WHERE id=? AND attempt=1',
              )
                .bind(run.id)
                .run();
              run.routineDone = 1;
              state.routineAt ??= Date.now();
            }
            await this.ctx.storage.delete(`legacy:${run.id}`);
          }
          const full = run && run.routineDone < run.attempt;
          if (
            !state.routine &&
            (full ||
              !state.routineAt ||
              Date.now() - state.routineAt >= 300_000)
          )
            state.routine = {
              index: 0,
              more: false,
              ...(full && run && { runId: run.id, attempt: run.attempt }),
            };
          if ((!run || full || !state.scanTurn) && state.routine) {
            const stage = routineStages[state.routine.index];
            state.stage = stage;
            await this.ctx.storage.put('state', state);
            const more = await runMaintenance(env, stage);
            state.routine.more ||= more;
            const nextIndex = state.routine.index + 1;
            if (nextIndex === routineStages.length) {
              if (state.routine.runId)
                await env.DB.prepare(
                  'UPDATE reconciliation_runs SET routineDone=? WHERE id=? AND attempt=?',
                )
                  .bind(
                    state.routine.attempt,
                    state.routine.runId,
                    state.routine.attempt,
                  )
                  .run();
              state.routineAt = Date.now();
              state.routine = state.routine.more
                ? { index: 0, more: false }
                : undefined;
              const backlog = await env.DB.prepare(
                "SELECT (SELECT count(*) FROM images WHERE deletedAt IS NULL AND previewKey IS NULL AND mime<>'image/gif' AND size<20971520) AS previews,(SELECT count(*) FROM images WHERE deletedAt IS NOT NULL AND purgedAt IS NULL) AS purges,(SELECT count(*) FROM storage_objects WHERE state='cleanup' OR (state IN ('uploading','committing') AND updatedAt<unixepoch()-1800)) AS recovery,(SELECT count(*) FROM storage_objects WHERE retryAt>unixepoch())+(SELECT count(*) FROM images WHERE (deletedAt IS NULL AND previewKey IS NULL AND previewRetryAt>?) OR (deletedAt IS NOT NULL AND purgedAt IS NULL AND purgeRetryAt>?)) AS deferred",
              )
                .bind(now(), now())
                .first<State['backlog']>();
              state.backlog = backlog ?? undefined;
            } else state.routine.index = nextIndex;
            state.scanTurn = true;
          } else if (run) {
            state.stage = `scan:${run.phase}`;
            await this.ctx.storage.put('state', state);
            await scanStorage(env.DB, env.BUCKET, run.id, budget.deadline);
            state.scanTurn = false;
          } else state.stage = 'idle';
          state.progress = Date.now();
          state.failures = 0;
          state.retryAt = undefined;
          state.error = undefined;
        },
        this.ctx.id.toString(),
      );
      if (!acquired) {
        state.stage = 'waiting-for-lease';
        state.waitingSince ??= Date.now();
      }
      await this.ctx.storage.put('state', state);
      await this.schedule(
        state.retryAt ??
          Date.now() +
            (acquired
              ? state.stage === 'idle' || state.terminal
                ? 300_000
                : 10
              : 1000),
      );
    } catch (error) {
      if (error instanceof BudgetExceeded) {
        // A unit that exceeds its declared allowance must be visible, never silently spin.
        state.terminal = true;
      } else
        state.terminal ||=
          /no such (table|column)|syntax error|SQLITE_CONSTRAINT|constraint failed/i.test(
            String(error),
          );
      state.failures++;
      state.terminal ||= state.failures >= 24;
      state.failedStage = state.stage;
      state.error = state.terminal
        ? 'Maintenance requires attention. Check Worker logs and bindings, then retry the scan or resume maintenance.'
        : 'Temporary service failure. Saved progress will retry automatically.';
      state.lastFailure = {
        at: Date.now(),
        stage: state.stage,
        message: state.error,
      };
      state.retryAt =
        Date.now() +
        Math.min(3_600_000, 1000 * 2 ** Math.min(state.failures, 12));
      await this.ctx.storage.put('state', state);
      console.error(
        JSON.stringify({
          event: 'maintenance.retry',
          reason:
            error instanceof Error
              ? error.message.slice(0, 300)
              : 'Binding operation failed',
          stage: state.stage,
          failures: state.failures,
          terminal: state.terminal,
          statements: budget.counts.statements,
          storage: budget.counts.storage,
        }),
      );
      // Terminal publication is retried too, including when D1 cannot accept status writes.
      try {
        if (state.terminal)
          await this.env.DB.prepare(
            "UPDATE reconciliation_runs SET status='failed',error=?,updatedAt=? WHERE status='running'",
          )
            .bind(state.error, now())
            .run();
      } catch {
        /*
        The independent alarm/watchdog retries publication.
        */
      }
      await this.schedule(state.retryAt);
    } finally {
      if (await this.ctx.storage.get<boolean>('paused'))
        await this.ctx.storage.deleteAlarm();
    }
  }

  protected async schedule(at = Date.now()) {
    await this.ctx.storage.transaction(async (storage) => {
      if (await storage.get<boolean>('paused')) return;
      const alarm = await storage.getAlarm();
      if (alarm === null || alarm > at) await storage.setAlarm(at);
    });
  }

  // Old per-run objects forward their persisted jobs to the single instance authority.
  async start(runId: string): Promise<void> {
    const legacy = await this.legacyMaintenanceDone();
    await this.env.MAINTENANCE.getByName(coordinator).enqueue(runId, legacy);
  }

  async legacyMaintenanceDone() {
    const job = await this.ctx.storage.get<{ maintenanceDone: boolean }>('job');
    return job?.maintenanceDone === true;
  }

  async enqueue(runId: string, legacyDone = false): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      await storage.put('coordinator', true);
      await storage.put('inspectRun', true);
      if (legacyDone) await storage.put(`legacy:${runId}`, true);
    });
    await this.schedule();
  }

  async wake(): Promise<void> {
    await this.ctx.storage.put('coordinator', true);
    await this.schedule();
    try {
      await this.flushAudits();
    } catch {
      /*
      Cron retries the durable outbox even while paused.
      */
    }
  }

  async control(paused: boolean, event?: ControlAudit): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      await storage.put('coordinator', true);
      await storage.put('paused', paused);
      if (event) await storage.put(`audit:${event.id}`, event);
      if (!paused) await storage.put('resumeRequested', true);
      if (paused) await storage.deleteAlarm();
      else await storage.setAlarm(Date.now());
    });
    if (paused) {
      try {
        await this.active;
      } catch {
        /*
        Recovery remains durable.
        */
      }
    }
    try {
      await this.flushAudits();
    } catch {
      /*
      Intent and its audit remain durable until D1 recovers.
      */
    }
  }

  async status() {
    return this.ctx.storage.transaction(async (storage) => {
      const state = await storage.get<State>('state');
      const paused = await storage.get<boolean>('paused');
      const value = state ?? initial();
      const progressAt = value.waitingSince ?? value.progress;
      const status = paused
        ? this.active
          ? 'paused'
          : 'drained'
        : value.terminal
          ? 'failed'
          : value.retryAt && value.retryAt > Date.now()
            ? 'retrying'
            : this.active
              ? 'running'
              : value.stage === 'idle'
                ? 'completed'
                : progressAt && Date.now() - progressAt > 600_000
                  ? 'stalled'
                  : 'running';
      return { ...value, paused: !!paused, status };
    });
  }

  async alarm(): Promise<void> {
    if (!(await this.ctx.storage.get<boolean>('coordinator'))) {
      const job = await this.ctx.storage.get<{ runId: string }>('job');
      if (job) await this.start(job.runId);
      await this.ctx.storage.delete('job');
      await this.ctx.storage.deleteAlarm();
      return;
    }
    if (this.active) return this.active;
    const work = this.execute();
    this.active = work;
    try {
      await work;
    } finally {
      this.active = undefined;
    }
  }
}
