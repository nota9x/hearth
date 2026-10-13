import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { authenticateKey, createUser } from '../../packages/core/auth';
import { id, now } from '../../packages/core/common';
import { database } from '../../packages/core/db';
import { deleteImage, ownedImage } from '../../packages/core/images';
import {
  aliases,
  apiKeys,
  auditLog,
  deliveryDomains,
  images,
  storageStats,
  users,
} from '../../packages/core/schema';
import { migrateDatabase } from '../helpers/database';
import { workerCompatibility } from '../helpers/workers';

let mf: Miniflare,
  binding: D1Database,
  bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      bindings: {
        APP_ORIGIN: 'https://app.example.com',
        ENVIRONMENT: 'production',
      },
      ...workerCompatibility('delivery'),
      d1Databases: ['DB'],
      r2Buckets: ['BUCKET'],
      ratelimits: {
        SHARE_FAILURE_LIMIT: {
          namespace_id: '4105',
          simple: { limit: 60, period: 60 },
        },
      },
    }),
  );
  binding = await mf.getD1Database('DB');
  bucket = await mf.getR2Bucket('BUCKET');
  await migrateDatabase(binding);
}, 30_000);
afterEach(async () => {
  await mf?.dispose();
});

describe('real D1 and R2 invariants', () => {
  it('protects the last active administrator and required credentials', async () => {
    const first = await createUser(binding, 'First admin', 'admin', null),
      database_ = database(binding);
    await expect(
      database_
        .update(users)
        .set({ status: 'disabled' })
        .where(eq(users.id, first.userId)),
    ).rejects.toThrow();
    await expect(
      database_.delete(apiKeys).where(eq(apiKeys.userId, first.userId)),
    ).rejects.toThrow();
    const second = await createUser(
      binding,
      'Second admin',
      'admin',
      first.userId,
    );
    await database_
      .update(users)
      .set({ status: 'disabled' })
      .where(eq(users.id, first.userId));
    await expect(authenticateKey(binding, second.key)).resolves.toHaveProperty(
      'user.role',
      'admin',
    );
    await expect(authenticateKey(binding, first.key)).rejects.toThrow();
  });
  it('leaves failed object deletion queued without restoring public metadata', async () => {
    const person = await createUser(binding, 'Purge failure', 'user', null),
      database_ = database(binding),
      imageId = id('img');
    await database_
      .insert(images)
      .values({
        id: imageId,
        userId: person.userId,
        objectKey: imageId,
        filename: 'a.png',
        mime: 'image/png',
        extension: 'png',
        size: 5,
        sha256: 'sha',
        width: 1,
        height: 1,
        createdAt: now(),
      })
      .run();
    await bucket.put(imageId, 'bytes');
    await deleteImage(
      binding,
      {
        delete: () => Promise.reject(new Error('Simulated R2 outage')),
        head: bucket.head.bind(bucket),
        resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
      },
      imageId,
      person.userId,
    );
    const [pending] = await database_
      .select()
      .from(images)
      .where(eq(images.id, imageId));
    expect(pending.deletedAt).not.toBeNull();
    expect(pending.purgedAt).toBeNull();
    expect(await bucket.head(imageId)).not.toBeNull();
    await deleteImage(binding, bucket, imageId, person.userId);
    expect(await bucket.head(imageId)).toBeNull();
    const deletionEvents = await database_
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, imageId));
    expect(deletionEvents).toHaveLength(1);
    const [stats] = await database_
      .select()
      .from(storageStats)
      .where(eq(storageStats.userId, person.userId));
    expect(stats.bytes).toBe(0);
  });

  it('updates accounting once, checks quotas, and makes deletion idempotent', async () => {
    const created = await createUser(binding, 'Storage', 'user', null),
      database_ = database(binding),
      imageId = id('img'),
      key = `objects/${imageId}`;
    await database_
      .update(users)
      .set({ quotaBytes: 100 })
      .where(eq(users.id, created.userId));
    await bucket.put(key, 'image');
    const row = {
      id: imageId,
      userId: created.userId,
      objectKey: key,
      filename: 'a.png',
      mime: 'image/png',
      extension: 'png',
      size: 90,
      sha256: 'sha',
      width: 1,
      height: 1,
      createdAt: now(),
    };
    await database_.insert(images).values(row).run();
    await expect(
      database_
        .insert(images)
        .values({ ...row, id: id('img'), objectKey: 'other' }),
    ).rejects.toThrow();
    const [statsBeforeDeletion] = await database_
      .select()
      .from(storageStats)
      .where(eq(storageStats.userId, created.userId));
    expect(statsBeforeDeletion.bytes).toBe(90);
    await deleteImage(binding, bucket, imageId, created.userId);
    await deleteImage(binding, bucket, imageId, created.userId);
    expect(await bucket.head(key)).toBeNull();
    const [statsAfterDeletion] = await database_
      .select()
      .from(storageStats)
      .where(eq(storageStats.userId, created.userId));
    expect(statsAfterDeletion.bytes).toBe(0);
  });
  it('enforces global host/slug uniqueness and preserves image bytes on alias removal', async () => {
    const created = await createUser(binding, 'Links', 'user', null),
      database_ = database(binding),
      imageId = id('img'),
      deliveryDomainId = id('hst');
    await database_
      .insert(deliveryDomains)
      .values({
        id: deliveryDomainId,
        hostname: 'links.example.com',
        createdAt: now(),
        updatedAt: now(),
        health: 'active',
      })
      .run();
    await database_
      .insert(images)
      .values({
        id: imageId,
        userId: created.userId,
        objectKey: imageId,
        filename: 'a.png',
        mime: 'image/png',
        extension: 'png',
        size: 30,
        sha256: 'sha',
        width: 1,
        height: 1,
        createdAt: now(),
      })
      .run();
    await bucket.put(imageId, 'bytes');
    const link = {
      id: id('lnk'),
      imageId,
      deliveryDomainId,
      slug: 'hello',
      createdAt: now(),
    };
    await database_.insert(aliases).values(link).run();
    await expect(
      database_.insert(aliases).values({ ...link, id: id('lnk') }),
    ).rejects.toThrow();
    await database_
      .update(aliases)
      .set({ disabledAt: now() })
      .where(eq(aliases.id, link.id));
    expect(await bucket.head(imageId)).not.toBeNull();
    const other = await createUser(binding, 'Other', 'user', null);
    const otherAuthentication = await authenticateKey(binding, other.key);
    await expect(
      ownedImage(binding, otherAuthentication.user, imageId),
    ).rejects.toThrow();
    await database_
      .update(users)
      .set({ status: 'disabled' })
      .where(eq(users.id, created.userId));
    await expect(authenticateKey(binding, created.key)).rejects.toThrow();
  });
});
