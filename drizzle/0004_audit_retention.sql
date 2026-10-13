-- Trim existing history before installing the write-time retention guard.
-- audit_date also indexes SQLite rowid, providing a stable oldest-first order.
DELETE FROM audit_log WHERE rowid IN (
  SELECT rowid FROM audit_log ORDER BY createdAt ASC, rowid ASC
  LIMIT (SELECT max(count(*) - 10000, 0) FROM audit_log)
);
--> statement-breakpoint
CREATE TRIGGER audit_retention AFTER INSERT ON audit_log
WHEN (SELECT count(*) FROM audit_log) > 10000
BEGIN
  DELETE FROM audit_log WHERE rowid IN (
    SELECT rowid FROM audit_log ORDER BY createdAt ASC, rowid ASC
    LIMIT (SELECT max(count(*) - 10000, 0) FROM audit_log)
  );
END;
