import { auditEvent } from './audit';
import { id, now } from './common';
import { database } from './db';
import {
  cleanupStorage,
  deleteStoredObjects,
  observeStoredObject,
  type StoredObject,
} from './storage';

export async function recoverStorage(db: D1Database, bucket: R2Bucket) {
  const entries = await db
    .prepare(
      "SELECT * FROM storage_objects WHERE (state IN ('uploading','committing','cleanup') AND updatedAt<?) OR (state='live' AND kind IN ('probe','preview') AND updatedAt<? AND NOT EXISTS(SELECT 1 FROM images WHERE previewKey=storage_objects.key AND deletedAt IS NULL)) LIMIT 50",
    )
    .bind(now() - 1800, now() - 1800)
    .all<StoredObject>();
  for (const entry of entries.results) {
    try {
      if (entry.state === 'live')
        await deleteStoredObjects(db, bucket, [entry.key]);
      else {
        const claimed = await db
          .prepare(
            "UPDATE storage_objects SET state='cleanup',updatedAt=? WHERE key=? AND state<>'live' AND updatedAt=? RETURNING key",
          )
          .bind(now(), entry.key, entry.updatedAt)
          .first();
        if (claimed) await cleanupStorage(db, bucket, entry.key);
      }
    } catch {
      console.error(
        JSON.stringify({ event: 'storage.recovery_pending', key: entry.key }),
      );
    }
  }
}

interface ScanRun {
  id: string;
  phase: string;
  cursor: string | null;
  metadataCursor: string | null;
  objectCount: number;
  bytes: number;
  startedAt: number;
}

export async function scanStorage(
  db: D1Database,
  bucket: R2Bucket,
  runId: string,
) {
  const run = await db
    .prepare(
      "SELECT * FROM reconciliation_runs WHERE id=? AND status='running'",
    )
    .bind(runId)
    .first<ScanRun>();
  if (!run) return;
  const finding = (
    kind: string,
    key: string,
    details: string,
    imageId: string | null = null,
  ) =>
    db
      .prepare(
        'INSERT INTO reconciliation_findings(id,runId,kind,objectKey,imageId,details,createdAt) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING',
      )
      .bind(id('find'), run.id, kind, key, imageId, details, now());
  try {
    const statements: D1PreparedStatement[] = [];
    if (run.phase === 'objects') {
      const page = await bucket.list({
        limit: 100,
        cursor: run.cursor ?? undefined,
      });
      for (const object of page.objects) {
        const image = await db
          .prepare(
            'SELECT id,userId,objectKey FROM images WHERE objectKey=? OR previewKey=?',
          )
          .bind(object.key, object.key)
          .first<{ id: string; userId: string; objectKey: string }>();
        await observeStoredObject(
          db,
          object.key,
          object.size,
          image
            ? image.objectKey === object.key
              ? 'original'
              : 'preview'
            : 'untracked',
          image?.id ?? null,
          image?.userId ?? null,
        );
        const entry = await db
          .prepare('SELECT * FROM storage_objects WHERE key=?')
          .bind(object.key)
          .first<StoredObject>();
        if (entry?.state === 'live' && entry.storedBytes !== object.size) {
          await db.batch([
            db.prepare('UPDATE storage_capacity SET blocked=1 WHERE id=1'),
            db
              .prepare(
                "UPDATE storage_objects SET storedBytes=MAX(storedBytes,?) WHERE key=? AND state='live'",
              )
              .bind(object.size, object.key),
            finding(
              'physical-size',
              object.key,
              'The stored file size differs from accounting. Verify its current size before restoring writes.',
              image?.id,
            ),
          ]);
        }
        if (
          !image &&
          entry?.state === 'live' &&
          ['untracked', 'original'].includes(entry.kind)
        )
          statements.push(
            finding(
              'orphan',
              object.key,
              'This file has no image record. It consumes capacity; review it before permanent deletion.',
            ),
          );
      }
      statements.push(
        db
          .prepare(
            "UPDATE reconciliation_runs SET cursor=?,phase=?,objectCount=?,bytes=?,updatedAt=? WHERE id=? AND status='running' AND phase='objects' AND cursor IS ?",
          )
          .bind(
            page.truncated ? page.cursor : null,
            page.truncated ? 'objects' : 'metadata',
            run.objectCount + page.objects.length,
            run.bytes +
              page.objects.reduce((sum, object) => sum + object.size, 0),
            now(),
            run.id,
            run.cursor,
          ),
      );
      await db.batch(statements);
      return;
    }
    const entries = await db
      .prepare(
        `SELECT * FROM (
      SELECT key,kind,imageId,userId,storedBytes FROM storage_objects WHERE state='live'
      UNION ALL SELECT objectKey,'original',id,userId,size FROM images WHERE purgedAt IS NULL AND NOT EXISTS(SELECT 1 FROM storage_objects WHERE key=images.objectKey)
      UNION ALL SELECT previewKey,'preview',id,userId,previewSize FROM images WHERE purgedAt IS NULL AND previewKey IS NOT NULL AND NOT EXISTS(SELECT 1 FROM storage_objects WHERE key=images.previewKey)
    ) WHERE key>? ORDER BY key LIMIT 100`,
      )
      .bind(run.metadataCursor ?? '')
      .all<StoredObject>();
    for (const entry of entries.results) {
      await observeStoredObject(
        db,
        entry.key,
        entry.storedBytes,
        entry.kind,
        entry.imageId,
        entry.userId,
      );
      if (await bucket.head(entry.key)) continue;
      const active = await db
        .prepare(
          'SELECT id,objectKey FROM images WHERE (objectKey=? OR previewKey=?) AND deletedAt IS NULL',
        )
        .bind(entry.key, entry.key)
        .first<{ id: string; objectKey: string }>();
      if (!active && ['original', 'preview', 'probe'].includes(entry.kind))
        continue;
      const original = active?.objectKey === entry.key;
      statements.push(
        db
          .prepare(
            `INSERT INTO reconciliation_findings(id,runId,kind,objectKey,imageId,details,createdAt)
          SELECT ?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM storage_objects WHERE key=? AND state='live')
          AND (?=0 OR EXISTS(SELECT 1 FROM images WHERE (objectKey=? OR previewKey=?) AND deletedAt IS NULL)) ON CONFLICT DO NOTHING`,
          )
          .bind(
            id('find'),
            run.id,
            original ? 'missing' : 'physical-missing',
            entry.key,
            active?.id ?? null,
            original
              ? 'The original is missing from R2. Retire its image record to remove broken links.'
              : 'A tracked object is absent. Verify and release its retained capacity.',
            now(),
            entry.key,
            active ? 1 : 0,
            entry.key,
            entry.key,
          ),
      );
    }
    if (entries.results.length === 100) {
      statements.push(
        db
          .prepare(
            "UPDATE reconciliation_runs SET metadataCursor=?,updatedAt=? WHERE id=? AND status='running' AND metadataCursor IS ?",
          )
          .bind(entries.results.at(-1)!.key, now(), run.id, run.metadataCursor),
      );
      await db.batch(statements);
      return;
    }
    const drift = await db
      .prepare(
        `SELECT s.userId FROM user_storage_stats s WHERE s.bytes<>(SELECT coalesce(sum(size),0) FROM images WHERE userId=s.userId AND deletedAt IS NULL) OR s.previewBytes<>(SELECT coalesce(sum(previewSize),0) FROM images WHERE userId=s.userId AND deletedAt IS NULL) OR s.imageCount<>(SELECT count(*) FROM images WHERE userId=s.userId AND deletedAt IS NULL)`,
      )
      .all<{ userId: string }>();
    for (const entry of drift.results)
      statements.push(
        finding('accounting', `user:${entry.userId}`, JSON.stringify(entry)),
      );
    statements.push(
      db.prepare(
        'UPDATE storage_capacity SET blocked=1 WHERE id=1 AND (persistedBytes<>(SELECT coalesce(sum(storedBytes),0) FROM storage_objects) OR reservedBytes<>(SELECT coalesce(sum(reservedBytes),0) FROM storage_objects))',
      ),
      db
        .prepare(
          "INSERT INTO reconciliation_findings(id,runId,kind,objectKey,details,createdAt) SELECT ?,?,'ledger','ledger','Capacity counters differ from the object ledger. Rebuild the counters before restoring writes.',? FROM storage_capacity WHERE id=1 AND (persistedBytes<>(SELECT coalesce(sum(storedBytes),0) FROM storage_objects) OR reservedBytes<>(SELECT coalesce(sum(reservedBytes),0) FROM storage_objects)) ON CONFLICT DO NOTHING",
        )
        .bind(id('find'), run.id, now()),
    );
    const event = await auditEvent(
      database(db),
      null,
      'storage.reconciliation_completed',
      run.id,
      { name: 'Storage scan', context: { bytes: run.bytes } },
    );
    statements.push(
      db
        .prepare(
          "UPDATE reconciliation_runs SET status='completed',completedAt=?,updatedAt=? WHERE id=? AND status='running'",
        )
        .bind(now(), now(), run.id),
      db
        .prepare(
          'INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT ?,?,?,?,?,? WHERE changes()>0',
        )
        .bind(
          event.id,
          event.actorId,
          event.action,
          event.targetId,
          event.metadata,
          event.createdAt,
        ),
      db
        .prepare(
          "UPDATE storage_capacity SET ready=1 WHERE id=1 AND multipartVerified=1 AND EXISTS(SELECT 1 FROM reconciliation_runs WHERE id=? AND status='completed')",
        )
        .bind(run.id),
    );
    await db.batch(statements);
  } catch (error) {
    await db
      .prepare(
        "UPDATE reconciliation_runs SET status='failed',error='The storage scan could not finish. Retry after storage and database access recover.',updatedAt=? WHERE id=? AND status='running'",
      )
      .bind(now(), run.id)
      .run();
    console.error(JSON.stringify({ event: 'storage.scan_failed', runId }));
    throw error;
  }
}
