CREATE TABLE `aliases` (
	`id` text PRIMARY KEY NOT NULL,
	`imageId` text NOT NULL,
	`hostId` text NOT NULL,
	`slug` text NOT NULL,
	`primary` integer DEFAULT false NOT NULL,
	`expiresAt` integer,
	`disabledAt` integer,
	`createdAt` integer NOT NULL,
	FOREIGN KEY (`imageId`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`hostId`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `alias_address` ON `aliases` (`hostId`,`slug`);--> statement-breakpoint
CREATE INDEX `aliases_image` ON `aliases` (`imageId`);--> statement-breakpoint
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
CREATE TABLE `delete_tokens` (
	`imageId` text PRIMARY KEY NOT NULL,
	`hash` text NOT NULL,
	`consumedAt` integer,
	FOREIGN KEY (`imageId`) REFERENCES `images`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
CREATE TABLE `host_access` (
	`hostId` text NOT NULL,
	`userId` text NOT NULL,
	PRIMARY KEY(`hostId`, `userId`),
	FOREIGN KEY (`hostId`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `hosts` (
	`id` text PRIMARY KEY NOT NULL,
	`label` text NOT NULL,
	`restricted` integer DEFAULT false NOT NULL,
	`enabled` integer DEFAULT true NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `hosts_label_unique` ON `hosts` (`label`);--> statement-breakpoint
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
CREATE TABLE `reconciliation_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`status` text NOT NULL,
	`cursor` text,
	`metadataCursor` text,
	`phase` text DEFAULT 'objects' NOT NULL,
	`objectCount` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`startedAt` integer NOT NULL,
	`completedAt` integer
);
--> statement-breakpoint
CREATE TABLE `reserved_names` (
	`label` text PRIMARY KEY NOT NULL,
	`createdAt` integer NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE `user_storage_stats` (
	`userId` text PRIMARY KEY NOT NULL,
	`imageCount` integer DEFAULT 0 NOT NULL,
	`bytes` integer DEFAULT 0 NOT NULL,
	`previewBytes` integer DEFAULT 0 NOT NULL,
	FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "nonnegative_stats" CHECK("user_storage_stats"."imageCount" >= 0 and "user_storage_stats"."bytes" >= 0 and "user_storage_stats"."previewBytes" >= 0)
);
--> statement-breakpoint
CREATE TABLE `users` (
	`id` text PRIMARY KEY NOT NULL,
	`displayName` text NOT NULL,
	`role` text DEFAULT 'user' NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`defaultHostId` text,
	`defaultRetention` text DEFAULT 'never' NOT NULL,
	`quotaBytes` integer,
	`createdAt` integer NOT NULL,
	`updatedAt` integer NOT NULL,
	FOREIGN KEY (`defaultHostId`) REFERENCES `hosts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "valid_role" CHECK("users"."role" in ('user','admin')),
	CONSTRAINT "valid_status" CHECK("users"."status" in ('active','disabled','deleted')),
	CONSTRAINT "valid_quota" CHECK("users"."quotaBytes" is null or "users"."quotaBytes" >= 0)
);
