import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  primaryKey,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

import type { DomainDiagnostics } from './domain-validation';
import type { ExpiryPolicyOverrides } from './expiry-policy';

export const deliveryDomains = sqliteTable(
  'delivery_domains',
  {
    id: text().primaryKey(),
    hostname: text().notNull().unique(),
    notes: text().notNull().default(''),
    accessMode: text({ enum: ['everyone', 'administrators', 'selected'] })
      .notNull()
      .default('everyone'),
    enabled: integer({ mode: 'boolean' }).notNull().default(true),
    isPrimary: integer({ mode: 'boolean' }).notNull().default(false),
    health: text({ enum: ['pending', 'active', 'misconfigured', 'unhealthy'] })
      .notNull()
      .default('pending'),
    lastCheckedAt: integer(),
    lastHealthyAt: integer(),
    diagnostics: text({ mode: 'json' }).$type<DomainDiagnostics>(),
    validationKey: text()
      .notNull()
      .default(sql`(lower(hex(randomblob(32))))`),
    checkId: text(),
    revision: integer().notNull().default(0),
    mutationId: text(),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [
    uniqueIndex('delivery_one_primary')
      .on(t.isPrimary)
      .where(sql`${t.isPrimary}=1`),
    index('delivery_domain_date').on(t.createdAt, t.id),
    check(
      'delivery_access_mode',
      sql`${t.accessMode} IN ('everyone','administrators','selected')`,
    ),
    check(
      'delivery_health',
      sql`${t.health} IN ('pending','active','misconfigured','unhealthy')`,
    ),
  ],
);
export const users = sqliteTable(
  'users',
  {
    id: text().primaryKey(),
    displayName: text().notNull(),
    role: text({ enum: ['user', 'admin'] })
      .notNull()
      .default('user'),
    status: text({ enum: ['active', 'disabled', 'deleted'] })
      .notNull()
      .default('active'),
    preferredDeliveryDomainId: text().references(() => deliveryDomains.id),
    defaultExpiry: text().notNull().default('never'),
    stripImageMetadata: integer({ mode: 'boolean' }).notNull().default(true),
    onboardingStatus: text({
      enum: ['pending', 'completed', 'skipped', 'exempt'],
    })
      .notNull()
      .default('pending'),
    onboardingStep: integer().notNull().default(0),
    onboardingUploadBaseline: integer(),
    onboardingUploadStatus: text({
      enum: ['waiting', 'verified', 'skipped'],
    }),
    onboardingUploadImageId: text(),
    bootstrapAdministrator: integer({ mode: 'boolean' })
      .notNull()
      .default(false),
    expiryPolicy: text({ mode: 'json' }).$type<ExpiryPolicyOverrides>(),
    quotaBytes: integer(),
    uploadCount: integer().notNull().default(0),
    seenUploadCount: integer().notNull().default(0),
    createdAt: integer().notNull(),
    updatedAt: integer().notNull(),
  },
  (t) => [
    check('valid_role', sql`${t.role} in ('user','admin')`),
    check(
      'valid_onboarding_status',
      sql`${t.onboardingStatus} in ('pending','completed','skipped','exempt')`,
    ),
    check('valid_onboarding_step', sql`${t.onboardingStep} between 0 and 6`),
    index('users_date').on(t.createdAt, t.id),
    check('valid_status', sql`${t.status} in ('active','disabled','deleted')`),
    check('valid_quota', sql`${t.quotaBytes} is null or ${t.quotaBytes} >= 0`),
  ],
);
export const apiKeys = sqliteTable('api_keys', {
  userId: text()
    .primaryKey()
    .references(() => users.id),
  keyId: text().notNull().unique(),
  secretHash: text().notNull(),
  version: integer().notNull().default(1),
  createdAt: integer().notNull(),
  rotatedAt: integer(),
  lastUsedAt: integer(),
});
export const uploadReceipts = sqliteTable('upload_receipts', {
  key: text().primaryKey(),
  userId: text()
    .notNull()
    .references(() => users.id),
  response: text(),
});
export const sessions = sqliteTable(
  'sessions',
  {
    hash: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id),
    version: integer().notNull(),
    createdAt: integer().notNull(),
    lastSeenAt: integer().notNull(),
    expiresAt: integer().notNull(),
  },
  (t) => [
    index('sessions_user').on(t.userId),
    index('sessions_expiry').on(t.expiresAt),
  ],
);
export const deliveryDomainAccess = sqliteTable(
  'delivery_domain_access',
  {
    deliveryDomainId: text()
      .notNull()
      .references(() => deliveryDomains.id, { onDelete: 'cascade' }),
    userId: text()
      .notNull()
      .references(() => users.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.deliveryDomainId, t.userId] }),
    index('delivery_access_user').on(t.userId),
  ],
);
export const images = sqliteTable(
  'images',
  {
    id: text().primaryKey(),
    userId: text()
      .notNull()
      .references(() => users.id),
    objectKey: text().notNull().unique(),
    filename: text().notNull(),
    mime: text().notNull(),
    extension: text().notNull(),
    size: integer().notNull(),
    sha256: text().notNull(),
    width: integer().notNull(),
    height: integer().notNull(),
    createdAt: integer().notNull(),
    expiresAt: integer(),
    deletedAt: integer(),
    purgedAt: integer(),
    previewKey: text(),
    previewSize: integer().notNull().default(0),
  },
  (t) => [
    index('images_owner_date').on(t.userId, t.createdAt),
    index('images_expiry').on(t.expiresAt),
    index('images_deleted').on(t.deletedAt, t.purgedAt),
    index('images_preview')
      .on(t.previewKey)
      .where(sql`${t.previewKey} IS NOT NULL`),
    check('image_size', sql`${t.size} > 0`),
  ],
);
export const aliases = sqliteTable(
  'aliases',
  {
    id: text().primaryKey(),
    imageId: text()
      .notNull()
      .references(() => images.id),
    deliveryDomainId: text()
      .notNull()
      .references(() => deliveryDomains.id),
    slug: text().notNull(),
    primary: integer({ mode: 'boolean' }).notNull().default(false),
    expiresAt: integer(),
    disabledAt: integer(),
    createdAt: integer().notNull(),
  },
  (t) => [
    uniqueIndex('alias_address').on(t.deliveryDomainId, t.slug),
    index('aliases_image').on(t.imageId),
    index('aliases_live_date')
      .on(t.createdAt, t.id)
      .where(sql`${t.disabledAt} IS NULL`),
    index('aliases_live_domain_date')
      .on(t.deliveryDomainId, t.createdAt, t.id)
      .where(sql`${t.disabledAt} IS NULL`),
    index('aliases_live_expiry')
      .on(t.expiresAt, t.id)
      .where(sql`${t.disabledAt} IS NULL`),
    uniqueIndex('alias_primary')
      .on(t.imageId)
      .where(sql`${t.primary} = 1 AND ${t.disabledAt} IS NULL`),
  ],
);
export const deleteTokens = sqliteTable('delete_tokens', {
  imageId: text()
    .primaryKey()
    .references(() => images.id),
  hash: text().notNull(),
  consumedAt: integer(),
});
export const storageStats = sqliteTable(
  'user_storage_stats',
  {
    userId: text()
      .primaryKey()
      .references(() => users.id),
    imageCount: integer().notNull().default(0),
    bytes: integer().notNull().default(0),
    previewBytes: integer().notNull().default(0),
  },
  (t) => [
    check(
      'nonnegative_stats',
      sql`${t.imageCount} >= 0 and ${t.bytes} >= 0 and ${t.previewBytes} >= 0`,
    ),
  ],
);
export const auditLog = sqliteTable(
  'audit_log',
  {
    id: text().primaryKey(),
    actorId: text(),
    action: text().notNull(),
    targetId: text(),
    metadata: text().notNull().default('{}'),
    createdAt: integer().notNull(),
  },
  (t) => [
    index('audit_date').on(t.createdAt),
    index('audit_actor_date').on(t.actorId, t.createdAt),
  ],
);
export const settings = sqliteTable('app_settings', {
  key: text().primaryKey(),
  value: text().notNull(),
});
export const reconciliation = sqliteTable(
  'reconciliation_runs',
  {
    id: text().primaryKey(),
    status: text().notNull(),
    cursor: text(),
    metadataCursor: text(),
    phase: text().notNull().default('objects'),
    objectCount: integer().notNull().default(0),
    bytes: integer().notNull().default(0),
    startedAt: integer().notNull(),
    completedAt: integer(),
    updatedAt: integer(),
    error: text(),
  },
  (t) => [
    uniqueIndex('reconciliation_one_running')
      .on(t.status)
      .where(sql`${t.status} = 'running'`),
  ],
);
export const maintenanceLock = sqliteTable('maintenance_lock', {
  id: text().primaryKey(),
  holder: text().notNull(),
  expiresAt: integer().notNull(),
});
export const findings = sqliteTable(
  'reconciliation_findings',
  {
    id: text().primaryKey(),
    runId: text()
      .notNull()
      .references(() => reconciliation.id),
    kind: text().notNull(),
    objectKey: text(),
    imageId: text(),
    details: text().notNull(),
    resolvedAt: integer(),
    createdAt: integer().notNull(),
  },
  (t) => [
    uniqueIndex('findings_unresolved_object')
      .on(t.kind, t.objectKey)
      .where(sql`${t.resolvedAt} IS NULL AND ${t.objectKey} IS NOT NULL`),
  ],
);
export const snapshots = sqliteTable('storage_snapshots', {
  day: text().primaryKey(),
  bytes: integer().notNull(),
  images: integer().notNull(),
});

export const storageCapacity = sqliteTable('storage_capacity', {
  id: integer().primaryKey(),
  limitBytes: integer(),
  persistedBytes: integer().notNull().default(0),
  reservedBytes: integer().notNull().default(0),
  ready: integer({ mode: 'boolean' }).notNull().default(false),
  multipartVerified: integer({ mode: 'boolean' }).notNull().default(false),
  blocked: integer({ mode: 'boolean' }).notNull().default(false),
});

export const storageObjects = sqliteTable(
  'storage_objects',
  {
    key: text().primaryKey(),
    kind: text().notNull(),
    imageId: text(),
    userId: text(),
    receiptKey: text(),
    state: text().notNull().default('uploading'),
    token: text().notNull(),
    uploadId: text(),
    reservedBytes: integer().notNull().default(0),
    stagedBytes: integer().notNull().default(0),
    storedBytes: integer().notNull().default(0),
    updatedAt: integer().notNull(),
  },
  (t) => [
    index('storage_recovery').on(t.state, t.updatedAt),
    index('storage_image').on(t.imageId),
    check(
      'storage_object_bytes',
      sql`${t.reservedBytes} >= 0 AND ${t.stagedBytes} >= 0 AND ${t.stagedBytes} <= ${t.reservedBytes} AND ${t.storedBytes} >= 0`,
    ),
  ],
);
