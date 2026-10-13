-- Counters and quotas must be atomic even when uploads race across Workers.
CREATE TRIGGER image_insert_guard BEFORE INSERT ON images BEGIN
  SELECT CASE WHEN NOT EXISTS (SELECT 1 FROM users WHERE id=NEW.userId AND status='active') THEN RAISE(ABORT,'account_inactive') END;
  SELECT CASE WHEN (SELECT quotaBytes FROM users WHERE id=NEW.userId) IS NOT NULL AND (SELECT bytes+previewBytes FROM user_storage_stats WHERE userId=NEW.userId)+NEW.size>(SELECT quotaBytes FROM users WHERE id=NEW.userId) THEN RAISE(ABORT,'quota_exceeded') END;
END;
CREATE TRIGGER image_added AFTER INSERT ON images WHEN NEW.deletedAt IS NULL BEGIN
  UPDATE user_storage_stats SET imageCount=imageCount+1,bytes=bytes+NEW.size WHERE userId=NEW.userId;
END;
CREATE TRIGGER image_deleted AFTER UPDATE OF deletedAt ON images WHEN OLD.deletedAt IS NULL AND NEW.deletedAt IS NOT NULL BEGIN
  UPDATE user_storage_stats SET imageCount=imageCount-1,bytes=bytes-OLD.size,previewBytes=previewBytes-OLD.previewSize WHERE userId=OLD.userId;
END;
CREATE TRIGGER preview_changed AFTER UPDATE OF previewSize ON images WHEN NEW.deletedAt IS NULL BEGIN
  UPDATE user_storage_stats SET previewBytes=previewBytes+NEW.previewSize-OLD.previewSize WHERE userId=NEW.userId;
END;
CREATE TRIGGER alias_access BEFORE INSERT ON aliases BEGIN
  SELECT CASE WHEN NOT EXISTS (
    SELECT 1 FROM images i JOIN users u ON i.userId=u.id JOIN hosts h ON h.id=NEW.hostId
    WHERE i.id=NEW.imageId AND i.deletedAt IS NULL AND u.status='active' AND h.enabled=1
    AND (h.restricted=0 OR EXISTS(SELECT 1 FROM host_access a WHERE a.hostId=h.id AND a.userId=u.id))
  ) THEN RAISE(ABORT,'host_access_denied') END;
END;
CREATE TRIGGER protect_last_admin BEFORE UPDATE OF role,status ON users WHEN OLD.role='admin' AND OLD.status='active' AND (NEW.role<>'admin' OR NEW.status<>'active') BEGIN
  SELECT CASE WHEN (SELECT COUNT(*) FROM users WHERE role='admin' AND status='active')<=1 THEN RAISE(ABORT,'last_admin') END;
END;
CREATE TRIGGER prevent_key_removal BEFORE DELETE ON api_keys WHEN EXISTS(SELECT 1 FROM users WHERE id=OLD.userId AND status<>'deleted') BEGIN
  SELECT RAISE(ABORT,'credential_required');
END;
