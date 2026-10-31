import { z } from 'zod';

import { auditEvent, type AuditValues } from './audit.ts';
import { requireAdmin, requireUser } from './auth.ts';
import { AppError, hostnameSchema, id, idSchema, now } from './common.ts';
import { randomSecret } from './crypto.ts';
import { database, type User } from './db.ts';
import { accessModes, isPublicHostname } from './domain-format.ts';
import type { DomainDiagnostics } from './domain-validation.ts';
import {
  appOrigin,
  deliveryOrigin,
  type PublicUrlEnvironment,
} from './public-urls.ts';
import { paginationState, parseSearch } from './search.ts';

export interface DeliveryDomain {
  id: string;
  hostname: string;
  notes: string;
  accessMode: (typeof accessModes)[number];
  enabled: boolean;
  isPrimary: boolean;
  health: 'pending' | 'active' | 'misconfigured' | 'unhealthy';
  lastCheckedAt: number | null;
  lastHealthyAt: number | null;
  diagnostics: DomainDiagnostics | null;
  revision: number;
  createdAt: number;
  updatedAt: number;
  linkCount: number;
}

const publicColumns = `d.id,d.hostname,d.notes,d.accessMode,d.enabled,d.isPrimary,d.health,d.lastCheckedAt,d.lastHealthyAt,d.diagnostics,d.revision,d.createdAt,d.updatedAt,
 (SELECT count(*) FROM aliases a WHERE a.deliveryDomainId=d.id AND a.disabledAt IS NULL) AS linkCount`;
type StoredDomain = Omit<
  DeliveryDomain,
  'diagnostics' | 'enabled' | 'isPrimary'
> & { diagnostics: string | null; enabled: number; isPrimary: number };
function serialize(row: StoredDomain): DeliveryDomain {
  return {
    ...row,
    enabled: !!row.enabled,
    isPrimary: !!row.isPrimary,
    diagnostics: row.diagnostics
      ? (JSON.parse(row.diagnostics) as DomainDiagnostics)
      : null,
  };
}

export const domainPermissionSql = `(u.role='admin' OR d.accessMode='everyone' OR (d.accessMode='selected' AND EXISTS(SELECT 1 FROM delivery_domain_access g WHERE g.deliveryDomainId=d.id AND g.userId=u.id)))`;
export const usableDomainSql = `d.enabled=1 AND d.health='active' AND u.status='active' AND ${domainPermissionSql}`;

export async function availableDeliveryDomains(
  binding: D1Database,
  ownerId: string,
) {
  const rows = await binding
    .prepare(
      `SELECT ${publicColumns} FROM delivery_domains d JOIN users u ON u.id=? WHERE ${usableDomainSql} ORDER BY d.isPrimary DESC,d.hostname,d.id`,
    )
    .bind(ownerId)
    .all<StoredDomain>();
  return rows.results.map((row) => serialize(row));
}

export async function primaryDeliveryDomain(binding: D1Database) {
  const row = await binding
    .prepare(
      `SELECT ${publicColumns} FROM delivery_domains d WHERE d.isPrimary=1`,
    )
    .first<StoredDomain>();
  return row ? serialize(row) : null;
}

export type DeliverySelection =
  { domain: DeliveryDomain; warning: null } | { domain: null; warning: string };
export async function selectDeliveryDomain(
  binding: D1Database,
  ownerId: string,
  explicitId?: string,
): Promise<DeliverySelection> {
  const owner = await binding
    .prepare('SELECT preferredDeliveryDomainId,status FROM users WHERE id=?')
    .bind(ownerId)
    .first<{ preferredDeliveryDomainId: string | null; status: string }>();
  if (!owner || owner.status !== 'active')
    return { domain: null, warning: 'This account cannot create share links.' };
  const selectedId = explicitId ?? owner.preferredDeliveryDomainId;
  const selected = await binding
    .prepare(
      `SELECT ${publicColumns},CASE WHEN ${usableDomainSql} THEN 1 ELSE 0 END AS usable FROM delivery_domains d JOIN users u ON u.id=? WHERE ${selectedId ? 'd.id=?' : 'd.isPrimary=1'}`,
    )
    .bind(...(selectedId ? [ownerId, selectedId] : [ownerId]))
    .first<StoredDomain & { usable: number }>();
  if (!selected)
    return {
      domain: null,
      warning: selectedId
        ? 'Your selected delivery domain no longer exists. Choose a delivery domain in Domains.'
        : 'No instance default is configured. Ask an administrator to configure one.',
    };
  const { usable, ...row } = selected;
  if (!usable)
    return {
      domain: null,
      warning: `The ${selectedId ? 'personally selected delivery domain' : 'instance default'} (${selected.hostname}) is ${selected.enabled ? (selected.health === 'active' ? 'unavailable to your account' : 'not currently validated as healthy') : 'disabled'}. Choose an available domain in Domains or contact an administrator.`,
    };
  return { domain: serialize(row), warning: null };
}

export async function requireDeliveryDomain(
  binding: D1Database,
  ownerId: string,
  domainId: string,
) {
  const selection = await selectDeliveryDomain(binding, ownerId, domainId);
  if (!selection.domain)
    throw new AppError(409, 'DELIVERY_UNAVAILABLE', selection.warning);
  return selection.domain;
}

export function configuredHostname(
  value: unknown,
  environment: PublicUrlEnvironment,
) {
  const development = environment.ENVIRONMENT === 'development';
  if (development && typeof value === 'string') {
    const name = value.trim().toLowerCase();
    const suffix = `:${environment.LOCAL_DELIVERY_PORT || '8788'}`;
    const localHostname = name.endsWith(suffix)
      ? name.slice(0, -suffix.length)
      : name;
    if (localHostname === '127.0.0.1' || localHostname.endsWith('.localhost'))
      value = localHostname;
  }
  const hostname =
    development && value === '127.0.0.1' ? value : hostnameSchema.parse(value);
  const app = new URL(appOrigin(environment));
  if (
    hostname === app.hostname &&
    (!development ||
      hostname !== '127.0.0.1' ||
      deliveryOrigin(hostname, environment) === app.origin)
  )
    throw new AppError(
      400,
      'APPLICATION_DOMAIN',
      'The application hostname cannot also be a delivery domain.',
    );
  if (
    !(
      development &&
      (hostname === '127.0.0.1' || hostname.endsWith('.localhost'))
    ) &&
    !isPublicHostname(hostname)
  )
    throw new AppError(
      400,
      'PRIVATE_DOMAIN',
      'Use a public hostname on an active Cloudflare zone.',
    );
  deliveryOrigin(hostname, environment);
  return hostname;
}

export async function domainDetails(
  binding: D1Database,
  actor: User,
  domainId: string,
) {
  requireAdmin(actor);
  const row = await binding
    .prepare(`SELECT ${publicColumns} FROM delivery_domains d WHERE d.id=?`)
    .bind(idSchema.parse(domainId))
    .first<StoredDomain>();
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Delivery domain not found.');
  const preferenceCount = await binding
    .prepare(
      'SELECT count(*) AS count FROM users WHERE preferredDeliveryDomainId=?',
    )
    .bind(domainId)
    .first<{ count: number }>();
  return { ...serialize(row), preferenceCount: preferenceCount?.count ?? 0 };
}

export async function deliveryDomainPage(
  binding: D1Database,
  actor: User,
  parameters: URLSearchParams,
  size = 24,
) {
  requireUser(actor);
  const conditions = [
    actor.role === 'admin'
      ? '1=1'
      : `EXISTS(SELECT 1 FROM users u WHERE u.id=? AND ${domainPermissionSql})`,
  ];
  const values: (string | number)[] = actor.role === 'admin' ? [] : [actor.id];
  const { text: query, dates } = parseSearch(parameters);
  for (const range of dates)
    if (range) {
      conditions.push('d.createdAt>=? AND d.createdAt<?');
      values.push(...range);
    }
  if (query) {
    conditions.push(
      `instr(lower(d.hostname||' '||d.notes||' delivery domain '||CASE WHEN d.enabled=0 THEN 'disabled' WHEN d.health='pending' THEN 'pending validation' ELSE d.health END||' '||CASE d.accessMode WHEN 'administrators' THEN 'administrators only' WHEN 'selected' THEN 'selected members' ELSE 'everyone' END||CASE WHEN d.isPrimary=1 THEN ' primary default' ELSE ' additional' END),?)>0`,
    );
    values.push(query);
  }
  const status = parameters.get('status');
  if (
    ['pending', 'active', 'misconfigured', 'unhealthy', 'disabled'].includes(
      status || '',
    )
  ) {
    conditions.push(
      status === 'disabled' ? 'd.enabled=0' : 'd.enabled=1 AND d.health=?',
    );
    if (status !== 'disabled') values.push(status!);
  }
  const access = parameters.get('access');
  if (accessModes.includes(access as (typeof accessModes)[number])) {
    conditions.push('d.accessMode=?');
    values.push(access!);
  }
  if (parameters.get('role') === 'primary') conditions.push('d.isPrimary=1');
  if (parameters.get('role') === 'additional') conditions.push('d.isPrimary=0');
  const filtered = conditions.join(' AND ');
  const [count, total] = await Promise.all([
    binding
      .prepare(
        `SELECT count(*) AS count FROM delivery_domains d WHERE ${filtered}`,
      )
      .bind(...values)
      .first<{ count: number }>(),
    binding
      .prepare(
        `SELECT count(*) AS count FROM delivery_domains d WHERE ${conditions[0]}`,
      )
      .bind(...(actor.role === 'admin' ? [] : [actor.id]))
      .first<{ count: number }>(),
  ]);
  const pagination = paginationState(
    parameters.get('page'),
    count?.count ?? 0,
    size,
  );
  const order =
    parameters.get('sort') === 'name'
      ? 'd.hostname,d.id'
      : parameters.get('sort') === 'oldest'
        ? 'd.createdAt,d.id'
        : 'd.createdAt DESC,d.id DESC';
  const rows = await binding
    .prepare(
      `SELECT ${publicColumns} FROM delivery_domains d WHERE ${filtered} ORDER BY ${order} LIMIT ? OFFSET ?`,
    )
    .bind(...values, size, (pagination.page - 1) * size)
    .all<StoredDomain>();
  return {
    domains: rows.results.map((row) => serialize(row)),
    pagination,
    total: total?.count ?? 0,
  };
}

const saveSchema = z.object({
  id: idSchema.optional(),
  revision: z.number().int().nonnegative().optional(),
  hostname: z.string(),
  notes: z.string().trim().max(500).default(''),
  accessMode: z.enum(accessModes),
  addMembers: z.array(idSchema).max(10_000).default([]),
  removeMembers: z.array(idSchema).max(10_000).default([]),
});

function changed() {
  return new AppError(
    409,
    'DOMAIN_CHANGED',
    'This domain changed while you were working. Refresh its details and try again.',
  );
}
async function eventStatement(
  binding: D1Database,
  actor: User,
  action: string,
  domain: Pick<DeliveryDomain, 'id' | 'hostname'>,
  actorIp?: string | null,
  token?: string,
  options: { before?: AuditValues; after?: AuditValues } = {},
) {
  const event = await auditEvent(
    database(binding),
    actor.id,
    action,
    domain.id,
    {
      actorName: actor.displayName,
      name: domain.hostname,
      actorIp,
      ...options,
    },
  );
  return binding
    .prepare(
      `INSERT INTO audit_log(id,actorId,action,targetId,metadata,createdAt) SELECT ?,?,?,?,?,? ${token ? 'WHERE EXISTS(SELECT 1 FROM delivery_domains WHERE id=? AND mutationId=?)' : ''}`,
    )
    .bind(
      event.id,
      event.actorId,
      event.action,
      event.targetId,
      event.metadata,
      event.createdAt,
      ...(token ? [domain.id, token] : []),
    );
}

export async function saveDeliveryDomain(
  binding: D1Database,
  actor: User,
  input: unknown,
  environment: PublicUrlEnvironment,
  actorIp?: string | null,
) {
  requireAdmin(actor);
  const value = saveSchema.parse(input);
  const hostname = configuredHostname(value.hostname, environment),
    timestamp = now();
  const previous = value.id
    ? await domainDetails(binding, actor, value.id)
    : null;
  if (
    previous &&
    (previous.hostname !== hostname || previous.revision !== value.revision)
  )
    throw changed();
  const domainId = previous?.id ?? id('dom'),
    token = randomSecret(16);
  const statements = [
    previous
      ? binding
          .prepare(
            'UPDATE delivery_domains SET notes=?,accessMode=?,updatedAt=?,revision=revision+1,mutationId=? WHERE id=? AND revision=?',
          )
          .bind(
            value.notes,
            value.accessMode,
            timestamp,
            token,
            domainId,
            value.revision!,
          )
      : binding
          .prepare(
            'INSERT INTO delivery_domains(id,hostname,notes,accessMode,createdAt,updatedAt,mutationId) VALUES(?,?,?,?,?,?,?)',
          )
          .bind(
            domainId,
            hostname,
            value.notes,
            value.accessMode,
            timestamp,
            timestamp,
            token,
          ),
  ];
  const guard =
    'EXISTS(SELECT 1 FROM delivery_domains WHERE id=? AND mutationId=?)';
  if (value.removeMembers.length > 0)
    statements.push(
      binding
        .prepare(
          `DELETE FROM delivery_domain_access WHERE deliveryDomainId=? AND userId IN (SELECT value FROM json_each(?)) AND ${guard}`,
        )
        .bind(domainId, JSON.stringify(value.removeMembers), domainId, token),
    );
  if (value.addMembers.length > 0)
    statements.push(
      binding
        .prepare(
          `INSERT OR IGNORE INTO delivery_domain_access(deliveryDomainId,userId) SELECT ?,id FROM users WHERE status<>'deleted' AND id IN (SELECT value FROM json_each(?)) AND ${guard}`,
        )
        .bind(domainId, JSON.stringify(value.addMembers), domainId, token),
    );
  statements.push(
    await eventStatement(
      binding,
      actor,
      previous ? 'domain.updated' : 'domain.created',
      { id: domainId, hostname },
      actorIp,
      token,
      {
        before: previous ?? {},
        after: { hostname, notes: value.notes, accessMode: value.accessMode },
      },
    ),
  );
  try {
    const result = await binding.batch(statements);
    if (!result[0].meta.changes) throw changed();
  } catch (error) {
    if (String(error).includes('delivery_domains.hostname'))
      throw new AppError(
        409,
        'DOMAIN_EXISTS',
        'This delivery domain is already configured.',
      );
    throw error;
  }
  return domainDetails(binding, actor, domainId);
}

export async function domainMembers(
  binding: D1Database,
  actor: User,
  domainId: string | null,
  parameters: URLSearchParams,
) {
  requireAdmin(actor);
  if (domainId) await domainDetails(binding, actor, domainId);
  const query = (parameters.get('q') || '').trim().slice(0, 200);
  const where = `status<>'deleted' AND instr(lower(displayName||' '||role),lower(?))>0`;
  const count = await binding
    .prepare(`SELECT count(*) AS count FROM users WHERE ${where}`)
    .bind(query)
    .first<{ count: number }>();
  const pagination = paginationState(
    parameters.get('page'),
    count?.count ?? 0,
    24,
  );
  const rows = await binding
    .prepare(
      `SELECT id,displayName,role,status,EXISTS(SELECT 1 FROM delivery_domain_access g WHERE g.userId=users.id AND g.deliveryDomainId=?) AS granted FROM users WHERE ${where} ORDER BY displayName,id LIMIT 24 OFFSET ?`,
    )
    .bind(domainId, query, (pagination.page - 1) * 24)
    .all<{
      id: string;
      displayName: string;
      role: string;
      status: string;
      granted: number;
    }>();
  return {
    members: rows.results.map((row) => ({ ...row, granted: !!row.granted })),
    pagination,
  };
}

export async function setDeliveryPreference(
  binding: D1Database,
  actor: User,
  domainId: string | null,
  actorIp?: string | null,
) {
  requireUser(actor);
  if (domainId)
    await requireDeliveryDomain(binding, actor.id, idSchema.parse(domainId));
  const event = await auditEvent(
    database(binding),
    actor.id,
    'user.delivery_preference',
    actor.id,
    { actorIp },
  );
  const results = await binding.batch([
    binding
      .prepare(
        `UPDATE users SET preferredDeliveryDomainId=?,updatedAt=? WHERE id=? AND (? IS NULL OR EXISTS(SELECT 1 FROM delivery_domains d JOIN users u ON u.id=? WHERE d.id=? AND ${usableDomainSql}))`,
      )
      .bind(domainId, now(), actor.id, domainId, actor.id, domainId),
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
  if (!results[0].meta.changes)
    throw new AppError(
      409,
      'DELIVERY_UNAVAILABLE',
      'The delivery domain is no longer available. Refresh and choose again.',
    );
}

export async function setPrimaryDeliveryDomain(
  binding: D1Database,
  actor: User,
  domainId: string,
  revision: number,
  actorIp?: string | null,
) {
  requireAdmin(actor);
  const domain = await domainDetails(binding, actor, domainId),
    token = randomSecret(16);
  const result = await binding.batch([
    binding
      .prepare(
        `UPDATE delivery_domains SET revision=revision+1,mutationId=?,updatedAt=? WHERE id=? AND revision=? AND enabled=1 AND health='active'`,
      )
      .bind(token, now(), domainId, revision),
    binding
      .prepare(
        'UPDATE delivery_domains SET isPrimary=0,revision=revision+1,updatedAt=? WHERE isPrimary=1 AND id<>? AND EXISTS(SELECT 1 FROM delivery_domains WHERE id=? AND mutationId=?)',
      )
      .bind(now(), domainId, domainId, token),
    binding
      .prepare(
        'UPDATE delivery_domains SET isPrimary=1 WHERE id=? AND mutationId=?',
      )
      .bind(domainId, token),
    await eventStatement(
      binding,
      actor,
      'domain.primary',
      domain,
      actorIp,
      token,
    ),
  ]);
  if (!result[0].meta.changes) throw changed();
}

export async function changeDeliveryAvailability(
  binding: D1Database,
  actor: User,
  input: {
    id: string;
    revision: number;
    enabled: boolean;
    replacementId: string | null;
    clearPrimary: boolean;
    expectedLinkCount: number;
    remove?: boolean;
  },
  actorIp?: string | null,
) {
  requireAdmin(actor);
  const domain = await domainDetails(binding, actor, input.id);
  if (
    domain.isPrimary &&
    (input.remove || !input.enabled) &&
    !input.replacementId &&
    !input.clearPrimary
  )
    throw new AppError(
      409,
      'PRIMARY_REPLACEMENT_REQUIRED',
      'Choose a healthy replacement or explicitly clear the instance default.',
    );
  if (input.replacementId === input.id)
    throw new AppError(
      400,
      'INVALID_REPLACEMENT',
      'Choose a different delivery domain.',
    );
  const token = randomSecret(16),
    timestamp = now();
  const replace = domain.isPrimary && (input.remove || !input.enabled);
  const results = await binding.batch([
    binding
      .prepare(
        `UPDATE delivery_domains SET revision=revision+1,mutationId=?,updatedAt=? WHERE id=? AND revision=? AND (SELECT count(*) FROM aliases WHERE deliveryDomainId=? AND disabledAt IS NULL)=? AND (? IS NULL OR EXISTS(SELECT 1 FROM delivery_domains WHERE id=? AND enabled=1 AND health='active'))`,
      )
      .bind(
        token,
        timestamp,
        input.id,
        input.revision,
        input.id,
        input.expectedLinkCount,
        replace ? input.replacementId : null,
        replace ? input.replacementId : null,
      ),
    binding
      .prepare(
        'UPDATE delivery_domains SET isPrimary=0 WHERE id=? AND mutationId=? AND ?=1',
      )
      .bind(input.id, token, replace ? 1 : 0),
    binding
      .prepare(
        'UPDATE delivery_domains SET isPrimary=1,revision=revision+1,updatedAt=? WHERE id=? AND EXISTS(SELECT 1 FROM delivery_domains WHERE id=? AND mutationId=?)',
      )
      .bind(timestamp, replace ? input.replacementId : null, input.id, token),
    binding
      .prepare(
        'UPDATE delivery_domains SET enabled=? WHERE id=? AND mutationId=?',
      )
      .bind(input.enabled ? 1 : 0, input.id, token),
    await eventStatement(
      binding,
      actor,
      input.remove
        ? 'domain.deleted'
        : input.enabled
          ? 'domain.enabled'
          : 'domain.disabled',
      domain,
      actorIp,
      token,
    ),
    ...(input.remove
      ? [
          binding
            .prepare(
              'UPDATE aliases SET disabledAt=?,"primary"=0 WHERE deliveryDomainId=? AND disabledAt IS NULL AND EXISTS(SELECT 1 FROM delivery_domains WHERE id=? AND mutationId=?)',
            )
            .bind(timestamp, input.id, input.id, token),
          binding
            .prepare(
              'DELETE FROM aliases WHERE deliveryDomainId=? AND EXISTS(SELECT 1 FROM delivery_domains WHERE id=? AND mutationId=?)',
            )
            .bind(input.id, input.id, token),
          binding
            .prepare('DELETE FROM delivery_domains WHERE id=? AND mutationId=?')
            .bind(input.id, token),
        ]
      : []),
  ]);
  if (!results[0].meta.changes) throw changed();
}
