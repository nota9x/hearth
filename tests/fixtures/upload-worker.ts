import { eq } from 'drizzle-orm';

import { AppError } from '../../packages/core/common';
import { database } from '../../packages/core/db';
import { users } from '../../packages/core/schema';
import { upload } from '../../packages/core/upload';

export default {
  async fetch(
    request: Request,
    env: Parameters<typeof upload>[2],
    context: ExecutionContext,
  ) {
    const userId = request.headers.get('X-Test-Storage-User');
    const [user] = await database(env.DB)
      .select()
      .from(users)
      .where(userId ? eq(users.id, userId) : undefined);
    // Test-only instrumentation; production upload code has no delay or metrics hooks.
    const barrier = Number(request.headers.get('X-Test-Storage-Barrier'));
    if (barrier) {
      await env.DB.prepare(
        'INSERT INTO test_storage_barrier DEFAULT VALUES',
      ).run();
      const deadline = Date.now() + 10_000;
      while (true) {
        const count = await env.DB.prepare(
          'SELECT count(*) AS count FROM test_storage_barrier',
        ).first<{ count: number }>();
        if (count!.count >= barrier) break;
        if (Date.now() > deadline)
          throw new Error('Storage test barrier timed out');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
    }
    const delay = Math.min(
      200,
      Math.max(0, Number(request.headers.get('X-Benchmark-R2-Delay-Ms')) || 0),
    );
    let r2Ms = 0,
      d1Ms = 0,
      parts = 0;
    const bucket = env.BUCKET,
      db = env.DB;
    const measured = {
      ...env,
      DB: {
        prepare: db.prepare.bind(db),
        exec: db.exec.bind(db),
        dump: db.dump.bind(db),
        withSession: db.withSession.bind(db),
        async batch<T = unknown>(
          statements: D1PreparedStatement[],
        ): Promise<D1Result<T>[]> {
          const start = Date.now();
          try {
            return await db.batch<T>(statements);
          } finally {
            d1Ms += Date.now() - start;
          }
        },
      },
      BUCKET: {
        head: bucket.head.bind(bucket),
        get: bucket.get.bind(bucket),
        put: bucket.put.bind(bucket),
        delete: bucket.delete.bind(bucket),
        list: bucket.list.bind(bucket),
        resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
        async createMultipartUpload(key: string, options?: R2MultipartOptions) {
          const multipart = await bucket.createMultipartUpload(key, options);
          return {
            key: multipart.key,
            uploadId: multipart.uploadId,
            abort: () => multipart.abort(),
            complete: (parts: R2UploadedPart[]) => multipart.complete(parts),
            async uploadPart(
              number: number,
              value:
                ReadableStream | ArrayBuffer | ArrayBufferView | string | Blob,
            ) {
              const start = Date.now();
              try {
                if (delay)
                  await new Promise((resolve) => setTimeout(resolve, delay));
                parts++;
                return await multipart.uploadPart(number, value);
              } finally {
                r2Ms += Date.now() - start;
              }
            },
          };
        },
      },
    };
    try {
      const task = upload(request, user, measured);
      // eslint-disable-next-line unicorn/prefer-await -- Match production disconnect cleanup.
      context.waitUntil(task.catch(() => {}));
      const result = await task;
      return Response.json(result, {
        headers: {
          'X-Upload-D1-Ms': String(d1Ms),
          'X-Upload-R2-Part-Ms': String(r2Ms),
          'X-Upload-R2-Parts': String(parts),
        },
      });
    } catch (error) {
      if (error instanceof AppError)
        return Response.json({ code: error.code }, { status: error.status });
      throw error;
    }
  },
};
