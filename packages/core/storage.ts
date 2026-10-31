import { AppError, id, now } from './common.ts';

export interface StoredObject {
  key: string;
  kind: string;
  imageId: string | null;
  userId: string | null;
  receiptKey: string | null;
  state: string;
  token: string;
  uploadId: string | null;
  reservedBytes: number;
  stagedBytes: number;
  storedBytes: number;
  updatedAt: number;
}
export interface StorageDeletionBucket {
  delete(keys: string | string[]): Promise<void>;
  head(key: string): Promise<unknown>;
  resumeMultipartUpload(
    key: string,
    uploadId: string,
  ): Pick<R2MultipartUpload, 'abort'>;
}

export function storageError(error: unknown): never {
  if (error instanceof AppError) throw error;
  if (String(error).includes('global_storage_limit'))
    throw new AppError(
      413,
      'GLOBAL_STORAGE_LIMIT_EXCEEDED',
      'This instance has reached its global storage limit. An administrator must free storage or increase the limit.',
    );
  throw new AppError(
    503,
    'STORAGE_ACCOUNTING_UNAVAILABLE',
    'Storage accounting is temporarily unavailable. Please try again.',
  );
}

export async function beginStorage(
  db: D1Database,
  key: string,
  kind: string,
  imageId: string | null = null,
  userId: string | null = null,
  receiptKey: string | null = null,
) {
  const token = id('write');
  const insert = db
    .prepare(
      `INSERT INTO storage_objects(key,kind,imageId,userId,receiptKey,token,updatedAt) ${receiptKey ? 'SELECT ?,?,?,?,?,?,? WHERE changes()>0' : 'VALUES(?,?,?,?,?,?,?)'}`,
    )
    .bind(key, kind, imageId, userId, receiptKey, token, now());
  try {
    if (receiptKey) {
      const results = await db.batch([
        db
          .prepare(
            'INSERT INTO upload_receipts(key,userId) VALUES(?,?) ON CONFLICT DO NOTHING',
          )
          .bind(receiptKey, userId),
        insert,
      ]);
      if (!results[1].meta.changes) return null;
    } else await insert.run();
  } catch (error) {
    storageError(error);
  }
  return token;
}

export class StorageWriter {
  private db: D1Database;
  private bucket: R2Bucket;
  private multipart: R2MultipartUpload | undefined;
  private lastHeartbeat = 0;
  readonly key: string;
  readonly token: string;
  constructor(db: D1Database, bucket: R2Bucket, key: string, token: string) {
    this.db = db;
    this.bucket = bucket;
    this.key = key;
    this.token = token;
  }

  async heartbeat() {
    if (now() - this.lastHeartbeat < 60) return;
    try {
      const result = await this.db
        .prepare(
          "UPDATE storage_objects SET updatedAt=? WHERE key=? AND token=? AND state='uploading'",
        )
        .bind(now(), this.key, this.token)
        .run();
      if (!result.meta.changes) storageError(new Error('Writer closed'));
      this.lastHeartbeat = now();
    } catch (error) {
      storageError(error);
    }
  }

  async uploadPart(number: number, bytes: Uint8Array) {
    try {
      const reserved = await this.db
        .prepare(
          "UPDATE storage_objects SET reservedBytes=reservedBytes+?,updatedAt=? WHERE key=? AND token=? AND state='uploading' RETURNING key",
        )
        .bind(bytes.byteLength, now(), this.key, this.token)
        .first();
      if (!reserved) storageError(new Error('Writer closed'));
      await this.start();
      const part = await this.multipart!.uploadPart(number, bytes);
      const recorded = await this.db
        .prepare(
          "UPDATE storage_objects SET stagedBytes=stagedBytes+?,updatedAt=? WHERE key=? AND token=? AND state='uploading' RETURNING key",
        )
        .bind(bytes.byteLength, now(), this.key, this.token)
        .first();
      if (!recorded) storageError(new Error('Writer closed'));
      return part;
    } catch (error) {
      if (
        error instanceof AppError ||
        String(error).includes('global_storage_limit') ||
        String(error).includes('D1_ERROR') ||
        String(error).includes('storage_accounting')
      )
        storageError(error);
      throw new AppError(
        503,
        'STORAGE_UNAVAILABLE',
        'Image storage is temporarily unavailable. Please try again.',
      );
    }
  }

  async start() {
    if (this.multipart) return;
    this.multipart = await this.bucket.createMultipartUpload(this.key);
    let recorded;
    try {
      recorded = await this.db
        .prepare(
          "UPDATE storage_objects SET uploadId=? WHERE key=? AND token=? AND state='uploading' RETURNING key",
        )
        .bind(this.multipart.uploadId, this.key, this.token)
        .first();
    } catch (error) {
      storageError(error);
    }
    if (recorded) {
      return;
    }

    await this.multipart.abort();
    storageError(new Error('Writer closed'));
  }

  async complete(parts: R2UploadedPart[]) {
    let claimed;
    try {
      claimed = await this.db
        .prepare(
          "UPDATE storage_objects SET state='committing',updatedAt=? WHERE key=? AND token=? AND state='uploading' RETURNING reservedBytes",
        )
        .bind(now(), this.key, this.token)
        .first<{ reservedBytes: number }>();
    } catch (error) {
      storageError(error);
    }
    if (!claimed || !this.multipart) storageError(new Error('Writer closed'));
    const object = await this.multipart.complete(parts);
    if (object.size !== claimed.reservedBytes) {
      await this.db
        .prepare('UPDATE storage_capacity SET blocked=1 WHERE id=1')
        .run();
      storageError(new Error('Unexpected physical size'));
    }
    return object;
  }

  finalizeStatement() {
    return this.db
      .prepare(
        "INSERT INTO storage_objects(key,kind,token,updatedAt) VALUES(?,'finalization',?,?) ON CONFLICT(key) DO UPDATE SET state='live',storedBytes=storage_objects.reservedBytes,reservedBytes=0,stagedBytes=0,updatedAt=excluded.updatedAt",
      )
      .bind(this.key, this.token, now());
  }

  async cleanup() {
    await cleanupStorage(
      this.db,
      this.bucket,
      this.key,
      this.token,
      this.multipart,
    );
  }
}

// Abort is the R2-side fence: stale Workers cannot recreate an object using a closed upload ID.
export async function cleanupStorage(
  db: D1Database,
  bucket: StorageDeletionBucket,
  key: string,
  token?: string,
  multipart?: R2MultipartUpload,
) {
  const claim = await db
    .prepare(
      `UPDATE storage_objects SET state='cleanup',updatedAt=? WHERE key=? AND state<>'live' ${token ? 'AND token=?' : ''} RETURNING *`,
    )
    .bind(now(), key, ...(token ? [token] : []))
    .first<StoredObject>();
  if (!claim) return;
  if (claim.uploadId) {
    try {
      await (
        multipart?.uploadId === claim.uploadId
          ? multipart
          : bucket.resumeMultipartUpload(key, claim.uploadId)
      ).abort();
    } catch (error) {
      if (
        !/\(10024\)$/.test(
          String(error instanceof Error ? error.message : error),
        )
      )
        throw error;
    }
  }
  const referenced = await db
    .prepare('SELECT id FROM images WHERE objectKey=? OR previewKey=?')
    .bind(key, key)
    .first();
  if (referenced) throw new Error('Cleanup object is referenced');
  await bucket.delete(key);
  if (await bucket.head(key)) throw new Error('Object deletion not confirmed');
  await db.batch([
    db
      .prepare('DELETE FROM upload_receipts WHERE key=? AND response IS NULL')
      .bind(claim.receiptKey),
    db
      .prepare(
        "DELETE FROM storage_objects WHERE key=? AND state='cleanup' AND token=?",
      )
      .bind(key, claim.token),
  ]);
}

export async function deleteStoredObjects(
  db: D1Database,
  bucket: StorageDeletionBucket,
  keys: string[],
) {
  for (const key of keys) {
    const entry = await db
      .prepare('SELECT * FROM storage_objects WHERE key=?')
      .bind(key)
      .first<StoredObject>();
    if (entry && entry.state !== 'live') {
      await cleanupStorage(db, bucket, key);
      continue;
    }
    const activeReference = await db
      .prepare(
        'SELECT id FROM images WHERE (objectKey=? OR previewKey=?) AND deletedAt IS NULL',
      )
      .bind(key, key)
      .first();
    if (activeReference && (await bucket.head(key))) continue;
    await bucket.delete(key);
    if (await bucket.head(key))
      throw new Error('Object deletion not confirmed');
    await db
      .prepare("DELETE FROM storage_objects WHERE key=? AND state='live'")
      .bind(key)
      .run();
  }
}

export async function writeStoredObject(
  db: D1Database,
  bucket: R2Bucket,
  key: string,
  kind: string,
  bytes: Uint8Array,
  imageId: string | null = null,
  userId: string | null = null,
) {
  const token = await beginStorage(db, key, kind, imageId, userId);
  const writer = new StorageWriter(db, bucket, key, token!);
  try {
    const part = await writer.uploadPart(1, bytes);
    const object = await writer.complete([part]);
    return { writer, object };
  } catch (error) {
    try {
      await writer.cleanup();
    } catch {
      console.error(JSON.stringify({ event: 'storage.cleanup_pending', key }));
    }
    throw error;
  }
}

export async function boundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
) {
  if (!stream) throw new Error('Missing generated output');
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit)
        throw new Error('Generated output exceeds its size bound');
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }
  return bytes;
}

export async function observeStoredObject(
  db: D1Database,
  key: string,
  size: number,
  kind = 'untracked',
  imageId: string | null = null,
  userId: string | null = null,
) {
  await db
    .prepare(
      "INSERT INTO storage_objects(key,kind,imageId,userId,state,token,storedBytes,updatedAt) VALUES(?,?,?,?,'live',?,?,?) ON CONFLICT DO NOTHING",
    )
    .bind(key, kind, imageId, userId, id('observed'), size, now())
    .run();
}
