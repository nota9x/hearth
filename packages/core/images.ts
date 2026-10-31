import { and, eq, isNull, sql } from 'drizzle-orm';

import { auditEvent, auditResource } from './audit.ts';
import { authorizeOwner } from './auth.ts';
import { AppError, expiry, now } from './common.ts';
import { database, type User } from './db.ts';
import { expiryChoices, validateImageExpiry } from './expiry-policy.ts';
import { getEffectiveExpiryPolicy } from './expiry-policy-store.ts';
import { aliases, auditLog, deleteTokens, images } from './schema.ts';
import { downloadFilename } from './serve.ts';
import { deleteStoredObjects, type StorageDeletionBucket } from './storage.ts';

async function expirySelection(binding: D1Database, user: User, ids: string[]) {
  const uniqueIds = [...new Set(ids)];
  const rows = await database(binding)
    .select({
      id: images.id,
      userId: images.userId,
      createdAt: images.createdAt,
      deletedAt: images.deletedAt,
    })
    .from(images)
    .where(
      sql`${images.id} IN (SELECT value FROM json_each(${JSON.stringify(uniqueIds)}))`,
    );
  if (
    rows.length !== uniqueIds.length ||
    rows.some((image) => image.deletedAt !== null)
  )
    throw new AppError(
      404,
      'NOT_FOUND',
      'One or more selected images no longer exist. Refresh your selection.',
    );
  for (const image of rows) authorizeOwner(user, image.userId);
  return { rows, ids: uniqueIds };
}
export async function imageExpiryOptions(
  binding: D1Database,
  user: User,
  ids: string[],
) {
  const { rows } = await expirySelection(binding, user, ids);
  const policy = await getEffectiveExpiryPolicy(binding, user);
  let oldest = Infinity;
  for (const image of rows) oldest = Math.min(oldest, image.createdAt);
  const deadline =
    policy.maxLifetimeSeconds === null
      ? null
      : oldest + policy.maxLifetimeSeconds;
  return { policy, deadline, choices: expiryChoices(policy, deadline) };
}
export async function changeImageExpiry(
  binding: D1Database,
  user: User,
  ids: string[],
  value: string,
  custom?: string,
  actorIp?: string | null,
) {
  const { rows, ids: uniqueIds } = await expirySelection(binding, user, ids);
  const timestamp = now();
  const policy = await getEffectiveExpiryPolicy(binding, user);
  const expiresAt = expiry(value, custom, timestamp);
  for (const image of rows)
    validateImageExpiry(policy, image.createdAt, expiresAt, timestamp);
  const event = await auditEvent(
    database(binding),
    user.id,
    'image.expiry',
    null,
    {
      actorName: user.displayName,
      actorIp,
      name: 'Images',
      before: {},
    },
  );
  const selection = JSON.stringify(uniqueIds);
  // Both statements use the same eligibility guard inside one D1 transaction.
  const eligible =
    'SELECT count(*) FROM images WHERE id IN (SELECT value FROM json_each(?)) AND deletedAt IS NULL AND (? = 1 OR userId = ?)';
  const admin = user.role === 'admin' ? 1 : 0;
  const results = await binding.batch([
    binding
      .prepare(
        `INSERT INTO audit_log (id,actorId,action,targetId,metadata,createdAt)
      SELECT 'evt_' || lower(hex(randomblob(16))), ?, 'image.expiry', id,
        json_set(?, '$.targetName', filename, '$.changes', json(CASE WHEN expiresAt IS ? THEN '[]' ELSE json_array(json_object('field','expiresAt','before',expiresAt,'after',?)) END)), ?
      FROM images WHERE id IN (SELECT value FROM json_each(?)) AND (${eligible}) = ?`,
      )
      .bind(
        user.id,
        event.metadata,
        expiresAt,
        expiresAt,
        timestamp,
        selection,
        selection,
        admin,
        user.id,
        uniqueIds.length,
      ),
    binding
      .prepare(
        `UPDATE images SET expiresAt = ? WHERE id IN (SELECT value FROM json_each(?)) AND (${eligible}) = ?`,
      )
      .bind(expiresAt, selection, selection, admin, user.id, uniqueIds.length),
  ]);
  if (results[1].meta.changes !== uniqueIds.length)
    throw new AppError(
      409,
      'SELECTION_CHANGED',
      'The selection changed. Refresh and try again; no expiry changes were applied.',
    );
}

export interface ImageFailure {
  id: string;
  code: string;
  message: string;
  filename?: string;
}
export interface DownloadImage {
  id: string;
  filename: string;
  mime: string;
  size: number;
  url: string;
}
export interface DownloadManifest {
  images: DownloadImage[];
  failed: ImageFailure[];
}
export interface DeleteResult {
  deletedIds: string[];
  alreadyRemovedIds: string[];
  failed: ImageFailure[];
}

function imageFailure(imageId: string, error: unknown): ImageFailure {
  return {
    id: imageId,
    code: error instanceof AppError ? error.code : 'UNAVAILABLE',
    message:
      error instanceof AppError
        ? error.message
        : 'Could not process this image. Please try again.',
  };
}

export async function prepareDownloads(
  binding: D1Database,
  bucket: Pick<R2Bucket, 'head'>,
  user: User,
  ids: string[],
): Promise<DownloadManifest> {
  const result: DownloadManifest = { images: [], failed: [] };
  const uniqueIds = new Set(ids);
  for (const imageId of uniqueIds) {
    let name: string | undefined;
    try {
      const image = await ownedImage(binding, user, imageId);
      name = downloadFilename(image.filename);
      const original = await bucket.head(image.objectKey);
      if (!original)
        throw new AppError(404, 'NOT_FOUND', 'Original image not found.');
      result.images.push({
        id: imageId,
        filename: name,
        mime: image.mime,
        size: original.size,
        url: `/api/media/${imageId}?download`,
      });
    } catch (error) {
      result.failed.push({ ...imageFailure(imageId, error), filename: name });
    }
  }
  return result;
}

export async function deleteImages(
  binding: D1Database,
  bucket: StorageDeletionBucket,
  user: User,
  ids: string[],
  actorIp?: string | null,
): Promise<DeleteResult> {
  const authorized = [];
  const uniqueIds = new Set(ids);
  for (const imageId of uniqueIds)
    authorized.push(await ownedImage(binding, user, imageId, true));
  const result: DeleteResult = {
    deletedIds: [],
    alreadyRemovedIds: [],
    failed: [],
  };
  for (const image of authorized) {
    try {
      await deleteImage(
        binding,
        bucket,
        image.id,
        user.id,
        'User request',
        actorIp,
      );
      (image.deletedAt === null
        ? result.deletedIds
        : result.alreadyRemovedIds
      ).push(image.id);
    } catch (error) {
      result.failed.push(imageFailure(image.id, error));
    }
  }
  return result;
}

export async function ownedImage(
  binding: D1Database,
  user: User,
  imageId: string,
  includeDeleted = false,
) {
  const [image] = await database(binding)
    .select()
    .from(images)
    .where(
      and(
        eq(images.id, imageId),
        includeDeleted ? undefined : isNull(images.deletedAt),
      ),
    );
  if (!image) throw new AppError(404, 'NOT_FOUND', 'Image not found.');
  authorizeOwner(user, image.userId);
  return image;
}
export async function deleteImage(
  binding: D1Database,
  bucket: StorageDeletionBucket,
  imageId: string,
  actorId: string | null,
  reason = actorId ? 'User request' : 'Deletion link',
  actorIp?: string | null,
) {
  const database_ = database(binding),
    timestamp = now();
  const [image] = await database_
    .select()
    .from(images)
    .where(eq(images.id, imageId));
  if (!image || image.purgedAt !== null) return;
  if (image.deletedAt === null) {
    const owner = await auditResource(database_, image.userId);
    const event = await auditEvent(
      database_,
      actorId,
      'image.deleted',
      imageId,
      {
        actorName: actorId
          ? undefined
          : reason === 'Image expired'
            ? 'System'
            : 'Deletion link holder',
        actorIp,
        context: { reason, owner: `${owner.name} (${image.userId})` },
      },
    );
    await database_.batch([
      database_
        .update(images)
        .set({ deletedAt: timestamp })
        .where(and(eq(images.id, imageId), isNull(images.deletedAt))),
      database_
        .insert(auditLog)
        .select(
          sql`SELECT ${event.id}, ${event.actorId}, ${event.action}, ${event.targetId}, ${event.metadata}, ${event.createdAt} WHERE changes() > 0`,
        ),
      database_
        .update(aliases)
        .set({ disabledAt: timestamp, primary: false })
        .where(eq(aliases.imageId, imageId)),
      database_
        .update(deleteTokens)
        .set({ consumedAt: timestamp })
        .where(eq(deleteTokens.imageId, imageId)),
    ]);
  }
  try {
    // A preview may have attached between the initial read and tombstoning.
    // After the tombstone, preview writers cannot attach new metadata.
    const [current] = await database_
      .select({ previewKey: images.previewKey })
      .from(images)
      .where(eq(images.id, imageId));
    await deleteStoredObjects(binding, bucket, [
      image.objectKey,
      ...(current?.previewKey ? [current.previewKey] : []),
    ]);
    await database_
      .update(images)
      .set({ purgedAt: now() })
      .where(eq(images.id, imageId));
  } catch {
    console.error(JSON.stringify({ event: 'image.purge_pending', imageId }));
  }
}
