import { z } from 'zod';

import { auditChanges } from '../packages/core/audit';
import { id, now } from '../packages/core/common';
import { newKey } from '../packages/core/crypto';

const quote = (value: string) => `'${value.replaceAll("'", "''")}'`;

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
