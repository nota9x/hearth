/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed D1 results. */

import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { presentAudit } from '../../packages/core/audit-presentation';
import { createUser } from '../../packages/core/auth';
import { id, now } from '../../packages/core/common';
import { database, type User } from '../../packages/core/db';
import {
  aliases,
  auditLog,
  deliveryDomains,
  images,
  users,
} from '../../packages/core/schema';
import {
  allocateShareSlug,
  getShareSlugConfig,
  isShareSlugCollision,
  setShareSlugDefault,
  SHARE_SLUG_ALPHABET,
} from '../../packages/core/share-slugs';
import { migrateDatabase } from '../helpers/database';

let mf: Miniflare;
let binding: D1Database;
let admin: User;
let imageId: string;
const deliveryDomainId = id('hst');
const secureRandom = crypto.getRandomValues.bind(crypto);

beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
    }),
  );
  binding = await mf.getD1Database('DB');
  await migrateDatabase(binding);
  const account = await createUser(
    binding,
    'Slug administrator',
    'admin',
    null,
  );
  [admin] = await database(binding)
    .select()
    .from(users)
    .where(eq(users.id, account.userId));
  await database(binding).insert(deliveryDomains).values({
    id: deliveryDomainId,
    hostname: 'slugs.example.com',
    createdAt: now(),
    updatedAt: now(),
    health: 'active',
  });
});

beforeEach(async () => {
  await binding
    .prepare('UPDATE app_settings SET value=? WHERE key=?')
    .bind(
      JSON.stringify({ defaultLength: 5, automaticFloor: 3 }),
      'shareSlugConfiguration',
    )
    .run();
  await database(binding).delete(aliases);
  await database(binding).delete(auditLog);
  imageId = id('img');
  await database(binding).insert(images).values({
    id: imageId,
    userId: admin.id,
    objectKey: imageId,
    filename: 'slug.png',
    mime: 'image/png',
    extension: 'png',
    size: 1,
    sha256: 'hash',
    width: 1,
    height: 1,
    createdAt: now(),
  });
});

afterEach(async () => {
  await mf?.dispose();
});

async function insert(slug: string) {
  const [alias] = await database(binding)
    .insert(aliases)
    .values({
      id: id('lnk'),
      imageId,
      deliveryDomainId,
      slug,
      createdAt: now(),
    })
    .returning();
  return alias.slug;
}

function repeatedCandidate() {
  return vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
    if (!(array instanceof Uint8Array))
      throw new TypeError('Expected slug bytes');
    if (array.length === 10) array.fill(0);
    else secureRandom(array);
    return array;
  });
}

describe('share slug allocation', () => {
  it('defaults to five secure URL-safe Base62 characters with one commit and no audit', async () => {
    const random = vi.spyOn(crypto, 'getRandomValues');
    const insecure = vi.spyOn(Math, 'random').mockImplementation(() => {
      throw new Error('Insecure random');
    });
    const commit = vi.fn(insert);
    const slug = await allocateShareSlug(binding, commit);
    expect(slug).toHaveLength(5);
    expect(
      [...slug].every((character) => SHARE_SLUG_ALPHABET.includes(character)),
    ).toBe(true);
    expect(encodeURIComponent(slug)).toBe(slug);
    expect(commit).toHaveBeenCalledTimes(1);
    expect(random).toHaveBeenCalled();
    expect(insecure).not.toHaveBeenCalled();
    expect(await database(binding).select().from(auditLog)).toEqual([]);
  });

  it('rejects biased byte values and can generate every alphabet character', async () => {
    await setShareSlugDefault(binding, 62, admin, null);
    const random = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementationOnce((array) => {
        if (!(array instanceof Uint8Array))
          throw new TypeError('Expected slug bytes');
        array.fill(255);
        return array;
      })
      .mockImplementation((array) => {
        if (!(array instanceof Uint8Array))
          throw new TypeError('Expected slug bytes');
        for (let index = 0; index < array.length; index++)
          array[index] = index % 62;
        return array;
      });
    expect(await allocateShareSlug(binding, insert)).toBe(SHARE_SLUG_ALPHABET);
    expect(random).toHaveBeenCalledTimes(2);
  });

  it.each([1, 2])(
    'retries %i real address collisions without expanding',
    async (collisions) => {
      await insert('AAAAA');
      let calls = 0;
      vi.spyOn(crypto, 'getRandomValues').mockImplementation((array) => {
        if (!(array instanceof Uint8Array))
          throw new TypeError('Expected slug bytes');
        array.fill(calls++ < collisions ? 0 : 1);
        return array;
      });
      expect(await allocateShareSlug(binding, insert)).toBe('BBBBB');
      expect(calls).toBe(collisions + 1);
      expect((await getShareSlugConfig(binding)).effectiveLength).toBe(5);
      expect(await database(binding).select().from(auditLog)).toEqual([]);
    },
  );

  it('expands exactly one character after three collisions and logs System once', async () => {
    await insert('AAAAA');
    repeatedCandidate();
    expect(await allocateShareSlug(binding, insert)).toHaveLength(6);
    expect(await allocateShareSlug(binding, insert)).toHaveLength(6);
    expect(await getShareSlugConfig(binding)).toEqual({
      defaultLength: 5,
      automaticFloor: 6,
      effectiveLength: 6,
    });
    const logs = await database(binding).select().from(auditLog);
    expect(logs).toHaveLength(1);
    expect(logs[0].actorId).toBeNull();
    expect(logs[0].action).toBe('share_slug.expanded');
    expect(presentAudit(logs[0])).toMatchObject({
      actor: 'System',
      actorIp: null,
    });
    expect(JSON.parse(logs[0].metadata)).toMatchObject({
      changes: [{ field: 'allocationSlugLength', before: 5, after: 6 }],
      context: {
        reason: 'Three address collisions at the current allocation length',
      },
    });
    expect(
      await database(binding)
        .select()
        .from(aliases)
        .where(eq(aliases.slug, 'AAAAA')),
    ).toHaveLength(1);
  });

  it('bounds allocation to twelve candidates and three expansions', async () => {
    const collision = new Error(
      'D1_ERROR: UNIQUE constraint failed: aliases.deliveryDomainId, aliases.slug: SQLITE_CONSTRAINT',
    );
    const lengths: number[] = [];
    const commit = vi.fn((slug: string) => {
      lengths.push(slug.length);
      return Promise.reject(collision);
    });
    await expect(allocateShareSlug(binding, commit)).rejects.toMatchObject({
      status: 503,
      code: 'SHARE_LINK_UNAVAILABLE',
    });
    expect(commit).toHaveBeenCalledTimes(12);
    expect(lengths).toEqual([5, 5, 5, 6, 6, 6, 7, 7, 7, 8, 8, 8]);
    expect(await database(binding).select().from(auditLog)).toHaveLength(3);
  });

  it('bounds collisions at the maximum length without expanding', async () => {
    await setShareSlugDefault(binding, 64, admin, null);
    const commit = vi.fn(() =>
      Promise.reject(
        new Error(
          'UNIQUE constraint failed: aliases.deliveryDomainId, aliases.slug',
        ),
      ),
    );
    await expect(allocateShareSlug(binding, commit)).rejects.toMatchObject({
      status: 503,
    });
    expect(commit).toHaveBeenCalledTimes(12);
    expect((await getShareSlugConfig(binding)).effectiveLength).toBe(64);
    expect(
      (await database(binding).select().from(auditLog)).map(
        (event) => event.action,
      ),
    ).toEqual(['settings.share_slug_length']);
  });

  it.each([
    'UNIQUE constraint failed: aliases.id',
    'UNIQUE constraint failed: aliases.imageId',
    'FOREIGN KEY constraint failed',
    'quota_exceeded',
    'network connection lost',
  ])('does not retry unrelated database failures: %s', async (message) => {
    const error = new Error(message);
    const commit = vi.fn(() => Promise.reject(error));
    await expect(allocateShareSlug(binding, commit)).rejects.toBe(error);
    expect(commit).toHaveBeenCalledTimes(1);
    expect((await getShareSlugConfig(binding)).automaticFloor).toBe(3);
  });

  it('recognizes only the address constraint inside wrapped causes', () => {
    expect(
      isShareSlugCollision(
        new Error('Drizzle query failed', {
          cause: new Error(
            'D1_ERROR: UNIQUE constraint failed: aliases.deliveryDomainId, aliases.slug: SQLITE_CONSTRAINT',
          ),
        }),
      ),
    ).toBe(true);
    expect(
      isShareSlugCollision(
        new Error(
          'UNIQUE constraint failed: aliases.deliveryDomainId, aliases.slugExtra',
        ),
      ),
    ).toBe(false);
    expect(
      isShareSlugCollision(
        'UNIQUE constraint failed: aliases.deliveryDomainId, aliases.slug',
      ),
    ).toBe(false);
  });

  it('allocates concurrently and makes simultaneous 5 → 6 expansion idempotent', async () => {
    await insert('AAAAA');
    repeatedCandidate();
    const count = 12;
    let arrivals = 0;
    let release!: () => void;
    // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- ES2022 target.
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const results = await Promise.all(
      Array.from({ length: count }, () => {
        let collisions = 0;
        return allocateShareSlug(binding, async (slug) => {
          try {
            return await insert(slug);
          } catch (error) {
            if (isShareSlugCollision(error) && ++collisions === 3) {
              if (++arrivals === count) release();
              await ready;
            }
            throw error;
          }
        });
      }),
    );
    expect(arrivals).toBe(count);
    expect(new Set(results).size).toBe(count);
    expect(results.every((slug) => slug.length === 6)).toBe(true);
    expect((await getShareSlugConfig(binding)).effectiveLength).toBe(6);
    expect(await database(binding).select().from(auditLog)).toHaveLength(1);
  });

  it('rolls expansion back when audit insertion fails', async () => {
    await binding
      .prepare(
        "CREATE TRIGGER reject_slug_expansion BEFORE INSERT ON audit_log WHEN NEW.action='share_slug.expanded' BEGIN SELECT RAISE(ABORT,'audit_failed'); END",
      )
      .run();
    await insert('AAAAA');
    repeatedCandidate();
    await expect(allocateShareSlug(binding, insert)).rejects.toMatchObject({
      status: 503,
    });
    expect((await getShareSlugConfig(binding)).automaticFloor).toBe(3);
    expect(await database(binding).select().from(auditLog)).toEqual([]);
  });

  it('recovers a committed expansion after a lost batch response', async () => {
    await insert('AAAAA');
    repeatedCandidate();
    const faulty: D1Database = {
      prepare: binding.prepare.bind(binding),
      exec: binding.exec.bind(binding),
      dump: binding.dump.bind(binding),
      withSession: binding.withSession.bind(binding),
      async batch<T>(
        statements: D1PreparedStatement[],
      ): Promise<D1Result<T>[]> {
        await binding.batch<T>(statements);
        throw new Error('Lost response after commit');
      },
    };
    expect(await allocateShareSlug(faulty, insert)).toHaveLength(6);
    expect((await getShareSlugConfig(binding)).effectiveLength).toBe(6);
    expect(await database(binding).select().from(auditLog)).toHaveLength(1);
  });

  it.each([
    null,
    '{}',
    '{',
    '{"defaultLength":2,"automaticFloor":3}',
    '{"defaultLength":5,"automaticFloor":65}',
    '{"defaultLength":5.5,"automaticFloor":3}',
  ])('fails closed for invalid config: %s', async (value) => {
    if (value === null)
      await binding
        .prepare('DELETE FROM app_settings WHERE key=?')
        .bind('shareSlugConfiguration')
        .run();
    else
      await binding
        .prepare('UPDATE app_settings SET value=? WHERE key=?')
        .bind(value, 'shareSlugConfiguration')
        .run();
    const commit = vi.fn(insert);
    await expect(allocateShareSlug(binding, commit)).rejects.toMatchObject({
      status: 503,
    });
    expect(commit).not.toHaveBeenCalled();
    if (value === null)
      await binding
        .prepare('INSERT INTO app_settings VALUES (?,?)')
        .bind(
          'shareSlugConfiguration',
          '{"defaultLength":5,"automaticFloor":3}',
        )
        .run();
  });
});

describe('administration and upgrades', () => {
  it('rolls an admin change back if its audit event cannot be inserted', async () => {
    await binding
      .prepare(
        "CREATE TRIGGER reject_slug_expansion BEFORE INSERT ON audit_log WHEN NEW.action='settings.share_slug_length' BEGIN SELECT RAISE(ABORT,'audit_failed'); END",
      )
      .run();
    await expect(setShareSlugDefault(binding, 8, admin, null)).rejects.toThrow(
      'audit_failed',
    );
    expect((await getShareSlugConfig(binding)).defaultLength).toBe(5);
    expect(await database(binding).select().from(auditLog)).toEqual([]);
  });

  it('records the actual previous default under simultaneous administrator changes', async () => {
    await Promise.all(
      [8, 9, 10].map((length) =>
        setShareSlugDefault(binding, length, admin, null),
      ),
    );
    const logs = await binding
      .prepare(
        "SELECT metadata FROM audit_log WHERE action='settings.share_slug_length' ORDER BY rowid",
      )
      .all<{ metadata: string }>();
    expect(logs.results).toHaveLength(3);
    let previous = 5;
    for (const log of logs.results) {
      const metadata = JSON.parse(log.metadata) as {
        changes: { before: number; after: number }[];
      };
      expect(metadata.changes[0].before).toBe(previous);
      previous = metadata.changes[0].after;
    }
    expect((await getShareSlugConfig(binding)).defaultLength).toBe(previous);
  });
  it.each([2, 65, 4.5, '5', null])(
    'rejects invalid admin length: %s',
    async (value) => {
      await expect(
        setShareSlugDefault(binding, value, admin, null),
      ).rejects.toThrow();
      expect(await database(binding).select().from(auditLog)).toEqual([]);
    },
  );

  it('requires an administrator', async () => {
    await expect(
      setShareSlugDefault(binding, 8, { ...admin, role: 'user' }, null),
    ).rejects.toMatchObject({ status: 403 });
  });

  it('supports increases, decreases, and unchanged saves while preserving the automatic floor', async () => {
    await insert('AAAAA');
    repeatedCandidate();
    await allocateShareSlug(binding, insert);
    expect(
      (await setShareSlugDefault(binding, 8, admin, '203.0.113.42'))
        .effectiveLength,
    ).toBe(8);
    expect(await allocateShareSlug(binding, insert)).toHaveLength(8);
    expect(
      (await setShareSlugDefault(binding, 5, admin, null)).effectiveLength,
    ).toBe(6);
    await setShareSlugDefault(binding, 5, admin, null);
    const logs = await database(binding).select().from(auditLog);
    expect(logs).toHaveLength(3);
    const changed = logs.find(
      (event) => event.action === 'settings.share_slug_length',
    )!;
    expect(changed.actorId).toBe(admin.id);
    expect(presentAudit(changed).actorIp).toBe('203.0.113.42');
    expect(JSON.parse(changed.metadata)).toMatchObject({
      changes: [{ field: 'defaultSlugLength', before: 5, after: 8 }],
    });
  });

  it('does not keep manual increases as an automatic floor', async () => {
    await setShareSlugDefault(binding, 8, admin, null);
    await setShareSlugDefault(binding, 5, admin, null);
    expect(await allocateShareSlug(binding, insert)).toHaveLength(5);
    expect((await getShareSlugConfig(binding)).automaticFloor).toBe(3);
  });

  it('preserves an admin increase racing with namespace expansion', async () => {
    await insert('AAAAA');
    repeatedCandidate();
    let collisions = 0;
    const slug = await allocateShareSlug(binding, async (candidate) => {
      try {
        return await insert(candidate);
      } catch (error) {
        if (++collisions === 3)
          await setShareSlugDefault(binding, 8, admin, null);
        throw error;
      }
    });
    expect(slug).toHaveLength(8);
    expect(await getShareSlugConfig(binding)).toEqual({
      defaultLength: 8,
      automaticFloor: 3,
      effectiveLength: 8,
    });
    expect(
      (await database(binding).select().from(auditLog)).map(
        (event) => event.action,
      ),
    ).toEqual(['settings.share_slug_length']);
  });
});
