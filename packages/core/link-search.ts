import {
  and,
  asc,
  desc,
  eq,
  gt,
  gte,
  isNull,
  lt,
  lte,
  or,
  sql,
} from 'drizzle-orm';

import { now } from './common';
import { aliases, deliveryDomains, images, users } from './schema';
import { dateRange, parseSearch } from './search';

export const LINK_PAGE_SIZE = 24;
export const linkFilterKeys = [
  'date',
  'from',
  'to',
  'status',
  'expiry',
  'domain',
  'owner',
  'image',
] as const;
export const linkSortOptions = {
  newest: 'Newest first',
  oldest: 'Oldest first',
  expiry: 'Expiring soonest',
  'expiry-desc': 'Expiring latest',
  name: 'Filename A–Z',
  slug: 'Slug A–Z',
};
export const linkStatuses = {
  active: 'Active',
  soon: 'Expiring soon',
  expired: 'Expired',
  unavailable: 'Unavailable',
};
export const linkExpiryFilters = {
  never: 'No expiry',
  today: 'Expires today',
  '24h': 'Next 24 hours',
  '7d': 'Next 7 days',
  '30d': 'Next 30 days',
  expired: 'Already expired',
};
export function effectiveExpiry(link: number | null, image: number | null) {
  return link === null ? image : image === null ? link : Math.min(link, image);
}
export function linkStatus(
  expiresAt: number | null,
  available: boolean,
  timestamp = now(),
) {
  return expiresAt !== null && expiresAt <= timestamp
    ? 'expired'
    : available
      ? expiresAt !== null && expiresAt <= timestamp + 7 * 86_400
        ? 'soon'
        : 'active'
      : 'unavailable';
}
export const effectiveLinkExpiry = sql<
  number | null
>`case when ${aliases.expiresAt} is null then ${images.expiresAt} when ${images.expiresAt} is null then ${aliases.expiresAt} else min(${aliases.expiresAt},${images.expiresAt}) end`;

export function linkSearchQuery(
  parameters: URLSearchParams,
  userId?: string,
  timestamp = now(),
) {
  const { query, text, dates } = parseSearch(parameters);
  let address = text
    .replace(/^https?:\/\//, '')
    .replace(/:\d+(?=\/)/, '')
    .split(/[?#]/, 1)[0];
  try {
    address = decodeURIComponent(address);
  } catch {
    /*
    Search malformed URL text literally.
    */
  }
  const deadline = effectiveLinkExpiry;
  const future = or(isNull(deadline), gt(deadline, timestamp));
  const available = and(
    eq(deliveryDomains.enabled, true),
    eq(users.status, 'active'),
  );
  const status = parameters.get('status');
  const expiration = parameters.get('expiry');
  const days =
    expiration === '24h'
      ? 1
      : expiration === '7d'
        ? 7
        : expiration === '30d'
          ? 30
          : 0;
  const today =
    expiration === 'today'
      ? dateRange(
          'today',
          '',
          '',
          new Date(timestamp * 1000),
          parameters.get('tz') || 'UTC',
        )
      : undefined;
  const base = and(
    isNull(aliases.disabledAt),
    isNull(images.deletedAt),
    userId ? eq(images.userId, userId) : undefined,
    parameters.get('image')
      ? eq(images.id, parameters.get('image')!)
      : undefined,
  );
  const filter = and(
    base,
    text
      ? or(
          sql`instr(lower(${images.filename}),${text})>0`,
          sql`instr(lower(${aliases.slug}),${text})>0`,
          sql`instr(lower(${deliveryDomains.hostname} || '/' || ${aliases.slug}),${address})>0`,
          userId
            ? undefined
            : sql`instr(lower(${users.displayName}),${text})>0`,
        )
      : undefined,
    ...dates.flatMap((range) =>
      range
        ? [gte(aliases.createdAt, range[0]), lt(aliases.createdAt, range[1])]
        : [],
    ),
    parameters.get('domain')
      ? eq(aliases.deliveryDomainId, parameters.get('domain')!)
      : undefined,
    !userId && parameters.get('owner')
      ? eq(images.userId, parameters.get('owner')!)
      : undefined,
    status === 'expired'
      ? lte(deadline, timestamp)
      : status === 'unavailable'
        ? and(
            future,
            or(
              eq(deliveryDomains.enabled, false),
              sql`${users.status}<>'active'`,
            ),
          )
        : status === 'soon'
          ? and(
              available,
              gt(deadline, timestamp),
              lte(deadline, timestamp + 7 * 86_400),
            )
          : status === 'active'
            ? and(
                available,
                future,
                or(isNull(deadline), gt(deadline, timestamp + 7 * 86_400)),
              )
            : undefined,
    expiration === 'never'
      ? isNull(deadline)
      : expiration === 'expired'
        ? lte(deadline, timestamp)
        : days
          ? and(
              gt(deadline, timestamp),
              lte(deadline, timestamp + days * 86_400),
            )
          : today
            ? and(
                gt(deadline, timestamp),
                gte(deadline, today[0]),
                lt(deadline, today[1]),
              )
            : undefined,
  );
  const requested = parameters.get('sort') || 'newest';
  const sort = Object.hasOwn(linkSortOptions, requested) ? requested : 'newest';
  const order =
    sort === 'oldest'
      ? [asc(aliases.createdAt)]
      : sort === 'expiry'
        ? [asc(sql`${deadline} is null`), asc(deadline)]
        : sort === 'expiry-desc'
          ? [asc(sql`${deadline} is null`), desc(deadline)]
          : sort === 'name'
            ? [asc(sql`lower(${images.filename})`)]
            : [sort === 'slug' ? asc(aliases.slug) : desc(aliases.createdAt)];
  return { base, filter, query, sort, order: [...order, asc(aliases.id)] };
}
