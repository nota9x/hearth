import { eq, sql } from 'drizzle-orm';

import { auditEvent } from './audit.ts';
import { authorizeOwner } from './auth.ts';
import { AppError, expiry, id, now, slugSchema } from './common.ts';
import { database, type User } from './db.ts';
import {
  availableDeliveryDomains,
  requireDeliveryDomain,
  selectDeliveryDomain,
} from './delivery-domains.ts';
import {
  expiryChoices,
  resolveExpiryPolicy,
  validateResourceExpiry,
} from './expiry-policy.ts';
import { getInstanceExpiryPolicy } from './expiry-policy-store.ts';
import { type DeleteResult, ownedImage } from './images.ts';
import { aliases, deliveryDomains, images, users } from './schema.ts';
import { allocateShareSlug } from './share-slugs.ts';

export async function selectedLinks(
  binding: D1Database,
  actor: User,
  ids: string[],
) {
  const rows = await database(binding)
    .select({
      link: aliases,
      owner: users,
      image: {
        id: images.id,
        filename: images.filename,
        expiresAt: images.expiresAt,
        deletedAt: images.deletedAt,
      },
      deliveryHostname: deliveryDomains.hostname,
    })
    .from(aliases)
    .innerJoin(images, eq(images.id, aliases.imageId))
    .innerJoin(users, eq(users.id, images.userId))
    .innerJoin(
      deliveryDomains,
      eq(deliveryDomains.id, aliases.deliveryDomainId),
    )
    .where(
      sql`${aliases.id} in (select value from json_each(${JSON.stringify([...new Set(ids)])}))`,
    );
  for (const row of rows) authorizeOwner(actor, row.owner.id);
  return rows;
}
async function expirySelection(
  binding: D1Database,
  actor: User,
  ids: string[],
) {
  const rows = await selectedLinks(binding, actor, ids);
  if (
    rows.length !== new Set(ids).size ||
    rows.some(
      (row) => row.link.disabledAt !== null || row.image.deletedAt !== null,
    )
  )
    throw new AppError(
      409,
      'SELECTION_CHANGED',
      'Some links no longer exist. Refresh your selection.',
    );
  const instance = await getInstanceExpiryPolicy(binding);
  const policies = rows.map((row) => resolveExpiryPolicy(instance, row.owner));
  let maximum: number | null = null;
  let deadline: number | null = null;
  for (const [index, row] of rows.entries()) {
    const limit = policies[index].maxLifetimeSeconds;
    if (limit === null) continue;
    maximum = maximum === null ? limit : Math.min(maximum, limit);
    const next = row.link.createdAt + limit;
    deadline = deadline === null ? next : Math.min(deadline, next);
  }
  const policy = {
    requireExpiry: policies.some((p) => p.requireExpiry),
    maxLifetimeSeconds: maximum,
    source: 'custom' as const,
  };
  return {
    rows,
    policies,
    policy,
    deadline,
    choices: expiryChoices(policy, deadline),
  };
}
export async function linkExpiryOptions(
  binding: D1Database,
  actor: User,
  ids: string[],
) {
  const { policy, deadline, choices } = await expirySelection(
    binding,
    actor,
    ids,
  );
  return { policy, deadline, choices };
}
export async function linkCreationOptions(
  binding: D1Database,
  actor: User,
  imageId: string,
) {
  const image = await ownedImage(binding, actor, imageId);
  const [owner] = await database(binding)
    .select()
    .from(users)
    .where(eq(users.id, image.userId));
  if (
    owner.status !== 'active' ||
    (image.expiresAt !== null && image.expiresAt <= now())
  )
    throw new AppError(
      409,
      'UNAVAILABLE',
      'This image is unavailable for new share links.',
    );
  const policy = resolveExpiryPolicy(
    await getInstanceExpiryPolicy(binding),
    owner,
  );
  const selection = await selectDeliveryDomain(binding, owner.id);
  return {
    policy,
    deadline:
      policy.maxLifetimeSeconds === null
        ? null
        : now() + policy.maxLifetimeSeconds,
    choices: expiryChoices(policy),
    deliveryDomains: await availableDeliveryDomains(binding, owner.id),
    selectedDeliveryDomainId: selection.domain?.id ?? null,
    imageExpiresAt: image.expiresAt,
  };
}
export async function createLink(
  binding: D1Database,
  actor: User,
  input: {
    imageId: string;
    deliveryDomainId: string;
    slug?: string;
    expiry: string;
    expiresAt?: string;
  },
  actorIp?: string | null,
) {
  const image = await ownedImage(binding, actor, input.imageId);
  const options = await linkCreationOptions(binding, actor, input.imageId);
  const domain = await requireDeliveryDomain(
    binding,
    image.userId,
    input.deliveryDomainId,
  );
  const timestamp = now(),
    expiresAt = expiry(input.expiry, input.expiresAt, timestamp),
    aliasId = id('lnk');
  validateResourceExpiry(
    options.policy,
    timestamp,
    expiresAt,
    timestamp,
    'Links',
    'creation',
  );
  const commit = async (slug: string) => {
    const event = await auditEvent(
      database(binding),
      actor.id,
      'alias.created',
      aliasId,
      {
        actorName: actor.displayName,
        actorIp,
        name: `${domain.hostname}/${slug}`,
        before: {},
        context: { imageId: image.id, filename: image.filename, expiresAt },
      },
    );
    const result = await binding.batch([
      binding
        .prepare(
          'INSERT INTO aliases(id,imageId,deliveryDomainId,slug,expiresAt,createdAt) SELECT ?,?,?,?,?,? FROM images WHERE id=? AND deletedAt IS NULL AND (expiresAt IS NULL OR expiresAt>?)',
        )
        .bind(
          aliasId,
          image.id,
          domain.id,
          slug,
          expiresAt,
          timestamp,
          image.id,
          timestamp,
        ),
      binding
        .prepare(
          'INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT ?,?,?,?,?,? WHERE changes()>0',
        )
        .bind(
          event.id,
          event.actorId,
          event.action,
          event.targetId,
          event.metadata,
          event.createdAt,
        ),
    ]);
    if (result[0].meta.changes === 0)
      throw new AppError(
        409,
        'UNAVAILABLE',
        'The image is no longer available for sharing.',
      );
    return { id: aliasId, slug };
  };
  return input.slug?.trim()
    ? commit(slugSchema.parse(input.slug))
    : allocateShareSlug(binding, commit);
}
export async function deleteLinks(
  binding: D1Database,
  actor: User,
  ids: string[],
  actorIp?: string | null,
): Promise<DeleteResult> {
  const rows = await selectedLinks(binding, actor, ids);
  const found = new Map(rows.map((row) => [row.link.id, row]));
  const result: DeleteResult = {
    deletedIds: [],
    alreadyRemovedIds: [],
    failed: [],
  };
  const uniqueIds = new Set(ids);
  for (const aliasId of uniqueIds) {
    const row = found.get(aliasId);
    if (!row) {
      result.failed.push({
        id: aliasId,
        code: 'NOT_FOUND',
        message: 'Link not found.',
      });
      continue;
    }
    if (row.link.disabledAt !== null) {
      result.alreadyRemovedIds.push(aliasId);
      continue;
    }
    const timestamp = now();
    const event = await auditEvent(
      database(binding),
      actor.id,
      'alias.deleted',
      aliasId,
      {
        actorName: actor.displayName,
        actorIp,
        name: `${row.deliveryHostname}/${row.link.slug}`,
        before: { disabledAt: null },
        after: { disabledAt: timestamp },
        context: {
          imageId: row.image.id,
          reason: row.link.primary
            ? 'Primary share link deleted'
            : 'Share link deleted',
        },
      },
    );
    try {
      const batch = await binding.batch([
        binding
          .prepare(
            'INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT ?,?,?,?,?,? FROM aliases WHERE id=? AND disabledAt IS NULL',
          )
          .bind(
            event.id,
            event.actorId,
            event.action,
            event.targetId,
            event.metadata,
            event.createdAt,
            aliasId,
          ),
        binding
          .prepare(
            'UPDATE aliases SET disabledAt=?,"primary"=0 WHERE id=? AND disabledAt IS NULL',
          )
          .bind(timestamp, aliasId),
        binding
          .prepare(
            `INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt)
          SELECT 'evt_'||lower(hex(randomblob(16))),?,'alias.primary',a.id,
          json_set(?,'$.targetName',h.hostname||'/'||a.slug,'$.changes',json_array(json_object('field','primaryLink','before',?,'after',h.hostname||'/'||a.slug))),?
          FROM aliases a JOIN delivery_domains h ON h.id=a.deliveryDomainId WHERE changes()>0 AND ?=1 AND a.imageId=? AND a."primary"=1 AND a.disabledAt IS NULL`,
          )
          .bind(
            actor.id,
            event.metadata,
            `${row.deliveryHostname}/${row.link.slug}`,
            timestamp,
            row.link.primary ? 1 : 0,
            row.image.id,
          ),
      ]);
      (batch[1].meta.changes
        ? result.deletedIds
        : result.alreadyRemovedIds
      ).push(aliasId);
    } catch {
      result.failed.push({
        id: aliasId,
        code: 'UNAVAILABLE',
        message: 'Could not delete this share link. Please try again.',
      });
    }
  }
  return result;
}
export async function changeLinkExpiry(
  binding: D1Database,
  actor: User,
  ids: string[],
  value: string,
  custom?: string,
  actorIp?: string | null,
) {
  const selection = await expirySelection(binding, actor, ids),
    timestamp = now(),
    expiresAt = expiry(value, custom, timestamp);
  for (const [index, row] of selection.rows.entries()) {
    if (row.image.expiresAt !== null && row.image.expiresAt <= timestamp)
      throw new AppError(
        409,
        'UNAVAILABLE',
        'An associated image has expired. Refresh your selection.',
      );
    validateResourceExpiry(
      selection.policies[index],
      row.link.createdAt,
      expiresAt,
      timestamp,
      'Links',
      'creation',
    );
  }
  const event = await auditEvent(
    database(binding),
    actor.id,
    'alias.expiry',
    null,
    { actorName: actor.displayName, actorIp, name: 'Share links', before: {} },
  );
  const idsJSON = JSON.stringify([...new Set(ids)]),
    admin = actor.role === 'admin' ? 1 : 0;
  const eligible = `SELECT count(*) FROM aliases a JOIN images i ON i.id=a.imageId WHERE a.id IN (SELECT value FROM json_each(?)) AND a.disabledAt IS NULL AND i.deletedAt IS NULL AND (i.expiresAt IS NULL OR i.expiresAt>?) AND (?=1 OR i.userId=?)`;
  const results = await binding.batch([
    binding
      .prepare(
        `INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT 'evt_'||lower(hex(randomblob(16))),?,'alias.expiry',a.id,json_set(?,'$.targetName',h.hostname||'/'||a.slug,'$.changes',json_array(json_object('field','expiresAt','before',a.expiresAt,'after',?))),? FROM aliases a JOIN delivery_domains h ON h.id=a.deliveryDomainId WHERE a.id IN (SELECT value FROM json_each(?)) AND (${eligible})=?`,
      )
      .bind(
        actor.id,
        event.metadata,
        expiresAt,
        timestamp,
        idsJSON,
        idsJSON,
        timestamp,
        admin,
        actor.id,
        selection.rows.length,
      ),
    binding
      .prepare(
        `UPDATE aliases SET expiresAt=? WHERE id IN (SELECT value FROM json_each(?)) AND (${eligible})=?`,
      )
      .bind(
        expiresAt,
        idsJSON,
        idsJSON,
        timestamp,
        admin,
        actor.id,
        selection.rows.length,
      ),
  ]);
  if (results[1].meta.changes !== selection.rows.length)
    throw new AppError(
      409,
      'SELECTION_CHANGED',
      'The selection changed. Refresh and try again; no expiry changes were applied.',
    );
}
export async function makePrimaryLink(
  binding: D1Database,
  actor: User,
  aliasId: string,
  actorIp?: string | null,
) {
  const [row] = await selectedLinks(binding, actor, [aliasId]);
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Link not found.');
  const timestamp = now();
  const eligible = `SELECT a.id FROM aliases a JOIN images i ON i.id=a.imageId JOIN delivery_domains h ON h.id=a.deliveryDomainId JOIN users u ON u.id=i.userId WHERE a.id=? AND a.disabledAt IS NULL AND (a.expiresAt IS NULL OR a.expiresAt>?) AND i.deletedAt IS NULL AND (i.expiresAt IS NULL OR i.expiresAt>?) AND h.enabled=1 AND u.status='active'`;
  const event = await auditEvent(
    database(binding),
    actor.id,
    'alias.primary',
    aliasId,
    {
      actorName: actor.displayName,
      actorIp,
      name: `${row.deliveryHostname}/${row.link.slug}`,
      before: {},
      after: { primaryLink: `${row.deliveryHostname}/${row.link.slug}` },
      context: { imageId: row.image.id },
    },
  );
  const results = await binding.batch([
    binding
      .prepare(
        `INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT ?,?,?,?,json_set(?,'$.changes',json_array(json_object('field','primaryLink','before',(SELECT h.hostname||'/'||a.slug FROM aliases a JOIN delivery_domains h ON h.id=a.deliveryDomainId WHERE a.imageId=? AND a."primary"=1 AND a.disabledAt IS NULL),'after',?))),? WHERE EXISTS(${eligible})`,
      )
      .bind(
        event.id,
        event.actorId,
        event.action,
        event.targetId,
        event.metadata,
        row.image.id,
        `${row.deliveryHostname}/${row.link.slug}`,
        timestamp,
        aliasId,
        timestamp,
        timestamp,
      ),
    binding
      .prepare(
        `UPDATE aliases SET "primary"=0 WHERE imageId=? AND EXISTS(${eligible})`,
      )
      .bind(row.image.id, aliasId, timestamp, timestamp),
    binding
      .prepare(`UPDATE aliases SET "primary"=1 WHERE id IN (${eligible})`)
      .bind(aliasId, timestamp, timestamp),
  ]);
  if (!results[2].meta.changes)
    throw new AppError(
      409,
      'UNAVAILABLE',
      'An active, available link is required. Refresh and try again.',
    );
}
