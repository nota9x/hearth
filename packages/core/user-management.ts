import { and, asc, count, desc, eq, gte, lt, or, sql } from 'drizzle-orm';

import { requireAdmin } from './auth';
import type { Database, User } from './db';
import { apiKeys, storageStats, users } from './schema';
import { paginationState, parseSearch } from './search';
import { USER_PAGE_SIZE, userSortOptions, userStatuses } from './user-search';

const fields = {
  id: users.id,
  displayName: users.displayName,
  displayNamePolicy: users.displayNamePolicy,
  role: users.role,
  status: users.status,
  quotaBytes: users.quotaBytes,
  expiryPolicy: users.expiryPolicy,
  createdAt: users.createdAt,
};
const usage = sql<number>`coalesce(${storageStats.bytes},0)+coalesce(${storageStats.previewBytes},0)`;
const imageCount = sql<number>`coalesce(${storageStats.imageCount},0)`;
export function userSearchQuery(parameters: URLSearchParams) {
  const { query, text, dates } = parseSearch(parameters);
  const status = parameters.get('status') || '';
  const role = parameters.get('role');
  const filter = and(
    Object.hasOwn(userStatuses, status)
      ? eq(users.status, status as keyof typeof userStatuses)
      : status === 'all'
        ? undefined
        : sql`${users.status} != 'deleted'`,
    role === 'user' || role === 'admin' ? eq(users.role, role) : undefined,
    text
      ? or(
          sql`instr(lower(${users.displayName}),${text})>0`,
          sql`instr(lower(${users.id}),${text})>0`,
        )
      : undefined,
    ...dates.flatMap((range) =>
      range
        ? [gte(users.createdAt, range[0]), lt(users.createdAt, range[1])]
        : [],
    ),
  );
  const requested = parameters.get('sort') || 'newest';
  const sort = Object.hasOwn(userSortOptions, requested) ? requested : 'newest';
  const order =
    sort === 'oldest'
      ? [asc(users.createdAt), asc(users.id)]
      : sort === 'newest'
        ? [desc(users.createdAt), desc(users.id)]
        : [
            sort === 'name'
              ? asc(sql`lower(${users.displayName})`)
              : sort === 'images'
                ? desc(imageCount)
                : desc(sort === 'storage' ? usage : users.createdAt),
            desc(users.createdAt),
            desc(users.id),
          ];
  return { query, sort, filter, order };
}
export async function userPage(
  db: Database,
  actor: User | null,
  parameters: URLSearchParams,
) {
  requireAdmin(actor);
  const query = userSearchQuery(parameters);
  const [matched] = await db
    .select({ count: count() })
    .from(users)
    .where(query.filter);
  const [all] =
    parameters.get('status') === 'all' &&
    !query.query &&
    ['role', 'date', 'from', 'to'].every((key) => !parameters.get(key))
      ? [matched]
      : await db.select({ count: count() }).from(users);
  const pagination = paginationState(
    parameters.get('page'),
    matched.count,
    USER_PAGE_SIZE,
  );
  const members = await db
    .select({ user: fields, bytes: usage, imageCount })
    .from(users)
    .leftJoin(storageStats, eq(storageStats.userId, users.id))
    .where(query.filter)
    .orderBy(...query.order)
    .limit(USER_PAGE_SIZE)
    .offset(pagination.offset);
  return {
    members,
    pagination,
    unfilteredTotal: all.count,
    query: query.query,
    sort: query.sort,
  };
}
export async function userDetails(
  db: Database,
  actor: User | null,
  userId: string,
) {
  requireAdmin(actor);
  const rows = await db
    .select({
      user: fields,
      bytes: usage,
      imageCount,
      keyCreated: apiKeys.createdAt,
      keyRotated: apiKeys.rotatedAt,
      keyLastUsed: apiKeys.lastUsedAt,
    })
    .from(users)
    .leftJoin(storageStats, eq(storageStats.userId, users.id))
    .leftJoin(apiKeys, eq(apiKeys.userId, users.id))
    .where(eq(users.id, userId));
  return rows.at(0) ?? null;
}
