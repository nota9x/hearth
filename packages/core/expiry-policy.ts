import { z } from 'zod';

import { AppError, durations, expiry, expiryDuration, now } from './common.ts';

export const lifetimeSchema = z
  .number()
  .int()
  .positive()
  .max(8_640_000_000_000);
export const expiryPolicySchema = z
  .object({
    requireExpiry: z.boolean(),
    maxLifetimeSeconds: lifetimeSchema.nullable(),
  })
  .strict();
export const expiryOverridesSchema = expiryPolicySchema.partial();
export type ExpiryPolicy = z.infer<typeof expiryPolicySchema>;
export type ExpiryPolicyOverrides = z.infer<typeof expiryOverridesSchema>;
export type EffectiveExpiryPolicy = ExpiryPolicy & {
  source: 'instance' | 'custom' | 'administrator';
};
export const unrestrictedExpiryPolicy: ExpiryPolicy = {
  requireExpiry: false,
  maxLifetimeSeconds: null,
};
export function resolveExpiryPolicy(
  instance: ExpiryPolicy,
  user: { role: string; expiryPolicy: ExpiryPolicyOverrides | null },
): EffectiveExpiryPolicy {
  if (user.role === 'admin')
    return { ...unrestrictedExpiryPolicy, source: 'administrator' };
  const overrides = user.expiryPolicy;
  return {
    requireExpiry: overrides?.requireExpiry ?? instance.requireExpiry,
    maxLifetimeSeconds:
      overrides?.maxLifetimeSeconds === undefined
        ? instance.maxLifetimeSeconds
        : overrides.maxLifetimeSeconds,
    source:
      overrides && Object.keys(overrides).length > 0 ? 'custom' : 'instance',
  };
}
export function formatLifetime(seconds: number | null): string {
  if (seconds === null) return 'Unlimited';
  for (const [unit, length] of [
    ['year', 31_536_000],
    ['day', 86_400],
    ['hour', 3600],
    ['minute', 60],
    ['second', 1],
  ] as const)
    if (seconds % length === 0) {
      const count = seconds / length;
      return `${count} ${unit}${count === 1 ? '' : 's'}`;
    }
  return `${seconds} seconds`;
}
export function validateImageExpiry(
  policy: ExpiryPolicy,
  createdAt: number,
  expiresAt: number | null,
  timestamp = now(),
) {
  return validateResourceExpiry(
    policy,
    createdAt,
    expiresAt,
    timestamp,
    'Images',
    'upload',
  );
}
export function validateResourceExpiry(
  policy: ExpiryPolicy,
  createdAt: number,
  expiresAt: number | null,
  timestamp = now(),
  resource = 'Images',
  origin = 'upload',
) {
  if (expiresAt === null) {
    if (policy.requireExpiry || policy.maxLifetimeSeconds !== null)
      throw new AppError(
        400,
        'EXPIRY_REQUIRED',
        `${resource} must have an expiry. Choose a duration${resource === 'Images' ? ' in your default image expiry settings' : ''}.`,
      );
    return;
  }
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= timestamp)
    throw new AppError(
      400,
      'INVALID_EXPIRATION',
      'Choose a future expiration.',
    );
  if (
    policy.maxLifetimeSeconds !== null &&
    expiresAt > createdAt + policy.maxLifetimeSeconds
  )
    throw new AppError(
      400,
      'EXPIRY_TOO_LONG',
      `${resource} may expire at most ${formatLifetime(policy.maxLifetimeSeconds)} after ${origin}.`,
    );
}
export function defaultExpiryError(policy: ExpiryPolicy, value: string) {
  const timestamp = now();
  try {
    validateImageExpiry(
      policy,
      timestamp,
      expiry(value, undefined, timestamp),
      timestamp,
    );
    return '';
  } catch (error) {
    return error instanceof Error
      ? error.message
      : 'Choose a valid default image expiry.';
  }
}
export function expiryChoices(
  policy: ExpiryPolicy,
  deadline: number | null = null,
  timestamp = now(),
) {
  const choices: [string, string][] = [];
  if (!policy.requireExpiry && policy.maxLifetimeSeconds === null)
    choices.push(['never', 'Never']);
  for (const [token, seconds] of Object.entries(durations))
    if (
      (policy.maxLifetimeSeconds === null ||
        seconds <= policy.maxLifetimeSeconds) &&
      (deadline === null || timestamp + seconds <= deadline)
    )
      choices.push([token, formatLifetime(seconds)]);
  if (
    deadline === null &&
    policy.maxLifetimeSeconds !== null &&
    !Object.values(durations).includes(policy.maxLifetimeSeconds)
  )
    choices.push([
      `${policy.maxLifetimeSeconds}s`,
      formatLifetime(policy.maxLifetimeSeconds),
    ]);
  if (deadline === null || deadline > timestamp)
    choices.push(['custom', 'Custom date']);
  return choices;
}
export function expiryLabel(value: string) {
  return value === 'never'
    ? 'Never'
    : value === 'custom'
      ? 'Custom date'
      : formatLifetime(expiryDuration(value));
}
