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
ALTER TABLE `reconciliation_runs` ADD `updatedAt` integer;--> statement-breakpoint
ALTER TABLE `reconciliation_runs` ADD `error` text;--> statement-breakpoint
INSERT INTO storage_capacity(id) VALUES(1);
--> statement-breakpoint
CREATE TRIGGER storage_reserve_guard BEFORE UPDATE OF reservedBytes ON storage_objects WHEN NEW.reservedBytes > OLD.reservedBytes BEGIN
  SELECT CASE WHEN (SELECT blocked FROM storage_capacity WHERE id=1)=1 OR ((SELECT limitBytes FROM storage_capacity WHERE id=1) IS NOT NULL AND (SELECT ready FROM storage_capacity WHERE id=1)=0) THEN RAISE(ABORT,'storage_accounting_unavailable') END;
  SELECT CASE WHEN (SELECT limitBytes FROM storage_capacity WHERE id=1) IS NOT NULL AND (SELECT persistedBytes+reservedBytes FROM storage_capacity WHERE id=1)+NEW.reservedBytes-OLD.reservedBytes>(SELECT limitBytes FROM storage_capacity WHERE id=1) THEN RAISE(ABORT,'global_storage_limit') END;
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
CREATE TRIGGER storage_removed AFTER DELETE ON storage_objects BEGIN
  UPDATE storage_capacity SET persistedBytes=persistedBytes-OLD.storedBytes,reservedBytes=reservedBytes-OLD.reservedBytes WHERE id=1;
END;
--> statement-breakpoint
CREATE TRIGGER storage_finalize_guard BEFORE UPDATE OF state ON storage_objects WHEN NEW.state='live' AND OLD.state<>'live' BEGIN
  SELECT CASE WHEN OLD.state<>'committing' THEN RAISE(ABORT,'storage_writer_closed') END;
END;
--> statement-breakpoint
INSERT INTO storage_objects(key,kind,imageId,userId,state,token,storedBytes,updatedAt)
SELECT objectKey,'original',id,userId,'live','baseline',size,createdAt FROM images WHERE purgedAt IS NULL;
--> statement-breakpoint
INSERT INTO storage_objects(key,kind,imageId,userId,state,token,storedBytes,updatedAt)
SELECT previewKey,'preview',id,userId,'live','baseline',MAX(previewSize),MAX(createdAt) FROM images WHERE purgedAt IS NULL AND previewKey IS NOT NULL GROUP BY previewKey ON CONFLICT DO NOTHING;
--> statement-breakpoint
UPDATE reconciliation_findings SET resolvedAt=CAST(strftime('%s','now') AS integer) WHERE resolvedAt IS NULL AND objectKey IS NOT NULL AND rowid NOT IN (SELECT MIN(rowid) FROM reconciliation_findings WHERE resolvedAt IS NULL AND objectKey IS NOT NULL GROUP BY kind,objectKey);
--> statement-breakpoint
CREATE UNIQUE INDEX findings_unresolved_object ON reconciliation_findings(kind,objectKey) WHERE resolvedAt IS NULL AND objectKey IS NOT NULL;
--> statement-breakpoint
CREATE TRIGGER storage_finalize_claim BEFORE INSERT ON storage_objects WHEN NEW.kind='finalization' BEGIN
  SELECT CASE WHEN NOT EXISTS(SELECT 1 FROM storage_objects WHERE key=NEW.key AND token=NEW.token AND state='committing') THEN RAISE(ABORT,'storage_writer_closed') END;
END;
--> statement-breakpoint
CREATE INDEX images_preview ON images(previewKey) WHERE previewKey IS NOT NULL;
