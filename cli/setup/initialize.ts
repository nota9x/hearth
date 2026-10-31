import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import type { PlatformProxy } from 'wrangler';
import { z } from 'zod';

import { authenticateKey, requireAdmin } from '../../packages/core/auth.ts';
import { AppError, now } from '../../packages/core/common.ts';
import {
  primaryDeliveryDomain,
  saveDeliveryDomain,
  selectDeliveryDomain,
  setPrimaryDeliveryDomain,
} from '../../packages/core/delivery-domains.ts';
import { digest } from '../../packages/core/digest.ts';
import { validateDeliveryDomain } from '../../packages/core/domain-validation.ts';
import { deleteImage } from '../../packages/core/images.ts';
import { createLink } from '../../packages/core/links.ts';
import { contentUrl } from '../../packages/core/public-urls.ts';
import { initializeFreshStorageSql } from '../bootstrap-data.ts';
import { type ProductionConfig } from '../production-config.ts';
import type { Cloudflare } from './cloudflare.ts';
import { SetupFailure } from './cloudflare.ts';
import { setupDirectory, type SetupState } from './state.ts';

export interface SetupBindings {
  DB: D1Database;
  BUCKET: R2Bucket;
  APP_ORIGIN: string;
  ENVIRONMENT: string;
}

// Only the installer calls this after verifying both successful creation checkpoints.
export async function initializeFreshStorage(db: D1Database) {
  await db.prepare(initializeFreshStorageSql).run();
  const capacity = await db
    .prepare('SELECT ready FROM storage_capacity WHERE id=1')
    .first<{ ready: number }>();
  if (!capacity?.ready)
    throw new SetupFailure(
      'Dedicated storage accounting could not be initialized safely. No Workers were activated; review setup provenance and recover accounting before continuing.',
    );
}

export async function withBindings<T>(
  cloudflare: Cloudflare,
  config: Pick<ProductionConfig, 'vars' | 'compatibility_date'> & {
    d1_databases: ProductionConfig['d1_databases'][number][];
    r2_buckets: ProductionConfig['r2_buckets'][number][];
  },
  operation: (environment: SetupBindings) => Promise<T>,
): Promise<T> {
  if (!cloudflare.token || !cloudflare.accountId)
    throw new SetupFailure(
      'Refresh Cloudflare authentication before opening remote bindings.',
      'authentication',
    );
  const file = path.join(setupDirectory, 'bindings.local.jsonc');
  await writeFile(
    file,
    JSON.stringify({
      name: 'hearth-installer',
      account_id: cloudflare.accountId,
      compatibility_date: config.compatibility_date,
      compatibility_flags: ['nodejs_compat'],
      vars: { APP_ORIGIN: config.vars?.APP_ORIGIN, ENVIRONMENT: 'production' },
      d1_databases: config.d1_databases
        .filter((binding) => binding.binding === 'DB')
        .map((binding) => ({ ...binding, remote: true })),
      r2_buckets: config.r2_buckets
        .filter((binding) => binding.binding === 'BUCKET')
        .map((binding) => ({ ...binding, remote: true })),
      workers_dev: false,
      preview_urls: false,
    }),
    { mode: 0o600 },
  );
  const keys = [
    'CLOUDFLARE_API_TOKEN',
    'CLOUDFLARE_API_KEY',
    'CLOUDFLARE_EMAIL',
    'CLOUDFLARE_ACCOUNT_ID',
    'CF_API_TOKEN',
    'CF_API_KEY',
    'CF_EMAIL',
    'CF_ACCOUNT_ID',
    'CLOUDFLARE_ENV',
    'WRANGLER_WRITE_LOGS',
    'WRANGLER_LOG',
    'WRANGLER_LOG_SANITIZE',
    'WRANGLER_OUTPUT_FILE_PATH',
    'WRANGLER_OUTPUT_FILE_DIRECTORY',
  ];
  const previous = Object.fromEntries(
    keys.map((key) => [key, process.env[key]]),
  );
  for (const key of keys) delete process.env[key];
  process.env.CLOUDFLARE_API_TOKEN = cloudflare.token;
  process.env.CLOUDFLARE_ACCOUNT_ID = cloudflare.accountId;
  process.env.WRANGLER_WRITE_LOGS = 'false';
  process.env.WRANGLER_LOG = 'none';
  process.env.WRANGLER_LOG_SANITIZE = 'true';
  let platform: PlatformProxy<SetupBindings> | undefined;
  let disposal: Promise<void> | undefined;
  const dispose = () => {
    // Event callbacks cannot await cleanup; finally also waits for this promise.
    // eslint-disable-next-line unicorn/prefer-await
    disposal ??= platform?.dispose().catch(() => {});
  };
  try {
    const { getPlatformProxy } = await import('wrangler');
    platform = await getPlatformProxy<SetupBindings>({
      configPath: file,
      persist: false,
      remoteBindings: true,
      envFiles: [],
    });
    cloudflare.controller.signal.throwIfAborted();
    cloudflare.controller.signal.addEventListener('abort', dispose, {
      once: true,
    });
    return await operation(platform.env);
  } catch (error) {
    if (
      cloudflare.controller.signal.aborted ||
      (error instanceof Error && error.name === 'SetupCancelled')
    )
      throw error;
    if (error instanceof SetupFailure) throw error;
    if (error instanceof AppError) throw new SetupFailure(error.message);
    throw new SetupFailure(
      'Hearth initialization could not complete. Check remote-binding access, account onboarding, and the selected D1/R2 resources, then retry. Private binding diagnostics were suppressed.',
    );
  } finally {
    cloudflare.controller.signal.removeEventListener('abort', dispose);
    try {
      await (disposal ?? platform?.dispose());
    } finally {
      for (const key of keys) {
        if (previous[key] === undefined) delete process.env[key];
        else process.env[key] = previous[key];
      }
    }
  }
}

export async function administrator(environment: SetupBindings, key: string) {
  try {
    const result = await authenticateKey(environment.DB, key);
    requireAdmin(result.user);
    return result.user;
  } catch {
    throw new SetupFailure(
      'The Hearth key does not authenticate an active administrator. Enter the saved administrator key; setup will not replace it.',
    );
  }
}

export async function verifyBrowserLogin(
  environment: SetupBindings,
  key: string,
  since: number,
) {
  const actor = await administrator(environment, key);
  const session = await environment.DB.prepare(
    'SELECT 1 AS present FROM sessions JOIN api_keys USING(userId) WHERE sessions.userId=? AND sessions.createdAt>=? AND sessions.expiresAt>? AND sessions.version=api_keys.version LIMIT 1',
  )
    .bind(actor.id, since, now())
    .first();
  return session !== null;
}

export async function initializeDomains(
  environment: SetupBindings,
  key: string,
  hostnames: string[],
  selectInitial = true,
) {
  const actor = await administrator(environment, key);
  for (const hostname of hostnames) {
    const existing = await environment.DB.prepare(
      'SELECT id,enabled FROM delivery_domains WHERE hostname=?',
    )
      .bind(hostname)
      .first<{ id: string; enabled: number }>();
    if (existing && !existing.enabled)
      throw new SetupFailure(
        `${hostname} is disabled in Hearth. An administrator must enable it before retrying; setup preserves existing availability policies.`,
      );
    const domain =
      existing ??
      (await saveDeliveryDomain(
        environment.DB,
        actor,
        { hostname, accessMode: 'everyone' },
        environment,
      ));
    const validated = await validateDeliveryDomain(
      environment,
      actor,
      domain.id,
    );
    if (validated.diagnostics?.outcome !== 'passed')
      throw new SetupFailure(
        validated.diagnostics?.message ??
          'The delivery domain did not pass its storage and HTTPS check.',
      );
    if (selectInitial && !(await primaryDeliveryDomain(environment.DB)))
      await setPrimaryDeliveryDomain(
        environment.DB,
        actor,
        domain.id,
        validated.revision,
      );
  }
}

export const smokeImage = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
  'base64',
);
const uploadResponse = z.object({ id: z.string(), url: z.url().nullable() });
const uploadKeys = new WeakMap<SetupState, string>();

export async function verifyUpload(
  environment: SetupBindings,
  key: string,
  state: SetupState,
  checkpoint: () => Promise<void>,
  request: typeof fetch = fetch,
) {
  const actor = await administrator(environment, key);
  const origin = environment.APP_ORIGIN;
  let clientKey = uploadKeys.get(state);
  if (!state.probe) {
    clientKey = crypto.getRandomValues(new Uint8Array(32)).toHex();
    uploadKeys.set(state, clientKey);
    state.probe = {
      receiptHash: await digest(`${actor.id}:${clientKey}`, 'upload-receipt'),
      ownerId: actor.id,
      attempted: false,
    };
    await checkpoint();
  }
  if (state.probe.ownerId !== actor.id)
    throw new SetupFailure(
      'Resume the pending verification with its original administrator key so setup can reconcile its image safely.',
    );
  let stored = await environment.DB.prepare(
    'SELECT response FROM upload_receipts WHERE key=?',
  )
    .bind(state.probe.receiptHash)
    .first<{ response: string | null }>();
  if (stored?.response) {
    const response = uploadResponse.parse(JSON.parse(stored.response));
    state.probe.imageId = response.id;
    if (response.url) state.probe.url = response.url;
  } else if (!state.probe.imageId) {
    if (stored)
      throw new SetupFailure(
        'The verification upload is still pending or uncertain. Let scheduled maintenance reconcile it, then retry. No duplicate image will be uploaded.',
      );
    if (!clientKey) {
      if (state.probe.attempted)
        throw new SetupFailure(
          'The interrupted verification has no receipt yet, so its outcome cannot be proven. Check the web Worker’s upload logs and let in-flight work finish, then retry. Setup preserves this check and will not risk a duplicate upload.',
        );
      state.probe = undefined;
      await checkpoint();
      throw new SetupFailure(
        'Setup stopped before sending the previous verification upload. Retry to start its check.',
      );
    }
    const form = new FormData();
    form.set('expiry', '1h');
    form.set(
      'file',
      new Blob([smokeImage], { type: 'image/png' }),
      'hearth-setup.png',
    );
    let response: Response;
    state.probe.attempted = true;
    await checkpoint();
    try {
      response = await request(`${origin}/api/v1/images`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${key}`,
          'Idempotency-Key': clientKey,
        },
        body: form,
        redirect: 'error',
        signal: AbortSignal.timeout(60_000),
      });
    } catch {
      throw new SetupFailure(
        'The verification upload response was lost. Retry to inspect its receipt before uploading again.',
        'transient',
      );
    }
    if (![201, 409].includes(response.status))
      throw new SetupFailure(
        `The deployed upload API returned ${response.status}. Check the web Worker and retry.`,
      );
    const value = uploadResponse.safeParse(await response.json());
    if (!value.success)
      throw new SetupFailure(
        'The upload is pending or returned an unexpected response. Retry to reconcile its receipt.',
      );
    state.probe.imageId = value.data.id;
    if (value.data.url) state.probe.url = value.data.url;
    await checkpoint();
    stored = await environment.DB.prepare(
      'SELECT response FROM upload_receipts WHERE key=?',
    )
      .bind(state.probe.receiptHash)
      .first<{ response: string | null }>();
    if (!stored?.response)
      throw new SetupFailure(
        'The verification upload commitment could not be confirmed. Retry before continuing.',
      );
  }
  const imageId = state.probe.imageId;
  if (!imageId)
    throw new SetupFailure(
      'The verification image is not committed yet. Retry after maintenance recovery.',
    );
  const image = await environment.DB.prepare(
    'SELECT userId,deletedAt,sha256 FROM images WHERE id=?',
  )
    .bind(imageId)
    .first<{ userId: string; deletedAt: number | null; sha256: string }>();
  if (!image || image.userId !== actor.id)
    throw new SetupFailure(
      'The verification image could not be matched to its owner. No objects were removed.',
    );
  if (image.deletedAt === null) {
    if (!state.probe.url) {
      const selection = await selectDeliveryDomain(environment.DB, actor.id);
      if (!selection.domain) throw new SetupFailure(selection.warning);
      const existing = await environment.DB.prepare(
        'SELECT slug FROM aliases WHERE imageId=? AND deliveryDomainId=? AND disabledAt IS NULL AND (expiresAt IS NULL OR expiresAt>unixepoch()) LIMIT 1',
      )
        .bind(imageId, selection.domain.id)
        .first<{ slug: string }>();
      const result =
        existing ??
        (await createLink(environment.DB, actor, {
          imageId,
          deliveryDomainId: selection.domain.id,
          expiry: 'never',
        }));
      state.probe.url = contentUrl(
        selection.domain.hostname,
        result.slug,
        environment,
      );
      await checkpoint();
    }
    const url = state.probe.url;
    if (!url)
      throw new SetupFailure(
        'The verification image has no delivery link. Repair the instance/personal delivery selection and retry.',
      );
    const target = new URL(url);
    const domains = await environment.DB.prepare(
      'SELECT hostname FROM delivery_domains WHERE id IN (SELECT deliveryDomainId FROM aliases WHERE imageId=?)',
    )
      .bind(imageId)
      .all<{ hostname: string }>();
    if (
      target.protocol !== 'https:' ||
      domains.results.every((domain) => domain.hostname !== target.hostname)
    )
      throw new SetupFailure(
        'The verification URL does not match this image’s delivery domains.',
      );
    const get = (headers?: HeadersInit, method = 'GET') =>
      request(url, {
        method,
        headers,
        redirect: 'error',
        signal: AbortSignal.timeout(30_000),
      });
    const publicResponse = await get();
    if (
      publicResponse.status !== 200 ||
      publicResponse.headers.get('content-type')?.split(';', 1)[0] !==
        'image/png'
    )
      throw new SetupFailure(
        'Public image delivery did not return the expected PNG. Repair delivery and retry.',
      );
    const bytes = new Uint8Array(await publicResponse.arrayBuffer());
    const hash = await crypto.subtle.digest('SHA-256', bytes);
    if (new Uint8Array(hash).toHex() !== image.sha256)
      throw new SetupFailure(
        'The delivered image bytes do not match the committed upload.',
      );
    const head = await get(undefined, 'HEAD');
    if (
      head.status !== 200 ||
      Number(head.headers.get('content-length')) !== bytes.length
    )
      throw new SetupFailure('Delivery HEAD verification failed.');
    const range = await get({ Range: 'bytes=0-3' });
    if (
      range.status !== 206 ||
      !Buffer.from(await range.arrayBuffer()).equals(
        Buffer.from(bytes.slice(0, 4)),
      )
    )
      throw new SetupFailure('Delivery range verification failed.');
    const etag = publicResponse.headers.get('etag');
    const conditional = etag ? await get({ 'If-None-Match': etag }) : undefined;
    if (conditional?.status !== 304)
      throw new SetupFailure(
        'Delivery conditional-request verification failed.',
      );
    await deleteImage(
      environment.DB,
      environment.BUCKET,
      imageId,
      actor.id,
      'Installer verification',
    );
  }
  if (state.probe.url) {
    const removed = await request(state.probe.url, {
      redirect: 'error',
      signal: AbortSignal.timeout(30_000),
    });
    if (removed.status !== 404)
      throw new SetupFailure(
        'The deleted verification image is still publicly accessible. Check caching rules and retry.',
      );
  }
  const cleanup = await environment.DB.prepare(
    'SELECT purgedAt FROM images WHERE id=?',
  )
    .bind(imageId)
    .first<{ purgedAt: number | null }>();
  if (cleanup?.purgedAt === null) {
    await deleteImage(
      environment.DB,
      environment.BUCKET,
      imageId,
      actor.id,
      'Installer verification',
    );
    throw new SetupFailure(
      'The verification image is private, but R2 cleanup is pending. Check storage access or let maintenance retry, then continue here.',
    );
  }
  state.probe = undefined;
  uploadKeys.delete(state);
  await checkpoint();
}
