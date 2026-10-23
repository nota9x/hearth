import { now } from './common';
import {
  cleanupStorage,
  deleteStoredObjects,
  type StoredObject,
} from './storage';

export async function deferMaintenanceItem(
  db: D1Database,
  table: 'images' | 'storage_objects',
  key: string,
  stage: 'preview' | 'purge' = 'purge',
) {
  const attempts = table === 'images' ? `${stage}Failures` : 'failures';
  const retry = table === 'images' ? `${stage}RetryAt` : 'retryAt';
  await db
    .prepare(
      `UPDATE ${table} SET ${retry}=?+MIN(86400,60*(1<<MIN(${attempts},11))),${attempts}=${attempts}+1 WHERE ${table === 'images' ? 'id' : 'key'}=?`,
    )
    .bind(now(), key)
    .run();
}

export async function recoverStorage(db: D1Database, bucket: R2Bucket) {
  const entries = await db
    .prepare(
      "SELECT * FROM storage_objects WHERE retryAt<=? AND ((state='cleanup' OR (state IN ('uploading','committing') AND updatedAt<?)) OR (state='live' AND kind IN ('probe','preview') AND updatedAt<? AND NOT EXISTS(SELECT 1 FROM images WHERE previewKey=storage_objects.key AND deletedAt IS NULL))) ORDER BY retryAt,key LIMIT 1",
    )
    .bind(now(), now() - 1800, now() - 1800)
    .all<StoredObject>();
  for (const entry of entries.results) {
    try {
      if (entry.state === 'live')
        await deleteStoredObjects(db, bucket, [entry.key]);
      else await cleanupStorage(db, bucket, entry.key);
    } catch {
      await deferMaintenanceItem(db, 'storage_objects', entry.key);
    }
  }
  return entries.results.length > 0;
}

interface ScanRun {
  id: string;
  phase: string;
  cursor: string | null;
  metadataCursor: string | null;
  objectCount: number;
  bytes: number;
}

// JSON pages avoid D1's parameter limit. Findings, accounting and cursor commit together.
export async function scanStorage(
  db: D1Database,
  bucket: R2Bucket,
  runId: string,
  deadline = Date.now() + 8000,
) {
  const run = await db
    .prepare(
      "SELECT * FROM reconciliation_runs WHERE id=? AND status='running'",
    )
    .bind(runId)
    .first<ScanRun>();
  if (!run) return;
  const timestamp = now();
  if (run.phase === 'objects') {
    const page = await bucket.list({
      limit: 100,
      cursor: run.cursor ?? undefined,
    });
    const objects = JSON.stringify(
      page.objects.map(({ key, size }) => ({ key, size })),
    );
    await db.batch([
      db
        .prepare(
          `INSERT INTO storage_objects(key,kind,imageId,userId,state,token,storedBytes,updatedAt)
        SELECT p.value->>'key',CASE WHEN i.objectKey=p.value->>'key' THEN 'original' WHEN i.id IS NOT NULL THEN 'preview' ELSE 'untracked' END,i.id,i.userId,'live','observed_'||lower(hex(randomblob(16))),p.value->>'size',?
        FROM json_each(?) p LEFT JOIN images i ON i.objectKey=p.value->>'key' OR i.previewKey=p.value->>'key'
        WHERE NOT EXISTS(SELECT 1 FROM storage_objects WHERE key=p.value->>'key') ON CONFLICT DO NOTHING`,
        )
        .bind(timestamp, objects),
      db
        .prepare(
          `INSERT INTO reconciliation_findings(id,runId,kind,objectKey,imageId,details,createdAt)
        SELECT 'find_'||lower(hex(randomblob(16))),?,'physical-size',o.key,o.imageId,'Stored size differs from accounting. Verify size before restoring writes.',?
        FROM storage_objects o JOIN json_each(?) p ON o.key=p.value->>'key' WHERE o.state='live' AND o.storedBytes<>p.value->>'size' ON CONFLICT DO NOTHING`,
        )
        .bind(run.id, timestamp, objects),
      db
        .prepare(
          `UPDATE storage_capacity SET blocked=1 WHERE id=1 AND EXISTS(SELECT 1 FROM storage_objects o JOIN json_each(?) p ON o.key=p.value->>'key' WHERE o.state='live' AND o.storedBytes<>p.value->>'size')`,
        )
        .bind(objects),
      db
        .prepare(
          `UPDATE storage_objects SET storedBytes=MAX(storedBytes,(SELECT value->>'size' FROM json_each(?) WHERE value->>'key'=storage_objects.key)) WHERE state='live' AND key IN (SELECT value->>'key' FROM json_each(?)) AND storedBytes<(SELECT value->>'size' FROM json_each(?) WHERE value->>'key'=storage_objects.key)`,
        )
        .bind(objects, objects, objects),
      db
        .prepare(
          `INSERT INTO reconciliation_findings(id,runId,kind,objectKey,details,createdAt)
        SELECT 'find_'||lower(hex(randomblob(16))),?,'orphan',o.key,'This file has no image record. Review before permanent deletion.',?
        FROM storage_objects o JOIN json_each(?) p ON o.key=p.value->>'key' WHERE o.state='live' AND o.kind IN ('untracked','original') AND NOT EXISTS(SELECT 1 FROM images WHERE objectKey=o.key OR previewKey=o.key) ON CONFLICT DO NOTHING`,
        )
        .bind(run.id, timestamp, objects),
      db
        .prepare(
          "UPDATE reconciliation_runs SET cursor=?,phase=?,objectCount=?,bytes=?,updatedAt=? WHERE id=? AND status='running' AND phase='objects' AND cursor IS ?",
        )
        .bind(
          page.truncated ? page.cursor : null,
          page.truncated ? 'objects' : 'metadata',
          run.objectCount + page.objects.length,
          run.bytes + page.objects.reduce((sum, o) => sum + o.size, 0),
          timestamp,
          run.id,
          run.cursor,
        ),
    ]);
    return;
  }
  if (run.phase === 'metadata') {
    const entries = await db
      .prepare(
        `SELECT * FROM (
      SELECT key,kind,imageId,userId,storedBytes FROM storage_objects WHERE state='live'
      UNION ALL SELECT objectKey,'original',id,userId,size FROM images WHERE purgedAt IS NULL AND NOT EXISTS(SELECT 1 FROM storage_objects WHERE key=images.objectKey)
      UNION ALL SELECT previewKey,'preview',id,userId,previewSize FROM images WHERE purgedAt IS NULL AND previewKey IS NOT NULL AND NOT EXISTS(SELECT 1 FROM storage_objects WHERE key=images.previewKey)
    ) WHERE key>? ORDER BY key LIMIT 20`,
      )
      .bind(run.metadataCursor ?? '')
      .all<StoredObject>();
    const missing: string[] = [];
    let processed = 0;
    for (const entry of entries.results) {
      if (processed && Date.now() >= deadline) break;
      if (!(await bucket.head(entry.key))) missing.push(entry.key);
      processed++;
    }
    const page = entries.results.slice(0, processed);
    await db.batch([
      db
        .prepare(
          `INSERT INTO storage_objects(key,kind,imageId,userId,state,token,storedBytes,updatedAt) SELECT value->>'key',value->>'kind',value->>'imageId',value->>'userId','live','observed_'||lower(hex(randomblob(16))),value->>'storedBytes',? FROM json_each(?) WHERE NOT EXISTS(SELECT 1 FROM storage_objects WHERE key=value->>'key') AND EXISTS(SELECT 1 FROM images WHERE purgedAt IS NULL AND (objectKey=value->>'key' OR previewKey=value->>'key')) ON CONFLICT DO NOTHING`,
        )
        .bind(timestamp, JSON.stringify(page)),
      db
        .prepare(
          `INSERT INTO reconciliation_findings(id,runId,kind,objectKey,imageId,details,createdAt)
        SELECT 'find_'||lower(hex(randomblob(16))),?,CASE WHEN i.objectKey=o.key THEN 'missing' ELSE 'physical-missing' END,o.key,i.id,CASE WHEN i.objectKey=o.key THEN 'Original missing from R2. Retire its image record.' ELSE 'Tracked object absent. Verify before releasing capacity.' END,?
        FROM storage_objects o JOIN json_each(?) p ON o.key=p.value LEFT JOIN images i ON (i.objectKey=o.key OR i.previewKey=o.key) AND i.deletedAt IS NULL
        WHERE o.state='live' AND (i.id IS NOT NULL OR o.kind NOT IN ('original','preview','probe')) ON CONFLICT DO NOTHING`,
        )
        .bind(run.id, timestamp, JSON.stringify(missing)),
      db
        .prepare(
          "UPDATE reconciliation_runs SET metadataCursor=?,phase=?,updatedAt=? WHERE id=? AND status='running' AND metadataCursor IS ?",
        )
        .bind(
          entries.results.length === 20 || processed < entries.results.length
            ? (page.at(-1)?.key ?? run.metadataCursor)
            : null,
          entries.results.length === 20 || processed < entries.results.length
            ? 'metadata'
            : 'accounting',
          timestamp,
          run.id,
          run.metadataCursor,
        ),
    ]);
    return;
  }
  const users = await db
    .prepare(
      'SELECT userId FROM user_storage_stats WHERE userId>? ORDER BY userId LIMIT 100',
    )
    .bind(run.metadataCursor ?? '')
    .all<{ userId: string }>();
  const accounting = db
    .prepare(
      `INSERT INTO reconciliation_findings(id,runId,kind,objectKey,details,createdAt)
    SELECT 'find_'||lower(hex(randomblob(16))),?,'accounting','user:'||s.userId,json_object('userId',s.userId),? FROM user_storage_stats s
    WHERE s.userId IN (SELECT value FROM json_each(?)) AND (s.bytes<>(SELECT coalesce(sum(size),0) FROM images WHERE userId=s.userId AND deletedAt IS NULL) OR s.previewBytes<>(SELECT coalesce(sum(previewSize),0) FROM images WHERE userId=s.userId AND deletedAt IS NULL) OR s.imageCount<>(SELECT count(*) FROM images WHERE userId=s.userId AND deletedAt IS NULL)) ON CONFLICT DO NOTHING`,
    )
    .bind(
      run.id,
      timestamp,
      JSON.stringify(users.results.map((user) => user.userId)),
    );
  if (users.results.length === 100) {
    await db.batch([
      accounting,
      db
        .prepare(
          "UPDATE reconciliation_runs SET metadataCursor=?,updatedAt=? WHERE id=? AND status='running' AND metadataCursor IS ?",
        )
        .bind(
          users.results.at(-1)!.userId,
          timestamp,
          run.id,
          run.metadataCursor,
        ),
    ]);
    return;
  }
  await db.batch([
    accounting,
    db.prepare(
      'UPDATE storage_capacity SET blocked=1 WHERE id=1 AND (persistedBytes<>(SELECT coalesce(sum(storedBytes),0) FROM storage_objects) OR reservedBytes<>(SELECT coalesce(sum(reservedBytes),0) FROM storage_objects))',
    ),
    db
      .prepare(
        "INSERT INTO reconciliation_findings(id,runId,kind,objectKey,details,createdAt) SELECT 'find_'||lower(hex(randomblob(16))),?,'ledger','ledger','Capacity differs from ledger. Rebuild counters before restoring writes.',? FROM storage_capacity WHERE id=1 AND (persistedBytes<>(SELECT coalesce(sum(storedBytes),0) FROM storage_objects) OR reservedBytes<>(SELECT coalesce(sum(reservedBytes),0) FROM storage_objects)) ON CONFLICT DO NOTHING",
      )
      .bind(run.id, timestamp),
    db
      .prepare(
        "UPDATE reconciliation_runs SET status='completed',completedAt=?,updatedAt=?,error=NULL WHERE id=? AND status='running'",
      )
      .bind(timestamp, timestamp, run.id),
    db
      .prepare(
        "INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT 'evt_'||lower(hex(randomblob(16))),NULL,'storage.reconciliation_completed',?,json_object('version',2,'actorName','System','targetName','Storage scan','changes',json_array(),'context',json_object('bytes',?)),? WHERE changes()>0",
      )
      .bind(run.id, run.bytes, timestamp),
    db
      .prepare(
        "UPDATE storage_capacity SET ready=1 WHERE id=1 AND multipartVerified=1 AND EXISTS(SELECT 1 FROM reconciliation_runs WHERE id=? AND status='completed')",
      )
      .bind(run.id),
  ]);
}
