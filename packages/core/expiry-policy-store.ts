import { eq } from 'drizzle-orm';

import { database, type User } from './db.ts';
import {
  expiryPolicySchema,
  resolveExpiryPolicy,
  unrestrictedExpiryPolicy,
} from './expiry-policy.ts';
import { settings, users } from './schema.ts';

export async function getInstanceExpiryPolicy(binding: D1Database) {
  const [row] = await database(binding)
    .select()
    .from(settings)
    .where(eq(settings.key, 'expiryPolicy'));
  return row
    ? expiryPolicySchema.parse(JSON.parse(row.value))
    : unrestrictedExpiryPolicy;
}
export async function getEffectiveExpiryPolicy(
  binding: D1Database,
  user: User,
) {
  const [current] = await database(binding)
    .select()
    .from(users)
    .where(eq(users.id, user.id));
  return resolveExpiryPolicy(
    await getInstanceExpiryPolicy(binding),
    current ?? user,
  );
}
