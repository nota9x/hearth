/* eslint-disable unicorn/no-await-expression-member -- Assertions inspect completed database and HTTP results. */
import { Buffer } from 'node:buffer';
import { readFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createUser } from '../../packages/core/auth';
import { AppError } from '../../packages/core/common';
import { database, type User } from '../../packages/core/db';
import { digest } from '../../packages/core/digest';
import { images, users } from '../../packages/core/schema';
import { serveObject } from '../../packages/core/serve';
import { upload } from '../../packages/core/upload';
import { migrateDatabase } from '../helpers/database';
import { workerBundle, workerCompatibility } from '../helpers/workers';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const boundary = 'hearth-adversarial-0x6e624eb7';
type Environment = Parameters<typeof upload>[2];
let mf: Miniflare, env: Environment;
let sanitized: User, retained: User;

function localRuntime(script?: string) {
  return new Miniflare(
    convertV4MiniflareOptions({
      modules: true,
      ...(script
        ? { scriptPath: script }
        : {
            script: 'export default { fetch() { return new Response("ok") } }',
          }),
      ...workerCompatibility('web'),
      d1Databases: ['DB'],
      r2Buckets: ['BUCKET'],
      bindings: {
        MAX_UPLOAD_BYTES: '26214400',
        APP_ORIGIN: 'https://app.example.com',
        ENVIRONMENT: 'production',
      },
    }),
  );
}

async function environment(runtime: Miniflare): Promise<Environment> {
  const DB = await runtime.getD1Database('DB');
  await migrateDatabase(DB);
  await DB.prepare(
    "INSERT INTO delivery_domains(id,hostname,health,createdAt,updatedAt) VALUES('adversarial-host','photos.example.com','active',1,1)",
  ).run();
  return {
    DB,
    // @ts-expect-error Miniflare's proxy uses Undici Headers; the binding is compatible at runtime.
    BUCKET: await runtime.getR2Bucket('BUCKET'),
    MAX_UPLOAD_BYTES: '26214400',
    APP_ORIGIN: 'https://app.example.com',
    ENVIRONMENT: 'production',
  };
}

async function actor(binding: D1Database, stripImageMetadata = true) {
  const created = await createUser(
    binding,
    'Adversarial uploader',
    'user',
    null,
  );
  await database(binding)
    .update(users)
    .set({ stripImageMetadata, preferredDeliveryDomainId: 'adversarial-host' })
    .where(eq(users.id, created.userId));
  return (
    await database(binding)
      .select()
      .from(users)
      .where(eq(users.id, created.userId))
  )[0];
}

beforeEach(async () => {
  mf = localRuntime();
  env = await environment(mf);
  sanitized = await actor(env.DB);
  retained = await actor(env.DB, false);
});
afterEach(async () => {
  await mf?.dispose();
});

function filePart(bytes = png, mime = 'image/png', filename = 'image.png') {
  return Buffer.concat([
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: ${mime}\r\n\r\n`,
    ),
    bytes,
    Buffer.from('\r\n'),
  ]);
}
function fieldPart(name: string, value: string) {
  return Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`,
  );
}
function multipart(parts: Buffer[], ending = `--${boundary}--\r\n`) {
  return Buffer.concat([...parts, Buffer.from(ending)]);
}
function request(body = multipart([filePart()]), key = 'a'.repeat(64)) {
  const values = new Headers();
  values.set('Content-Type', `multipart/form-data; boundary="${boundary}"`);
  values.set('Idempotency-Key', key);
  return new Request('https://app.example.com/api/upload', {
    method: 'POST',
    headers: values,
    body,
  });
}
async function state(person: User, currentEnv = env) {
  const counts = await currentEnv.DB.prepare(
    `
    SELECT
      (SELECT count(*) FROM images WHERE userId=?) AS images,
      (SELECT count(*) FROM aliases WHERE imageId IN (SELECT id FROM images WHERE userId=?)) AS aliases,
      (SELECT count(*) FROM delete_tokens WHERE imageId IN (SELECT id FROM images WHERE userId=?)) AS tokens,
      (SELECT count(*) FROM upload_receipts WHERE userId=?) AS receipts,
      (SELECT count(*) FROM audit_log WHERE actorId=? AND action='image.uploaded') AS audits,
      (SELECT uploadCount FROM users WHERE id=?) AS uploads,
      (SELECT bytes FROM user_storage_stats WHERE userId=?) AS bytes,
      (SELECT previewBytes FROM user_storage_stats WHERE userId=?) AS previews,
      (SELECT imageCount FROM user_storage_stats WHERE userId=?) AS imageCount
  `,
  )
    .bind(...Array.from({ length: 9 }, () => person.id))
    .first();
  const stored = await currentEnv.BUCKET.list({
    prefix: `objects/${person.id}/`,
  });
  return {
    counts,
    objects: stored.objects.map(({ key }) => key),
  };
}
function pngDimensions(width: number, height: number) {
  const bytes = Buffer.from(png);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  bytes.writeUInt32BE(crc32(bytes.subarray(12, 29)), 29);
  return bytes;
}

describe('bounded upload parser corpus with real storage rollback', () => {
  it.each([true, false])(
    'rejects signature/container/dimension mutations and releases retry claims, strip=%s',
    async (strip) => {
      const person = strip ? sanitized : retained;
      const jpeg = Buffer.from(await readFile('tests/fixtures/upload.jpeg'));
      const gif = Buffer.from(await readFile('tests/fixtures/upload.gif'));
      const webp = Buffer.from(await readFile('tests/fixtures/upload.webp'));
      const avif = Buffer.from(await readFile('tests/fixtures/upload.avif'));
      webp.writeUInt32LE(webp.length + 64, 4);
      // Fixed xorshift seed mutates only PNG signature bytes; no random/timing spray.
      let seed = 0x6e_62_4e_b7;
      const corrupted = Array.from({ length: 5 }, () => {
        seed ^= seed << 13;
        seed ^= seed >>> 17;
        seed ^= seed << 5;
        const bytes = Buffer.from(png);
        bytes[1 + ((seed >>> 0) % 7)] ^= 255;
        return bytes;
      });
      const corpus = [
        Buffer.from(
          '<svg xmlns="http://www.w3.org/2000/svg" onload="alert(1)"/>',
        ),
        png.subarray(0, 12),
        jpeg.subarray(0, 16),
        gif.subarray(0, -1),
        webp,
        avif.subarray(0, 16),
        pngDimensions(10_001, 10_000),
        pngDimensions(0, 1),
        ...corrupted,
      ];
      const before = await state(person);
      for (const [index, bytes] of corpus.entries()) {
        const key = (index + 1).toString(16).padStart(64, '0');
        let outcome: unknown;
        try {
          outcome = await upload(
            request(multipart([filePart(bytes)]), key),
            person,
            env,
          );
        } catch (error) {
          outcome = error;
        }
        expect(outcome, `corpus ${index}, strip=${strip}`).toBeInstanceOf(
          AppError,
        );
        expect(
          (outcome as { status: number }).status,
          `corpus ${index}, strip=${strip}`,
        ).toBeGreaterThanOrEqual(400);
        expect((outcome as { status: number }).status).toBeLessThan(500);
        expect(await state(person)).toEqual(before);
      }
      await expect(
        upload(request(undefined, '1'.padStart(64, '0')), person, env),
      ).resolves.toHaveProperty('size', png.length);
    },
  );

  it.each([
    [
      'retention then expiry',
      [fieldPart('retention', 'never'), fieldPart('expiry', '1h')],
    ],
    [
      'expiry then retention',
      [fieldPart('expiry', '1h'), fieldPart('retention', 'never')],
    ],
    [
      'duplicate custom expiration',
      [
        fieldPart('expiresAt', '2099-01-01T00:00:00Z'),
        fieldPart('expiresAt', '2098-01-01T00:00:00Z'),
      ],
    ],
    ['forged owner', [fieldPart('userId', 'victim')]],
    ['prototype field', [fieldPart('__proto__', 'never')]],
    ['field size boundary', [fieldPart('expiry', '1'.repeat(129))]],
    [
      'third option',
      [
        fieldPart('expiry', 'never'),
        fieldPart('expiresAt', '2099-01-01T00:00:00Z'),
        fieldPart('retention', 'never'),
      ],
    ],
  ])(
    'rejects %s in either file ordering, without durable effects',
    async (_label, fields) => {
      const before = await state(sanitized);
      for (const parts of [
        [filePart(), ...fields],
        [...fields, filePart()],
      ]) {
        await expect(
          upload(request(multipart(parts), 'b'.repeat(64)), sanitized, env),
        ).rejects.toMatchObject({ status: 400 });
        expect(await state(sanitized)).toEqual(before);
      }
    },
  );

  it('canonicalizes contradictory MIME and filename metadata and preserves delivery isolation', async () => {
    const result = await upload(
      request(
        multipart([filePart(png, 'text/html', '../attack.html')]),
        'c'.repeat(64),
      ),
      sanitized,
      env,
    );
    const row = (
      await database(env.DB)
        .select()
        .from(images)
        .where(eq(images.id, result.id))
    )[0];
    expect(row).toMatchObject({
      userId: sanitized.id,
      mime: 'image/png',
      extension: 'png',
      filename: 'attack.html',
    });
    const response = await serveObject(
      env.BUCKET,
      row.objectKey,
      new Request('https://photos.example.com/image'),
      row.mime,
      row.filename,
    );
    expect(response.headers.get('Content-Type')).toBe('image/png');
    expect(response.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(response.headers.get('Content-Security-Policy')).toBe(
      "default-src 'none'; sandbox",
    );
    expect(Buffer.from(await response.arrayBuffer())).toEqual(png);
  });

  it('rejects ambiguous retry headers after actual Headers normalization', async () => {
    const before = await state(sanitized);
    const headers = new Headers();
    headers.append('Idempotency-Key', 'd'.repeat(64));
    headers.append('Idempotency-Key', 'e'.repeat(64));
    expect(headers.get('Idempotency-Key')).toBe(
      `${'d'.repeat(64)}, ${'e'.repeat(64)}`,
    );
    const duplicate = request();
    duplicate.headers.set('Idempotency-Key', headers.get('Idempotency-Key')!);
    for (const candidate of [
      duplicate,
      ...[
        'F'.repeat(64),
        'a'.repeat(63),
        'a'.repeat(65),
        '%61'.repeat(64),
        'a'.repeat(4096),
      ].map((key) => request(undefined, key)),
    ]) {
      await expect(upload(candidate, sanitized, env)).rejects.toMatchObject({
        status: 400,
        code: 'INVALID_UPLOAD_KEY',
      });
    }
    expect(await state(sanitized)).toEqual(before);
  });
});

function gate(target: number) {
  let entered = 0;
  let arrive!: () => void, release!: () => void;
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- ES2022 target.
  const ready = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  // eslint-disable-next-line unicorn/prefer-promise-with-resolvers -- ES2022 target.
  const blocked = new Promise<void>((resolve) => {
    release = resolve;
  });
  return {
    ready,
    release,
    async wait() {
      if (++entered === target) arrive();
      await blocked;
    },
  };
}
function gatedEnvironment(barrier: ReturnType<typeof gate>) {
  const DB = env.DB;
  return {
    ...env,
    DB: {
      prepare: DB.prepare.bind(DB),
      exec: DB.exec.bind(DB),
      dump: DB.dump.bind(DB),
      withSession: DB.withSession.bind(DB),
      async batch<T = unknown>(
        statements: D1PreparedStatement[],
      ): Promise<D1Result<T>[]> {
        if (statements.length > 3) await barrier.wait();
        return DB.batch<T>(statements);
      },
    },
  };
}

describe('controlled upload state transitions', () => {
  it('uses the current quota at commit after all contenders completed R2, with atomic receipt/accounting rollback', async () => {
    const person = await actor(env.DB);
    await env.DB.prepare('UPDATE users SET quotaBytes=? WHERE id=?')
      .bind(3 * png.length, person.id)
      .run();
    const barrier = gate(3);
    const currentEnv = gatedEnvironment(barrier);
    const tasks = ['2', '3', '4'].map((digit) =>
      upload(request(undefined, digit.repeat(64)), person, currentEnv),
    );
    const settled = Promise.allSettled(tasks);
    await barrier.ready;
    try {
      expect((await state(person)).objects).toHaveLength(3);
      await env.DB.prepare('UPDATE users SET quotaBytes=? WHERE id=?')
        .bind(png.length, person.id)
        .run();
    } finally {
      barrier.release();
    }
    const results = await settled;
    expect(results.filter(({ status }) => status === 'fulfilled')).toHaveLength(
      1,
    );
    const failures = results.filter((result) => result.status === 'rejected');
    expect(failures).toHaveLength(2);
    for (const result of failures)
      expect(result.reason as unknown).toMatchObject({
        status: 413,
        code: 'QUOTA_EXCEEDED',
      });
    expect((await state(person)).counts).toMatchObject({
      images: 1,
      aliases: 1,
      tokens: 1,
      receipts: 1,
      audits: 1,
      uploads: 1,
      bytes: png.length,
      previews: 0,
      imageCount: 1,
    });
    expect((await state(person)).objects).toHaveLength(1);
  });

  it('rejects account disablement completed after R2 storage but before D1 persistence', async () => {
    const person = await actor(env.DB);
    const before = await state(person);
    const barrier = gate(1),
      key = '5'.repeat(64);
    const task = upload(
      request(undefined, key),
      person,
      gatedEnvironment(barrier),
    );
    const settled = Promise.allSettled([task]);
    await barrier.ready;
    try {
      expect((await state(person)).objects).toHaveLength(1);
      await env.DB.prepare("UPDATE users SET status='disabled' WHERE id=?")
        .bind(person.id)
        .run();
    } finally {
      barrier.release();
    }
    const [result] = await settled;
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason as unknown).toMatchObject({
      status: 403,
      code: 'ACCOUNT_DISABLED',
    });
    expect(await state(person)).toEqual(before);
    await env.DB.prepare("UPDATE users SET status='active' WHERE id=?")
      .bind(person.id)
      .run();
    await expect(
      upload(request(undefined, key), person, env),
    ).resolves.toHaveProperty('size', png.length);
  });

  it('keeps an idempotency claim locked until failed committed-object cleanup finishes', async () => {
    const person = await actor(env.DB),
      key = '6'.repeat(64);
    await env.DB.prepare('UPDATE users SET quotaBytes=0 WHERE id=?')
      .bind(person.id)
      .run();
    const barrier = gate(1);
    const bucket = env.BUCKET;
    const wrapped = {
      ...env,
      BUCKET: {
        head: bucket.head.bind(bucket),
        get: bucket.get.bind(bucket),
        put: bucket.put.bind(bucket),
        list: bucket.list.bind(bucket),
        createMultipartUpload: bucket.createMultipartUpload.bind(bucket),
        resumeMultipartUpload: bucket.resumeMultipartUpload.bind(bucket),
        async delete(keys: string | string[]) {
          await barrier.wait();
          await bucket.delete(keys);
        },
      },
    };
    const settled = Promise.allSettled([
      upload(request(undefined, key), person, wrapped),
    ]);
    await barrier.ready;
    try {
      const receiptKey = await digest(`${person.id}:${key}`, 'upload-receipt');
      expect(
        await env.DB.prepare('SELECT response FROM upload_receipts WHERE key=?')
          .bind(receiptKey)
          .first(),
      ).toEqual({ response: null });
      await expect(
        upload(request(undefined, key), person, env),
      ).rejects.toMatchObject({ status: 409, code: 'UPLOAD_IN_PROGRESS' });
      expect((await state(person)).objects).toHaveLength(1);
    } finally {
      barrier.release();
    }
    const [result] = await settled;
    expect(result.status).toBe('rejected');
    expect((result as PromiseRejectedResult).reason as unknown).toMatchObject({
      code: 'QUOTA_EXCEEDED',
    });
    expect((await state(person)).counts).toMatchObject({
      images: 0,
      aliases: 0,
      tokens: 0,
      receipts: 0,
      audits: 0,
      uploads: 0,
      bytes: 0,
    });
    expect((await state(person)).objects).toHaveLength(0);
    await env.DB.prepare('UPDATE users SET quotaBytes=? WHERE id=?')
      .bind(png.length, person.id)
      .run();
    await expect(
      upload(request(undefined, key), person, env),
    ).resolves.toHaveProperty('size', png.length);
  });
});

it('repeats upload parser boundary cases inside actual workerd, with real D1/R2', async () => {
  const runtime = localRuntime(workerBundle('upload'));
  try {
    const currentEnv = await environment(runtime);
    const person = await actor(currentEnv.DB);
    const before = await state(person, currentEnv);
    const cases = [
      multipart([filePart(pngDimensions(10_001, 10_000))]),
      multipart([
        fieldPart('retention', 'never'),
        fieldPart('expiry', '1h'),
        filePart(),
      ]),
      multipart([filePart(), fieldPart('userId', 'victim')]),
      multipart([filePart()], `--${boundary.slice(0, -1)}--\r\n`),
    ];
    for (const [index, body] of cases.entries()) {
      const candidate = request(body, index.toString(16).padStart(64, '0'));
      const response = await runtime.dispatchFetch(candidate.url, {
        method: 'POST',
        headers: Object.fromEntries(candidate.headers),
        body,
      });
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      await response.arrayBuffer();
      expect(await state(person, currentEnv)).toEqual(before);
    }
    const acceptedBody = multipart([
      filePart(png, 'application/javascript', 'payload.js'),
    ]);
    const acceptedRequest = request(acceptedBody, '7'.repeat(64));
    const accepted = await runtime.dispatchFetch(acceptedRequest.url, {
      method: 'POST',
      headers: Object.fromEntries(acceptedRequest.headers),
      body: acceptedBody,
    });
    expect(accepted.status).toBe(200);
    await accepted.arrayBuffer();
    expect((await state(person, currentEnv)).counts).toMatchObject({
      images: 1,
      tokens: 1,
      aliases: 1,
      audits: 1,
    });
  } finally {
    await runtime.dispose();
  }
}, 30_000);
