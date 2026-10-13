/* eslint-disable unicorn/no-await-expression-member -- Inspect completed HTTP responses directly. */
/* eslint vitest/expect-expect: ["error", {"assertFunctionNames": ["expect", "error", "uploaded"]}] */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';

import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { POST as webUpload } from '../../apps/web/src/routes/api/upload/+server';
import { POST } from '../../apps/web/src/routes/api/v1/images/+server';
import { createUser } from '../../packages/core/auth';
import { now } from '../../packages/core/common';
import { randomSecret } from '../../packages/core/crypto';
import { database } from '../../packages/core/db';
import { digest } from '../../packages/core/digest';
import type { Env } from '../../packages/core/env';
import { resolvePublicShare } from '../../packages/core/public-share';
import {
  auditLog,
  deleteTokens,
  deliveryDomains,
  images,
  users,
} from '../../packages/core/schema';
import { filename } from '../../packages/core/serve';
import { migrateDatabase } from '../helpers/database';

vi.mock('cloudflare:workers', () => ({ waitUntil: () => {} }));

const boundary = '--------------------8df2247211d47b0';
const contentType = `multipart/form-data; boundary=${boundary}`;
const resultSchema = z.object({
  id: z.string(),
  url: z.url(),
  deleteUrl: z.url(),
  size: z.number(),
  expiresAt: z.string().nullable(),
});
let mf: Miniflare,
  env: Env,
  key: string,
  ownerId: string,
  nativeBody: Buffer,
  png: Buffer;
const allow = { limit: () => Promise.resolve({ success: true }) };

beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      cf: false,
      modules: true,
      script: 'export default { fetch() { return new Response("ok") } }',
      d1Databases: ['DB'],
      r2Buckets: ['BUCKET'],
    }),
  );
  const DB = await mf.getD1Database('DB');
  await migrateDatabase(DB);
  // @ts-expect-error Miniflare R2 proxy uses Undici Headers types.
  const bucket: R2Bucket = await mf.getR2Bucket('BUCKET');
  env = {
    DB,
    BUCKET: {
      head: bucket.head.bind(bucket),
      get: bucket.get.bind(bucket),
      put: bucket.put.bind(bucket),
      delete: bucket.delete.bind(bucket),
      list: bucket.list.bind(bucket),
      createMultipartUpload: bucket.createMultipartUpload.bind(bucket),
      resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
    },
    ASSETS: { fetch: vi.fn() },
    APP_ORIGIN: 'https://app.example.com',
    ENVIRONMENT: 'test',
    MAX_UPLOAD_BYTES: '26214400',
    TURNSTILE_SITE_KEY: 'test',
    TURNSTILE_SECRET_KEY: 'test',
    LOGIN_LIMIT: allow,
    MUTATION_LIMIT: allow,
    SENSITIVE_LIMIT: allow,
    UPLOAD_LIMIT: allow,
  } as unknown as Env;
  const created = await createUser(DB, 'ShareX contract', 'user', null);
  key = created.key;
  ownerId = created.userId;
  await database(DB)
    .insert(deliveryDomains)
    .values([
      {
        id: 'photos',
        hostname: 'photos.example.com',
        createdAt: now(),
        updatedAt: now(),
        health: 'active',
      },
      {
        id: 'second',
        hostname: 'second.example.com',
        createdAt: now(),
        updatedAt: now(),
        health: 'active',
      },
    ]);
  await database(DB)
    .update(users)
    .set({ preferredDeliveryDomainId: 'photos' })
    .where(eq(users.id, ownerId));
  nativeBody = await readFile('tests/fixtures/sharex/sharex21-multipart.bin');
  const start = nativeBody.indexOf('\r\n\r\n') + 4;
  png = nativeBody.subarray(
    start,
    nativeBody.indexOf(`\r\n--${boundary}`, start),
  );
});
afterEach(async () => {
  await mf?.dispose();
});

function multipart(bytes = png, name = 'image.png', field = 'file') {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="${field}"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
    ),
    bytes,
    Buffer.from(`\r\n--${boundary}--\r\n`),
  ]);
}
function send(
  body = nativeBody,
  authorization = `Bearer ${key}`,
  headers: Record<string, string> = {},
) {
  return POST({
    request: new Request(`${env.APP_ORIGIN}/api/v1/images`, {
      method: 'POST',
      headers: {
        'Content-Type': contentType,
        Authorization: authorization,
        'User-Agent': 'ShareX/21.0.0',
        ...headers,
      },
      body: new Uint8Array(body),
    }),
    locals: { env },
  } as Parameters<typeof POST>[0]);
}
async function uploaded(body = nativeBody) {
  const response = await send(body);
  expect(response.status).toBe(201);
  expect(response.headers.get('Content-Type')).toContain('application/json');
  return resultSchema.parse(await response.json());
}
async function error(response: Response, status: number, code?: string) {
  expect(response.status).toBe(status);
  expect(response.headers.get('Content-Type')).toContain('application/json');
  expect(response.headers.has('Location')).toBe(false);
  const text = await response.text();
  const parsed = z
    .object({
      error: z.object({ code: z.string(), message: z.string().min(1) }),
      id: z.string().optional(),
      url: z.null().optional(),
      sharingWarning: z.string().optional(),
      size: z.number().optional(),
      expiresAt: z.string().nullable().optional(),
      deleteUrl: z.url().optional(),
    })
    .strict()
    .parse(JSON.parse(text));
  if (code) expect(parsed.error.code).toBe(code);
  expect(text).not.toContain(key);
  expect(text).not.toMatch(/objects\/|stack|internal-outage|SQLITE|Error:/);
  return parsed;
}
function publicImage(url: string) {
  return resolvePublicShare(new Request(url), {
    DB: env.DB,
    BUCKET: env.BUCKET,
    APP_ORIGIN: env.APP_ORIGIN,
    ENVIRONMENT: 'development',
    SHARE_FAILURE_LIMIT: allow,
  });
}

describe('observed ShareX 21 HTTP contract with real D1 and R2', () => {
  it('replays the exact captured native multipart request, preserving Unicode and safe response fields', async () => {
    const result = await uploaded();
    expect(result.url).toMatch(
      /^https:\/\/photos\.example\.com\/[A-Za-z0-9]{5}$/,
    );
    expect(result.deleteUrl).toMatch(
      new RegExp(
        String.raw`^https://app\.example\.com/delete/${result.id}#[a-f0-9]{64}$`,
      ),
    );
    expect(result.expiresAt).toBeNull();
    expect(JSON.stringify(result)).not.toContain(key);
    const [image] = await database(env.DB)
      .select()
      .from(images)
      .where(eq(images.id, result.id));
    expect(image.filename).toBe('PNG spaces café 🎉.PNG');
    expect(image.userId).toBe(ownerId);
    const response = await publicImage(result.url);
    expect(response.status).toBe(200);
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
    const [log] = await database(env.DB)
      .select()
      .from(auditLog)
      .where(eq(auditLog.targetId, result.id));
    expect(log.action).toBe('image.uploaded');
    expect(JSON.stringify(log)).not.toContain(
      result.deleteUrl.split('#', 2)[1],
    );
    const [capability] = await database(env.DB)
      .select()
      .from(deleteTokens)
      .where(eq(deleteTokens.imageId, result.id));
    expect(capability.hash).toBe(
      await digest(result.deleteUrl.split('#', 2)[1], 'delete'),
    );
  });

  it.each([
    'a..b.PNG',
    'no-extension',
    'misleading.html',
    'ampersand & % (test).png',
    'café 🎉.PNG',
    'x'.repeat(239) + '🎉.png',
    '../traversal.png',
    String.raw`C:\folder\image.png`,
  ])(
    'safely preserves or normalizes filename %s without trusting extension',
    async (name) => {
      const result = await uploaded(multipart(png, name));
      const [image] = await database(env.DB)
        .select()
        .from(images)
        .where(eq(images.id, result.id));
      expect(image.filename).toBe(filename(name));
      const response = await publicImage(result.url);
      expect(response.status).toBe(200);
      expect(response.headers.get('Content-Type')).toBe('image/png');
      expect(response.headers.get('Content-Disposition')).not.toMatch(/[\r\n]/);
    },
  );
  it('rejects wrong file field, malformed multipart, non-images, malformed images and oversize input', async () => {
    await error(await send(multipart(png, 'x.png', 'image')), 400);
    await error(await send(Buffer.from('broken')), 400);
    await error(await send(multipart(Buffer.from('<svg/>'), 'spoof.png')), 400);
    await error(await send(multipart(Buffer.from('GIF89a'), 'bad.gif')), 400);
    env.MAX_UPLOAD_BYTES = String(png.length - 1);
    await error(await send(), 413, 'UPLOAD_TOO_LARGE');
  });
  it('returns a plain-language error for a native multipart expiry argument', async () => {
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="expiry"\r\n\r\ninvalid\r\n`,
      ),
      nativeBody,
    ]);
    const response = await error(await send(body), 400, 'INVALID_INPUT');
    expect(response.error.message).toBe('Choose a valid image expiry.');
  });
  it('returns 429 with Retry-After for upload and failed-auth limits, and enforces host restrictions and quota', async () => {
    env.UPLOAD_LIMIT = { limit: () => Promise.resolve({ success: false }) };
    const response = await send();
    expect(response.headers.get('Retry-After')).toBe('60');
    await error(response, 429);
    env.UPLOAD_LIMIT = allow;
    env.LOGIN_LIMIT = { limit: () => Promise.resolve({ success: false }) };
    await error(await send(nativeBody, ''), 429);
    await database(env.DB)
      .update(deliveryDomains)
      .set({ accessMode: 'selected' })
      .where(eq(deliveryDomains.id, 'photos'));
    await error(await send(), 409, 'IMAGE_SAVED_WITHOUT_LINK');
    await database(env.DB)
      .update(deliveryDomains)
      .set({ accessMode: 'everyone' })
      .where(eq(deliveryDomains.id, 'photos'));
    await database(env.DB)
      .update(users)
      .set({ quotaBytes: 1 })
      .where(eq(users.id, ownerId));
    await error(await send(), 413);
  });
  it.each(['create', 'part', 'complete', 'canonical-read'])(
    'returns sanitized HTTP 503 for storage %s failure and removes uncommitted objects',
    async (stage) => {
      const before = await env.BUCKET.list();
      if (stage === 'create')
        vi.spyOn(env.BUCKET, 'createMultipartUpload').mockRejectedValueOnce(
          new Error('internal-outage'),
        );
      else if (stage === 'canonical-read')
        vi.spyOn(env.BUCKET, 'get').mockRejectedValueOnce(
          new Error('internal-outage'),
        );
      else {
        const create = env.BUCKET.createMultipartUpload.bind(env.BUCKET);
        vi.spyOn(env.BUCKET, 'createMultipartUpload').mockImplementationOnce(
          async (...arguments_) => {
            const upload = await create(...arguments_);
            return {
              ...upload,
              key: upload.key,
              uploadId: upload.uploadId,
              abort: upload.abort.bind(upload),
              uploadPart:
                stage === 'part'
                  ? vi.fn().mockRejectedValue(new Error('internal-outage'))
                  : upload.uploadPart.bind(upload),
              complete:
                stage === 'complete'
                  ? vi.fn().mockRejectedValue(new Error('internal-outage'))
                  : upload.complete.bind(upload),
            };
          },
        );
      }
      const body =
        stage === 'canonical-read'
          ? multipart(
              await readFile('tests/fixtures/metadata/private.webp'),
              'private.webp',
            )
          : nativeBody;
      await error(await send(body), 503, 'STORAGE_UNAVAILABLE');
      expect((await env.BUCKET.list()).objects).toHaveLength(
        before.objects.length,
      );
    },
  );
  it('uses the selected full delivery hostname independently of application origin', async () => {
    await env.DB.prepare(
      "UPDATE delivery_domains SET hostname='second.delivery.example.net' WHERE id='second'",
    ).run();
    await database(env.DB)
      .update(users)
      .set({ preferredDeliveryDomainId: 'second' })
      .where(eq(users.id, ownerId));
    const result = await uploaded();
    expect(new URL(result.url).origin).toBe(
      'https://second.delivery.example.net',
    );
    expect(new URL(result.deleteUrl).origin).toBe(env.APP_ORIGIN);
    expect((await publicImage(result.url)).status).toBe(200);
  });

  it('replays explicit retry keys without duplicate storage or deletion capability changes', async () => {
    const retryKey = randomSecret();
    const first = resultSchema.parse(
      await (
        await send(nativeBody, undefined, { 'Idempotency-Key': retryKey })
      ).json(),
    );
    const repeated = resultSchema.parse(
      await (
        await send(nativeBody, undefined, { 'Idempotency-Key': retryKey })
      ).json(),
    );
    expect(repeated).toEqual(first);
    await error(
      await send(nativeBody, undefined, { 'Idempotency-Key': 'invalid' }),
      400,
    );
  });
});

describe('saved uploads without delivery', () => {
  it('returns a ShareX error with the saved image and replays it after delivery becomes usable', async () => {
    await env.DB.prepare(
      'UPDATE users SET preferredDeliveryDomainId=NULL WHERE id=?',
    )
      .bind(ownerId)
      .run();
    await env.DB.prepare('UPDATE delivery_domains SET isPrimary=0').run();
    const retryKey = randomSecret();
    const first = await send(nativeBody, undefined, {
      'Idempotency-Key': retryKey,
    });
    expect(first.status).toBe(409);
    const original = await first.json();
    const saved = z
      .object({
        id: z.string(),
        url: z.null(),
        sharingWarning: z.string(),
        error: z.object({
          code: z.literal('IMAGE_SAVED_WITHOUT_LINK'),
          message: z.string(),
        }),
      })
      .parse(original);
    expect(saved.error.message).toContain('Image already saved');
    expect(
      (
        await env.DB.prepare('SELECT deletedAt FROM images WHERE id=?')
          .bind(saved.id)
          .first()
      )?.deletedAt,
    ).toBeNull();
    expect(
      (
        await env.DB.prepare(
          'SELECT count(*) AS count FROM aliases WHERE imageId=?',
        )
          .bind(saved.id)
          .first()
      )?.count,
    ).toBe(0);
    await env.DB.prepare(
      "UPDATE delivery_domains SET isPrimary=1 WHERE id='photos'",
    ).run();
    const replay = await send(nativeBody, undefined, {
      'Idempotency-Key': retryKey,
    });
    expect(replay.status).toBe(409);
    expect(await replay.json()).toEqual(original);
    const next = await uploaded();
    expect(new URL(next.url).origin).toBe('https://photos.example.com');
    await env.DB.prepare('UPDATE delivery_domains SET isPrimary=0').run();
  });
  it('returns web success and a sharing warning while storing an image privately', async () => {
    await env.DB.prepare(
      'UPDATE users SET preferredDeliveryDomainId=NULL WHERE id=?',
    )
      .bind(ownerId)
      .run();
    await env.DB.prepare('UPDATE delivery_domains SET isPrimary=0').run();
    const [owner] = await database(env.DB)
      .select()
      .from(users)
      .where(eq(users.id, ownerId));
    const response = await webUpload({
      request: new Request(env.APP_ORIGIN + '/api/upload', {
        method: 'POST',
        headers: { 'Content-Type': contentType },
        body: new Uint8Array(nativeBody),
      }),
      locals: { env, user: owner },
    } as Parameters<typeof webUpload>[0]);
    expect(response.status).toBe(201);
    const result = z
      .object({ id: z.string(), url: z.null(), sharingWarning: z.string() })
      .parse(await response.json());
    expect(result.sharingWarning).toContain('No instance default');
    expect(
      (
        await env.DB.prepare('SELECT deletedAt FROM images WHERE id=?')
          .bind(result.id)
          .first()
      )?.deletedAt,
    ).toBeNull();
  });
});
