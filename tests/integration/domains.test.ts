/* eslint-disable unicorn/no-await-expression-member, @typescript-eslint/require-await -- Response assertions and asynchronous fetch fixtures. */
import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createUser } from '../../packages/core/auth';
import { id, now } from '../../packages/core/common';
import { database, type User } from '../../packages/core/db';
import {
  availableDeliveryDomains,
  changeDeliveryAvailability,
  deliveryDomainPage,
  domainDetails,
  domainMembers,
  primaryDeliveryDomain,
  saveDeliveryDomain,
  selectDeliveryDomain,
  setDeliveryPreference,
  setPrimaryDeliveryDomain,
} from '../../packages/core/delivery-domains';
import {
  DELIVERY_PROBE_KEY,
  DELIVERY_PROBE_PATH,
} from '../../packages/core/delivery-probe';
import {
  isCloudflareAddress,
  validateDeliveryDomain,
} from '../../packages/core/domain-validation';
import { createLink } from '../../packages/core/links';
import { type PublicUrlEnvironment } from '../../packages/core/public-urls';
import { images, users } from '../../packages/core/schema';
import { migrateDatabase } from '../helpers/database';
import { workerBundle, workerCompatibility } from '../helpers/workers';

let mf: Miniflare, binding: D1Database, admin: User, member: User, other: User;
let environment: PublicUrlEnvironment & { DB: D1Database; BUCKET: R2Bucket };
beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: workerBundle('delivery'),
      ...workerCompatibility('delivery'),
      bindings: {
        ENVIRONMENT: 'production',
        APP_ORIGIN: 'https://app.example.com',
      },
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
  await migrateDatabase(binding);
  environment = {
    DB: binding,
    // @ts-expect-error Miniflare R2 proxies use Undici Headers types.
    BUCKET: await mf.getR2Bucket('BUCKET'),
    APP_ORIGIN: 'https://app.example.com',
    ENVIRONMENT: 'production',
  };
  const people = await Promise.all([
    createUser(binding, 'Administrator', 'admin', null),
    createUser(binding, 'Member', 'user', null),
    createUser(binding, 'Other', 'user', null),
  ]);
  [admin, member, other] = await Promise.all(
    people.map(
      async (person) =>
        (
          await database(binding)
            .select()
            .from(users)
            .where(eq(users.id, person.userId))
        )[0],
    ),
  );
}, 30_000);
afterEach(() => vi.unstubAllGlobals());
afterEach(async () => {
  await mf?.dispose();
});

async function add(
  hostname = 'images.example.com',
  accessMode: 'everyone' | 'administrators' | 'selected' = 'everyone',
) {
  return saveDeliveryDomain(
    binding,
    admin,
    { hostname, accessMode },
    environment,
  );
}
async function active(
  hostname = 'images.example.com',
  accessMode: 'everyone' | 'administrators' | 'selected' = 'everyone',
) {
  const domain = await add(hostname, accessMode);
  await binding
    .prepare(
      "UPDATE delivery_domains SET health='active',lastHealthyAt=? WHERE id=?",
    )
    .bind(now(), domain.id)
    .run();
  return domainDetails(binding, admin, domain.id);
}
async function image(owner = member) {
  const imageId = id('img');
  await database(binding).insert(images).values({
    id: imageId,
    userId: owner.id,
    objectKey: imageId,
    filename: 'domain-test.png',
    mime: 'image/png',
    extension: 'png',
    size: 5,
    sha256: 'test',
    width: 1,
    height: 1,
    createdAt: now(),
  });
  await environment.BUCKET.put(imageId, 'bytes');
  return imageId;
}
function healthyNetwork() {
  const calls = vi.fn(
    async (input: string | URL | Request, options?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'cloudflare-dns.com')
        return Response.json({
          Status: 0,
          Answer: [{ type: 1, data: '104.16.0.1' }],
        });
      const response = await mf.dispatchFetch(url, {
        headers: options?.headers
          ? Object.fromEntries(new Headers(options.headers))
          : undefined,
      });
      return response as unknown as Response;
    },
  );
  vi.stubGlobal('fetch', calls);
  return calls;
}

describe('delivery selection and permissions', () => {
  it('never selects an unchosen domain or substitutes for an unhealthy primary', async () => {
    expect((await selectDeliveryDomain(binding, member.id)).domain).toBeNull();
    const first = await active();
    expect((await selectDeliveryDomain(binding, member.id)).domain).toBeNull();
    expect(await primaryDeliveryDomain(binding)).toBeNull();
    await active('secondary.example.com');
    await setPrimaryDeliveryDomain(binding, admin, first.id, first.revision);
    await binding
      .prepare("UPDATE delivery_domains SET health='unhealthy' WHERE id=?")
      .bind(first.id)
      .run();
    expect((await selectDeliveryDomain(binding, member.id)).domain).toBeNull();
    expect((await primaryDeliveryDomain(binding))?.id).toBe(first.id);
  });
  it('does not clear or bypass an unavailable personal preference', async () => {
    const first = await active(),
      second = await active('secondary.example.com');
    await setPrimaryDeliveryDomain(binding, admin, second.id, second.revision);
    await setDeliveryPreference(binding, member, first.id);
    await binding
      .prepare(
        "UPDATE delivery_domains SET accessMode='administrators' WHERE id=?",
      )
      .bind(first.id)
      .run();
    expect((await selectDeliveryDomain(binding, member.id)).domain).toBeNull();
    expect(
      (
        await binding
          .prepare(
            'SELECT preferredDeliveryDomainId AS id FROM users WHERE id=?',
          )
          .bind(member.id)
          .first()
      )?.id,
    ).toBe(first.id);
  });
  it('enforces all three access policies against the image owner, including admin-created links', async () => {
    const everyone = await active(),
      restricted = await active('restricted.example.com', 'selected'),
      admins = await active('admins.example.com', 'administrators');
    await saveDeliveryDomain(
      binding,
      admin,
      { ...restricted, addMembers: [member.id] },
      environment,
    );
    expect(
      (await availableDeliveryDomains(binding, member.id)).map(
        (domain) => domain.id,
      ),
    ).toEqual(expect.arrayContaining([everyone.id, restricted.id]));
    expect(
      (await availableDeliveryDomains(binding, other.id)).map(
        (domain) => domain.id,
      ),
    ).toEqual([everyone.id]);
    expect(await availableDeliveryDomains(binding, admin.id)).toHaveLength(3);
    await expect(
      createLink(binding, admin, {
        imageId: await image(other),
        deliveryDomainId: admins.id,
        expiry: 'never',
      }),
    ).rejects.toMatchObject({ code: 'DELIVERY_UNAVAILABLE' });
  });
  it('rejects pending, unhealthy, disabled, and unauthorized primary changes', async () => {
    const pending = await add();
    await expect(
      setPrimaryDeliveryDomain(binding, admin, pending.id, pending.revision),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      setPrimaryDeliveryDomain(binding, member, pending.id, pending.revision),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      saveDeliveryDomain(
        binding,
        member,
        { hostname: 'other.example.com', accessMode: 'everyone' },
        environment,
      ),
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      validateDeliveryDomain(environment, member, pending.id),
    ).rejects.toMatchObject({ status: 403 });
    await binding
      .prepare(
        "UPDATE delivery_domains SET health='active',enabled=0 WHERE id=?",
      )
      .bind(pending.id)
      .run();
    await expect(
      setPrimaryDeliveryDomain(binding, admin, pending.id, 0),
    ).rejects.toMatchObject({ status: 409 });
  });
  it('prevents stale edits and leaves only one primary under competing changes', async () => {
    const first = await active(),
      second = await active('second.example.com');
    await saveDeliveryDomain(
      binding,
      admin,
      { ...first, notes: 'Changed' },
      environment,
    );
    await expect(
      saveDeliveryDomain(
        binding,
        admin,
        { ...first, notes: 'Stale' },
        environment,
      ),
    ).rejects.toMatchObject({ code: 'DOMAIN_CHANGED' });
    await Promise.allSettled([
      setPrimaryDeliveryDomain(binding, admin, first.id, 1),
      setPrimaryDeliveryDomain(binding, admin, second.id, 0),
    ]);
    expect(
      (
        await binding
          .prepare(
            'SELECT count(*) AS count FROM delivery_domains WHERE isPrimary=1',
          )
          .first()
      )?.count,
    ).toBe(1);
  });
});

describe('removal and collection behavior', () => {
  it('requires a primary replacement or explicit clearing and revokes links without deleting images', async () => {
    const first = await active(),
      second = await active('replacement.example.com'),
      imageId = await image();
    await setPrimaryDeliveryDomain(binding, admin, first.id, 0);
    await setDeliveryPreference(binding, member, first.id);
    await createLink(binding, member, {
      imageId,
      deliveryDomainId: first.id,
      expiry: 'never',
    });
    const details = await domainDetails(binding, admin, first.id);
    const input = {
      id: first.id,
      revision: details.revision,
      enabled: false,
      remove: true,
      expectedLinkCount: details.linkCount,
      replacementId: null,
      clearPrimary: false,
    };
    await expect(
      changeDeliveryAvailability(binding, admin, input),
    ).rejects.toMatchObject({ code: 'PRIMARY_REPLACEMENT_REQUIRED' });
    await changeDeliveryAvailability(binding, admin, {
      ...input,
      replacementId: second.id,
    });
    expect((await primaryDeliveryDomain(binding))?.id).toBe(second.id);
    expect((await selectDeliveryDomain(binding, member.id)).domain?.id).toBe(
      second.id,
    );
    expect(
      (
        await binding
          .prepare(
            'SELECT count(*) AS count FROM aliases WHERE deliveryDomainId=?',
          )
          .bind(first.id)
          .first()
      )?.count,
    ).toBe(0);
    expect(
      (
        await binding
          .prepare('SELECT deletedAt FROM images WHERE id=?')
          .bind(imageId)
          .first()
      )?.deletedAt,
    ).toBeNull();
  });
  it('rejects destructive confirmations if links were added after review', async () => {
    const domain = await active();
    await createLink(binding, member, {
      imageId: await image(),
      deliveryDomainId: domain.id,
      expiry: 'never',
    });
    await expect(
      changeDeliveryAvailability(binding, admin, {
        id: domain.id,
        revision: 0,
        enabled: false,
        remove: true,
        expectedLinkCount: 0,
        replacementId: null,
        clearPrimary: false,
      }),
    ).rejects.toMatchObject({ code: 'DOMAIN_CHANGED' });
    expect((await domainDetails(binding, admin, domain.id)).linkCount).toBe(1);
  });
  it('retains member grants outside the edited page and does not expose private validation material', async () => {
    const domain = await active('selected.example.com', 'selected');
    await saveDeliveryDomain(
      binding,
      admin,
      { ...domain, addMembers: [member.id] },
      environment,
    );
    const details = await domainDetails(binding, admin, domain.id);
    await saveDeliveryDomain(
      binding,
      admin,
      { ...details, addMembers: [other.id] },
      environment,
    );
    expect(await availableDeliveryDomains(binding, member.id)).toHaveLength(1);
    expect(await availableDeliveryDomains(binding, other.id)).toHaveLength(1);
    const page = await domainMembers(
      binding,
      admin,
      domain.id,
      new URLSearchParams({ q: 'Member' }),
    );
    expect(
      page.members.some((person) => person.id === member.id && person.granted),
    ).toBe(true);
    const publicData = JSON.stringify([
      await domainDetails(binding, admin, domain.id),
      await deliveryDomainPage(binding, admin, new URLSearchParams()),
      await availableDeliveryDomains(binding, member.id),
    ]);
    expect(publicData).not.toMatch(/validationKey|mutationId|checkId/);
  });
});

describe('validation and safe public URLs', () => {
  it('rejects application and private hostnames before any network operation', async () => {
    const fetch = vi.fn();
    vi.stubGlobal('fetch', fetch);
    for (const hostname of [
      'app.example.com',
      'images.localhost',
      'images.internal',
    ])
      await expect(add(hostname)).rejects.toMatchObject({ status: 400 });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('uses fixed loopback transport only for local development checks', async () => {
    environment.ENVIRONMENT = 'development';
    const domain = await add('shots.localhost');
    const network = healthyNetwork();
    // The development transport carries the signed hostname separately because DNS may not resolve .localhost.
    network.mockImplementation(
      async (input: string | URL | Request, options?: RequestInit) => {
        const endpoint = new URL(
          input instanceof Request ? input.url : String(input),
        );
        expect(endpoint.hostname).toBe('127.0.0.1');
        expect(endpoint.port).toBe('8788');
        const headers = new Headers(options?.headers);
        expect(headers.get('X-Hearth-Local-Hostname')).toBe('shots.localhost');
        // The production Worker must ignore the development routing hint.
        expect(
          (
            await mf.dispatchFetch(endpoint.href, {
              headers: Object.fromEntries(headers),
            })
          ).status,
        ).toBe(404);
        endpoint.hostname = headers.get('X-Hearth-Local-Hostname')!;
        return (await mf.dispatchFetch(endpoint.href, {
          headers: Object.fromEntries(headers),
        })) as unknown as Response;
      },
    );
    try {
      const checked = await validateDeliveryDomain(
        environment,
        admin,
        domain.id,
      );
      expect(checked.health).toBe('active');
      expect(checked.diagnostics?.message).toContain(
        'Production DNS and TLS were not checked',
      );
      expect(network).toHaveBeenCalledOnce();
    } finally {
      environment.ENVIRONMENT = 'production';
    }
  });
  it('validates the real delivery Worker and its R2 read without leaking its signing key', async () => {
    const domain = await add();
    const fetch = healthyNetwork();
    const checked = await validateDeliveryDomain(environment, admin, domain.id);
    expect(checked.health).toBe('active');
    expect(checked.lastHealthyAt).not.toBeNull();
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(
      (await environment.BUCKET.list({ prefix: DELIVERY_PROBE_KEY })).objects,
    ).toEqual([]);
    expect(
      (
        await mf.dispatchFetch(
          `https://images.example.com${DELIVERY_PROBE_PATH}`,
        )
      ).status,
    ).toBe(404);
    fetch.mockClear();
    await deliveryDomainPage(binding, admin, new URLSearchParams());
    expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects private or non-Cloudflare DNS answers without contacting the hostname', async () => {
    const domain = await add();
    const fetch = vi.fn(async () =>
      Response.json({
        Status: 0,
        Answer: [
          { type: 1, data: '127.0.0.1' },
          { type: 1, data: '104.16.0.1' },
        ],
      }),
    );
    vi.stubGlobal('fetch', fetch);
    expect(
      (await validateDeliveryDomain(environment, admin, domain.id)).health,
    ).toBe('misconfigured');
    expect(fetch).toHaveBeenCalledTimes(2);
    for (const address of [
      '127.0.0.1',
      '10.0.0.1',
      '169.254.169.254',
      '::1',
      'fe80::1',
      'fc00::1',
      '8.8.8.8',
      '2606:4700:invalid',
    ])
      expect(isCloudflareAddress(address)).toBe(false);
    expect(isCloudflareAddress('2606:4700::1111')).toBe(true);
  });
  it('marks a previously healthy domain unhealthy and rejects redirects or a different instance proof', async () => {
    const domain = await add();
    healthyNetwork();
    await validateDeliveryDomain(environment, admin, domain.id);
    const fetch = vi.fn(async (input: string | URL) =>
      String(input).startsWith('https://cloudflare-dns.com')
        ? Response.json({
            Status: 0,
            Answer: [{ type: 1, data: '104.16.0.1' }],
          })
        : new Response(null, {
            status: 302,
            headers: { Location: 'http://127.0.0.1/' },
          }),
    );
    vi.stubGlobal('fetch', fetch);
    let checked = await validateDeliveryDomain(environment, admin, domain.id);
    expect(checked.health).toBe('unhealthy');
    expect(checked.diagnostics?.message).toContain('redirects');
    fetch.mockImplementation(async (input) =>
      Response.json(
        String(input).startsWith('https://cloudflare-dns.com')
          ? {
              Status: 0,
              Answer: [{ type: 1, data: '104.16.0.1' }],
            }
          : {
              domainId: domain.id,
              nonce: 'wrong',
              hash: 'wrong',
              proof: '0'.repeat(64),
            },
      ),
    );
    checked = await validateDeliveryDomain(environment, admin, domain.id);
    expect(checked.health).toBe('unhealthy');
    expect(checked.diagnostics?.message).toContain(
      'does not serve this Hearth instance',
    );
  });
  it('keeps previous health on resolver outages and prevents an older check overwriting a newer result', async () => {
    const domain = await active();
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.reject(new Error('DNS outage'))),
    );
    const checked = await validateDeliveryDomain(environment, admin, domain.id);
    expect(checked.health).toBe('active');
    expect(checked.diagnostics?.outcome).toBe('inconclusive');
    let resolve!: () => void;
    const blocked = new Promise<void>((done) => (resolve = done));
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        await blocked;
        return Response.json({ Status: 3 });
      }),
    );
    // eslint-disable-next-line unicorn/prefer-await -- Attach rejection handling before releasing the concurrent check.
    const older = validateDeliveryDomain(environment, admin, domain.id).catch(
      (error: unknown) => error,
    );
    await vi.waitFor(async () =>
      expect(
        (
          await binding
            .prepare('SELECT checkId FROM delivery_domains WHERE id=?')
            .bind(domain.id)
            .first()
        )?.checkId,
      ).not.toBeNull(),
    );
    healthyNetwork();
    await validateDeliveryDomain(environment, admin, domain.id);
    resolve();
    expect(await older).toMatchObject({ code: 'CHECK_SUPERSEDED' });
    expect((await domainDetails(binding, admin, domain.id)).health).toBe(
      'active',
    );
  });
});
