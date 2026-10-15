CREATE TABLE `aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`imageId` text NOT NULL,
	`deliveryDomainId` text NOT NULL,
	`slug` text NOT NULL,
	`primary` integer DEFAULT false NOT NULL,
	`expiresAt` integer,
	`disabledAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`imageId`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`deliveryDomainId`) REFERENCES `delivery_domains`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alias_address` ON `aliases` (`deliveryDomainId`,`slug`);--> statement-breakpoint
CREATE INDEX `aliases_image` ON `aliases` (`imageId`);--> statement-breakpoint
CREATE INDEX `aliases_live_date` ON `aliases` (`createdAt`,`id`) WHERE "aliases"."disabledAt" IS NULL;--> statement-breakpoint
CREATE INDEX `aliases_live_domain_date` ON `aliases` (`deliveryDomainId`,`createdAt`,`id`) WHERE "aliases"."disabledAt" IS NULL;--> statement-breakpoint
CREATE INDEX `aliases_live_expiry` ON `aliases` (`expiresAt`,`id`) WHERE "aliases"."disabledAt" IS NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `alias_primary` ON `aliases` (`imageId`) WHERE "aliases"."primary" = 1 AND "aliases"."disabledAt" IS NULL;--> statement-breakpoint
CREATE TABLE `api_keys` (
	`userId` text PRIMARY KEY NOT NULL,
	`keyId` text NOT NULL,
	`secretHash` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`createdAt` integer NOT NULL,
	`rotatedAt` integer,
	`lastUsedAt` integer,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `api_keys_keyId_unique` ON `api_keys` (`keyId`);--> statement-breakpoint
CREATE TABLE `audit_log` (
	`id` text PRIMARY KEY NOT NULL,
	`actorId` text,
	`action` text NOT NULL,
	`targetId` text,
	`metadata` text DEFAULT '{}' NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `audit_date` ON `audit_log` (`createdAt`);--> statement-breakpoint
CREATE INDEX `audit_actor_date` ON `audit_log` (`actorId`,`createdAt`);--> statement-breakpoint
CREATE TABLE `delete_tokens` (
	`imageId` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`consumedAt` integer,
	FOREIGN KEY (`imageId`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `delivery_domain_access` (
	`deliveryDomainId` text NOT NULL,
	`userId` text NOT NULL,
	PRIMARY KEY(`deliveryDomainId`, `userId`),
	FOREIGN KEY (`deliveryDomainId`) REFERENCES `delivery_domains`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `delivery_access_user` ON `delivery_domain_access` (`userId`);--> statement-breakpoint
CREATE TABLE `delivery_domains` (
	`id` text PRIMARY KEY NOT NULL,
	`hostname` text NOT NULL,
	`notes` text DEFAULT '' NOT NULL,
	`accessMode` text DEFAULT 'everyone' NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`isPrimary` integer DEFAULT false NOT NULL,
	`health` text DEFAULT 'pending' NOT NULL,
	`lastCheckedAt` integer,
	`lastHealthyAt` integer,
	`diagnostics` text,
	`validationKey` text DEFAULT (lower(hex(randomblob(32)))) NOT NULL,
	`checkId` text,
	`revision` integer DEFAULT 0 NOT NULL,
	`mutationId` text,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	CONSTRAINT "delivery_access_mode" CHECK("delivery_domains"."accessMode" IN ('everyone','administrators','selected')),
	CONSTRAINT "delivery_health" CHECK("delivery_domains"."health" IN ('pending','active','misconfigured','unhealthy'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_domains_hostname_unique` ON `delivery_domains` (`hostname`);--> statement-breakpoint
CREATE UNIQUE INDEX `delivery_one_primary` ON `delivery_domains` (`isPrimary`) WHERE "delivery_domains"."isPrimary"=1;--> statement-breakpoint
CREATE INDEX `delivery_domain_date` ON `delivery_domains` (`createdAt`,`id`);--> statement-breakpoint
CREATE TABLE `reconciliation_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`runId` text NOT NULL,
	`kind` text NOT NULL,
	`objectKey` text,
	`imageId` text,
	`details` text NOT NULL,
	`resolvedAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`runId`) REFERENCES `reconciliation_runs`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `findings_unresolved_object` ON `reconciliation_findings` (`kind`,`objectKey`) WHERE "reconciliation_findings"."resolvedAt" IS NULL AND "reconciliation_findings"."objectKey" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `images` (
	`id` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`objectKey` text NOT NULL,
	`filename` text NOT NULL,
	`mime` text NOT NULL,
	`extension` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`expiresAt` integer,
	`deletedAt` integer,
	`purgedAt` integer,
	`previewKey` text,
	`previewSize` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "image_size" CHECK("images"."size" > 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `images_objectKey_unique` ON `images` (`objectKey`);--> statement-breakpoint
CREATE INDEX `images_owner_date` ON `images` (`userId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `images_expiry` ON `images` (`expiresAt`);--> statement-breakpoint
CREATE INDEX `images_deleted` ON `images` (`deletedAt`,`purgedAt`);--> statement-breakpoint
CREATE INDEX `images_preview` ON `images` (`previewKey`) WHERE "images"."previewKey" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `maintenance_lock` (
	`id` text PRIMARY KEY NOT NULL,
	`holder` text NOT NULL,
	`expiresAt` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `reconciliation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`cursor` text,
	`metadataCursor` text,
	`phase` text DEFAULT 'objects' NOT NULL,
	`objectCount` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`startedAt` integer NOT NULL,
	`completedAt` integer,
	`updatedAt` integer,
	`error` text
);
--> statement-breakpoint
CREATE UNIQUE INDEX `reconciliation_one_running` ON `reconciliation_runs` (`status`) WHERE "reconciliation_runs"."status" = 'running';--> statement-breakpoint
CREATE TABLE `sessions` (
	`hash` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`version` integer NOT NULL,
	`createdAt` integer NOT NULL,
	`lastSeenAt` integer NOT NULL,
	`expiresAt` integer NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `sessions_user` ON `sessions` (`userId`);--> statement-breakpoint
CREATE INDEX `sessions_expiry` ON `sessions` (`expiresAt`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_snapshots` (
	`day` text PRIMARY KEY NOT NULL,
	`bytes` integer NOT NULL,
	`images` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_capacity` (
	`id` integer PRIMARY KEY NOT NULL,
	`limitBytes` integer,
	`persistedBytes` integer DEFAULT 0 NOT NULL,
	`reservedBytes` integer DEFAULT 0 NOT NULL,
	`ready` integer DEFAULT false NOT NULL,
	`multipartVerified` integer DEFAULT false NOT NULL,
	`blocked` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE TABLE `storage_objects` (
	`key` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`imageId` text,
	`userId` text,
	`receiptKey` text,
	`state` text DEFAULT 'uploading' NOT NULL,
	`token` text NOT NULL,
	`uploadId` text,
	`reservedBytes` integer DEFAULT 0 NOT NULL,
	`stagedBytes` integer DEFAULT 0 NOT NULL,
	`storedBytes` integer DEFAULT 0 NOT NULL,
	`updatedAt` integer NOT NULL,
	CONSTRAINT "storage_object_bytes" CHECK("storage_objects"."reservedBytes" >= 0 AND "storage_objects"."stagedBytes" >= 0 AND "storage_objects"."stagedBytes" <= "storage_objects"."reservedBytes" AND "storage_objects"."storedBytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `storage_recovery` ON `storage_objects` (`state`,`updatedAt`);--> statement-breakpoint
CREATE INDEX `storage_image` ON `storage_objects` (`imageId`);--> statement-breakpoint
CREATE TABLE `user_storage_stats` (
	`userId` text PRIMARY KEY NOT NULL,
	`imageCount` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`previewBytes` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "nonnegative_stats" CHECK("user_storage_stats"."imageCount" >= 0 and "user_storage_stats"."bytes" >= 0 and "user_storage_stats"."previewBytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE `upload_receipts` (
	`key` text PRIMARY KEY NOT NULL,
	`userId` text NOT NULL,
	`response` text,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`displayName` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`preferredDeliveryDomainId` text,
	`defaultExpiry` text DEFAULT 'never' NOT NULL,
	`stripImageMetadata` integer DEFAULT true NOT NULL,
	`onboardingStatus` text DEFAULT 'pending' NOT NULL,
	`onboardingStep` integer DEFAULT 0 NOT NULL,
	`onboardingUploadBaseline` integer,
	`onboardingUploadStatus` text,
	`onboardingUploadImageId` text,
	`bootstrapAdministrator` integer DEFAULT false NOT NULL,
	`expiryPolicy` text,
	`quotaBytes` integer,
	`uploadCount` integer DEFAULT 0 NOT NULL,
	`seenUploadCount` integer DEFAULT 0 NOT NULL,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`preferredDeliveryDomainId`) REFERENCES `delivery_domains`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "valid_role" CHECK("users"."role" in ('user','admin')),
	CONSTRAINT "valid_onboarding_status" CHECK("users"."onboardingStatus" in ('pending','completed','skipped','exempt')),
	CONSTRAINT "valid_onboarding_step" CHECK("users"."onboardingStep" between 0 and 6),
	CONSTRAINT "valid_status" CHECK("users"."status" in ('active','disabled','deleted')),
	CONSTRAINT "valid_quota" CHECK("users"."quotaBytes" is null or "users"."quotaBytes" >= 0)
);
--> statement-breakpoint
CREATE INDEX `users_date` ON `users` (`createdAt`,`id`);
--> statement-breakpoint
INSERT INTO storage_capacity(id) VALUES(1);
--> statement-breakpoint
INSERT INTO app_settings(key,value) VALUES('shareSlugConfiguration','{"defaultLength":5,"automaticFloor":3}');
--> statement-breakpoint
CREATE TRIGGER alias_access BEFORE INSERT ON aliases BEGIN
 SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM images i JOIN users u ON u.id=i.userId JOIN delivery_domains d ON d.id=NEW.deliveryDomainId
  WHERE i.id=NEW.imageId AND i.deletedAt IS NULL AND u.status='active' AND d.enabled=1 AND d.health='active'
  AND (u.role='admin' OR d.accessMode='everyone' OR (d.accessMode='selected' AND EXISTS(SELECT 1 FROM delivery_domain_access a WHERE a.deliveryDomainId=d.id AND a.userId=u.id)))
 ) THEN RAISE(ABORT,'delivery_access_denied') END;
END;
--> statement-breakpoint
CREATE TRIGGER alias_first_primary AFTER INSERT ON aliases
WHEN NEW.disabledAt IS NULL AND NOT EXISTS (SELECT 1 FROM aliases WHERE imageId=NEW.imageId AND disabledAt IS NULL AND "primary"=1)
BEGIN
  UPDATE aliases SET "primary"=1 WHERE id=NEW.id;
END;
--> statement-breakpoint
CREATE TRIGGER alias_promote_primary AFTER UPDATE OF disabledAt ON aliases
WHEN OLD.disabledAt IS NULL AND NEW.disabledAt IS NOT NULL AND OLD."primary"=1
BEGIN
  UPDATE aliases SET "primary"=1
  WHERE id=(SELECT id FROM aliases WHERE imageId=NEW.imageId AND disabledAt IS NULL ORDER BY createdAt,id LIMIT 1)
  AND EXISTS (SELECT 1 FROM images WHERE id=NEW.imageId AND deletedAt IS NULL)
  AND NOT EXISTS (SELECT 1 FROM aliases WHERE imageId=NEW.imageId AND disabledAt IS NULL AND "primary"=1);
END;
--> statement-breakpoint
CREATE TRIGGER audit_retention AFTER INSERT ON audit_log
WHEN (SELECT count(*) FROM audit_log) > 10000
BEGIN
  DELETE FROM audit_log WHERE rowid IN (
    SELECT rowid FROM audit_log ORDER BY createdAt ASC, rowid ASC
    LIMIT (SELECT max(count(*) - 10000, 0) FROM audit_log)
  );
END;
--> statement-breakpoint
CREATE TRIGGER delivery_clear_preferences BEFORE DELETE ON delivery_domains BEGIN
 UPDATE users SET preferredDeliveryDomainId=NULL WHERE preferredDeliveryDomainId=OLD.id;
END;
--> statement-breakpoint
CREATE TRIGGER delivery_primary_insertion BEFORE INSERT ON delivery_domains WHEN NEW.isPrimary=1 AND (NEW.enabled=0 OR NEW.health<>'active') BEGIN
 SELECT RAISE(ABORT,'delivery_primary_unavailable');
END;
--> statement-breakpoint
CREATE TRIGGER delivery_primary_removal BEFORE DELETE ON delivery_domains WHEN OLD.isPrimary=1 BEGIN
 SELECT RAISE(ABORT,'delivery_primary_requires_replacement');
END;
--> statement-breakpoint
CREATE TRIGGER delivery_primary_selection BEFORE UPDATE OF isPrimary,enabled ON delivery_domains
WHEN NEW.isPrimary=1 AND (NEW.enabled=0 OR (OLD.isPrimary=0 AND NEW.health<>'active')) BEGIN
 SELECT RAISE(ABORT,'delivery_primary_unavailable');
END;
--> statement-breakpoint
CREATE TRIGGER image_added AFTER INSERT ON images WHEN NEW.deletedAt IS NULL BEGIN
  UPDATE user_storage_stats SET imageCount=imageCount+1,bytes=bytes+NEW.size WHERE userId=NEW.userId;
END;
--> statement-breakpoint
CREATE TRIGGER image_deleted AFTER UPDATE OF deletedAt ON images WHEN OLD.deletedAt IS NULL AND NEW.deletedAt IS NOT NULL BEGIN
  UPDATE user_storage_stats SET imageCount=imageCount-1,bytes=bytes-OLD.size,previewBytes=previewBytes-OLD.previewSize WHERE userId=OLD.userId;
END;
--> statement-breakpoint
CREATE TRIGGER image_insert_guard BEFORE INSERT ON images BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.userId AND status='active') THEN RAISE(ABORT,'account_inactive') END;
  SELECT CASE WHEN (SELECT quotaBytes FROM users WHERE id=NEW.userId) IS NOT NULL AND (SELECT bytes+previewBytes FROM user_storage_stats WHERE userId=NEW.userId)+NEW.size>(SELECT quotaBytes FROM users WHERE id=NEW.userId) THEN RAISE(ABORT,'quota_exceeded') END;
END;
--> statement-breakpoint
CREATE TRIGGER prevent_key_removal BEFORE DELETE ON api_keys WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.userId AND status<>'deleted') BEGIN
  SELECT RAISE(ABORT,'credential_required');
END;
--> statement-breakpoint
CREATE TRIGGER preview_changed AFTER UPDATE OF previewSize ON images WHEN NEW.deletedAt IS NULL BEGIN
  UPDATE user_storage_stats SET previewBytes=previewBytes+NEW.previewSize-OLD.previewSize WHERE userId=NEW.userId;
END;
--> statement-breakpoint
CREATE TRIGGER protect_last_admin BEFORE UPDATE OF role,status ON users WHEN OLD.role='admin' AND OLD.status='active' AND (NEW.role<>'admin' OR NEW.status<>'active') BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM users WHERE role='admin' AND status='active')<=1 THEN RAISE(ABORT,'last_admin') END;
END;
--> statement-breakpoint
CREATE TRIGGER storage_added AFTER INSERT ON storage_objects BEGIN
  UPDATE storage_capacity SET persistedBytes=persistedBytes+NEW.storedBytes,reservedBytes=reservedBytes+NEW.reservedBytes WHERE id=1;
END;
--> statement-breakpoint
CREATE TRIGGER storage_changed AFTER UPDATE OF storedBytes,reservedBytes ON storage_objects BEGIN
  UPDATE storage_capacity SET persistedBytes=persistedBytes+NEW.storedBytes-OLD.storedBytes,reservedBytes=reservedBytes+NEW.reservedBytes-OLD.reservedBytes WHERE id=1;
END;
--> statement-breakpoint
CREATE TRIGGER storage_finalize_claim BEFORE INSERT ON storage_objects WHEN NEW.kind='finalization' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_objects WHERE key=NEW.key AND token=NEW.token AND state='committing') THEN RAISE(ABORT,'storage_writer_closed') END;
END;
--> statement-breakpoint
CREATE TRIGGER storage_finalize_guard BEFORE UPDATE OF state ON storage_objects WHEN NEW.state='live' AND OLD.state<>'live' BEGIN
  SELECT CASE WHEN OLD.state<>'committing' THEN RAISE(ABORT,'storage_writer_closed') END;
END;
--> statement-breakpoint
CREATE TRIGGER storage_removed AFTER DELETE ON storage_objects BEGIN
  UPDATE storage_capacity SET persistedBytes=persistedBytes-OLD.storedBytes,reservedBytes=reservedBytes-OLD.reservedBytes WHERE id=1;
END;
--> statement-breakpoint
CREATE TRIGGER storage_reserve_guard BEFORE UPDATE OF reservedBytes ON storage_objects WHEN NEW.reservedBytes > OLD.reservedBytes BEGIN
  SELECT CASE WHEN (SELECT blocked FROM storage_capacity WHERE id=1)=1 OR ((SELECT limitBytes FROM storage_capacity WHERE id=1) IS NOT NULL AND (SELECT ready FROM storage_capacity WHERE id=1)=0) THEN RAISE(ABORT,'storage_accounting_unavailable') END;
  SELECT CASE WHEN (SELECT limitBytes FROM storage_capacity WHERE id=1) IS NOT NULL AND (SELECT persistedBytes+reservedBytes FROM storage_capacity WHERE id=1)+NEW.reservedBytes-OLD.reservedBytes>(SELECT limitBytes FROM storage_capacity WHERE id=1) THEN RAISE(ABORT,'global_storage_limit') END;
END;
