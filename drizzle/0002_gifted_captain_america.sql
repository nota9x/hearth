ALTER TABLE `images` ADD `previewRetryAt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `images` ADD `previewFailures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `images` ADD `purgeRetryAt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `images` ADD `purgeFailures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `images_preview_retry` ON `images` (`previewRetryAt`,`id`) WHERE "images"."deletedAt" IS NULL AND "images"."previewKey" IS NULL;--> statement-breakpoint
CREATE INDEX `images_purge_retry` ON `images` (`purgeRetryAt`,`id`) WHERE "images"."deletedAt" IS NOT NULL AND "images"."purgedAt" IS NULL;--> statement-breakpoint
ALTER TABLE `reconciliation_runs` ADD `attempt` integer DEFAULT 1 NOT NULL;--> statement-breakpoint
ALTER TABLE `reconciliation_runs` ADD `routineDone` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `storage_objects` ADD `retryAt` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `storage_objects` ADD `failures` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE INDEX `storage_retry` ON `storage_objects` (`retryAt`,`key`);