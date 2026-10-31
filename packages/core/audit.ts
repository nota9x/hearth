import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { id, now } from './common.ts';
import type { database } from './db.ts';
import { aliases, deliveryDomains, images, users } from './schema.ts';

// Deliberate allowlist: never serialize request bodies, credentials, or whole DB rows.
export const auditFields = {
  onboardingStatus: 'Onboarding status',
  onboardingStep: 'Onboarding step',
  onboardingUploadStatus: 'First image milestone',
  displayName: 'Display name',
  displayNamePolicy: 'Display name policy',
  restrictDisplayNameChanges: 'Restrict display name changes',
  role: 'Role',
  status: 'Status',
  defaultExpiry: 'Expiry',
  stripImageMetadata: 'Strip image metadata',
  requireExpiry: 'Expiry required',
  maxLifetimeSeconds: 'Maximum lifetime',
  requireExpiryOverride: 'Expiry requirement override',
  maxLifetimeOverride: 'Maximum lifetime override',
  defaultRetention: 'Expiry', // Historical audit metadata.
  defaultHost: 'Default subdomain',
  defaultsCleared: 'Users whose default subdomain was cleared',
  quotaBytes: 'Storage quota',
  limitBytes: 'Global storage limit',
  expiresAt: 'Expiration',
  hostname: 'Delivery hostname',
  notes: 'Notes',
  accessMode: 'Access mode',
  isPrimary: 'Instance default',
  health: 'Health',
  label: 'Subdomain',
  restricted: 'Restricted access',
  enabled: 'Enabled',
  access: 'Allowed users',
  siteName: 'Site name',
  defaultSlugLength: 'Default share-link slug length',
  allocationSlugLength: 'Share-link allocation length',
  primaryLink: 'Primary link',
  disabledAt: 'Disabled at',
  filename: 'Filename',
  size: 'Size',
  mime: 'File type',
  imageId: 'Image ID',
  owner: 'Owner',
  reason: 'Reason',
  sessionsRevoked: 'Sessions revoked',
  imagesDeleted: 'Images deleted',
  kind: 'Finding type',
  objectKey: 'Storage object',
  runId: 'Reconciliation ID',
  bytes: 'Original bytes',
  previewBytes: 'Preview bytes',
  imageCount: 'Image count',
} as const;
export type AuditValue = string | number | boolean | null | string[];
export type AuditValues = Partial<Record<keyof typeof auditFields, AuditValue>>;
export type AuditChange = {
  field: keyof typeof auditFields;
  before: AuditValue;
  after: AuditValue;
};
const auditActorIpSchema = z.union([z.ipv4(), z.ipv6()]);

export function safeAuditActorIp(value: unknown): string | null {
  const parsed = auditActorIpSchema.safeParse(
    typeof value === 'string' ? value.trim() : value,
  );
  return parsed.success ? parsed.data : null;
}

export function auditActorIp(request: Request): string | null {
  return safeAuditActorIp(request.headers.get('cf-connecting-ip'));
}

export function safeAuditValues(input: Record<string, unknown>): AuditValues {
  const output: AuditValues = {};
  for (const field of Object.keys(
    auditFields,
  ) as (keyof typeof auditFields)[]) {
    const value = input[field];
    if (
      value === null ||
      typeof value === 'string' ||
      typeof value === 'boolean' ||
      (typeof value === 'number' && Number.isFinite(value)) ||
      (Array.isArray(value) && value.every((item) => typeof item === 'string'))
    )
      output[field] = value;
  }
  return output;
}
export function auditChanges(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
): AuditChange[] {
  const safeBefore = safeAuditValues(before),
    safeAfter = safeAuditValues(after);
  return (Object.keys(safeAfter) as (keyof typeof auditFields)[])
    .filter(
      (field) =>
        JSON.stringify(safeBefore[field] ?? null) !==
        JSON.stringify(safeAfter[field]),
    )
    .map((field) => ({
      field,
      before: safeBefore[field] ?? null,
      after: safeAfter[field]!,
    }));
}
export type AuditDatabase = ReturnType<typeof database>;
export async function auditResource(
  db: AuditDatabase,
  targetId: string | null,
) {
  if (!targetId) return { name: 'Workspace', values: {} };
  if (targetId.startsWith('usr_')) {
    const [row] = await db.select().from(users).where(eq(users.id, targetId));
    if (row) return { name: row.displayName, values: safeAuditValues(row) };
  } else if (targetId.startsWith('img_')) {
    const [row] = await db.select().from(images).where(eq(images.id, targetId));
    if (row) return { name: row.filename, values: safeAuditValues(row) };
  } else if (targetId.startsWith('dom_')) {
    const [row] = await db
      .select()
      .from(deliveryDomains)
      .where(eq(deliveryDomains.id, targetId));
    if (row) return { name: row.hostname, values: safeAuditValues(row) };
  } else if (targetId.startsWith('lnk_')) {
    const [row] = await db
      .select({ alias: aliases, deliveryHostname: deliveryDomains.hostname })
      .from(aliases)
      .innerJoin(
        deliveryDomains,
        eq(deliveryDomains.id, aliases.deliveryDomainId),
      )
      .where(eq(aliases.id, targetId));
    if (row)
      return {
        name: `${row.deliveryHostname}/${row.alias.slug}`,
        values: safeAuditValues(row.alias),
      };
  }
  return { name: targetId, values: {} };
}
// Return values, not a thenable Drizzle query: callers insert in the mutation's D1 batch.
export async function auditEvent(
  db: AuditDatabase,
  actorId: string | null,
  action: string,
  targetId: string | null = null,
  options: {
    name?: string;
    before?: AuditValues;
    after?: AuditValues;
    context?: AuditValues;
    actorName?: string;
    actorIp?: string | null;
  } = {},
) {
  const actor =
    actorId && options.actorName === undefined
      ? await auditResource(db, actorId)
      : null;
  const target =
    options.name === undefined || options.before === undefined
      ? await auditResource(db, targetId)
      : { name: options.name, values: options.before };
  const actorIp = safeAuditActorIp(options.actorIp);
  return {
    id: id('evt'),
    actorId,
    action,
    targetId,
    createdAt: now(),
    metadata: JSON.stringify({
      version: 2,
      actorName: options.actorName ?? actor?.name ?? actorIp ?? 'System',
      ...(actorIp && { actorIp }),
      targetName: options.name ?? target.name,
      changes: auditChanges(
        options.before ?? target.values,
        options.after ?? {},
      ),
      context: safeAuditValues(options.context ?? {}),
    }),
  };
}
