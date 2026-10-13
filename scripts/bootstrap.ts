import { spawnSync } from 'node:child_process';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import nodePath from 'node:path';

import { auditChanges } from '../packages/core/audit';
import { id, now } from '../packages/core/common';
import { newKey } from '../packages/core/crypto';

const arguments_ = process.argv.slice(2),
  name = arguments_[0];
if (!name || name.length > 80)
  throw new Error(
    'Usage: pnpm bootstrap "Display name" [--remote]. This only creates the first administrator.',
  );
const remote = arguments_.includes('--remote'),
  config = arguments_.includes('--config')
    ? arguments_[arguments_.indexOf('--config') + 1]
    : 'apps/web/wrangler.jsonc';
const key = await newKey(),
  userId = id('usr'),
  timestamp = now(),
  escape = (s: string) => `'${s.replaceAll("'", "''")}'`;
const directory = await mkdtemp(nodePath.join(tmpdir(), 'hearth-bootstrap-'));
try {
  const path = nodePath.join(directory, 'bootstrap.sql');
  // Only irreversible hashes enter the temporary SQL file; never plaintext credentials.
  const trigger = `bootstrap_${userId}`;
  const sql = `CREATE TRIGGER ${trigger} AFTER INSERT ON users WHEN NEW.id=${escape(userId)} BEGIN
SELECT CASE WHEN (SELECT COUNT(*) FROM users WHERE role='admin')>1 THEN RAISE(ABORT,'administrator_already_exists') END;
INSERT INTO api_keys(userId,keyId,secretHash,createdAt) VALUES(NEW.id,${escape(key.keyId)},${escape(key.secretHash)},${timestamp});
INSERT INTO user_storage_stats(userId) VALUES(NEW.id);
INSERT INTO audit_log(id,action,targetId,metadata,createdAt) VALUES(${escape(id('evt'))},'admin.bootstrapped',NEW.id,${escape(JSON.stringify({ version: 1, actorName: 'System', targetName: name, changes: auditChanges({}, { displayName: name, role: 'admin', status: 'active' }), context: {} }))},${timestamp});
END;
INSERT INTO users(id,displayName,role,status,bootstrapAdministrator,createdAt,updatedAt) VALUES(${escape(userId)},${escape(name)},'admin','active',1,${timestamp},${timestamp});
DROP TRIGGER ${trigger};`;
  await writeFile(path, sql, { mode: 0o600 });
  const result = spawnSync(
    process.execPath,
    [
      nodePath.resolve('node_modules/wrangler/bin/wrangler.js'),
      'd1',
      'execute',
      'DB',
      remote ? '--remote' : '--local',
      '--config',
      config,
      '--file',
      path,
      '--yes',
    ],
    { encoding: 'utf8' },
  );
  if (result.status !== 0)
    throw new Error(
      `Bootstrap refused or failed. Check migrations and existing administrators. ${result.stderr.replaceAll(key.secretHash, '[digest]').slice(-1800)}`,
    );
  console.log(
    `Administrator created: ${name}\nSave this API key; it will not be shown again:\n${key.plaintext}`,
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
