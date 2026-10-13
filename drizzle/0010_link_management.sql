UPDATE aliases SET "primary" = 0 WHERE disabledAt IS NOT NULL;
--> statement-breakpoint
UPDATE aliases SET "primary" = 1
WHERE id IN (
  SELECT (SELECT a.id FROM aliases a WHERE a.imageId=i.id AND a.disabledAt IS NULL ORDER BY a.createdAt,a.id LIMIT 1)
  FROM images i WHERE i.deletedAt IS NULL
  AND NOT EXISTS (SELECT 1 FROM aliases p WHERE p.imageId=i.id AND p.disabledAt IS NULL AND p."primary"=1)
);
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
CREATE INDEX aliases_live_date ON aliases(createdAt,id) WHERE disabledAt IS NULL;
--> statement-breakpoint
CREATE INDEX aliases_live_host_date ON aliases(hostId,createdAt,id) WHERE disabledAt IS NULL;
--> statement-breakpoint
CREATE INDEX aliases_live_expiry ON aliases(expiresAt,id) WHERE disabledAt IS NULL;
