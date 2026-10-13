-- Reset delivery configuration and public links; accounts, originals, and storage accounting remain intact.
DROP TABLE aliases;
--> statement-breakpoint
DROP TABLE host_access;
--> statement-breakpoint
DROP TABLE reserved_names;
--> statement-breakpoint
UPDATE users SET defaultHostId=NULL;
--> statement-breakpoint
DELETE FROM hosts;
--> statement-breakpoint
ALTER TABLE hosts RENAME TO delivery_domains;
--> statement-breakpoint
ALTER TABLE users RENAME COLUMN defaultHostId TO preferredDeliveryDomainId;
--> statement-breakpoint
DROP TABLE delivery_domains;
--> statement-breakpoint
DELETE FROM upload_receipts;
--> statement-breakpoint
CREATE TABLE delivery_domains (
 id TEXT PRIMARY KEY NOT NULL,
 hostname TEXT NOT NULL,
 notes TEXT NOT NULL DEFAULT '',
 accessMode TEXT NOT NULL DEFAULT 'everyone' CHECK(accessMode IN ('everyone','administrators','selected')),
 enabled INTEGER NOT NULL DEFAULT 1,
 isPrimary INTEGER NOT NULL DEFAULT 0,
 health TEXT NOT NULL DEFAULT 'pending' CHECK(health IN ('pending','active','misconfigured','unhealthy')),
 lastCheckedAt INTEGER,
 lastHealthyAt INTEGER,
 diagnostics TEXT,
 validationKey TEXT NOT NULL DEFAULT (lower(hex(randomblob(32)))),
 checkId TEXT,
 revision INTEGER NOT NULL DEFAULT 0,
 mutationId TEXT,
 createdAt INTEGER NOT NULL,
 updatedAt INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX delivery_domains_hostname_unique ON delivery_domains(hostname);
--> statement-breakpoint
CREATE UNIQUE INDEX delivery_one_primary ON delivery_domains(isPrimary) WHERE isPrimary=1;
--> statement-breakpoint
CREATE INDEX delivery_domain_date ON delivery_domains(createdAt,id);
--> statement-breakpoint
CREATE TABLE delivery_domain_access (
 deliveryDomainId TEXT NOT NULL REFERENCES delivery_domains(id) ON DELETE CASCADE,
 userId TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 PRIMARY KEY(deliveryDomainId,userId)
);
--> statement-breakpoint
CREATE INDEX delivery_access_user ON delivery_domain_access(userId);
--> statement-breakpoint
CREATE TABLE aliases (
 id TEXT PRIMARY KEY NOT NULL,
 imageId TEXT NOT NULL REFERENCES images(id),
 deliveryDomainId TEXT NOT NULL REFERENCES delivery_domains(id),
 slug TEXT NOT NULL,
 "primary" INTEGER NOT NULL DEFAULT 0,
 expiresAt INTEGER,
 disabledAt INTEGER,
 createdAt INTEGER NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX alias_address ON aliases(deliveryDomainId,slug);
--> statement-breakpoint
CREATE INDEX aliases_image ON aliases(imageId);
--> statement-breakpoint
CREATE UNIQUE INDEX alias_primary ON aliases(imageId) WHERE "primary"=1 AND disabledAt IS NULL;
--> statement-breakpoint
CREATE INDEX aliases_live_date ON aliases(createdAt,id) WHERE disabledAt IS NULL;
--> statement-breakpoint
CREATE INDEX aliases_live_domain_date ON aliases(deliveryDomainId,createdAt,id) WHERE disabledAt IS NULL;
--> statement-breakpoint
CREATE INDEX aliases_live_expiry ON aliases(expiresAt,id) WHERE disabledAt IS NULL;
--> statement-breakpoint
CREATE TRIGGER delivery_primary_selection BEFORE UPDATE OF isPrimary,enabled ON delivery_domains
WHEN NEW.isPrimary=1 AND (NEW.enabled=0 OR (OLD.isPrimary=0 AND NEW.health<>'active')) BEGIN
 SELECT RAISE(ABORT,'delivery_primary_unavailable');
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
CREATE TRIGGER delivery_clear_preferences BEFORE DELETE ON delivery_domains BEGIN
 UPDATE users SET preferredDeliveryDomainId=NULL WHERE preferredDeliveryDomainId=OLD.id;
END;
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

