import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import Busboy, { type BusboyInstance } from '@fastify/busboy';
import { z } from 'zod';

import { auditActorIp, auditEvent } from './audit';
import { AppError, expiry, id, now } from './common';
import { randomSecret } from './crypto';
import { database, type User } from './db';
import { selectDeliveryDomain, usableDomainSql } from './delivery-domains';
import { digest } from './digest';
import { validateImageExpiry } from './expiry-policy';
import { getEffectiveExpiryPolicy } from './expiry-policy-store';
import { createGifValidator } from './gif';
import { filename, inspectImage } from './media';
import { sanitizeImage } from './metadata';
import {
  contentUrl,
  deletionUrl,
  type PublicUrlEnvironment,
} from './public-urls';
import { allocateShareSlug } from './share-slugs';
import { beginStorage, StorageWriter } from './storage';

const responseSchema = z.object({
  id: z.string(),
  url: z.url().nullable(),
  sharingWarning: z.string().nullable(),
  deleteUrl: z.url(),
  size: z.number(),
  expiresAt: z.string().nullable(),
});
function storageUnavailable() {
  return new AppError(
    503,
    'STORAGE_UNAVAILABLE',
    'Image storage is temporarily unavailable. Please try again.',
  );
}
export async function upload(
  request: Request,
  user: User,
  environment: PublicUrlEnvironment & {
    DB: D1Database;
    BUCKET: R2Bucket;
    MAX_UPLOAD_BYTES: string;
  },
  source: 'bearer' | 'session' = 'session',
) {
  const limit = Number(environment.MAX_UPLOAD_BYTES);
  if (
    !request.body ||
    Number(request.headers.get('content-length') || 0) > limit + 65_536
  )
    throw new AppError(
      413,
      'UPLOAD_TOO_LARGE',
      'The upload exceeds the size limit.',
    );
  const imageId = id('img'),
    stripMetadata = user.stripImageMetadata,
    timestamp = now(),
    d = new Date(timestamp * 1000),
    objectKey = `objects/${user.id}/${d.getUTCFullYear()}/${String(d.getUTCMonth() + 1).padStart(2, '0')}/${imageId}`;
  let parser: BusboyInstance;
  try {
    parser = new Busboy({
      highWaterMark: 65_536,
      fileHwm: 65_536,
      headers: { 'content-type': request.headers.get('content-type') || '' },
      limits: {
        files: 1,
        fields: 2,
        parts: 3,
        fileSize: limit,
        fieldSize: 128,
        headerPairs: 50,
      },
    });
  } catch {
    throw new AppError(
      400,
      'INVALID_MULTIPART',
      'Send one image as multipart field “file”.',
    );
  }
  // A key identifies one logical upload, including retries after a lost response.
  // Pending receipts can only be reclaimed by fenced, physically verified recovery.
  const clientKey = request.headers.get('Idempotency-Key');
  if (clientKey && !/^[\da-f]{64}$/.test(clientKey))
    throw new AppError(400, 'INVALID_UPLOAD_KEY', 'Invalid upload retry key.');
  const receiptKey = clientKey
    ? await digest(`${user.id}:${clientKey}`, 'upload-receipt')
    : undefined;
  const token = clientKey
    ? await digest(`${user.id}:${clientKey}`, 'upload-delete')
    : randomSecret();
  const writerToken = await beginStorage(
    environment.DB,
    objectKey,
    'original',
    imageId,
    user.id,
    receiptKey ?? null,
  );
  if (!writerToken) {
    await request.body.cancel();
    const receipt = await environment.DB.prepare(
      'SELECT response FROM upload_receipts WHERE key = ?',
    )
      .bind(receiptKey)
      .first<{ response: string | null }>();
    if (receipt?.response) {
      const result = responseSchema
        .omit({ deleteUrl: true })
        .parse(JSON.parse(receipt.response));
      return {
        ...result,
        deleteUrl: deletionUrl(result.id, token, environment),
      };
    }
    throw new AppError(
      409,
      'UPLOAD_IN_PROGRESS',
      'This upload is still processing or its outcome is uncertain. Wait, then retry to check again.',
    );
  }
  const writer = new StorageWriter(
    environment.DB,
    environment.BUCKET,
    objectKey,
    writerToken,
  );
  let fileTask: Promise<void> | undefined,
    fileError: Error | undefined,
    originalName = 'image',
    size = 0,
    sha256 = '';
  let metadata: ReturnType<typeof inspectImage> | undefined;
  let activeFile: Readable | undefined;
  let parserError: Error | undefined;
  const parts: R2UploadedPart[] = [];
  let deferredHash = false;
  const reader = request.body.getReader();
  let requestEnded = false;
  let cancellation: Promise<void> | undefined;
  function cancelRequest() {
    if (!requestEnded && !cancellation)
      cancellation = reader.cancel().catch(() => {});
  }
  parser.on('error', (error: Error) => {
    parserError = error;
    activeFile?.destroy(error);
    cancelRequest();
  });
  const abort = () => {
    parser.destroy(new Error('Upload cancelled.'));
    cancelRequest();
  };
  request.signal.addEventListener('abort', abort, { once: true });
  const fields: Record<string, string> = {};
  parser.on('field', (name, value, _nameTruncated, valueTruncated) => {
    if (
      valueTruncated ||
      !['expiry', 'retention', 'expiresAt'].includes(name) ||
      Object.hasOwn(fields, name)
    )
      fileError = new AppError(400, 'INVALID_FIELD', 'Invalid upload options.');
    else {
      const field = name === 'retention' ? 'expiry' : name;
      if (Object.hasOwn(fields, field))
        fileError = new AppError(
          400,
          'INVALID_FIELD',
          'Invalid upload options.',
        );
      else fields[field] = value;
    }
  });
  for (const event of ['filesLimit', 'fieldsLimit', 'partsLimit'] as const)
    parser.on(event, () => {
      fileError = new AppError(
        400,
        'INVALID_MULTIPART',
        'Send exactly one file and valid upload options.',
      );
    });
  parser.on('file', (name, stream, originalFilename) => {
    if (name !== 'file' || fileTask) {
      fileError = new AppError(
        400,
        'INVALID_MULTIPART',
        'Use the file field for your image.',
      );
      stream.resume();
      return;
    }
    originalName = filename(originalFilename);
    activeFile = stream;
    // Observe errors even while createMultipartUpload/uploadPart is pending.
    stream.on('error', () => {});
    fileTask = (async () => {
      try {
        await writer.start();
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw storageUnavailable();
      }
      const prefix = new Uint8Array(1_048_576);
      const tail = new Uint8Array(32);
      // R2 requires a known stream length. Multipart keeps arbitrary multipart
      // request bodies streaming without adding a file-length API requirement.
      let part = new Uint8Array(5 * 1024 * 1024);
      let firstPart: Uint8Array | undefined;
      let prefixLength = 0;
      let tailLength = 0;
      let buffered = 0;
      const hash = createHash('sha256');
      const gif = createGifValidator();
      async function* input() {
        let inputSize = 0;
        for await (const raw of stream) {
          const chunk: unknown = raw;
          if (!(chunk instanceof Uint8Array))
            throw new TypeError('Expected binary upload data.');
          inputSize += chunk.length;
          if (inputSize > limit)
            throw new AppError(
              413,
              'UPLOAD_TOO_LARGE',
              'The image exceeds the upload limit.',
            );
          yield chunk;
        }
        if (stream.truncated)
          throw new AppError(
            413,
            'UPLOAD_TOO_LARGE',
            'The image exceeds the upload limit.',
          );
      }
      const sanitizer = stripMetadata ? sanitizeImage(input()) : undefined;
      const canonical = sanitizer?.bytes ?? input();
      for await (const raw of canonical) {
        const chunk: unknown = raw;
        if (!(chunk instanceof Uint8Array)) {
          throw new TypeError('Expected a binary upload chunk.');
        }
        size += chunk.length;
        deferredHash = sanitizer?.deferredHeader ?? false;
        gif.write(chunk);
        if (prefixLength < prefix.length) {
          const add = chunk.subarray(0, prefix.length - prefixLength);
          prefix.set(add, prefixLength);
          prefixLength += add.length;
        }
        const retained = Math.min(tailLength, Math.max(0, 32 - chunk.length));
        tail.copyWithin(0, tailLength - retained, tailLength);
        const ending = chunk.subarray(Math.max(0, chunk.length - 32));
        tail.set(ending, retained);
        tailLength = retained + ending.length;
        if (!deferredHash) hash.update(chunk);
        for (let offset = 0; offset < chunk.length;) {
          const length = Math.min(
            part.length - buffered,
            chunk.length - offset,
          );
          part.set(chunk.subarray(offset, offset + length), buffered);
          offset += length;
          buffered += length;
          if (buffered !== part.length) continue;
          // Do not overwrite the backing buffer until R2 has consumed it.
          if (deferredHash && !firstPart) {
            firstPart = part;
            part = new Uint8Array(part.length);
          } else {
            const number = parts.length + (firstPart ? 2 : 1);
            try {
              parts.push(await writer.uploadPart(number, part));
            } catch (error) {
              if (error instanceof AppError) throw error;
              throw storageUnavailable();
            }
          }
          if (parserError) throw parserError;
          buffered = 0;
        }
      }
      if (stream.truncated)
        throw new AppError(
          413,
          'UPLOAD_TOO_LARGE',
          'The image exceeds the upload limit.',
        );
      if (deferredHash) {
        sanitizer!.patchHeader(firstPart ?? part.subarray(0, buffered));
        sanitizer!.patchHeader(prefix.subarray(0, prefixLength));
      }
      metadata = inspectImage(
        prefix.subarray(0, prefixLength),
        size,
        tail.subarray(0, tailLength),
        gif,
      );
      try {
        if (buffered)
          parts.push(
            await writer.uploadPart(
              parts.length + (firstPart ? 2 : 1),
              part.subarray(0, buffered),
            ),
          );
        if (firstPart) parts.unshift(await writer.uploadPart(1, firstPart));
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw storageUnavailable();
      }
      if (parserError) throw parserError;
      if (!deferredHash) sha256 = hash.digest('hex');
    })().catch((error: unknown) => {
      fileError =
        error instanceof Error
          ? error
          : new Error('Upload failed.', { cause: error });
      parser.destroy(fileError);
      stream.destroy(fileError);
      cancelRequest();
    });
  });
  try {
    request.signal.throwIfAborted();
    let received = 0;
    async function* chunks() {
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) {
            requestEnded = true;
            return;
          }
          await writer.heartbeat();
          received += value.length;
          if (received > limit + 65_536)
            throw new AppError(
              413,
              'UPLOAD_TOO_LARGE',
              'The upload exceeds the size limit.',
            );
          yield value;
        }
      } finally {
        cancelRequest();
        await cancellation;
        reader.releaseLock();
      }
    }
    await pipeline(
      Readable.from(chunks(), { objectMode: false, highWaterMark: 65_536 }),
      parser,
    );
    await fileTask;
    if (fileError) throw fileError;
    if (!fileTask || !size || !metadata)
      throw new AppError(400, 'MISSING_FILE', 'Choose an image to upload.');
    const expiresAt = expiry(
      fields.expiry || user.defaultExpiry,
      fields.expiresAt,
      timestamp,
    );
    try {
      validateImageExpiry(
        await getEffectiveExpiryPolicy(environment.DB, user),
        timestamp,
        expiresAt,
      );
    } catch (error) {
      if (!fields.expiry && error instanceof AppError)
        throw new AppError(
          error.status,
          error.code,
          `Your saved default image expiry is no longer allowed. Update it in Settings. ${error.message}`,
        );
      throw error;
    }
    const database_ = database(environment.DB);
    request.signal.throwIfAborted();
    try {
      await writer.complete(parts);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw storageUnavailable();
    }
    if (deferredHash) {
      try {
        const object = await environment.BUCKET.get(objectKey);
        if (!object) throw new Error('Canonical image missing.');
        const hash = createHash('sha256');
        const body = (object.body as ReadableStream<Uint8Array>).getReader();
        try {
          while (true) {
            request.signal.throwIfAborted();
            const { value, done } = await body.read();
            if (done) break;
            hash.update(value);
          }
        } finally {
          await body.cancel();
          body.releaseLock();
        }
        sha256 = hash.digest('hex');
      } catch (error) {
        if (request.signal.aborted) throw error;
        throw storageUnavailable();
      }
    }
    const selection = await selectDeliveryDomain(environment.DB, user.id);
    const aliasId = id('lnk');
    const imageMetadata = metadata;
    const deleteHash = await digest(token, 'delete');
    const uploadEvent = await auditEvent(
      database_,
      user.id,
      'image.uploaded',
      imageId,
      {
        name: originalName,
        actorName: user.displayName,
        before: {},
        actorIp: auditActorIp(request),
        context: {
          size,
          mime: metadata.mime,
          expiresAt,
          hostname: selection.domain?.hostname ?? null,
          owner: user.displayName,
        },
      },
    );
    try {
      const commit = async (slug: string | null) => {
        const domain = slug ? selection.domain : null;
        const base = {
          id: imageId,
          size,
          expiresAt: expiresAt
            ? new Date(expiresAt * 1000).toISOString()
            : null,
        };
        const shared = JSON.stringify({
          ...base,
          url:
            domain && slug
              ? contentUrl(domain.hostname, slug, environment)
              : null,
          sharingWarning: null,
        });
        const unshared = JSON.stringify({
          ...base,
          url: null,
          sharingWarning:
            selection.warning ||
            'The selected delivery domain became unavailable while saving. Choose an available domain and create a share link from Images.',
        });
        const choose =
          'CASE WHEN EXISTS(SELECT 1 FROM aliases WHERE id=?) THEN ? ELSE ? END';
        const binding = environment.DB;
        request.signal.throwIfAborted();
        const statements = [
          writer.finalizeStatement(),
          binding
            .prepare(
              'INSERT INTO images(id,userId,objectKey,filename,mime,extension,size,sha256,width,height,createdAt,expiresAt) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
            )
            .bind(
              imageId,
              user.id,
              objectKey,
              originalName,
              imageMetadata.mime,
              imageMetadata.extension,
              size,
              sha256,
              imageMetadata.width,
              imageMetadata.height,
              timestamp,
              expiresAt,
            ),
          ...(domain && slug
            ? [
                binding
                  .prepare(
                    `INSERT INTO aliases(id,imageId,deliveryDomainId,slug,"primary",expiresAt,createdAt) SELECT ?,?,?,?,1,?,? FROM delivery_domains d JOIN users u ON u.id=? WHERE d.id=? AND ${usableDomainSql}`,
                  )
                  .bind(
                    aliasId,
                    imageId,
                    domain.id,
                    slug,
                    expiresAt,
                    timestamp,
                    user.id,
                    domain.id,
                  ),
              ]
            : []),
          binding
            .prepare('INSERT INTO delete_tokens(imageId,hash) VALUES(?,?)')
            .bind(imageId, deleteHash),
          binding
            .prepare('UPDATE users SET uploadCount=uploadCount+1 WHERE id=?')
            .bind(user.id),
          ...(source === 'bearer'
            ? [
                binding
                  .prepare(
                    "UPDATE users SET onboardingUploadStatus='verified',onboardingUploadImageId=? WHERE id=? AND onboardingUploadStatus='waiting' AND onboardingUploadBaseline IS NOT NULL AND uploadCount>=onboardingUploadBaseline",
                  )
                  .bind(imageId, user.id),
              ]
            : []),
          binding
            .prepare(
              'INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) VALUES(?,?,?,?,?,?)',
            )
            .bind(
              uploadEvent.id,
              uploadEvent.actorId,
              uploadEvent.action,
              uploadEvent.targetId,
              uploadEvent.metadata,
              uploadEvent.createdAt,
            ),
          ...(receiptKey
            ? [
                binding
                  .prepare(
                    `UPDATE upload_receipts SET response=${choose} WHERE key=? AND response IS NULL`,
                  )
                  .bind(aliasId, shared, unshared, receiptKey),
              ]
            : []),
          binding
            .prepare(`SELECT ${choose} AS response`)
            .bind(aliasId, shared, unshared),
        ];
        const results = await binding.batch<{ response: string }>(statements);
        const result = responseSchema
          .omit({ deleteUrl: true })
          .parse(JSON.parse(results.at(-1)!.results[0].response));
        return {
          ...result,
          deleteUrl: deletionUrl(imageId, token, environment),
        };
      };
      if (!selection.domain) return await commit(null);
      try {
        return await allocateShareSlug(environment.DB, commit);
      } catch (error) {
        if (
          error instanceof AppError &&
          error.code === 'SHARE_LINK_UNAVAILABLE'
        )
          return await commit(null);
        throw error;
      }
    } catch (error) {
      if (error instanceof AppError || request.signal.aborted) throw error;
      if (String(error).includes('quota_exceeded'))
        throw new AppError(
          413,
          'QUOTA_EXCEEDED',
          'Your storage quota has been exceeded.',
        );
      if (String(error).includes('account_inactive'))
        throw new AppError(
          403,
          'ACCOUNT_DISABLED',
          'This account is disabled.',
        );
      console.error(
        JSON.stringify({ event: 'upload.persistence_failed', imageId }),
      );
      throw new AppError(
        503,
        'SHARE_LINK_UNAVAILABLE',
        'Share links are temporarily unavailable. Please try again.',
      );
    }
  } catch (error) {
    cancelRequest();
    activeFile?.destroy();
    await fileTask;
    await cancellation;
    try {
      await writer.cleanup();
    } catch {
      console.error(
        JSON.stringify({ event: 'upload.cleanup_failed', imageId }),
      );
    }
    if (error instanceof AppError) throw error;
    if (error instanceof z.ZodError) throw error;
    throw new AppError(
      400,
      'UPLOAD_FAILED',
      'The upload could not be completed. Check the file and try again.',
    );
  } finally {
    request.signal.removeEventListener('abort', abort);
    if (request.body.locked) reader.releaseLock();
  }
}
