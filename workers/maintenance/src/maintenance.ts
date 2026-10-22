import { and, eq, isNotNull, isNull, lt, ne, sql } from 'drizzle-orm';

import { id, now } from '../../../packages/core/common';
import { database } from '../../../packages/core/db';
import type { Env as WebEnvironment } from '../../../packages/core/env';
import { deleteImage } from '../../../packages/core/images';
import { images, snapshots } from '../../../packages/core/schema';
import {
  boundedBytes,
  deleteStoredObjects,
  writeStoredObject,
} from '../../../packages/core/storage';
import {
  deferMaintenanceItem,
  recoverStorage,
} from '../../../packages/core/storage-maintenance';

export type Environment = Pick<WebEnvironment, 'DB' | 'BUCKET' | 'IMAGES'>;
export async function withMaintenanceLease(
  environment: Environment,
  operation: () => Promise<void>,
  holder = id('job'),
): Promise<boolean> {
  const timestamp = now();
  const lease = await environment.DB.prepare(
    `INSERT INTO maintenance_lock(id,holder,expiresAt) VALUES('cron',?,?) ON CONFLICT(id) DO UPDATE SET holder=excluded.holder,expiresAt=excluded.expiresAt WHERE maintenance_lock.expiresAt < ? OR maintenance_lock.holder=excluded.holder RETURNING holder`,
  )
    .bind(holder, timestamp + 1200, timestamp)
    .first();
  if (!lease) return false;
  try {
    await operation();
    return true;
  } finally {
    await environment.DB.prepare(
      'DELETE FROM maintenance_lock WHERE id = ? AND holder = ?',
    )
      .bind('cron', holder)
      .run();
  }
}
export type RoutineStage =
  | 'sessions'
  | 'tokens'
  | 'expiry'
  | 'purge'
  | 'recovery'
  | 'preview'
  | 'snapshot';
export const routineStages: RoutineStage[] = [
  'sessions',
  'tokens',
  'expiry',
  'purge',
  'recovery',
  'preview',
  'snapshot',
];

export async function runMaintenance(
  environment: Environment,
  stage: RoutineStage,
) {
  const database_ = database(environment.DB),
    timestamp = now();
  if (stage === 'sessions') {
    const result = await environment.DB.prepare(
      'DELETE FROM sessions WHERE hash IN (SELECT hash FROM sessions WHERE expiresAt<? OR lastSeenAt<? ORDER BY hash LIMIT 100)',
    )
      .bind(timestamp, timestamp - 7 * 86_400)
      .run();
    return result.meta.changes === 100;
  }
  if (stage === 'tokens') {
    const result = await environment.DB.prepare(
      'DELETE FROM delete_tokens WHERE imageId IN (SELECT imageId FROM delete_tokens WHERE consumedAt IS NOT NULL ORDER BY imageId LIMIT 100)',
    ).run();
    return result.meta.changes === 100;
  }
  if (stage === 'expiry') {
    const expired = await database_
      .select()
      .from(images)
      .where(and(isNull(images.deletedAt), lt(images.expiresAt, timestamp)))
      .orderBy(images.expiresAt, images.id)
      .limit(1);
    for (const image of expired)
      await deleteImage(
        environment.DB,
        environment.BUCKET,
        image.id,
        null,
        'Image expired',
      );
    return expired.length > 0;
  }
  if (stage === 'purge') {
    const pending = await database_
      .select()
      .from(images)
      .where(
        and(
          isNotNull(images.deletedAt),
          isNull(images.purgedAt),
          sql`${images.purgeRetryAt}<=${timestamp}`,
        ),
      )
      .orderBy(images.purgeRetryAt, images.id)
      .limit(1);
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
        await deferMaintenanceItem(environment.DB, 'images', image.id, 'purge');
        console.error(
          JSON.stringify({
            event: 'maintenance.purge_failed',
            imageId: image.id,
          }),
        );
      }
    }
    return pending.length > 0;
  }
  if (stage === 'recovery')
    return recoverStorage(environment.DB, environment.BUCKET);
  if (stage === 'preview') {
    if (environment.IMAGES) {
      const candidates = await database_
        .select()
        .from(images)
        .where(
          and(
            isNull(images.deletedAt),
            isNull(images.previewKey),
            sql`${images.previewRetryAt}<=${timestamp}`,
            ne(images.mime, 'image/gif'),
            lt(images.size, 20 * 1024 * 1024),
          ),
        )
        .orderBy(images.previewRetryAt, images.id)
        .limit(1);
      for (const image of candidates) {
        const key = `previews/${image.userId}/${image.id}/${id('preview')}.webp`;
        try {
          const object = await environment.BUCKET.get(image.objectKey);
          if (!object) throw new Error('Original missing');
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
          await deferMaintenanceItem(
            environment.DB,
            'images',
            image.id,
            'preview',
          );
          console.error(
            JSON.stringify({ event: 'preview.failed', imageId: image.id }),
          );
        }
      }
      return candidates.length > 0;
    }
    return false;
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
  return false;
}
