import { and, eq, gt, sql } from 'drizzle-orm';

import { auditEvent } from './audit';
import { AppError, id, now } from './common';
import { newKey, parseKey, randomSecret, verify } from './crypto';
import { database, type User } from './db';
import { digest } from './digest';
import { apiKeys, auditLog, sessions, storageStats, users } from './schema';

export async function authenticateKey(binding: D1Database, key: string) {
  const database_ = database(binding);
  const keyId = parseKey(key);
  const [row] = await database_
    .select({ key: apiKeys, user: users })
    .from(apiKeys)
    .innerJoin(users, eq(users.id, apiKeys.userId))
    .where(eq(apiKeys.keyId, keyId));
  const valid = await verify(
    key,
    row?.key.secretHash || '0'.repeat(64),
    'api-key',
  );
  if (!row || !valid || row.user.status !== 'active')
    throw new AppError(401, 'INVALID_KEY', 'The API key is invalid.');
  if ((row.key.lastUsedAt || 0) < now() - 300)
    await database_
      .update(apiKeys)
      .set({ lastUsedAt: now() })
      .where(eq(apiKeys.userId, row.user.id));
  return row;
}
export async function createSession(
  binding: D1Database,
  userId: string,
  version: number,
  actorIp?: string | null,
) {
  const token = randomSecret();
  const timestamp = now();
  const db = database(binding);
  await db.batch([
    db.insert(sessions).values({
      hash: await digest(token, 'session'),
      userId,
      version,
      createdAt: timestamp,
      lastSeenAt: timestamp,
      expiresAt: timestamp + 30 * 86_400,
    }),
    db
      .insert(auditLog)
      .values(await auditEvent(db, userId, 'auth.login', userId, { actorIp })),
  ]);
  return token;
}
export async function authenticateSession(
  binding: D1Database,
  token: string | undefined,
) {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const database_ = database(binding);
  const hash = await digest(token, 'session');
  const timestamp = now();
  const [row] = await database_
    .select({ user: users, session: sessions })
    .from(sessions)
    .innerJoin(users, eq(users.id, sessions.userId))
    .innerJoin(
      apiKeys,
      and(eq(apiKeys.userId, users.id), eq(apiKeys.version, sessions.version)),
    )
    .where(
      and(
        eq(sessions.hash, hash),
        gt(sessions.expiresAt, timestamp),
        gt(sessions.lastSeenAt, timestamp - 7 * 86_400),
        eq(users.status, 'active'),
      ),
    );
  if (!row) return null;
  if (row.session.lastSeenAt < timestamp - 300)
    await database_
      .update(sessions)
      .set({ lastSeenAt: timestamp })
      .where(eq(sessions.hash, hash));
  return row.user;
}
export function requireUser(user: User | null | undefined): User {
  if (!user)
    throw new AppError(401, 'UNAUTHENTICATED', 'Please sign in to continue.');
  return user;
}
export function requireAdmin(user: User | null | undefined): User {
  const u = requireUser(user);
  if (u.role !== 'admin')
    throw new AppError(403, 'FORBIDDEN', 'Administrator access is required.');
  return u;
}
export function authorizeOwner(user: User, ownerId: string) {
  if (user.id !== ownerId && user.role !== 'admin')
    throw new AppError(404, 'NOT_FOUND', 'Image not found.');
}
export async function createUser(
  binding: D1Database,
  displayName: string,
  role: 'user' | 'admin',
  actorId: string | null,
  actorIp?: string | null,
) {
  const database_ = database(binding),
    key = await newKey(),
    timestamp = now(),
    userId = id('usr');
  await database_.batch([
    database_.insert(users).values({
      id: userId,
      displayName,
      role,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    database_.insert(apiKeys).values({
      userId,
      keyId: key.keyId,
      secretHash: key.secretHash,
      createdAt: timestamp,
    }),
    database_.insert(storageStats).values({ userId }),
    database_.insert(auditLog).values(
      await auditEvent(database_, actorId, 'user.created', userId, {
        name: displayName,
        before: {},
        after: { displayName, role, status: 'active' },
        actorIp,
      }),
    ),
  ]);
  return { userId, key: key.plaintext };
}
export async function rotateKey(
  binding: D1Database,
  userId: string,
  actorId: string,
  admin = false,
  actorIp?: string | null,
) {
  const database_ = database(binding),
    key = await newKey(),
    timestamp = now();
  await database_.batch([
    database_
      .update(apiKeys)
      .set({
        keyId: key.keyId,
        secretHash: key.secretHash,
        version: sql`${apiKeys.version}+1`,
        rotatedAt: timestamp,
      })
      .where(eq(apiKeys.userId, userId)),
    database_.delete(sessions).where(eq(sessions.userId, userId)),
    database_
      .insert(auditLog)
      .values(
        await auditEvent(
          database_,
          actorId,
          admin ? 'credential.reset' : 'credential.rotated',
          userId,
          { context: { sessionsRevoked: true }, actorIp },
        ),
      ),
  ]);
  return key.plaintext;
}
