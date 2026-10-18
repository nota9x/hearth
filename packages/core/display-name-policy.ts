import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { database, type User } from './db';
import { settings } from './schema';

export const displayNamePolicySchema = z.enum(['inherit', 'allow', 'restrict']);

export async function getDisplayNameRestriction(binding: D1Database) {
  const [row] = await database(binding)
    .select({ value: settings.value })
    .from(settings)
    .where(eq(settings.key, 'restrictDisplayNameChanges'));
  return row?.value === 'true';
}

export function displayNameChangesRestricted(
  instanceRestriction: boolean,
  user: Pick<User, 'role' | 'displayNamePolicy'>,
) {
  return (
    user.role !== 'admin' &&
    (user.displayNamePolicy === 'inherit'
      ? instanceRestriction
      : user.displayNamePolicy === 'restrict')
  );
}
