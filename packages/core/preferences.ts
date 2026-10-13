import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { auditEvent } from './audit';
import { requireUser } from './auth';
import { expiry, expirySchema, now } from './common';
import { database, type User } from './db';
import { validateImageExpiry } from './expiry-policy';
import { getEffectiveExpiryPolicy } from './expiry-policy-store';
import { auditLog, users } from './schema';

const preferencesSchema = z.object({
  displayName: z.string().trim().min(1).max(80).optional(),
  expiry: expirySchema
    .refine((value) => value !== 'custom', 'Choose a default duration.')
    .optional(),
  stripImageMetadata: z.boolean().optional(),
});

export async function savePreferences(
  binding: D1Database,
  actor: User,
  input: unknown,
  actorIp?: string | null,
) {
  requireUser(actor);
  const value = preferencesSchema.parse(input);
  const timestamp = now();
  if (value.expiry !== undefined)
    validateImageExpiry(
      await getEffectiveExpiryPolicy(binding, actor),
      timestamp,
      expiry(value.expiry, undefined, timestamp),
      timestamp,
    );
  const changes = {
    ...(value.displayName !== undefined && { displayName: value.displayName }),
    ...(value.expiry !== undefined && { defaultExpiry: value.expiry }),
    ...(value.stripImageMetadata !== undefined && {
      stripImageMetadata: value.stripImageMetadata,
    }),
  };
  if (Object.keys(changes).length === 0) return;
  const db = database(binding);
  const event = await auditEvent(db, actor.id, 'user.preferences', actor.id, {
    after: changes,
    actorIp,
  });
  await db.batch([
    db
      .update(users)
      .set({ ...changes, updatedAt: timestamp })
      .where(eq(users.id, actor.id)),
    db.insert(auditLog).values(event),
  ]);
}
