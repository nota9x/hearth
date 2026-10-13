import {
  type AuditChange,
  auditFields,
  type AuditValue,
  safeAuditActorIp,
  safeAuditValues,
} from './audit';
import { type AuditAction, auditActionTitles } from './audit-search';
import { expiryLabel, formatLifetime } from './expiry-policy';

export function auditValue(field: string, value: AuditValue): string {
  if (field === 'maxLifetimeSeconds' || field === 'maxLifetimeOverride')
    return typeof value === 'number' || value === null
      ? formatLifetime(value)
      : String(value);
  if (field === 'requireExpiryOverride' && value === null)
    return 'Instance default';
  if (value === null)
    return field === 'expiresAt'
      ? 'Never'
      : field === 'limitBytes'
        ? 'Unlimited'
        : 'Not set';
  if (Array.isArray(value)) return value.join(', ') || 'None';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (field === 'defaultExpiry' || field === 'defaultRetention')
    return typeof value === 'string' &&
      (value === 'never' || /^\d+[shdy]$/.test(value))
      ? expiryLabel(value)
      : String(value);
  if (
    typeof value === 'number' &&
    (field === 'expiresAt' || field === 'disabledAt')
  ) {
    const date = new Date(value * 1000);
    return Number.isNaN(date.getTime()) ? String(value) : date.toISOString();
  }
  return typeof value === 'number' &&
    ['quotaBytes', 'limitBytes', 'size', 'bytes', 'previewBytes'].includes(
      field,
    )
    ? `${value.toLocaleString('en-US')} bytes`
    : String(value);
}

function quotedAuditValue(field: string, value: AuditValue): string {
  return JSON.stringify(auditValue(field, value));
}

export function presentAudit(
  log: {
    action: string;
    metadata: string;
    actorId: string | null;
    targetId: string | null;
  },
  fallback?: { actor: string; target: string },
) {
  let raw: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(log.metadata);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
      raw = parsed as Record<string, unknown>;
  } catch {
    /*
    Historical malformed metadata is not fatal.
    */
  }
  const changes: AuditChange[] = [];
  if (Array.isArray(raw.changes))
    for (const entry of raw.changes) {
      if (!entry || typeof entry !== 'object') continue;
      const item = entry as Record<string, unknown>;
      if (
        typeof item.field !== 'string' ||
        !Object.hasOwn(auditFields, item.field)
      )
        continue;
      const field = item.field as keyof typeof auditFields;
      const before = safeAuditValues({ [field]: item.before }),
        after = safeAuditValues({ [field]: item.after });
      if (before[field] !== undefined && after[field] !== undefined)
        changes.push({ field, before: before[field]!, after: after[field]! });
    }
  const details = changes.map(
    (change) =>
      `${auditFields[change.field]} changed from ${quotedAuditValue(change.field, change.before)} to ${quotedAuditValue(change.field, change.after)}`,
  );
  const context = safeAuditValues(
    raw.context && typeof raw.context === 'object'
      ? (raw.context as Record<string, unknown>)
      : raw,
  );
  const actorIp = safeAuditActorIp(raw.actorIp);
  return {
    title:
      auditActionTitles[log.action as AuditAction] ??
      log.action.replaceAll(/[._]/g, ' '),
    actor:
      typeof raw.actorName === 'string'
        ? raw.actorName
        : (fallback?.actor ?? log.actorId ?? 'System / unknown'),
    actorIp,
    target:
      typeof raw.targetName === 'string'
        ? raw.targetName
        : (fallback?.target ?? log.targetId ?? 'Workspace'),
    details,
    summary:
      details.length === 1
        ? details[0].length <= 160
          ? details[0]
          : `${auditFields[changes[0].field]} changed`
        : details.length > 0
          ? `${details.length} fields changed: ${changes.map((c) => auditFields[c.field]).join(', ')}`
          : '',
    context: Object.entries(context).map(([field, value]) => ({
      label: auditFields[field as keyof typeof auditFields],
      value: auditValue(field, value),
    })),
  };
}
