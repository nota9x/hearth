import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import { createUser } from '../../packages/core/auth';
import { randomSecret } from '../../packages/core/crypto';
import { database, type User } from '../../packages/core/db';
import { digest } from '../../packages/core/digest';
import * as media from '../../packages/core/media';
import {
  armOnboardingUpload,
  skipOnboardingUpload,
} from '../../packages/core/onboarding';
import {
  aliases,
  auditLog,
  deliveryDomains,
  images,
  storageStats,
  users,
} from '../../packages/core/schema';
import { upload } from '../../packages/core/upload';
import { migrateDatabase } from '../helpers/database';
import { workerBundle, workerCompatibility } from '../helpers/workers';

const partSize = 5 * 1024 * 1024;
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const boundary = 'upload-test-boundary';
const contentType = `multipart/form-data; boundary=${boundary}`;
const header = Buffer.from(
  `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="test.png"\r\nContent-Type: image/png\r\n\r\n`,
);
const footer = Buffer.from(`\r\n--${boundary}--\r\n`);
let mf: Miniflare;
let env: Parameters<typeof upload>[2];
let user: User;

beforeEach(async () => {
  mf = new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      scriptPath: workerBundle('upload'),
      ...workerCompatibility('web'),
      d1Databases: ['DB'],
      r2Buckets: ['BUCKET'],
      bindings: {
        MAX_UPLOAD_BYTES: String(25 * 1024 * 1024),
        APP_ORIGIN: 'https://app.example.com',
        ENVIRONMENT: 'production',
      },
    }),
  );
  const DB = await mf.getD1Database('DB');
  await migrateDatabase(DB);
  env = {
    DB,
    // @ts-expect-error Miniflare's proxy uses Undici Headers; the binding is compatible at runtime.
    BUCKET: await mf.getR2Bucket('BUCKET'),
    MAX_UPLOAD_BYTES: String(25 * 1024 * 1024),
    APP_ORIGIN: 'https://app.example.com',
    ENVIRONMENT: 'production',
  };
  // Plain facades allow fault injection; Miniflare proxy methods cannot be spied on.
  const bucket = env.BUCKET;
  env.BUCKET = {
    head: bucket.head.bind(bucket),
    get: bucket.get.bind(bucket),
    put: bucket.put.bind(bucket),
    delete: bucket.delete.bind(bucket),
    list: bucket.list.bind(bucket),
    createMultipartUpload: bucket.createMultipartUpload.bind(bucket),
    resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
  };
  env.DB = {
    prepare: DB.prepare.bind(DB),
    batch: DB.batch.bind(DB),
    exec: DB.exec.bind(DB),
    dump: DB.dump.bind(DB),
    withSession: DB.withSession.bind(DB),
  };
  const created = await createUser(DB, 'Uploader', 'user', null);
  const db = database(DB);
  await db.insert(deliveryDomains).values({
    id: 'host',
    hostname: 'photos.example.com',
    createdAt: 1,
    updatedAt: 1,
    health: 'active',
  });
  await db
    .update(users)
    // Legacy padding fixtures exercise transport, not container sanitization.
    .set({ preferredDeliveryDomainId: 'host', stripImageMetadata: false })
    .where(eq(users.id, created.userId));
  [user] = await db.select().from(users).where(eq(users.id, created.userId));
}, 30_000);

afterEach(() => vi.restoreAllMocks());
afterEach(async () => {
  await mf?.dispose();
});

function imageBytes(size: number) {
  const bytes = Buffer.alloc(size, 0x61);
  png.copy(bytes);
  png.subarray(-12).copy(bytes, size - 12);
  return bytes;
}

function deferred() {
  let resolve!: () => void;
  // The repository targets ES2022, which has no Promise.withResolvers type.
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function requestFor(
  bytes: Uint8Array = png,
  chunkSize = 8191,
  failAfter = Infinity,
  onFailure = () => {},
  failureReady?: Promise<void>,
) {
  const segments = [header, bytes, footer];
  let segment = 0,
    offset = 0,
    pulled = 0,
    cancelled = false;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (pulled > failAfter) {
        await failureReady;
        onFailure();
        controller.error(new Error('Client disconnected'));
        return;
      }
      const current = segments[segment];
      if (!current) {
        controller.close();
        return;
      }
      const chunk = current.subarray(offset, offset + chunkSize);
      offset += chunk.length;
      pulled += chunk.length;
      controller.enqueue(chunk);
      if (offset !== current.length) return;
      segment++;
      offset = 0;
    },
    cancel() {
      cancelled = true;
    },
  });
  const request = new Request('https://app.example.com/api/upload', {
    method: 'POST',
    headers: {
      'cf-connecting-ip': '2001:db8::42',
      'content-type': contentType,
    },
    body,
    // @ts-expect-error Node requires duplex for a streaming request body.
    duplex: 'half',
  });
  return {
    request,
    get pulled() {
      return pulled;
    },
    get cancelled() {
      return cancelled;
    },
  };
}

async function rowFor(id: string) {
  const [row] = await database(env.DB)
    .select()
    .from(images)
    .where(eq(images.id, id));
  return row;
}

describe('first image milestone', () => {
  it('ignores older, browser, and failed uploads and records the first completed bearer upload', async () => {
    const older = await upload(requestFor().request, user, env, 'bearer');
    await armOnboardingUpload(env.DB, user);
    const [armed] = await database(env.DB)
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    expect(armed).toMatchObject({
      onboardingUploadBaseline: 1,
      onboardingUploadStatus: 'waiting',
      onboardingUploadImageId: null,
    });
    await upload(requestFor().request, user, env);
    await expect(
      upload(requestFor(Buffer.from('invalid')).request, user, env, 'bearer'),
    ).rejects.toThrow();
    const [before] = await database(env.DB)
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    expect(before.onboardingUploadStatus).toBe('waiting');
    expect(before.onboardingUploadImageId).toBeNull();
    const first = await upload(requestFor().request, user, env, 'bearer');
    const second = await upload(requestFor().request, user, env, 'bearer');
    const [after] = await database(env.DB)
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    expect(after.onboardingUploadStatus).toBe('verified');
    expect(after.onboardingUploadImageId).toBe(first.id);
    expect(after.onboardingUploadImageId).not.toBe(older.id);
    expect(after.onboardingUploadImageId).not.toBe(second.id);
    await skipOnboardingUpload(env.DB, after);
    const [stillVerified] = await database(env.DB)
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    expect(stillVerified.onboardingUploadImageId).toBe(first.id);
  });
  it('does not verify another user and keeps one winner for concurrent bearer uploads', async () => {
    const other = await createUser(env.DB, 'Other uploader', 'user', null);
    const [otherUser] = await database(env.DB)
      .select()
      .from(users)
      .where(eq(users.id, other.userId));
    await armOnboardingUpload(env.DB, user);
    await upload(requestFor().request, otherUser, env, 'bearer');
    const [before] = await database(env.DB)
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    expect(before.onboardingUploadStatus).toBe('waiting');
    const results = await Promise.all([
      upload(requestFor().request, user, env, 'bearer'),
      upload(requestFor().request, user, env, 'bearer'),
    ]);
    const [after] = await database(env.DB)
      .select()
      .from(users)
      .where(eq(users.id, user.id));
    expect(results.map((result) => result.id)).toContain(
      after.onboardingUploadImageId,
    );
    expect(after.onboardingUploadStatus).toBe('verified');
  });
});

async function largeWebp() {
  const base = Buffer.from(
    await readFile('tests/fixtures/metadata/animated.webp'),
  );
  let offset = 12;
  while (base.toString('ascii', offset, offset + 4) !== 'ANMF')
    offset +=
      8 + base.readUInt32LE(offset + 4) + (base.readUInt32LE(offset + 4) & 1);
  const frameSize = base.readUInt32LE(offset + 4);
  const frameEnd = offset + 8 + frameSize;
  const privateData = Buffer.alloc(6 * 1024 * 1024, 65);
  Buffer.from('Private frame metadata').copy(privateData);
  const chunkHeader = Buffer.alloc(8);
  chunkHeader.write('JUNK');
  chunkHeader.writeUInt32LE(privateData.length, 4);
  const input = Buffer.concat([
    base.subarray(0, frameEnd),
    chunkHeader,
    privateData,
    base.subarray(frameEnd),
  ]);
  input.writeUInt32LE(frameSize + 8 + privateData.length, offset + 4);
  input.writeUInt32LE(input.length - 8, 4);
  return input;
}

describe('canonical metadata stripping', () => {
  it('patches a deferred first WebP part and hashes canonical bytes in order', async () => {
    const input = await largeWebp();
    const result = await upload(
      requestFor(input).request,
      { ...user, stripImageMetadata: true },
      env,
    );
    const row = await rowFor(result.id);
    const stored = Buffer.from(
      await (await env.BUCKET.get(row.objectKey))!.arrayBuffer(),
    );
    expect(stored.readUInt32LE(4) + 8).toBe(stored.length);
    expect(stored.includes(Buffer.from('Private'))).toBe(false);
    expect(row.sha256).toBe(createHash('sha256').update(stored).digest('hex'));
    expect(row.size).toBe(stored.length);
  });

  it('removes an unpublished WebP if its canonical hash read fails', async () => {
    const bytes = await readFile('tests/fixtures/metadata/private.webp');
    const before = await env.BUCKET.list();
    vi.spyOn(env.BUCKET, 'get').mockRejectedValue(
      new Error('Hash read failed'),
    );
    await expect(
      upload(
        requestFor(bytes).request,
        { ...user, stripImageMetadata: true },
        env,
      ),
    ).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
    const after = await env.BUCKET.list();
    expect(after.objects).toEqual(before.objects);
  });
  it.each([
    'orientation-8.jpg',
    'private.png',
    'private.webp',
    'private.gif',
    'private.avif',
    'animated.png',
    'animated.webp',
  ])(
    'stores sanitized %s with canonical hashes, sizes and downloads',
    async (name) => {
      const bytes = await readFile(`tests/fixtures/metadata/${name}`);
      const result = await upload(
        requestFor(bytes, 7).request,
        { ...user, stripImageMetadata: true },
        env,
      );
      const row = await rowFor(result.id);
      const stored = Buffer.from(
        await (await env.BUCKET.get(row.objectKey))!.arrayBuffer(),
      );
      expect(stored.includes(Buffer.from('Private'))).toBe(false);
      expect(row.size).toBe(stored.length);
      expect(result.size).toBe(stored.length);
      expect(row.sha256).toBe(
        createHash('sha256').update(stored).digest('hex'),
      );
      expect(row).toMatchObject({ width: 48, height: 32 });
      const response = await media.serveObject(
        env.BUCKET,
        row.objectKey,
        new Request('https://example.com/image?download'),
        row.mime,
        row.filename,
      );
      expect(Buffer.from(await response.arrayBuffer())).toEqual(stored);
    },
  );

  it('isolates concurrent snapshots and never rewrites old canonical objects', async () => {
    const bytes = await readFile('tests/fixtures/metadata/private.webp');
    const [stripped, preserved] = await Promise.all([
      upload(
        requestFor(bytes).request,
        { ...user, stripImageMetadata: true },
        env,
      ),
      upload(
        requestFor(bytes).request,
        { ...user, stripImageMetadata: false },
        env,
      ),
    ]);
    const sanitizedRow = await rowFor(stripped.id),
      originalRow = await rowFor(preserved.id);
    const sanitized = Buffer.from(
      await (await env.BUCKET.get(sanitizedRow.objectKey))!.arrayBuffer(),
    );
    expect(sanitized.includes(Buffer.from('Private'))).toBe(false);
    expect(
      Buffer.from(
        await (await env.BUCKET.get(originalRow.objectKey))!.arrayBuffer(),
      ),
    ).toEqual(bytes);
    await database(env.DB)
      .update(users)
      .set({ stripImageMetadata: true })
      .where(eq(users.id, user.id));
    await database(env.DB)
      .update(users)
      .set({ stripImageMetadata: false })
      .where(eq(users.id, user.id));
    expect(
      Buffer.from(
        await (await env.BUCKET.get(sanitizedRow.objectKey))!.arrayBuffer(),
      ),
    ).toEqual(sanitized);
    expect(
      Buffer.from(
        await (await env.BUCKET.get(originalRow.objectKey))!.arrayBuffer(),
      ),
    ).toEqual(bytes);
  });

  it('fails closed and releases receipts when sanitization fails', async () => {
    const bytes = Buffer.from(
      await readFile('tests/fixtures/metadata/private.png'),
    );
    bytes[29] ^= 1;
    const before = await env.BUCKET.list();
    const request = requestFor(bytes).request;
    const key = randomSecret();
    request.headers.set('Idempotency-Key', key);
    const complete = vi.fn();
    wrapMultipart((multipart) => ({
      ...multipart,
      key: multipart.key,
      uploadId: multipart.uploadId,
      uploadPart: multipart.uploadPart.bind(multipart),
      abort: multipart.abort.bind(multipart),
      complete,
    }));
    await expect(
      upload(request, { ...user, stripImageMetadata: true }, env),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    expect(complete).not.toHaveBeenCalled();
    const after = await env.BUCKET.list();
    expect(after.objects).toEqual(before.objects);
    const receipt = await env.DB.prepare(
      'SELECT key FROM upload_receipts WHERE key=?',
    )
      .bind(await digest(`${user.id}:${key}`, 'upload-receipt'))
      .first();
    expect(receipt).toBeNull();
  });

  it('sanitizes inside actual workerd with real R2 and D1', async () => {
    await database(env.DB)
      .update(users)
      .set({ stripImageMetadata: true })
      .where(eq(users.id, user.id));
    try {
      const bytes = await readFile('tests/fixtures/metadata/private.webp');
      const response = await mf.dispatchFetch(
        'https://app.example.com/api/upload',
        {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: Buffer.concat([header, bytes, footer]),
        },
      );
      expect(response.status).toBe(200);
      const result = z.object({ id: z.string() }).parse(await response.json());
      const row = await rowFor(result.id);
      const stored = Buffer.from(
        await (await env.BUCKET.get(row.objectKey))!.arrayBuffer(),
      );
      expect(stored.includes(Buffer.from('Private'))).toBe(false);
      expect(row.sha256).toBe(
        createHash('sha256').update(stored).digest('hex'),
      );
    } finally {
      await database(env.DB)
        .update(users)
        .set({ stripImageMetadata: false })
        .where(eq(users.id, user.id));
    }
  });
});

// Delegate to real R2 except for the fault or delay under test.
function wrapMultipart(
  wrap: (multipart: R2MultipartUpload) => R2MultipartUpload,
) {
  const create = env.BUCKET.createMultipartUpload.bind(env.BUCKET);
  return vi
    .spyOn(env.BUCKET, 'createMultipartUpload')
    .mockImplementation(async (key, options) =>
      wrap(await create(key, options)),
    );
}

describe('streaming upload', () => {
  it.each(['expiry', 'retention'])(
    'accepts the %s option at the API boundary',
    async (field) => {
      const form = new FormData();
      form.append('file', new File([png], 'image.png', { type: 'image/png' }));
      form.append(field, '1h');
      const result = await upload(
        new Request('https://app.example.com/api/upload', {
          method: 'POST',
          body: form,
        }),
        user,
        env,
      );
      expect(result.expiresAt).not.toBeNull();
      const row = await rowFor(result.id);
      expect(row.expiresAt).toBeGreaterThan(Date.now() / 1000);
    },
  );
  it.each(['upload.gif', 'animated.gif'])(
    'stores and serves %s unchanged with trailer padding',
    async (fixture) => {
      const bytes = Buffer.concat([
        await readFile(`tests/fixtures/${fixture}`),
        Buffer.from([0, 13, 10]),
      ]);
      const result = await upload(requestFor(bytes, 1).request, user, env);
      const row = await rowFor(result.id);
      expect(row).toMatchObject({
        mime: 'image/gif',
        extension: 'gif',
        width: 2,
        height: 3,
        size: bytes.length,
      });
      for (const suffix of ['', '?download']) {
        const response = await media.serveObject(
          env.BUCKET,
          row.objectKey,
          new Request(`https://example.com/image${suffix}`),
          row.mime,
          row.filename,
        );
        expect(response.headers.get('content-type')).toBe('image/gif');
        expect(response.headers.get('x-content-type-options')).toBe('nosniff');
        expect(Buffer.from(await response.arrayBuffer())).toEqual(bytes);
      }
    },
  );

  it('rejects a malformed GIF before committing metadata or an object', async () => {
    const bytes = await readFile('tests/fixtures/animated.gif');
    const complete = vi.fn();
    wrapMultipart((multipart) => ({
      ...multipart,
      key: multipart.key,
      uploadId: multipart.uploadId,
      uploadPart: multipart.uploadPart.bind(multipart),
      abort: multipart.abort.bind(multipart),
      complete,
    }));
    await expect(
      upload(requestFor(bytes.subarray(0, -2)).request, user, env),
    ).rejects.toMatchObject({ code: 'INVALID_FILE_TYPE' });
    expect(complete).not.toHaveBeenCalled();
  });

  it('waits for an in-flight part before aborting after a client disconnect', async () => {
    const entered = deferred();
    const failed = deferred();
    const release = deferred();
    let settled = false,
      aborted = false,
      abortRaced = false;
    wrapMultipart((multipart) => ({
      key: multipart.key,
      uploadId: multipart.uploadId,
      complete: (parts) => multipart.complete(parts),
      async uploadPart(number, value) {
        entered.resolve();
        await release.promise;
        const result = await multipart.uploadPart(number, value);
        settled = true;
        return result;
      },
      async abort() {
        abortRaced = !settled;
        aborted = true;
        await multipart.abort();
      },
    }));
    const source = requestFor(
      imageBytes(partSize * 2),
      65_536,
      partSize + header.length,
      failed.resolve,
      entered.promise,
    );
    // Observe rejection immediately while coordinating the concurrent failure.
    // eslint-disable-next-line vitest/valid-expect
    const task = expect(
      upload(source.request, user, env),
    ).rejects.toMatchObject({ code: 'UPLOAD_FAILED' });
    await entered.promise;
    await failed.promise;
    try {
      expect(aborted).toBe(false);
    } finally {
      release.resolve();
    }
    await task;
    expect(aborted).toBe(true);
    expect(abortRaced).toBe(false);
    expect(source.request.body!.locked).toBe(false);
  });

  it('cancels a pending request read when multipart creation fails', async () => {
    let cancelled = false;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(header);
        controller.enqueue(png.subarray(0, 16));
      },
      cancel() {
        cancelled = true;
      },
    });
    vi.spyOn(env.BUCKET, 'createMultipartUpload').mockRejectedValue(
      new Error('R2 unavailable'),
    );
    const request = new Request('https://app.example.com', {
      method: 'POST',
      headers: { 'content-type': contentType },
      body,
      // @ts-expect-error Node requires duplex for a streaming request body.
      duplex: 'half',
    });
    await expect(upload(request, user, env)).rejects.toMatchObject({
      status: 503,
      code: 'STORAGE_UNAVAILABLE',
    });
    expect(cancelled).toBe(true);
    expect(request.body!.locked).toBe(false);
  });

  it.each([1, 8191])(
    'preserves bytes, hash, metadata, response and audit with %i-byte chunks',
    async (chunkSize) => {
      const result = await upload(
        requestFor(png, chunkSize).request,
        user,
        env,
      );
      expect(result).toMatchObject({ size: png.length, expiresAt: null });
      const row = await rowFor(result.id);
      expect(row).toMatchObject({
        width: 1,
        height: 1,
        mime: 'image/png',
        size: png.length,
        sha256: createHash('sha256').update(png).digest('hex'),
      });
      const stored = await env.BUCKET.get(row.objectKey);
      expect(Buffer.from(await stored!.arrayBuffer()).equals(png)).toBe(true);
      const logs = await database(env.DB)
        .select()
        .from(auditLog)
        .where(eq(auditLog.targetId, result.id));
      expect(logs).toHaveLength(1);
      expect(logs[0].action).toBe('image.uploaded');
      expect(JSON.parse(logs[0].metadata)).toMatchObject({
        actorIp: '2001:db8::42',
      });
    },
  );

  it.each([partSize, partSize + 1, partSize * 2 + 37])(
    'handles prefix and exact part boundaries at %i bytes',
    async (size) => {
      const lengths: number[] = [];
      wrapMultipart((multipart) => ({
        key: multipart.key,
        uploadId: multipart.uploadId,
        abort: () => multipart.abort(),
        complete: (parts) => multipart.complete(parts),
        uploadPart(number, value) {
          if (!(value instanceof Uint8Array))
            throw new TypeError('Expected bounded part');
          lengths.push(value.byteLength);
          return multipart.uploadPart(number, value);
        },
      }));
      const bytes = imageBytes(size);
      const result = await upload(requestFor(bytes, 70_001).request, user, env);
      const row = await rowFor(result.id);
      expect(row.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
      expect(lengths.slice(0, -1).every((length) => length === partSize)).toBe(
        true,
      );
      expect(lengths.reduce((sum, length) => sum + length, 0)).toBe(size);
      const stored = await env.BUCKET.get(row.objectKey);
      expect(Buffer.from(await stored!.arrayBuffer()).equals(bytes)).toBe(true);
    },
  );

  it('runs the actual upload inside workerd with real R2 and D1', async () => {
    const bytes = imageBytes(partSize * 2 + 13);
    const response = await mf.dispatchFetch(
      'https://app.example.com/api/upload',
      {
        method: 'POST',
        headers: { 'content-type': contentType },
        body: Buffer.concat([header, bytes, footer]),
      },
    );
    expect(response.status).toBe(200);
    const result = (await response.json()) as Awaited<
      ReturnType<typeof upload>
    >;
    const row = await rowFor(result.id);
    expect(row.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    const stored = await env.BUCKET.get(row.objectKey);
    expect(Buffer.from(await stored!.arrayBuffer()).equals(bytes)).toBe(true);
  });

  it('retains the object for reconciliation when the D1 reference check fails', async () => {
    const before = await env.BUCKET.list();
    const prepare = env.DB.prepare.bind(env.DB);
    const originalBatch = env.DB.batch.bind(env.DB);
    vi.spyOn(env.DB, 'batch').mockImplementation((statements) =>
      statements.length > 3
        ? Promise.reject(new Error('D1 unavailable'))
        : originalBatch(statements),
    );
    vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query === 'SELECT id FROM images WHERE objectKey=? OR previewKey=?')
        throw new Error('Lookup unavailable');
      return prepare(query);
    });
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(upload(requestFor().request, user, env)).rejects.toMatchObject(
      { code: 'SHARE_LINK_UNAVAILABLE' },
    );
    const after = await env.BUCKET.list();
    expect(after.objects).toHaveLength(before.objects.length + 1);
    expect(log).toHaveBeenCalledWith(
      expect.stringContaining('upload.cleanup_failed'),
    );
  });

  it('preserves the file-size boundary and total request limit', async () => {
    await expect(
      upload(requestFor(png).request, user, {
        ...env,
        MAX_UPLOAD_BYTES: String(png.length - 1),
      }),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413 });
    await expect(
      upload(requestFor(png).request, user, {
        ...env,
        MAX_UPLOAD_BYTES: String(png.length),
      }),
    ).resolves.toHaveProperty('size', png.length);
    const source = requestFor(imageBytes(100_000), 100_000);
    await expect(
      upload(source.request, user, { ...env, MAX_UPLOAD_BYTES: '100' }),
    ).rejects.toMatchObject({ code: 'UPLOAD_TOO_LARGE', status: 413 });
    expect(source.cancelled).toBe(true);
  });

  it('bounds read-ahead and does not reuse the part buffer while R2 is stalled', async () => {
    const entered = deferred();
    const release = deferred();
    let unchanged = false;
    wrapMultipart((multipart) => ({
      key: multipart.key,
      uploadId: multipart.uploadId,
      abort: () => multipart.abort(),
      complete: (parts) => multipart.complete(parts),
      async uploadPart(number, value) {
        if (!(value instanceof Uint8Array))
          throw new TypeError('Expected bounded part');
        if (number === 1) {
          const hash = createHash('sha256').update(value).digest('hex');
          entered.resolve();
          await release.promise;
          unchanged = hash === createHash('sha256').update(value).digest('hex');
        }
        return multipart.uploadPart(number, value);
      },
    }));
    const source = requestFor(imageBytes(partSize * 3), 65_536);
    const task = upload(source.request, user, env);
    await entered.promise;
    try {
      await new Promise((resolve) => setTimeout(resolve, 30));
      expect(source.pulled).toBeLessThan(partSize + 1024 * 1024);
    } finally {
      release.resolve();
    }
    await task;
    expect(unchanged).toBe(true);
  });

  it.each(['create', 'part', 'complete', 'committed-complete'])(
    'cleans up an R2 %s failure',
    async (failure) => {
      const before = await env.BUCKET.list();
      if (failure === 'create') {
        vi.spyOn(env.BUCKET, 'createMultipartUpload').mockRejectedValue(
          new Error('R2 unavailable'),
        );
      } else {
        wrapMultipart((multipart) => ({
          key: multipart.key,
          uploadId: multipart.uploadId,
          abort: () => multipart.abort(),
          uploadPart(number, value) {
            return failure === 'part'
              ? Promise.reject(new Error('Part failed'))
              : multipart.uploadPart(number, value);
          },
          async complete(parts) {
            if (failure === 'committed-complete')
              await multipart.complete(parts);
            throw new Error('Completion response lost');
          },
        }));
      }
      await expect(
        upload(requestFor(imageBytes(partSize + 1)).request, user, env),
      ).rejects.toMatchObject({ status: 503, code: 'STORAGE_UNAVAILABLE' });
      const after = await env.BUCKET.list();
      expect(after.objects.map((object) => object.key)).toEqual(
        before.objects.map((object) => object.key),
      );
    },
  );

  it.each([false, true])(
    'protects D1 writes when failure occurs after commit=%s',
    async (committed) => {
      const before = await env.BUCKET.list();
      const batch = env.DB.batch.bind(env.DB);
      vi.spyOn(env.DB, 'batch').mockImplementation(async (statements) => {
        if (statements.length <= 3) return batch(statements);
        if (committed) await batch(statements);
        throw new Error('D1 response lost');
      });
      await expect(
        upload(requestFor().request, user, env),
      ).rejects.toMatchObject({ code: 'SHARE_LINK_UNAVAILABLE' });
      const after = await env.BUCKET.list();
      expect(after.objects.length - before.objects.length).toBe(
        committed ? 1 : 0,
      );
    },
  );
});

function keyed(key: string, bytes: Uint8Array = png) {
  const { request } = requestFor(bytes);
  request.headers.set('Idempotency-Key', key);
  return request;
}
describe('upload idempotency', () => {
  it('retries real slug collisions atomically and stores the successful URL in the receipt', async () => {
    const config = await env.DB.prepare(
      'SELECT value FROM app_settings WHERE key=?',
    )
      .bind('shareSlugConfiguration')
      .first<{ value: string }>();
    await env.DB.prepare('UPDATE app_settings SET value=? WHERE key=?')
      .bind('{"defaultLength":5,"automaticFloor":3}', 'shareSlugConfiguration')
      .run();
    const key = randomSecret();
    const secureRandom = crypto.getRandomValues.bind(crypto);
    const random = vi
      .spyOn(crypto, 'getRandomValues')
      .mockImplementation((array) => {
        if (!(array instanceof Uint8Array))
          throw new TypeError('Expected random bytes');
        if (array.length === 10) array.fill(0);
        else secureRandom(array);
        return array;
      });
    try {
      const existing = await upload(requestFor().request, user, env);
      expect(new URL(existing.url!).pathname).toBe('/AAAAA');
      const before = await env.BUCKET.list();
      const db = database(env.DB);
      const [beforeUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, user.id));
      const [beforeStats] = await db
        .select()
        .from(storageStats)
        .where(eq(storageStats.userId, user.id));
      const completed = vi.fn();
      wrapMultipart((multipart) => ({
        key: multipart.key,
        uploadId: multipart.uploadId,
        abort: multipart.abort.bind(multipart),
        uploadPart: multipart.uploadPart.bind(multipart),
        async complete(parts) {
          completed();
          return multipart.complete(parts);
        },
      }));
      const result = await upload(keyed(key), user, env);
      expect(new URL(result.url!).pathname).toMatch(/^\/[A-Za-z0-9]{6}$/);

      expect(completed).toHaveBeenCalledOnce();
      const [alias] = await db
        .select()
        .from(aliases)
        .where(eq(aliases.imageId, result.id));
      expect(new URL(result.url!).pathname).toBe(`/${alias.slug}`);
      const [afterUser] = await db
        .select()
        .from(users)
        .where(eq(users.id, user.id));
      const [afterStats] = await db
        .select()
        .from(storageStats)
        .where(eq(storageStats.userId, user.id));
      expect(afterUser.uploadCount).toBe(beforeUser.uploadCount + 1);
      expect(afterStats.imageCount).toBe(beforeStats.imageCount + 1);
      expect(afterStats.bytes).toBe(beforeStats.bytes + png.length);
      expect(
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.targetId, result.id)),
      ).toHaveLength(1);
      expect(
        await db
          .select()
          .from(auditLog)
          .where(eq(auditLog.action, 'share_slug.expanded')),
      ).toHaveLength(1);
      const after = await env.BUCKET.list();
      expect(after.objects).toHaveLength(before.objects.length + 1);
      const receipt = await env.DB.prepare(
        'SELECT response FROM upload_receipts WHERE key=?',
      )
        .bind(await digest(`${user.id}:${key}`, 'upload-receipt'))
        .first<{ response: string }>();
      expect(JSON.parse(receipt!.response)).toMatchObject({
        id: result.id,
        url: result.url,
      });
      expect(await upload(keyed(key), user, env)).toEqual(result);
      expect(completed).toHaveBeenCalledOnce();
    } finally {
      random.mockRestore();
      await env.DB.prepare('UPDATE app_settings SET value=? WHERE key=?')
        .bind(config!.value, 'shareSlugConfiguration')
        .run();
    }
  });
  it('replays the exact result without another object, alias, token, counter or audit event', async () => {
    const key = randomSecret();
    const before = await env.DB.prepare(
      'SELECT uploadCount FROM users WHERE id = ?',
    )
      .bind(user.id)
      .first<{ uploadCount: number }>();
    const first = await upload(keyed(key), user, env);
    const create = vi.spyOn(env.BUCKET, 'createMultipartUpload');
    const second = await upload(keyed(key), user, env);
    expect(second).toEqual(first);
    expect(create).not.toHaveBeenCalled();
    const after = await env.DB.prepare(
      'SELECT uploadCount FROM users WHERE id = ?',
    )
      .bind(user.id)
      .first<{ uploadCount: number }>();
    expect(after!.uploadCount).toBe(before!.uploadCount + 1);
    const token = await env.DB.prepare(
      'SELECT hash FROM delete_tokens WHERE imageId = ?',
    )
      .bind(first.id)
      .first<{ hash: string }>();
    expect(token!.hash).toBe(
      await digest(first.deleteUrl.split('#', 2)[1], 'delete'),
    );
    for (const table of ['images', 'aliases', 'delete_tokens', 'audit_log']) {
      const column =
        table === 'images'
          ? 'id'
          : table === 'audit_log'
            ? 'targetId'
            : 'imageId';
      const row = await env.DB.prepare(
        `SELECT COUNT(*) AS count FROM ${table} WHERE ${column} = ?`,
      )
        .bind(first.id)
        .first<{ count: number }>();
      expect(row?.count).toBe(1);
    }
    const receipt = await env.DB.prepare(
      'SELECT key, response FROM upload_receipts WHERE response LIKE ?',
    )
      .bind(`%${first.id}%`)
      .first<{ key: string; response: string }>();
    expect(receipt?.key).not.toBe(key);
    expect(receipt?.response).not.toContain(first.deleteUrl.split('#', 2)[1]);
  });
  it('scopes operation keys and delete secrets to the authenticated owner', async () => {
    const key = randomSecret();
    const created = await createUser(env.DB, 'Receipt isolation', 'user', null);
    await database(env.DB)
      .update(users)
      .set({ preferredDeliveryDomainId: 'host' })
      .where(eq(users.id, created.userId));
    const [other] = await database(env.DB)
      .select()
      .from(users)
      .where(eq(users.id, created.userId));
    const first = await upload(keyed(key), user, env);
    const second = await upload(keyed(key), other, env);
    expect(first.id).not.toBe(second.id);
    expect(first.deleteUrl.split('#', 2)[1]).not.toBe(
      second.deleteUrl.split('#', 2)[1],
    );
    await expect(upload(keyed(key), user, env)).resolves.toEqual(first);
  });
  it('claims a key atomically while the original R2 upload is still pending', async () => {
    const entered = deferred(),
      release = deferred();
    wrapMultipart((multipart) => ({
      key: multipart.key,
      uploadId: multipart.uploadId,
      abort: () => multipart.abort(),
      complete: (parts) => multipart.complete(parts),
      async uploadPart(number, value) {
        entered.resolve();
        await release.promise;
        return multipart.uploadPart(number, value);
      },
    }));
    const key = randomSecret();
    const first = upload(keyed(key), user, env);
    await entered.promise;
    try {
      await expect(upload(keyed(key), user, env)).rejects.toMatchObject({
        code: 'UPLOAD_IN_PROGRESS',
      });
    } finally {
      release.resolve();
    }
    const result = await first;
    await expect(upload(keyed(key), user, env)).resolves.toEqual(result);
  });
  it('replays a committed operation after the D1 response is lost', async () => {
    const key = randomSecret();
    const batch = env.DB.batch.bind(env.DB);
    const fault = vi
      .spyOn(env.DB, 'batch')
      .mockImplementation(async (statements) => {
        const result = await batch(statements);
        if (statements.length <= 3) return result;
        throw new Error('Commit response lost');
      });
    await expect(upload(keyed(key), user, env)).rejects.toMatchObject({
      code: 'SHARE_LINK_UNAVAILABLE',
    });
    fault.mockRestore();
    const create = vi.spyOn(env.BUCKET, 'createMultipartUpload');
    const result = await upload(keyed(key), user, env);
    expect(create).not.toHaveBeenCalled();
    const row = await rowFor(result.id);
    expect(await env.BUCKET.head(row.objectKey)).not.toBeNull();
  });
  it('releases a failed operation only after cleanup so the same key can retry', async () => {
    const key = randomSecret();
    const originalBatch = env.DB.batch.bind(env.DB);
    const fault = vi
      .spyOn(env.DB, 'batch')
      .mockImplementation((statements) =>
        statements.length > 3
          ? Promise.reject(new Error('D1 unavailable'))
          : originalBatch(statements),
      );
    const before = await env.BUCKET.list();
    await expect(upload(keyed(key), user, env)).rejects.toMatchObject({
      code: 'SHARE_LINK_UNAVAILABLE',
    });
    const after = await env.BUCKET.list();
    expect(after.objects).toHaveLength(before.objects.length);
    fault.mockRestore();
    await expect(upload(keyed(key), user, env)).resolves.toHaveProperty(
      'size',
      png.length,
    );
  });
  it('retains an uncertain claim if cleanup cannot verify the D1 outcome', async () => {
    const key = randomSecret();
    const originalBatch = env.DB.batch.bind(env.DB);
    const batch = vi
      .spyOn(env.DB, 'batch')
      .mockImplementation((statements) =>
        statements.length > 3
          ? Promise.reject(new Error('Lost response'))
          : originalBatch(statements),
      );
    const prepare = env.DB.prepare.bind(env.DB);
    const lookup = vi.spyOn(env.DB, 'prepare').mockImplementation((query) => {
      if (query === 'SELECT id FROM images WHERE objectKey=? OR previewKey=?')
        throw new Error('Lookup unavailable');
      return prepare(query);
    });
    vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(upload(keyed(key), user, env)).rejects.toMatchObject({
      code: 'SHARE_LINK_UNAVAILABLE',
    });
    batch.mockRestore();
    lookup.mockRestore();
    await expect(upload(keyed(key), user, env)).rejects.toMatchObject({
      code: 'UPLOAD_IN_PROGRESS',
    });
  });

  it('propagates an explicit request abort and releases the multipart and claim', async () => {
    const controller = new AbortController();
    const key = randomSecret();
    const entered = deferred(),
      release = deferred();
    const aborted = vi.fn();
    wrapMultipart((multipart) => ({
      key: multipart.key,
      uploadId: multipart.uploadId,
      async abort() {
        aborted();
        await multipart.abort();
      },
      complete: (parts) => multipart.complete(parts),
      async uploadPart(number, value) {
        entered.resolve();
        await release.promise;
        return multipart.uploadPart(number, value);
      },
    }));
    const request = new Request(keyed(key, imageBytes(partSize + 1)), {
      signal: controller.signal,
    });
    const task = upload(request, user, env);
    // Attach rejection before triggering it.
    // eslint-disable-next-line vitest/valid-expect
    const rejected = expect(task).rejects.toMatchObject({
      code: 'UPLOAD_FAILED',
    });
    await entered.promise;
    controller.abort();
    release.resolve();
    await rejected;
    expect(aborted).toHaveBeenCalledOnce();
    expect(request.body!.locked).toBe(false);
    await expect(upload(keyed(key), user, env)).resolves.toHaveProperty(
      'size',
      png.length,
    );
  });
});
