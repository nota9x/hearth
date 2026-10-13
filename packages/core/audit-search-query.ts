import {
  and,
  asc,
  count,
  desc,
  eq,
  gte,
  lt,
  or,
  type SQL,
  sql,
} from 'drizzle-orm';

import { type AuditDatabase, auditFields } from './audit';
import {
  AUDIT_MAX_PAGES,
  AUDIT_PAGE_SIZE,
  auditActionTitles,
  auditSortOptions,
} from './audit-search';
import { requireAdmin } from './auth';
import type { User } from './db';
import { auditLog } from './schema';
import { paginationState, parseSearch } from './search';

const metadata = sql`case when json_valid(${auditLog.metadata}) then ${auditLog.metadata} else '{}' end`;
const fields = JSON.stringify(Object.keys(auditFields));
const actor = sql`coalesce(json_extract(${metadata}, '$.actorName'), '') || ' ' || coalesce(json_extract(${metadata}, '$.actorIp'), '') || ' ' || coalesce(${auditLog.actorId}, 'System') || ' ' || coalesce((select displayName from users where id=${auditLog.actorId}), '')`;
const target = sql`coalesce(json_extract(${metadata}, '$.targetName'), '') || ' ' || coalesce(${auditLog.targetId}, 'Workspace') || ' ' || coalesce((select displayName from users where id=${auditLog.targetId}), '') || ' ' || coalesce((select filename from images where id=${auditLog.targetId}), '') || ' ' || coalesce((select hostname from delivery_domains where id=${auditLog.targetId}), '') || ' ' || coalesce((select h.hostname || '/' || a.slug from aliases a join delivery_domains h on h.id=a.deliveryDomainId where a.id=${auditLog.targetId}), '')`;
const contains = (value: SQL, text: string) =>
  sql`instr(lower(${value}), ${text.toLowerCase()}) > 0`;

// Match only safe scalar values / string arrays, never arbitrary nested credentials.
function safeValueMatch(value: SQL, type: SQL, text: string) {
  return sql`((${type} in ('text','integer','real','true','false') and instr(lower(cast(${value} as text)), ${text}) > 0) or (${type}='array' and exists(select 1 from json_each(case when ${type}='array' then ${value} else '[]' end) v where v.type='text' and instr(lower(v.value), ${text}) > 0)))`;
}
function detailMatch(text: string) {
  const change = sql`case when c.type='object' then c.value else '{}' end`;
  return sql`(
    exists(select 1 from json_each(${metadata}, '$.context') c where c.key in (select value from json_each(${fields})) and ${safeValueMatch(sql`c.value`, sql`c.type`, text)})
    or exists(select 1 from json_each(${metadata}, '$.changes') c where json_extract(${change}, '$.field') in (select value from json_each(${fields})) and (
      ${contains(sql`json_extract(${change}, '$.field')`, text)}
      or ${safeValueMatch(sql`json_extract(${change}, '$.before')`, sql`json_type(${change}, '$.before')`, text)}
      or ${safeValueMatch(sql`json_extract(${change}, '$.after')`, sql`json_type(${change}, '$.after')`, text)}
    ))
    or exists(select 1 from json_each(${metadata}) c where c.key in (select value from json_each(${fields})) and ${safeValueMatch(sql`c.value`, sql`c.type`, text)})
  )`;
}
export function auditSearchQuery(parameters: URLSearchParams) {
  const { query, text, dates } = parseSearch(parameters);
  const selectedActor = (parameters.get('actor') ?? '').trim().slice(0, 240);
  const selectedTarget = (parameters.get('target') ?? '').trim().slice(0, 240);
  const selectedAction = (parameters.get('action') ?? '').slice(0, 100);
  const matchingActions = Object.entries(auditActionTitles)
    .filter(([, title]) => title.toLowerCase().includes(text))
    .map(([action]) => action);
  const filter = and(
    parameters.get('actorId')
      ? eq(auditLog.actorId, parameters.get('actorId')!)
      : undefined,
    text
      ? or(
          contains(actor, text),
          contains(target, text),
          contains(sql`${auditLog.action}`, text),
          sql`${auditLog.action} in (select value from json_each(${JSON.stringify(matchingActions)}))`,
          detailMatch(text),
        )
      : undefined,
    selectedActor ? contains(actor, selectedActor) : undefined,
    selectedTarget ? contains(target, selectedTarget) : undefined,
    selectedAction ? eq(auditLog.action, selectedAction) : undefined,
    ...dates.flatMap((range) =>
      range
        ? [gte(auditLog.createdAt, range[0]), lt(auditLog.createdAt, range[1])]
        : [],
    ),
  );
  const requestedSort = parameters.get('sort') || 'newest';
  const sort = Object.hasOwn(auditSortOptions, requestedSort)
    ? requestedSort
    : 'newest';
  const order =
    sort === 'oldest'
      ? [asc(auditLog.createdAt), sql`audit_log.rowid asc`]
      : sort === 'action'
        ? [
            asc(auditLog.action),
            desc(auditLog.createdAt),
            sql`audit_log.rowid desc`,
          ]
        : [desc(auditLog.createdAt), sql`audit_log.rowid desc`];
  return { query, sort, filter, order };
}

export async function searchAuditLog(
  db: AuditDatabase,
  user: User | null,
  parameters: URLSearchParams,
) {
  // Enforced here as well as in the route, including counts and filter options.
  requireAdmin(user);
  const query = auditSearchQuery(parameters);
  const [matched] = await db
    .select({ count: count() })
    .from(auditLog)
    .where(query.filter);
  const [all] = await db.select({ count: count() }).from(auditLog);
  const pagination = paginationState(
    parameters.get('page'),
    matched.count,
    AUDIT_PAGE_SIZE,
    AUDIT_MAX_PAGES,
  );
  const logs = await db
    .select()
    .from(auditLog)
    .where(query.filter)
    .orderBy(...query.order)
    .limit(AUDIT_PAGE_SIZE)
    .offset(pagination.offset);
  const actions = await db
    .selectDistinct({ action: auditLog.action })
    .from(auditLog)
    .orderBy(auditLog.action);
  return {
    logs,
    pagination,
    query: query.query,
    sort: query.sort,
    unfilteredTotal: all.count,
    actions: Object.fromEntries(
      actions.map(({ action }) => [
        action,
        auditActionTitles[action as keyof typeof auditActionTitles] ?? action,
      ]),
    ),
  };
}
