/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed query and HTTP results. */
import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createUser } from '../../packages/core/auth';
import { id, now } from '../../packages/core/common';
import { database, type User } from '../../packages/core/db';
import { ownedImage } from '../../packages/core/images';
import {
  effectiveExpiry,
  linkSearchQuery,
  linkStatus,
} from '../../packages/core/link-search';
import {
  changeLinkExpiry,
  createLink,
  deleteLinks,
  linkCreationOptions,
  linkExpiryOptions,
  makePrimaryLink,
} from '../../packages/core/links';
import {
  aliases,
  auditLog,
  deliveryDomains,
  images,
  users,
} from '../../packages/core/schema';
import { paginationState } from '../../packages/core/search';
import { migrateDatabase } from '../helpers/database';
import { workerBundle, workerCompatibility } from '../helpers/workers';

let mf: Miniflare,
  binding: D1Database,
  bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>,
  owner: User,
  other: User,
  admin: User;
const deliveryDomainId = id('hst');
beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: workerBundle('delivery'),
      bindings: {
        APP_ORIGIN: 'https://app.example.com',
        ENVIRONMENT: 'production',
      },
      ...workerCompatibility('delivery'),
      ratelimits: {
        SHARE_FAILURE_LIMIT: {
          namespace_id: '4105',
          simple: { limit: 60, period: 60 },
        },
      },
      d1Databases: ['DB'],
      r2Buckets: ['BUCKET'],
    }),
  );
  binding = await mf.getD1Database('DB');
  bucket = await mf.getR2Bucket('BUCKET');
  await migrateDatabase(binding);
  const db = database(binding);
  const people = await Promise.all([
    createUser(binding, 'Alice', 'user', null),
    createUser(binding, 'Bob', 'user', null),
    createUser(binding, 'Admin', 'admin', null),
  ]);
  [owner, other, admin] = await Promise.all(
    people.map(async (person) => {
      const rows = await db
        .select()
        .from(users)
        .where(eq(users.id, person.userId));
      return rows[0];
    }),
  );
  await db.insert(deliveryDomains).values({
    id: deliveryDomainId,
    hostname: 'shots.example.com',
    createdAt: now(),
    updatedAt: now(),
    health: 'active',
  });
});
afterEach(async () => {
  await mf?.dispose();
});
async function fixture(person = owner, expiresAt: number | null = null) {
  const imageId = id('img'),
    timestamp = now();
  await database(binding)
    .insert(images)
    .values({
      id: imageId,
      userId: person.id,
      objectKey: imageId,
      filename: `holiday-${imageId}.png`,
      mime: 'image/png',
      extension: 'png',
      size: 3,
      sha256: 'abc',
      width: 1,
      height: 1,
      createdAt: timestamp,
      expiresAt,
    });
  await bucket.put(imageId, new Uint8Array([1, 2, 3]));
  return imageId;
}
const newLink = (imageId: string, slug?: string) =>
  createLink(binding, owner, {
    imageId,
    deliveryDomainId,
    slug,
    expiry: 'never',
  });
const linksFor = (imageId: string) =>
  database(binding).select().from(aliases).where(eq(aliases.imageId, imageId));
const liveFor = async (imageId: string) =>
  (await linksFor(imageId)).filter((link) => link.disabledAt === null);
function publicRequest(slug: string) {
  return mf.dispatchFetch(`https://shots.example.com/${slug}`);
}
describe('independent share-link lifecycle', () => {
  it('deletes primary, secondary and final links without changing stored image metadata or expiry', async () => {
    const expiresAt = now() + 86_400,
      imageId = await fixture(owner, expiresAt);
    const first = await newLink(imageId),
      second = await newLink(imageId),
      third = await newLink(imageId);
    expect((await liveFor(imageId)).find((link) => link.primary)?.id).toBe(
      first.id,
    );
    await database(binding)
      .update(aliases)
      .set({ createdAt: now() + 1 })
      .where(eq(aliases.id, third.id));
    expect((await publicRequest(first.slug)).status).toBe(200);
    expect((await deleteLinks(binding, owner, [first.id])).deletedIds).toEqual([
      first.id,
    ]);
    expect((await liveFor(imageId)).find((link) => link.primary)?.id).toBe(
      second.id,
    );
    expect((await publicRequest(first.slug)).status).toBe(404);
    await deleteLinks(binding, owner, [third.id]);
    await deleteLinks(binding, owner, [second.id]);
    expect(await liveFor(imageId)).toEqual([]);
    const image = await ownedImage(binding, owner, imageId);
    expect(image).toMatchObject({
      userId: owner.id,
      expiresAt,
      deletedAt: null,
    });
    expect(await bucket.head(image.objectKey)).not.toBeNull();
    const next = await newLink(imageId);
    expect((await liveFor(imageId))[0]).toMatchObject({
      id: next.id,
      primary: true,
    });
    expect((await publicRequest(next.slug)).status).toBe(200);
    // Generated slugs preserve case; exact tombstoned addresses remain reserved.
    await expect(
      database(binding)
        .insert(aliases)
        .values({
          id: id('lnk'),
          imageId,
          deliveryDomainId,
          slug: first.slug,
          createdAt: now(),
        }),
    ).rejects.toThrow();
  });
  it('authorizes the entire batch before modifying links and handles stale items', async () => {
    const ownImage = await fixture(),
      foreignImage = await fixture(other);
    const own = await newLink(ownImage);
    const foreign = await createLink(binding, other, {
      imageId: foreignImage,
      deliveryDomainId,
      expiry: 'never',
    });
    await expect(
      deleteLinks(binding, owner, [own.id, foreign.id]),
    ).rejects.toThrow();
    expect(await liveFor(ownImage)).toHaveLength(1);
    await deleteLinks(binding, admin, [foreign.id]);
    const result = await deleteLinks(binding, owner, [
      own.id,
      own.id,
      id('lnk'),
    ]);
    expect(result.deletedIds).toEqual([own.id]);
    expect(result.failed).toHaveLength(1);
    expect(
      (await deleteLinks(binding, owner, [own.id])).alreadyRemovedIds,
    ).toEqual([own.id]);
  });
  it('keeps concurrent deletion, creation and explicit promotion consistent', async () => {
    const imageId = await fixture();
    const first = await newLink(imageId),
      second = await newLink(imageId),
      third = await newLink(imageId);
    await Promise.allSettled([
      deleteLinks(binding, owner, [first.id, second.id]),
      makePrimaryLink(binding, owner, third.id),
      newLink(imageId),
    ]);
    let live = await liveFor(imageId);
    expect(live.filter((link) => link.primary)).toHaveLength(1);
    await Promise.all(
      live.map((link) => deleteLinks(binding, owner, [link.id])),
    );
    live = await liveFor(imageId);
    expect(live).toHaveLength(0);
    expect((await ownedImage(binding, owner, imageId)).deletedAt).toBeNull();
  });
  it('logs link mutations and promotions in the existing audit format', async () => {
    const imageId = await fixture();
    const first = await newLink(imageId),
      second = await newLink(imageId);
    await deleteLinks(binding, owner, [first.id]);
    const events = await database(binding)
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, second.id));
    expect(events.map((event) => event.action)).toContain('alias.primary');
  });
});
describe('link expiry policy', () => {
  it('uses owner policies, link creation time, and independent image deadlines', async () => {
    const db = database(binding),
      imageId = await fixture(owner, now() + 7200);
    await db
      .update(users)
      .set({
        expiryPolicy: { requireExpiry: true, maxLifetimeSeconds: 86_400 },
      })
      .where(eq(users.id, owner.id));
    await expect(newLink(imageId)).rejects.toThrow('Links must have an expiry');
    await expect(
      createLink(binding, admin, {
        imageId,
        deliveryDomainId,
        expiry: 'never',
      }),
    ).rejects.toThrow('Links must have an expiry');
    const options = await linkCreationOptions(binding, admin, imageId);
    expect(options.choices.map(([value]) => value)).not.toContain('never');
    const link = await createLink(binding, owner, {
      imageId,
      deliveryDomainId,
      expiry: '24h',
    });
    expect((await liveFor(imageId))[0].expiresAt).toBeGreaterThan(now() + 7200);
    await db
      .update(aliases)
      .set({ createdAt: now() - 80_000 })
      .where(eq(aliases.id, link.id));
    await expect(
      changeLinkExpiry(binding, owner, [link.id], '24h'),
    ).rejects.toThrow('after creation');
    expect(
      (await linkExpiryOptions(binding, owner, [link.id])).choices.map(
        ([value]) => value,
      ),
    ).not.toContain('24h');
    await changeLinkExpiry(binding, owner, [link.id], '1h');
    expect(
      (await ownedImage(binding, owner, imageId)).expiresAt,
    ).toBeGreaterThan(now() + 7100);
    await db
      .update(users)
      .set({ expiryPolicy: null })
      .where(eq(users.id, owner.id));
  });
  it('rejects mixed-owner and stale selections atomically and allows expired links to be renewed', async () => {
    const imageId = await fixture(),
      foreignImage = await fixture(other);
    const first = await newLink(imageId),
      second = await newLink(imageId);
    const foreign = await createLink(binding, other, {
      imageId: foreignImage,
      deliveryDomainId,
      expiry: 'never',
    });
    await database(binding)
      .update(users)
      .set({ expiryPolicy: { requireExpiry: true, maxLifetimeSeconds: 3600 } })
      .where(eq(users.id, other.id));
    await expect(
      changeLinkExpiry(binding, admin, [first.id, foreign.id], '24h'),
    ).rejects.toThrow();
    expect((await liveFor(imageId))[0].expiresAt).toBeNull();
    await deleteLinks(binding, owner, [second.id]);
    await expect(
      changeLinkExpiry(binding, owner, [first.id, second.id], '1h'),
    ).rejects.toThrow('no longer exist');
    await database(binding)
      .update(aliases)
      .set({ expiresAt: now() - 1 })
      .where(eq(aliases.id, first.id));
    await changeLinkExpiry(binding, owner, [first.id], '1h');
    expect((await publicRequest(first.slug)).status).toBe(200);
    await database(binding)
      .update(users)
      .set({ expiryPolicy: null })
      .where(eq(users.id, other.id));
  });
});
async function query(parameters: Record<string, string>, userId = owner.id) {
  const search = linkSearchQuery(new URLSearchParams(parameters), userId);
  return database(binding)
    .select({ id: aliases.id })
    .from(aliases)
    .innerJoin(images, eq(images.id, aliases.imageId))
    .innerJoin(
      deliveryDomains,
      eq(deliveryDomains.id, aliases.deliveryDomainId),
    )
    .innerJoin(users, eq(users.id, images.userId))
    .where(search.filter)
    .orderBy(...search.order);
}

describe('server-side link management queries', () => {
  it('searches slug, filename, full URLs, domain and admin owner; combines filters and sorting', async () => {
    const imageId = await fixture(),
      first = await newLink(imageId, 'find-this-link'),
      second = await newLink(imageId, 'find-next-link');
    await database(binding)
      .update(aliases)
      .set({ createdAt: now() - 100 })
      .where(eq(aliases.id, first.id));
    expect(
      await query({ q: 'https://shots.example.com:8788/find-this-link' }),
    ).toEqual([{ id: first.id }]);
    expect(await query({ q: 'find-', image: imageId, sort: 'oldest' })).toEqual(
      [{ id: first.id }, { id: second.id }],
    );
    expect(await query({ q: imageId })).toHaveLength(2);
    expect(
      await query({ q: 'shots.example.com', image: imageId }),
    ).toHaveLength(2);
    expect(await query({ q: 'alice', image: imageId }, '')).toHaveLength(2);
    expect(await query({ q: 'bob', image: imageId })).toHaveLength(0);
    expect(await query({ q: '%', image: imageId })).toHaveLength(0);
    await changeLinkExpiry(binding, owner, [first.id], '1h');
    expect(
      await query({
        image: imageId,
        status: 'soon',
        expiry: '24h',
        host: deliveryDomainId,
      }),
    ).toEqual([{ id: first.id }]);
    expect(await query({ image: imageId, expiry: 'never' })).toEqual([
      { id: second.id },
    ]);
    expect(await query({ image: imageId, sort: 'expiry' })).toEqual([
      { id: first.id },
      { id: second.id },
    ]);
    await database(binding)
      .update(aliases)
      .set({ expiresAt: now() - 1 })
      .where(eq(aliases.id, first.id));
    expect(await query({ image: imageId, status: 'expired' })).toEqual([
      { id: first.id },
    ]);
    await database(binding)
      .update(deliveryDomains)
      .set({ enabled: false })
      .where(eq(deliveryDomains.id, deliveryDomainId));
    expect(await query({ image: imageId, status: 'unavailable' })).toEqual([
      { id: second.id },
    ]);
    await database(binding)
      .update(deliveryDomains)
      .set({ enabled: true })
      .where(eq(deliveryDomains.id, deliveryDomainId));
    const plan = await binding
      .prepare(
        'EXPLAIN QUERY PLAN SELECT id FROM aliases WHERE disabledAt IS NULL ORDER BY createdAt,id LIMIT 24',
      )
      .all<{ detail: string }>();
    expect(
      plan.results.some((row) => row.detail.includes('aliases_live_date')),
    ).toBe(true);
    expect(paginationState('999', 25, 24)).toMatchObject({
      page: 2,
      pages: 2,
      offset: 24,
    });
    expect(effectiveExpiry(null, 10)).toBe(10);
    expect(effectiveExpiry(20, 10)).toBe(10);
    expect(linkStatus(10, false, 11)).toBe('expired');
  });
});
