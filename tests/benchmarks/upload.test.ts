import { Buffer } from 'node:buffer';
import { readFile, writeFile } from 'node:fs/promises';
import { crc32 } from 'node:zlib';

import { eq } from 'drizzle-orm';
import { convertV4MiniflareOptions, Miniflare } from 'miniflare';
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';

import { createUser } from '../../packages/core/auth';
import { randomSecret } from '../../packages/core/crypto';
import { database, type User } from '../../packages/core/db';
import { deliveryDomains, users } from '../../packages/core/schema';
import type { upload } from '../../packages/core/upload';
import { migrateDatabase } from '../helpers/database';
import { workerBundle, workerCompatibility } from '../helpers/workers';

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

beforeAll(async () => {
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
afterAll(async () => {
  await mf?.dispose();
});

function imageBytes(size: number) {
  const bytes = Buffer.alloc(size, 0x61);
  png.copy(bytes);
  png.subarray(-12).copy(bytes, size - 12);
  return bytes;
}

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

it('compares metadata stripping and opt-out under workerd backpressure', async () => {
  const pngText = Buffer.alloc(2 * 1024 * 1024, 65);
  Buffer.from('Comment\0Private benchmark ').copy(pngText);
  const pngHeader = Buffer.alloc(8);
  pngHeader.writeUInt32BE(pngText.length);
  pngHeader.write('tEXt', 4);
  const pngCrc = Buffer.alloc(4);
  pngCrc.writeUInt32BE(crc32(Buffer.concat([Buffer.from('tEXt'), pngText])));
  const jpeg = await readFile('tests/fixtures/metadata/orientation-8.jpg');
  const app = Buffer.alloc(65_534, 65);
  app.set([255, 237, 255, 252]);
  const bytes = [
    Buffer.concat([
      png.subarray(0, -12),
      pngHeader,
      pngText,
      pngCrc,
      png.subarray(-12),
    ]),
    Buffer.concat([
      jpeg.subarray(0, -2),
      ...Array.from({ length: 32 }, () => app),
      jpeg.subarray(-2),
    ]),
    await largeWebp(),
  ];
  const bodies = bytes.map((file) => Buffer.concat([header, file, footer]));
  const rows: {
    stripping: boolean;
    concurrency: number;
    r2DelayMs: number;
    filesPerSecond: number;
    medianMs: number;
    p95Ms: number;
    errors: number;
  }[] = [];
  try {
    for (const stripping of [false, true]) {
      await database(env.DB)
        .update(users)
        .set({ stripImageMetadata: stripping })
        .where(eq(users.id, user.id));
      const warm = await mf.dispatchFetch(
        'https://app.example.com/api/upload',
        {
          method: 'POST',
          headers: { 'content-type': contentType },
          body: bodies[0],
        },
      );
      await warm.text();
      expect(warm.status).toBe(200);
      for (const r2DelayMs of [0, 75]) {
        for (const concurrency of [1, 2]) {
          const latencies: number[] = [];
          let next = 0,
            errors = 0;
          const count = 6;
          const started = performance.now();
          await Promise.all(
            Array.from({ length: concurrency }, async () => {
              while (next < count) {
                const index = next++;
                const start = performance.now();
                const response = await mf.dispatchFetch(
                  'https://app.example.com/api/upload',
                  {
                    method: 'POST',
                    headers: {
                      'content-type': contentType,
                      'X-Benchmark-R2-Delay-Ms': String(r2DelayMs),
                    },
                    body: bodies[index % bodies.length],
                  },
                );
                await response.text();
                if (response.status !== 200) errors++;
                latencies.push(performance.now() - start);
              }
            }),
          );
          latencies.sort((a, b) => a - b);
          rows.push({
            stripping,
            concurrency,
            r2DelayMs,
            filesPerSecond: (count * 1000) / (performance.now() - started),
            medianMs: latencies[2],
            p95Ms: latencies[5],
            errors,
          });
        }
      }
    }
  } finally {
    await database(env.DB)
      .update(users)
      .set({ stripImageMetadata: false })
      .where(eq(users.id, user.id));
  }
  await writeFile(
    'artifacts/metadata-benchmark.json',
    JSON.stringify(rows, null, 2),
  );
  console.log('LOCAL_METADATA_BENCHMARK', JSON.stringify(rows));
  expect(rows.every((row) => row.errors === 0)).toBe(true);
}, 120_000);

it('benchmarks bounded upload concurrency in local workerd', async () => {
  const sizes = [256 * 1024, 2 * 1024 * 1024, 8 * 1024 * 1024];
  const bodies = sizes.map((size) =>
    Buffer.concat([header, imageBytes(size), footer]),
  );
  const rows: Record<string, number>[] = [];
  // Warm the worker, R2 and D1 before timing.
  await mf.dispatchFetch('https://app.example.com/api/upload', {
    method: 'POST',
    headers: { 'content-type': contentType },
    body: bodies[0],
  });
  for (const r2DelayMs of [0, 75]) {
    for (const concurrency of [1, 2, 3, 6, 8]) {
      for (let repetition = 0; repetition < 3; repetition++) {
        const count = 12,
          latencies: number[] = [];
        let next = 0,
          errors = 0;
        let d1Ms = 0,
          r2Ms = 0,
          parts = 0;
        const started = performance.now();
        const cpu = process.cpuUsage();
        let peakDriverRss = process.memoryUsage().rss;
        const sample = setInterval(() => {
          peakDriverRss = Math.max(peakDriverRss, process.memoryUsage().rss);
        }, 20);
        try {
          await Promise.all(
            Array.from({ length: concurrency }, async () => {
              while (next < count) {
                const index = next++;
                const start = performance.now();
                const response = await mf.dispatchFetch(
                  'https://app.example.com/api/upload',
                  {
                    method: 'POST',
                    headers: {
                      'content-type': contentType,
                      'Idempotency-Key': randomSecret(),
                      'X-Benchmark-R2-Delay-Ms': String(r2DelayMs),
                    },
                    body: bodies[index % bodies.length],
                  },
                );
                await response.text();
                if (response.status !== 200) errors++;
                d1Ms += Number(response.headers.get('X-Upload-D1-Ms'));
                r2Ms += Number(response.headers.get('X-Upload-R2-Part-Ms'));
                parts += Number(response.headers.get('X-Upload-R2-Parts'));
                latencies.push(performance.now() - start);
              }
            }),
          );
        } finally {
          clearInterval(sample);
        }
        const elapsed = performance.now() - started;
        const usage = process.cpuUsage(cpu);
        latencies.sort((a, b) => a - b);
        rows.push({
          concurrency,
          r2DelayMs,
          meanD1BatchMs: d1Ms / count,
          meanR2PartMs: r2Ms / parts,
          parts,
          repetition,
          seconds: elapsed / 1000,
          filesPerSecond: (count * 1000) / elapsed,
          mibPerSecond:
            (((sizes.reduce((sum, size) => sum + size, 0) * 4) / 1_048_576) *
              1000) /
            elapsed,
          medianLatencyMs: latencies[5],
          p95LatencyMs: latencies[11],
          errors,
          driverPeakRssMiB: peakDriverRss / 1_048_576,
          driverCpuMs: (usage.user + usage.system) / 1000,
        });
      }
    }
  }
  console.log('LOCAL_UPLOAD_BENCHMARK', JSON.stringify(rows));
  const { writeFile } = await import('node:fs/promises');
  await writeFile(
    'artifacts/upload-benchmark.json',
    JSON.stringify(rows, null, 2),
  );
  expect(rows.every((row) => row.errors === 0)).toBe(true);
}, 180_000);
