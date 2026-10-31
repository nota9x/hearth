import { z } from 'zod';

import { auditEvent } from './audit.ts';
import { requireAdmin } from './auth.ts';
import { AppError } from './common.ts';
import { database, type User } from './db.ts';

export const SHARE_SLUG_ALPHABET =
  'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const shareSlugLengthSchema = z.number().int().min(3).max(64);
const slugConfigSchema = z.object({
  defaultLength: shareSlugLengthSchema,
  automaticFloor: shareSlugLengthSchema,
});
const settingKey = 'shareSlugConfiguration';
const effectiveSql =
  "max(json_extract(value, '$.defaultLength'), json_extract(value, '$.automaticFloor'))";
const maximumAttempts = 12;
const maximumExpansions = 3;
const collisionThreshold = 3;

export type ShareSlugConfig = z.infer<typeof slugConfigSchema> & {
  effectiveLength: number;
};

function unavailable() {
  return new AppError(
    503,
    'SHARE_LINK_UNAVAILABLE',
    'Share links are temporarily unavailable. Please try again.',
  );
}

function parseConfig(
  row: { value: string } | null | undefined,
): ShareSlugConfig {
  try {
    const config = slugConfigSchema.parse(row ? JSON.parse(row.value) : null);
    return {
      ...config,
      effectiveLength: Math.max(config.defaultLength, config.automaticFloor),
    };
  } catch {
    console.error(
      JSON.stringify({ event: 'share_slug.invalid_configuration' }),
    );
    throw unavailable();
  }
}

export async function getShareSlugConfig(binding: D1Database) {
  return parseConfig(
    await binding
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .bind(settingKey)
      .first<{ value: string }>(),
  );
}

function generateSlug(length: number) {
  let slug = '';
  const bytes = new Uint8Array(length * 2);
  // Reject 248..255 so every Base62 character has exactly four byte values.
  while (slug.length < length) {
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 248) slug += SHARE_SLUG_ALPHABET[byte % 62];
      if (slug.length === length) return slug;
    }
  }
  return slug;
}

export function isShareSlugCollision(error: unknown): boolean {
  while (error instanceof Error) {
    if (
      /UNIQUE constraint failed: aliases\.deliveryDomainId, aliases\.slug(?:$|:)/.test(
        error.message,
      )
    )
      return true;
    error = error.cause;
  }
  return false;
}

async function changeConfig(
  binding: D1Database,
  field: 'defaultLength' | 'automaticFloor',
  previous: number,
  length: number,
  event: Awaited<ReturnType<typeof auditEvent>>,
) {
  const guard =
    field === 'automaticFloor'
      ? effectiveSql
      : "json_extract(value, '$.defaultLength')";
  // Audit before UPDATE with the same predicate: the entire D1 batch is atomic.
  // A stale contender inserts no event and reads the winning config.
  const results = await binding.batch<{ value: string }>([
    binding
      .prepare(
        `INSERT INTO audit_log (id, actorId, action, targetId, metadata, createdAt)
         SELECT ?, ?, ?, ?, ?, ? FROM app_settings WHERE key = ? AND ${guard} = ?`,
      )
      .bind(
        event.id,
        event.actorId,
        event.action,
        event.targetId,
        event.metadata,
        event.createdAt,
        settingKey,
        previous,
      ),
    binding
      .prepare(
        `UPDATE app_settings SET value = json_set(value, '$.${field}', ?)
         WHERE key = ? AND ${guard} = ?`,
      )
      .bind(length, settingKey, previous),
    binding
      .prepare('SELECT value FROM app_settings WHERE key = ?')
      .bind(settingKey),
  ]);
  return {
    changed: results[1].meta.changes > 0,
    config: parseConfig(results[2].results[0]),
  };
}

export async function setShareSlugDefault(
  binding: D1Database,
  input: unknown,
  actor: User,
  actorIp: string | null,
) {
  requireAdmin(actor);
  const length = shareSlugLengthSchema.parse(input);
  for (let attempt = 0; attempt < 3; attempt++) {
    const previous = await getShareSlugConfig(binding);
    if (previous.defaultLength === length) return previous;
    const event = await auditEvent(
      database(binding),
      actor.id,
      'settings.share_slug_length',
      settingKey,
      {
        name: 'Share-link IDs',
        actorName: actor.displayName,
        actorIp,
        before: { defaultSlugLength: previous.defaultLength },
        after: { defaultSlugLength: length },
      },
    );
    const result = await changeConfig(
      binding,
      'defaultLength',
      previous.defaultLength,
      length,
      event,
    );
    if (result.changed || result.config.defaultLength === length)
      return result.config;
  }
  throw new AppError(
    409,
    'SETTINGS_CHANGED',
    'Settings changed while saving. Refresh and try again.',
  );
}

async function expandNamespace(binding: D1Database, length: number) {
  const event = await auditEvent(
    database(binding),
    null,
    'share_slug.expanded',
    settingKey,
    {
      name: 'Share-link IDs',
      before: { allocationSlugLength: length },
      after: { allocationSlugLength: length + 1 },
      context: {
        reason: 'Three address collisions at the current allocation length',
      },
    },
  );
  try {
    const result = await changeConfig(
      binding,
      'automaticFloor',
      length,
      length + 1,
      event,
    );
    return result.config;
  } catch {
    // The batch may have committed despite a lost response. Do not expand twice.
    const current = await getShareSlugConfig(binding);
    if (current.effectiveLength > length) return current;
    console.error(JSON.stringify({ event: 'share_slug.expansion_failed' }));
    throw unavailable();
  }
}

export async function allocateShareSlug<T>(
  binding: D1Database,
  commit: (slug: string) => Promise<T>,
): Promise<T> {
  let config = await getShareSlugConfig(binding);
  let collisions = 0;
  let expansions = 0;
  for (let attempt = 0; attempt < maximumAttempts; attempt++) {
    try {
      return await commit(generateSlug(config.effectiveLength));
    } catch (error) {
      if (!isShareSlugCollision(error)) throw error;
    }
    collisions++;
    if (attempt === maximumAttempts - 1) break;
    const previousLength = config.effectiveLength;
    // At occupancy p, three independent collisions have probability p³.
    // This detects pressure without counting aliases or maintaining counters.
    if (
      collisions >= collisionThreshold &&
      expansions < maximumExpansions &&
      previousLength < 64
    ) {
      config = await expandNamespace(binding, previousLength);
      expansions++;
      collisions = 0;
    } else {
      config = await getShareSlugConfig(binding);
      if (config.effectiveLength !== previousLength) collisions = 0;
    }
  }
  console.error(JSON.stringify({ event: 'share_slug.allocation_exhausted' }));
  throw unavailable();
}
