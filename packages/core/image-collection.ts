import { and, count, eq, isNull, sql } from 'drizzle-orm';

import type { Database } from './db';
import type { Env } from './env';
import { imageSearchQuery } from './image-search-query';
import { contentUrl } from './public-urls';
import { aliases, deliveryDomains, images, users } from './schema';
import { paginationState } from './search';

export const imageFields = {
  id: images.id,
  filename: images.filename,
  mime: images.mime,
  size: images.size,
  width: images.width,
  height: images.height,
  createdAt: images.createdAt,
  expiresAt: images.expiresAt,
};
export async function imageCollection(
  db: Database,
  env: Env,
  parameters: URLSearchParams,
  ownerId?: string,
  size = 24,
) {
  const query = imageSearchQuery(parameters, ownerId);
  const [matched] = await db
    .select({ count: count() })
    .from(images)
    .where(query.filter);
  const hasFilters = [
    'q',
    'date',
    'from',
    'to',
    'type',
    'orientation',
    'size',
    'domain',
    'owner',
  ].some((key) => parameters.get(key));
  const [all] = hasFilters
    ? await db.select({ count: count() }).from(images).where(query.base)
    : [matched];
  const pagination = paginationState(
    parameters.get('page'),
    matched.count,
    size,
  );
  const timestamp = Math.floor(Date.now() / 1000);
  const rows = await db
    .select({
      image: imageFields,
      owner: users.displayName,
      ownerId: users.id,
      ownerStatus: users.status,
      available: sql<boolean>`${users.status}='active' AND ${deliveryDomains.enabled}=1 AND (${aliases.expiresAt} IS NULL OR ${aliases.expiresAt}>${timestamp}) AND (${images.expiresAt} IS NULL OR ${images.expiresAt}>${timestamp})`,
      linkCount: sql<number>`(SELECT count(*) FROM aliases a WHERE a.imageId=${images.id} AND a.disabledAt IS NULL)`,
      slug: aliases.slug,
      deliveryHostname: deliveryDomains.hostname,
    })
    .from(images)
    .innerJoin(users, eq(users.id, images.userId))
    .leftJoin(
      aliases,
      and(
        eq(aliases.imageId, images.id),
        eq(aliases.primary, true),
        isNull(aliases.disabledAt),
      ),
    )
    .leftJoin(deliveryDomains, eq(deliveryDomains.id, aliases.deliveryDomainId))
    .where(query.filter)
    .orderBy(...query.order)
    .limit(size)
    .offset(pagination.offset);
  return {
    images: rows.map((row) => ({
      ...row.image,
      owner: row.owner,
      ownerId: row.ownerId,
      ownerStatus: row.ownerStatus,
      linkCount: row.linkCount,
      url:
        row.available && row.deliveryHostname && row.slug
          ? contentUrl(row.deliveryHostname, row.slug, env)
          : null,
    })),
    pagination,
    unfilteredTotal: all.count,
    query: query.query,
    sort: query.sort,
  };
}
export type CollectionImage = Awaited<
  ReturnType<typeof imageCollection>
>['images'][number];
