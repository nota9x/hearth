import type { storageCapacity } from './schema';

export type StorageWarning = 'normal' | 'nearly-full' | 'full';

function storageWarning(used: number, limit: number | null): StorageWarning {
  if (limit === null) return 'normal';
  if (used >= limit) return 'full';
  return used / limit >= 0.99 ? 'nearly-full' : 'normal';
}

export async function storageWarnings(db: D1Database, userId: string) {
  const capacity = await db
    .prepare(
      `SELECT u.quotaBytes,s.bytes+s.previewBytes AS userBytes,
        c.limitBytes,c.persistedBytes+c.reservedBytes AS instanceBytes,c.ready,c.blocked
        FROM users u JOIN user_storage_stats s ON s.userId=u.id
        CROSS JOIN storage_capacity c WHERE u.id=? AND c.id=1`,
    )
    .bind(userId)
    .first<{
      quotaBytes: number | null;
      userBytes: number;
      limitBytes: number | null;
      instanceBytes: number;
      ready: number;
      blocked: number;
    }>();
  if (!capacity) throw new Error('Storage accounting is missing.');
  return {
    personal: storageWarning(capacity.userBytes, capacity.quotaBytes),
    instance:
      capacity.ready && !capacity.blocked
        ? storageWarning(capacity.instanceBytes, capacity.limitBytes)
        : ('normal' as const),
  };
}

export async function storageOverview(db: D1Database) {
  const results = await db.batch([
    db.prepare('SELECT * FROM storage_capacity WHERE id=1'),
    db.prepare(`SELECT count(*) AS objects,coalesce(sum(stagedBytes),0) AS stagedBytes,
      coalesce(sum(CASE WHEN state='cleanup' THEN storedBytes+reservedBytes ELSE 0 END),0) AS recoveryBytes,
      coalesce(sum(CASE WHEN state='live' THEN 1 ELSE 0 END),0) AS persistedObjects
      FROM storage_objects`),
    db.prepare(
      `SELECT count(*) AS count,coalesce(sum(o.storedBytes+o.reservedBytes),0) AS bytes FROM storage_objects o JOIN images i ON i.id=o.imageId WHERE i.deletedAt IS NOT NULL AND NOT EXISTS(SELECT 1 FROM images WHERE (objectKey=o.key OR previewKey=o.key) AND deletedAt IS NULL)`,
    ),
    db.prepare(
      'SELECT coalesce(sum(imageCount),0) AS images,coalesce(sum(bytes+previewBytes),0) AS activeBytes FROM user_storage_stats',
    ),
    db.prepare(
      'SELECT id,displayName,bytes+previewBytes AS bytes,imageCount FROM users JOIN user_storage_stats ON users.id=user_storage_stats.userId WHERE bytes+previewBytes>0 ORDER BY bytes+previewBytes DESC,users.id LIMIT 5',
    ),
    db.prepare(
      "SELECT * FROM reconciliation_runs WHERE status='completed' ORDER BY completedAt DESC LIMIT 1",
    ),
  ]);
  return {
    capacity: results[0].results[0] as typeof storageCapacity.$inferSelect,
    objects: results[1].results[0] as {
      objects: number;
      stagedBytes: number;
      recoveryBytes: number;
      persistedObjects: number;
    },
    pending: results[2].results[0] as { count: number; bytes: number },
    active: results[3].results[0] as { images: number; activeBytes: number },
    consumers: results[4].results as {
      id: string;
      displayName: string;
      bytes: number;
      imageCount: number;
    }[],
    lastSuccessful: results[5].results[0] as
      | { id: string; completedAt: number; bytes: number; objectCount: number }
      | undefined,
  };
}
