import { and, eq, gt, isNotNull, isNull, lt, ne, or, sql } from 'drizzle-orm';

import { auditEvent } from '../../../packages/core/audit';
import { id, now } from '../../../packages/core/common';
import { database } from '../../../packages/core/db';
import type { Env as WebEnvironment } from '../../../packages/core/env';
import { deleteImage } from '../../../packages/core/images';
import {
  auditLog,
  deleteTokens,
  images,
  reconciliation,
  sessions,
  snapshots,
} from '../../../packages/core/schema';
import {
  boundedBytes,
  deleteStoredObjects,
  writeStoredObject,
} from '../../../packages/core/storage';
import {
  recoverStorage,
  scanStorage,
} from '../../../packages/core/storage-maintenance';

type Environment = Pick<WebEnvironment, 'DB' | 'BUCKET' | 'IMAGES'>;
export async function maintain(environment: Environment) {
  const holder = id('job'),
    timestamp = now();
  const lease = await environment.DB.prepare(
    `INSERT INTO maintenance_lock(id,holder,expiresAt) VALUES('cron',?,?) ON CONFLICT(id) DO UPDATE SET holder=excluded.holder,expiresAt=excluded.expiresAt WHERE maintenance_lock.expiresAt < ? RETURNING holder`,
  )
    .bind(holder, timestamp + 1200, timestamp)
    .first();
  if (!lease) return;
  try {
    await maintainUnlocked(environment);
  } finally {
    await environment.DB.prepare(
      'DELETE FROM maintenance_lock WHERE id = ? AND holder = ?',
    )
      .bind('cron', holder)
      .run();
  }
}
async function maintainUnlocked(environment: Environment) {
  const database_ = database(environment.DB),
    timestamp = now();
  await database_
    .delete(sessions)
    .where(
      or(
        lt(sessions.expiresAt, timestamp),
        lt(sessions.lastSeenAt, timestamp - 7 * 86_400),
      ),
    );
  await database_
    .delete(deleteTokens)
    .where(isNotNull(deleteTokens.consumedAt));
  const expired = await database_
    .select()
    .from(images)
    .where(and(isNull(images.deletedAt), lt(images.expiresAt, timestamp)))
    .limit(50);
  for (const image of expired)
    await deleteImage(
      environment.DB,
      environment.BUCKET,
      image.id,
      null,
      'Image expired',
    );
  const pending = await database_
    .select()
    .from(images)
    .where(and(isNotNull(images.deletedAt), isNull(images.purgedAt)))
    .limit(50);
  for (const image of pending) {
    try {
      await deleteStoredObjects(environment.DB, environment.BUCKET, [
        image.objectKey,
        ...(image.previewKey ? [image.previewKey] : []),
      ]);
      await database_
        .update(images)
        .set({ purgedAt: now() })
        .where(eq(images.id, image.id));
    } catch {
      console.error(
        JSON.stringify({
          event: 'maintenance.purge_failed',
          imageId: image.id,
        }),
      );
    }
  }
  await recoverStorage(environment.DB, environment.BUCKET);
  if (environment.IMAGES) {
    const candidates = await database_
      .select()
      .from(images)
      .where(
        and(
          isNull(images.deletedAt),
          isNull(images.previewKey),
          ne(images.mime, 'image/gif'),
          lt(images.size, 20 * 1024 * 1024),
        ),
      )
      .limit(5);
    for (const image of candidates) {
      const key = `previews/${image.userId}/${image.id}/${id('preview')}.webp`;
      try {
        const object = await environment.BUCKET.get(image.objectKey);
        if (!object) continue;
        // R2 bodies contain bytes; the platform declaration uses an unparameterized stream.
        const result = await environment.IMAGES.input(
          object.body as ReadableStream<Uint8Array>,
        )
          .transform({ width: 640, height: 480, fit: 'scale-down' })
          .output({ format: 'image/webp' });
        const bytes = await boundedBytes(
          result.response().body,
          5 * 1024 * 1024,
        );
        const { writer, object: saved } = await writeStoredObject(
          environment.DB,
          environment.BUCKET,
          key,
          'preview',
          bytes,
          image.id,
          image.userId,
        );
        try {
          const results = await environment.DB.batch([
            writer.finalizeStatement(),
            environment.DB.prepare(
              'UPDATE images SET previewKey=?,previewSize=? WHERE id=? AND deletedAt IS NULL AND previewKey IS NULL',
            ).bind(key, saved.size, image.id),
          ]);
          if (!results[1].meta.changes)
            await deleteStoredObjects(environment.DB, environment.BUCKET, [
              key,
            ]);
        } catch (error) {
          await writer.cleanup();
          throw error;
        }
      } catch {
        console.error(
          JSON.stringify({ event: 'preview.failed', imageId: image.id }),
        );
      }
    }
  }
  const day = new Date(timestamp * 1000).toISOString().slice(0, 10);
  await database_
    .insert(snapshots)
    .values({
      day,
      bytes: sql`(select coalesce(sum(bytes+previewBytes),0) from user_storage_stats)`,
      images: sql`(select coalesce(sum(imageCount),0) from user_storage_stats)`,
    })
    .onConflictDoNothing();
  let [run] = await database_
    .select()
    .from(reconciliation)
    .where(eq(reconciliation.status, 'running'))
    .limit(1);
  const [todayRun] = await database_
    .select({ id: reconciliation.id })
    .from(reconciliation)
    .where(
      gt(reconciliation.startedAt, Math.floor(timestamp / 86_400) * 86_400),
    )
    .limit(1);
  if (!run && !todayRun && new Date().getUTCHours() === 3) {
    const runId = id('rec');
    await database_.batch([
      database_
        .insert(reconciliation)
        .values({ id: runId, status: 'running', startedAt: timestamp }),
      database_.insert(auditLog).values(
        await auditEvent(database_, null, 'storage.reconciliation', runId, {
          name: 'Storage reconciliation',
          context: { reason: 'Scheduled maintenance' },
        }),
      ),
    ]);
    [run] = await database_
      .select()
      .from(reconciliation)
      .where(eq(reconciliation.status, 'running'))
      .limit(1);
  }
  if (run) await scanStorage(environment.DB, environment.BUCKET, run.id);
}
export default {
  scheduled(
    _event: ScheduledController,
    environment: Environment,
    context: ExecutionContext,
  ) {
    context.waitUntil(maintain(environment));
  },
} satisfies ExportedHandler<Environment>;
