import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  DELIVERY_PROBE_CONTENT,
  DELIVERY_PROBE_PATH,
  deliveryProbeKey,
  probeSignature,
} from '../../packages/core/delivery-probe';
import {
  type DeliveryEnvironment,
  resolvePublicShare,
} from '../../packages/core/public-share';
import { migrateDatabase } from '../helpers/database';
import { workerBundle, workerCompatibility } from '../helpers/workers';

let mf: Miniflare;
let DB: D1Database;
let bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
const host = 'shots.example.com';
const signingKey = 'test-only-delivery-signing-key';
let sequence = 0;

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
  DB = await mf.getD1Database('DB');
  bucket = await mf.getR2Bucket('BUCKET');
  await migrateDatabase(DB);
  await DB.prepare(
    "INSERT INTO users(id,displayName,createdAt,updatedAt) VALUES ('adversarial-owner','Owner',1,1)",
  ).run();
  await DB.prepare(
    "INSERT INTO delivery_domains(id,hostname,validationKey,health,createdAt,updatedAt) VALUES (?,?,?,'active',1,1)",
  )
    .bind('adversarial-host', host, signingKey)
    .run();
  await bucket.put(deliveryProbeKey('a'.repeat(32)), DELIVERY_PROBE_CONTENT);
});

afterEach(async () => {
  await mf?.dispose();
});

async function resource() {
  const slug = `Adversarial${++sequence}`;
  await DB.prepare(
    `INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt)
     VALUES (?,'adversarial-owner',?,'image.png','image/png','png',5,'sha',1,1,1)`,
  )
    .bind(slug, slug)
    .run();
  await DB.prepare(
    "INSERT INTO aliases(id,imageId,deliveryDomainId,slug,createdAt) VALUES (?,?,'adversarial-host',?,1)",
  )
    .bind(slug, slug, slug)
    .run();
  await bucket.put(slug, 'bytes');
  return slug;
}

function get(
  path: string,
  options: Pick<RequestInit, 'method' | 'headers'> = {},
  ip = '192.0.2.90',
) {
  return mf.dispatchFetch(
    path.startsWith('https:') ? path : `https://${host}${path}`,
    {
      ...options,
      headers: {
        'CF-Connecting-IP': ip,
        ...Object.fromEntries(new Headers(options.headers)),
      },
    },
  );
}

describe('adversarial delivery in the actual Worker runtime', () => {
  it('applies URL normalization without decoding slugs or trusting forwarding hosts', async () => {
    const slug = await resource();
    const rejected = [
      `/%41${slug.slice(1)}`,
      `/${slug}%00`,
      `/${slug}%2f`,
      `/${slug}%5c`,
      `/%252e%252e/${slug}`,
      `//${slug}`,
      `/${slug}/`,
      `/s/${slug}`,
      `/${slug.toLowerCase()}`,
      `/${slug}\u{200B}`,
      `/\u{FF21}${slug.slice(1)}`,
      '/ab',
      `/${'a'.repeat(65)}`,
      `https://${host}./${slug}`,
      `https://evil.example/${slug}`,
      `https://${host}.evil.example/${slug}`,
    ];
    for (const path of rejected) {
      const response = await get(path, {
        headers: {
          'X-Forwarded-Host': host,
          'X-Hearth-Local-Hostname': host,
          Range: 'bytes=0-1',
        },
      });
      expect(response.status).toBe(404);
      expect(await response.text()).toBe('Not found');
    }
    for (const path of [
      `/discard/../${slug}`,
      `/discard/%2e%2e/${slug}`,
      `https://SHOTS.EXAMPLE.COM/${slug}`,
      `/${slug}?slug=missing&slug=${slug}&download=0&download=1`,
    ]) {
      const response = await get(path);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('bytes');
    }
    for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']) {
      const response = await get(`/${slug}`, { method });
      expect(response.status).toBe(405);
      expect(response.headers.get('Allow')).toBe('GET, HEAD');
    }
  });

  it('cannot resurrect a revoked link with simultaneous ranges and conditional requests', async () => {
    const slug = await resource();
    const original = await get(`/${slug}`);
    const etag = original.headers.get('ETag')!;
    expect(await original.text()).toBe('bytes');
    await DB.prepare('UPDATE aliases SET disabledAt=1 WHERE id=?')
      .bind(slug)
      .run();
    const conditions: Record<string, string>[] = [
      { Range: 'bytes=0-1' },
      { 'If-None-Match': etag },
      { 'If-Match': etag, Range: 'bytes=1-3' },
      { 'If-Modified-Since': new Date().toUTCString() },
    ];
    const attempts = await Promise.all(
      ['GET', 'HEAD'].flatMap((method) =>
        conditions.map((headers) =>
          get(`/${slug}?preview&download`, { method, headers }),
        ),
      ),
    );
    for (const response of attempts) {
      expect(response.status).toBe(404);
      expect(response.headers.get('ETag')).toBeNull();
      expect(response.headers.get('Content-Range')).toBeNull();
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
      expect(['', 'Not found']).toContain(await response.text());
    }
    expect(await bucket.head(slug)).not.toBeNull();
  });

  it('binds domain proofs to host, nonce, deadline and instance across real HTTP', async () => {
    const nonce = 'a'.repeat(32);
    const until = String(Math.floor(Date.now() / 1000) + 30);
    const signature = probeSignature(
      signingKey,
      'request',
      'adversarial-host',
      host,
      nonce,
      until,
    );
    const parameters = new URLSearchParams({ nonce, until, signature });
    const valid = await get(`${DELIVERY_PROBE_PATH}?${parameters}`);
    expect(valid.status).toBe(200);
    const proof = (await valid.json()) as {
      domainId: string;
      nonce: string;
      hash: string;
      proof: string;
    };
    expect(proof.domainId).toBe('adversarial-host');
    expect(proof.nonce).toBe(nonce);
    expect(proof.proof).toBe(
      probeSignature(
        signingKey,
        'response',
        'adversarial-host',
        host,
        nonce,
        until,
        proof.hash,
      ),
    );
    const tampered = [
      new URLSearchParams({ nonce: 'b'.repeat(32), until, signature }),
      new URLSearchParams({
        nonce,
        until: String(Number(until) + 1),
        signature,
      }),
      new URLSearchParams({ nonce, until, signature: '0'.repeat(64) }),
      new URLSearchParams({ nonce, until, signature: signature.toUpperCase() }),
      new URLSearchParams({ nonce, until: '1', signature }),
      new URLSearchParams({
        nonce,
        until: String(Number(until) + 120),
        signature,
      }),
      new URLSearchParams(`nonce=bad&${parameters}`),
      new URLSearchParams(`signature=bad&${parameters}`),
    ];
    for (const query of tampered)
      await expect(
        get(`${DELIVERY_PROBE_PATH}?${query}`),
      ).resolves.toHaveProperty('status', 404);
    await expect(
      get(`https://evil.example${DELIVERY_PROBE_PATH}?${parameters}`, {
        headers: { 'X-Hearth-Local-Hostname': host },
      }),
    ).resolves.toHaveProperty('status', 404);
    await expect(
      get(`${DELIVERY_PROBE_PATH}?${parameters}`, { method: 'HEAD' }),
    ).resolves.toHaveProperty('status', 404);
    await bucket.delete(deliveryProbeKey(nonce));
    await expect(
      get(`${DELIVERY_PROBE_PATH}?${parameters}`),
    ).resolves.toHaveProperty('status', 503);
    await expect(get(DELIVERY_PROBE_PATH)).resolves.toHaveProperty(
      'status',
      404,
    );
  });

  it('does not consult failed storage for protected, revoked or unknown shares', async () => {
    const slug = await resource();
    const storage = vi.fn(() => Promise.reject(new Error('Injected outage')));
    const env = {
      DB,
      ENVIRONMENT: 'development',
      APP_ORIGIN: 'https://app.example.com',
      BUCKET: { get: storage },
    } as unknown as DeliveryEnvironment;
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const visible = await resolvePublicShare(
        new Request(`https://${host}/${slug}`),
        env,
      );
      expect(visible.status).toBe(503);
      expect(await visible.text()).toBe('Temporarily unavailable');
      storage.mockClear();
      await DB.prepare('UPDATE aliases SET disabledAt=1 WHERE id=?')
        .bind(slug)
        .run();
      for (const path of [`/${slug}`, '/unknown', `/${slug}?download`]) {
        const response = await resolvePublicShare(
          new Request(`https://${host}${path}`, {
            headers: { Range: 'bytes=0-1', 'If-None-Match': '"etag"' },
          }),
          env,
        );
        expect(response.status).toBe(404);
        expect(await response.text()).toBe('Not found');
      }
      expect(storage).not.toHaveBeenCalled();
      expect(errorLog).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({ event: 'delivery.unavailable' }),
      );
    } finally {
      errorLog.mockRestore();
    }
  });
});
