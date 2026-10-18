import { eq } from 'drizzle-orm';
import { z } from 'zod';

import { auditEvent } from './audit';
import { requireUser } from './auth';
import { AppError, expiry, expirySchema, now } from './common';
import { database, type User } from './db';
import {
  displayNameChangesRestricted,
  getDisplayNameRestriction,
} from './display-name-policy';
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
  const db = database(binding);
  if (value.displayName !== undefined) {
    const [current] = await db
      .select({
        displayName: users.displayName,
        role: users.role,
        displayNamePolicy: users.displayNamePolicy,
      })
      .from(users)
      .where(eq(users.id, actor.id));
    if (!current) throw new AppError(404, 'NOT_FOUND', 'User not found.');
    if (
      value.displayName !== current.displayName &&
      displayNameChangesRestricted(
        await getDisplayNameRestriction(binding),
        current,
      )
    )
      throw new AppError(
        403,
        'FORBIDDEN',
        'Display name changes are disabled by your administrator.',
      );
  }
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
