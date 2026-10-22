import { z } from 'zod';

import { auditChanges } from '../packages/core/audit';
import { id, now } from '../packages/core/common';
import { newKey } from '../packages/core/crypto';

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

export const initializeFreshStorageSql = `UPDATE storage_capacity SET ready=1,multipartVerified=1
WHERE id=1 AND ready=0 AND blocked=0 AND persistedBytes=0 AND reservedBytes=0
AND NOT EXISTS(SELECT 1 FROM storage_objects) AND NOT EXISTS(SELECT 1 FROM images)`;

export async function purgeLocalDatabase(db: D1Database) {
  const schema = await db
    .prepare(
      `SELECT type,name FROM sqlite_schema WHERE type IN ('trigger','view','table')
       AND name NOT GLOB 'sqlite_*' AND name NOT GLOB '_cf_*'
       ORDER BY CASE type WHEN 'trigger' THEN 0 WHEN 'view' THEN 1 ELSE 2 END`,
    )
    .all<{ type: string; name: string }>();
  await db.batch(
    [
      'PRAGMA defer_foreign_keys=ON',
      ...schema.results.map(
        ({ type, name }) => `DROP ${type} "${name.replaceAll('"', '""')}"`,
      ),
    ].map((sql) => db.prepare(sql)),
  );
}

export async function bootstrapLocalAdministrator(
  environment: { DB: D1Database; BUCKET: R2Bucket },
  candidate: Awaited<ReturnType<typeof prepareBootstrap>>,
) {
  const objects = await environment.BUCKET.list({ limit: 1 });
  await environment.DB.batch(
    [
      ...candidate.statements,
      ...(objects.objects.length === 0 ? [initializeFreshStorageSql] : []),
    ].map((sql) => environment.DB.prepare(sql)),
  );
}

export async function prepareBootstrap(name: string, userId = id('usr')) {
  z.string().trim().min(1).max(80).parse(name);
  z.string()
    .regex(/^usr_[a-f0-9]{32}$/)
    .parse(userId);
  const key = await newKey();
  const timestamp = now();
  const trigger = `bootstrap_${userId}`;
  const metadata = JSON.stringify({
    version: 1,
    actorName: 'System',
    targetName: name,
    changes: auditChanges(
      {},
      { displayName: name, role: 'admin', status: 'active' },
    ),
    context: {},
  });
  const statements = [
    `CREATE TRIGGER IF NOT EXISTS ${trigger} AFTER INSERT ON users WHEN NEW.id=${quote(userId)} BEGIN
SELECT CASE WHEN (SELECT COUNT(*) FROM users)>1 THEN RAISE(ABORT,'administrator_already_exists') END;
INSERT INTO api_keys(userId,keyId,secretHash,createdAt) VALUES(NEW.id,${quote(key.keyId)},${quote(key.secretHash)},${timestamp});
INSERT INTO user_storage_stats(userId) VALUES(NEW.id);
INSERT INTO audit_log(id,action,targetId,metadata,createdAt) VALUES(${quote(id('evt'))},'admin.bootstrapped',NEW.id,${quote(metadata)},${timestamp});
END;`,
    `INSERT INTO users(id,displayName,role,status,bootstrapAdministrator,createdAt,updatedAt) VALUES(${quote(userId)},${quote(name)},'admin','active',1,${timestamp},${timestamp});`,
    `DROP TRIGGER ${trigger};`,
  ];
  return { userId, key, statements, sql: statements.join('\n') };
}
