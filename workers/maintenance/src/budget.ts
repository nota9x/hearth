export class BudgetExceeded extends Error {}

// Meter actual binding calls, including every statement inside a D1 batch.
export function maintenanceBudget(db: D1Database, bucket: R2Bucket) {
  const counts = { statements: 0, storage: 0 };
  const deadline = Date.now() + 8000;
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function charge(kind: keyof typeof counts, amount = 1) {
    if (counts[kind] + amount > 40)
      throw new BudgetExceeded('Maintenance slice budget');
    counts[kind] += amount;
  }
  function statement(original: D1PreparedStatement): D1PreparedStatement {
    const wrapped = new Proxy(original, {
      get(target, key): unknown {
        if (key === 'bind')
          return (...values: unknown[]): unknown =>
            statement(target.bind(...values));
        const method: unknown = Reflect.get(target, key);
        if (typeof method !== 'function') return method;
        return (...values: unknown[]): unknown => {
          charge('statements');
          return Reflect.apply(method, target, values);
        };
      },
    });
    originals.set(wrapped, original);
    return wrapped;
  }
  const multipart = (upload: R2MultipartUpload) =>
    new Proxy(upload, {
      get(upload, operation): unknown {
        const value: unknown = Reflect.get(upload, operation);
        return typeof value === 'function'
          ? (...arguments_: unknown[]): unknown => {
              charge('storage');
              return Reflect.apply(value, upload, arguments_);
            }
          : value;
      },
    });
  return {
    counts,
    deadline,
    DB: new Proxy(db, {
      get(target, key): unknown {
        if (key === 'prepare')
          return (query: string) => statement(target.prepare(query));
        if (key === 'batch')
          return (queries: D1PreparedStatement[]) => {
            charge('statements', queries.length);
            return target.batch(queries.map((q) => originals.get(q) ?? q));
          };
        const value: unknown = Reflect.get(target, key);
        return typeof value === 'function'
          ? (...arguments_: unknown[]): unknown =>
              Reflect.apply(value, target, arguments_)
          : value;
      },
    }),
    BUCKET: new Proxy(bucket, {
      get(target, key): unknown {
        if (key === 'resumeMultipartUpload')
          return (...values: Parameters<R2Bucket['resumeMultipartUpload']>) =>
            multipart(target.resumeMultipartUpload(...values));
        if (key === 'createMultipartUpload')
          return async (
            ...values: Parameters<R2Bucket['createMultipartUpload']>
          ) => {
            charge('storage');
            return multipart(await target.createMultipartUpload(...values));
          };
        const method: unknown = Reflect.get(target, key);
        if (typeof method !== 'function') return method;
        return (...values: unknown[]): unknown => {
          charge('storage');
          const result: unknown = Reflect.apply(method, target, values);
          return result;
        };
      },
    }),
  };
}
