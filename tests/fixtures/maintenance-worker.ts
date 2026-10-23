import type { Env } from '../../packages/core/env';
import { MaintenanceJob } from '../../workers/maintenance/src/job';

// Faults exist only in this disposable runtime, around the real coordinator and bindings.
export class TestMaintenanceJob extends MaintenanceJob {
  constructor(context: DurableObjectState, env: Env) {
    const fail = async (kind: string) => {
      const fault = await context.storage.get<string>('test:fault');
      if (fault !== kind) return;
      if (kind !== 'database') await context.storage.delete('test:fault');
      throw new Error(`Temporary ${kind} service unavailable`);
    };
    const statements = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
    const wrap = (
      statement: D1PreparedStatement,
      query: string,
    ): D1PreparedStatement => {
      const proxy = new Proxy(statement, {
        get(target, key): unknown {
          if (key === 'bind')
            return (...arguments_: unknown[]): unknown =>
              wrap(target.bind(...arguments_), query);
          const method: unknown = Reflect.get(target, key);
          return typeof method === 'function'
            ? async (...arguments_: unknown[]): Promise<unknown> => {
                if (query.startsWith('DELETE FROM maintenance_lock'))
                  await fail('release');
                await fail('database');
                return Reflect.apply(method, target, arguments_);
              }
            : method;
        },
      });
      statements.set(proxy, statement);
      return proxy;
    };
    const DB = new Proxy(env.DB, {
      get(target, key): unknown {
        if (key === 'prepare')
          return (query: string) => wrap(target.prepare(query), query);
        if (key === 'batch')
          return async (queries: D1PreparedStatement[]) => {
            await fail('database');
            return target.batch(
              queries.map((query) => statements.get(query) ?? query),
            );
          };
        return Reflect.get(target, key);
      },
    });
    const BUCKET = new Proxy(env.BUCKET, {
      get(target, key): unknown {
        const method: unknown = Reflect.get(target, key);
        return typeof method === 'function'
          ? async (...arguments_: unknown[]): Promise<unknown> => {
              if (key === 'list') await fail('storage');
              return Reflect.apply(method, target, arguments_);
            }
          : method;
      },
    });
    super(context, { ...env, DB, BUCKET });
  }
  protected override async schedule(at = Date.now()) {
    const state = await this.ctx.storage.get<{ stage: string }>('state');
    if (
      at - Date.now() < 1000 &&
      state?.stage.startsWith('scan:') &&
      (await this.ctx.storage.get('test:fault')) === 'schedule'
    ) {
      await this.ctx.storage.delete('test:fault');
      throw new Error('Temporary scheduling service unavailable');
    }
    await super.schedule(at);
  }

  async fault(kind: string) {
    await this.ctx.storage.put('test:fault', kind);
  }
  async poke() {
    await this.ctx.storage.transaction(async (storage) => {
      const state = await storage.get<Record<string, unknown>>('state');
      if (state) await storage.put('state', { ...state, retryAt: 0 });
      await storage.setAlarm(Date.now());
    });
  }
  async recoveryAlarm() {
    return this.ctx.storage.getAlarm();
  }
}
export default {
  fetch() {
    return new Response('test');
  },
};
