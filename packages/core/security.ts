import { z } from 'zod';

import { AppError } from './common';

export async function rateLimit(binding: RateLimit, key: string) {
  const result = await binding.limit({ key });
  if (!result.success)
    throw new AppError(
      429,
      'RATE_LIMITED',
      'Too many attempts. Try again in one minute.',
    );
}
export async function turnstile(
  token: unknown,
  environment: {
    ENVIRONMENT: string;
    APP_ORIGIN: string;
    TURNSTILE_SECRET_KEY?: string;
  },
  action: string,
) {
  const value = z.string().min(1).max(2048).parse(token);
  const secret =
    environment.TURNSTILE_SECRET_KEY ||
    (environment.ENVIRONMENT === 'development'
      ? '1x0000000000000000000000000000000AA'
      : undefined);
  if (
    !secret ||
    (environment.ENVIRONMENT === 'production' && /^[123]x000/.test(secret))
  )
    throw new AppError(503, 'CONFIGURATION', 'Authentication is unavailable.');
  let response: Response;
  try {
    response = await fetch(
      'https://challenges.cloudflare.com/turnstile/v0/siteverify',
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ secret, response: value }),
        signal: AbortSignal.timeout(10_000),
      },
    );
  } catch {
    throw new AppError(
      503,
      'TURNSTILE_UNAVAILABLE',
      'Verification is unavailable. Please try again.',
    );
  }
  const result = z
    .object({
      success: z.boolean(),
      hostname: z.string().optional(),
      action: z.string().optional(),
    })
    .parse(await response.json());
  if (
    !result.success ||
    (environment.ENVIRONMENT === 'production' &&
      (result.hostname !== new URL(environment.APP_ORIGIN).hostname ||
        result.action !== action))
  )
    throw new AppError(
      400,
      'INVALID_TURNSTILE',
      'Verification expired or failed. Please try again.',
    );
}
