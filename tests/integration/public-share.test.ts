import { readFile } from 'node:fs/promises';

import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { migrateDatabase } from '../helpers/database';
import { workerBundle, workerCompatibility } from '../helpers/workers';

let mf: Miniflare;
let binding: D1Database;
let bucket: Awaited<ReturnType<Miniflare['getR2Bucket']>>;
const productionIp = '203.0.113.10';
let failureBudget: { limit: number; period: 60 };

beforeEach(async () => {
  const configSource = await readFile(
    'workers/delivery/wrangler.jsonc',
    'utf8',
  );
  const config = ts.parseConfigFileTextToJson('wrangler.jsonc', configSource)
    .config as {
    compatibility_date: string;
    ratelimits: {
      name: string;
      namespace_id: string;
      simple: { limit: number; period: 60 };
    }[];
  };
  failureBudget = config.ratelimits.find(
    ({ name }) => name === 'SHARE_FAILURE_LIMIT',
  )!.simple;
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: workerBundle('delivery'),
      ...workerCompatibility('delivery'),
      bindings: {
        APP_ORIGIN: 'https://app.example.com',
        ENVIRONMENT: 'production',
      },
      d1Databases: ['DB'],
      r2Buckets: ['BUCKET'],
      ratelimits: Object.fromEntries(
        config.ratelimits.map(({ name, ...limit }) => [name, limit]),
      ),
    }),
  );
  binding = await mf.getD1Database('DB');
  bucket = await mf.getR2Bucket('BUCKET');
  await migrateDatabase(binding);
  await binding
    .prepare(
      "INSERT INTO users(id,displayName,createdAt,updatedAt) VALUES ('owner','Owner',1,1)",
    )
    .run();
  await binding
    .prepare(
      "INSERT INTO delivery_domains(id,hostname,health,createdAt,updatedAt) VALUES ('host','shots.example.com','active',1,1),('other','other.example.com','active',1,1)",
    )
    .run();
  await binding
    .prepare(
      `INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt)
    VALUES ('image','owner','original','image.png','image/png','png',5,'sha',1,1,1)`,
    )
    .run();
  await bucket.put('original', 'bytes');
  for (const [host, slug] of [
    ['host', 'aB3xQ'],
    ['other', 'aB3xQ'],
    ['host', 'old'],
    ['host', '0123456789abcdef01234567'],
  ])
    await binding
      .prepare(
        "INSERT INTO aliases(id,imageId,deliveryDomainId,slug,createdAt) VALUES (?,'image',?,?,1)",
      )
      .bind(`${host}-${slug}`, host, slug)
      .run();
}, 30_000);

afterEach(async () => {
  await mf?.dispose();
});

function get(
  path = '/aB3xQ',
  options: Pick<RequestInit, 'method' | 'headers'> = {},
  ip = productionIp,
) {
  return mf.dispatchFetch(
    path.startsWith('https://') ? path : `https://shots.example.com${path}`,
    {
      ...options,
      headers: {
        'CF-Connecting-IP': ip,
        ...Object.fromEntries(new Headers(options.headers)),
      },
    },
  );
}

describe('public share delivery with real native bindings, D1 and R2', () => {
  it('serves previews, downloads, HEAD and existing slug lengths', async () => {
    for (let index = 0; index < 6; index++) {
      const response = await get(
        index % 2 ? '/aB3xQ?download' : '/aB3xQ?preview',
        {
          method: index % 3 ? 'GET' : 'HEAD',
          headers: { 'User-Agent': 'Discordbot' },
        },
      );
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(index % 3 ? 'bytes' : '');
      expect(response.headers.get('Content-Disposition')).toContain(
        index % 2 ? 'attachment' : 'inline',
      );
    }
    for (const slug of ['old', '0123456789abcdef01234567']) {
      const response = await get(`/${slug}`);
      expect(response.status).toBe(200);
      expect(await response.text()).toBe('bytes');
    }
    await expect(get('/ab3xq')).resolves.toHaveProperty('status', 404);
  });

  it('preserves conditional requests, HEAD headers and byte ranges', async () => {
    const full = await get();
    const etag = full.headers.get('ETag')!;
    const head = await get('/aB3xQ', { method: 'HEAD' });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe('');
    for (const header of [
      'ETag',
      'Cache-Control',
      'Content-Type',
      'Content-Length',
    ])
      expect(head.headers.get(header)).toBe(full.headers.get(header));
    const cached = await get('/aB3xQ', { headers: { 'If-None-Match': etag } });
    expect(cached.status).toBe(304);
    expect(await cached.text()).toBe('');
    await expect(
      get('/aB3xQ', { headers: { 'If-Match': '"wrong"' } }),
    ).resolves.toHaveProperty('status', 412);
    const range = await get('/aB3xQ', { headers: { Range: 'bytes=1-3' } });
    expect(range.status).toBe(206);
    expect(await range.text()).toBe('yte');
    expect(range.headers.get('Content-Range')).toBe('bytes 1-3/5');
    expect(full.headers.get('Cache-Control')).toBe(
      'public, max-age=0, must-revalidate',
    );
  });

  it.each(['plain', 'html'])(
    'makes unavailable states indistinguishable for %s, including conditional GET and HEAD',
    async (representation) => {
      const lookup = (
        path = '/aB3xQ',
        options: Pick<RequestInit, 'method' | 'headers'> = {},
      ) =>
        get(
          path,
          {
            ...options,
            headers: {
              ...(representation === 'html' && {
                Accept: 'text/html',
                'Sec-Fetch-Dest': 'document',
              }),
              ...Object.fromEntries(new Headers(options.headers)),
            },
          },
          representation === 'html' ? '203.0.113.11' : productionIp,
        );
      const original = await lookup();
      expect(original.status).toBe(200);
      const etag = original.headers.get('ETag')!;
      await original.arrayBuffer();
      const variants = [
        ['GET', '/aB3xQ', { 'If-None-Match': etag }],
        ['HEAD', '/aB3xQ', { 'If-None-Match': etag }],
        ['GET', '/aB3xQ', { Range: 'bytes=1-3' }],
        ['GET', '/aB3xQ?download', { 'If-Match': '"anything"' }],
      ] as const;
      const baselines: { body: string; headers: Record<string, string> }[] = [];
      for (const [method, , headers] of variants) {
        const response = await lookup('/never', { method, headers });
        baselines.push({
          body: await response.text(),
          headers: Object.fromEntries(response.headers),
        });
      }
      const expectedBody = baselines[0].body;
      const expectedHeaders = baselines[0].headers;
      const expectedHeadHeaders = baselines[1].headers;
      const states = [
        [
          "UPDATE aliases SET expiresAt=1 WHERE slug='aB3xQ'",
          'UPDATE aliases SET expiresAt=NULL',
        ],
        [
          "UPDATE aliases SET disabledAt=1 WHERE slug='aB3xQ'",
          'UPDATE aliases SET disabledAt=NULL,"primary"=0',
        ],
        ['UPDATE images SET expiresAt=1', 'UPDATE images SET expiresAt=NULL'],
        ['UPDATE images SET deletedAt=1', 'UPDATE images SET deletedAt=NULL'],
        [
          'UPDATE delivery_domains SET enabled=0',
          'UPDATE delivery_domains SET enabled=1',
        ],
        [
          "UPDATE users SET status='disabled'",
          "UPDATE users SET status='active'",
        ],
        [
          "UPDATE users SET status='deleted'",
          "UPDATE users SET status='active'",
        ],
      ];
      for (const [disable, restore] of states) {
        await binding.prepare(disable).run();
        for (const [index, [method, path, headers]] of variants.entries()) {
          const response = await lookup(path, { method, headers });
          expect(response.status).toBe(404);
          expect(await response.text()).toBe(baselines[index].body);
          expect(Object.fromEntries(response.headers)).toEqual(
            baselines[index].headers,
          );
        }
        await binding.prepare(restore).run();
        if (restore.includes('images'))
          await binding
            .prepare(
              'UPDATE user_storage_stats SET imageCount=1,bytes=5,previewBytes=0',
            )
            .run();
      }
      await bucket.delete('original');
      const missingObject = await lookup();
      expect(missingObject.status).toBe(404);
      expect(await missingObject.text()).toBe(expectedBody);
      expect(Object.fromEntries(missingObject.headers)).toEqual(
        expectedHeaders,
      );
      const missingHead = await lookup('/aB3xQ', { method: 'HEAD' });
      expect(missingHead.status).toBe(404);
      expect(await missingHead.text()).toBe('');
      expect(Object.fromEntries(missingHead.headers)).toEqual(
        expectedHeadHeaders,
      );
      await bucket.put('original', 'bytes');
      await binding
        .prepare("UPDATE delivery_domains SET accessMode='selected'")
        .run();
      await expect(get()).resolves.toHaveProperty('status', 200);
      await binding
        .prepare("UPDATE delivery_domains SET accessMode='everyone'")
        .run();
    },
  );

  it('does not negative-cache an unused slug before it is created', async () => {
    const missing = await get('/newly');
    expect(missing.status).toBe(404);
    expect(missing.headers.get('Cache-Control')).toBe('private, no-store');
    await binding
      .prepare(
        "INSERT INTO aliases(id,imageId,deliveryDomainId,slug,createdAt) VALUES ('new','image','host','newly',1)",
      )
      .run();
    const created = await get('/newly');
    expect(created.status).toBe(200);
    expect(await created.text()).toBe('bytes');
  });

  it('uses the configured native budget and prevents method, host and forwarding-header bypass', async () => {
    const actor = '198.51.100.20';
    const original = await get('/aB3xQ', {}, actor);
    const etag = original.headers.get('ETag')!;
    const variants: Pick<RequestInit, 'method' | 'headers'>[] = [
      { method: 'HEAD' },
      { headers: { 'If-None-Match': etag } },
      { headers: { Range: 'bytes=1-3' } },
      { headers: { 'If-Match': '"wrong"' } },
    ];
    for (const [index, options] of variants.entries())
      await expect(
        get('/aB3xQ?download', options, actor),
      ).resolves.toHaveProperty('status', [200, 304, 206, 412][index]);
    // The native budget may cross one minute boundary during this bounded run.
    // Controlled-clock unit tests cover exact exhaustion, expiry, and cache eviction.
    const window = () => Math.floor(Date.now() / (failureBudget.period * 1000));
    const firstWindow = window();
    let exhausted = false;
    let guesses = 0;
    for (let index = 0; index <= failureBudget.limit * 2; index++) {
      guesses++;
      const response = await get(
        index % 2
          ? '/guess?download'
          : 'https://other.example.com/guess?preview',
        { method: index % 3 ? 'GET' : 'HEAD' },
        actor,
      );
      if (response.status === 429) {
        exhausted = true;
        break;
      }
      expect(response.status).toBe(404);
    }
    expect(
      exhausted,
      'The configured native failure budget must reject guesses',
    ).toBe(true);
    expect(guesses).toBeGreaterThan(failureBudget.limit);
    expect(guesses).toBeLessThanOrEqual(
      (window() === firstWindow
        ? failureBudget.limit
        : failureBudget.limit * 2) + 1,
    );
    for (const path of [
      '/aB3xQ',
      '/guess',
      'https://other.example.com/aB3xQ',
      '/s/aB3xQ',
      '/aB3xQ?download',
    ]) {
      const response = await get(
        path,
        {
          headers: {
            'X-Forwarded-For': '192.0.2.1',
            'X-Real-IP': '192.0.2.2',
            'Cache-Control': 'no-cache',
          },
        },
        actor,
      );
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    }
    const head = await get('/aB3xQ', { method: 'HEAD' }, actor);
    expect(head.status).toBe(429);
    expect(await head.text()).toBe('');
    await expect(get('/aB3xQ', {}, '198.51.100.30')).resolves.toHaveProperty(
      'status',
      200,
    );
    await expect(get('/guess', {}, '198.51.100.30')).resolves.toHaveProperty(
      'status',
      404,
    );
  });
});
