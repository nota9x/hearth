import { z } from 'zod';

import {
  hostnameMessage,
  isPublicHostname,
  parseHostname,
} from './domain-format';

export const hostnameSchema = z.string().transform((value, context) => {
  try {
    return parseHostname(value);
  } catch {
    context.addIssue({ code: 'custom', message: hostnameMessage });
    return z.NEVER;
  }
});

export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const id = (prefix: string) =>
  `${prefix}_${crypto.randomUUID().replaceAll('-', '')}`;
export const now = () => Math.floor(Date.now() / 1000);
export const reserved = new Set(
  'www app api admin auth cdn static assets status support help mail smtp ftp root system security abuse login logout delete settings images links domains robots favicon'.split(
    ' ',
  ),
);
export const slugSchema = z
  .string()
  .trim()
  .toLowerCase()
  .min(3)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/)
  .refine((s) => !reserved.has(s), 'This path is reserved.');
export const idSchema = z.string().regex(/^[a-z]+_[a-f0-9]{32}$/);
export const expirySchema = z.union([
  z.enum(['never', '1h', '6h', '24h', '7d', '30d', '90d', '1y', 'custom']),
  z
    .string()
    .regex(/^[1-9]\d*s$/, 'Choose a valid image expiry.')
    .refine(
      (value) =>
        Number.isSafeInteger(Number(value.slice(0, -1))) &&
        Number(value.slice(0, -1)) <= 8_640_000_000_000,
      'Choose a valid duration.',
    ),
]);
export const durations: Record<string, number> = {
  '1h': 3600,
  '6h': 21_600,
  '24h': 86_400,
  '7d': 604_800,
  '30d': 2_592_000,
  '90d': 7_776_000,
  '1y': 31_536_000,
};
export function expiry(
  expiry: string,
  custom?: string,
  timestamp = now(),
): number | null {
  expirySchema.parse(expiry);
  if (expiry === 'never') return null;
  if (expiry === 'custom') {
    const n = Math.floor(
      Date.parse(
        z
          .string()
          .datetime({
            offset: true,
            error: 'Enter a valid expiry date with a timezone.',
          })
          .parse(custom),
      ) / 1000,
    );
    if (n <= timestamp)
      throw new AppError(
        400,
        'INVALID_EXPIRATION',
        'Choose a future expiration.',
      );
    return n;
  }
  const result = timestamp + expiryDuration(expiry);
  if (!Number.isFinite(new Date(result * 1000).getTime()))
    throw new AppError(400, 'INVALID_EXPIRATION', 'Choose a valid duration.');
  return result;
}
export function expiryDuration(value: string) {
  return value.endsWith('s') ? Number(value.slice(0, -1)) : durations[value];
}
export const configSchema = z
  .object({
    ENVIRONMENT: z.enum(['development', 'test', 'production']),
    APP_ORIGIN: z.url(),
    LOCAL_DELIVERY_PORT: z.coerce.number().int().min(1).max(65_535).optional(),
    TURNSTILE_SITE_KEY: z.string().min(1),
    MAX_UPLOAD_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(100 * 1024 * 1024),
  })
  .superRefine((value, context) => {
    const origin = new URL(value.APP_ORIGIN);
    if (
      origin.origin !== value.APP_ORIGIN ||
      !['http:', 'https:'].includes(origin.protocol)
    )
      context.addIssue({
        code: 'custom',
        path: ['APP_ORIGIN'],
        message: 'Use a canonical origin without path or trailing slash.',
      });
    if (
      value.ENVIRONMENT === 'production' &&
      (origin.protocol !== 'https:' ||
        !hostnameSchema.safeParse(origin.hostname).success ||
        !isPublicHostname(origin.hostname) ||
        /^[123]x000/.test(value.TURNSTILE_SITE_KEY))
    )
      context.addIssue({
        code: 'custom',
        message:
          'Production requires HTTPS, a public domain and a real Turnstile site key.',
      });
  });
export const bytes = (n: number) =>
  n < 1024
    ? `${n} B`
    : n < 1_048_576
      ? `${(n / 1024).toFixed(1)} KB`
      : n < 1_073_741_824
        ? `${(n / 1_048_576).toFixed(1)} MB`
        : `${(n / 1_073_741_824).toFixed(2)} GB`;
export const date = (n: number | null) =>
  n
    ? new Intl.DateTimeFormat('en', { dateStyle: 'medium' }).format(n * 1000)
    : 'Never';

const timestampFormat = new Intl.DateTimeFormat('en', {
  dateStyle: 'medium',
  timeStyle: 'short',
});
const relativeFormat = new Intl.RelativeTimeFormat('en', { numeric: 'always' });
export const dateTime = (value: number | null) =>
  value === null ? 'Never' : timestampFormat.format(value * 1000);
export function relativeExpiry(value: number | null, timestamp: number) {
  if (value === null) return '';
  const remaining = value - timestamp;
  if (remaining <= 0) return 'Expired';
  if (remaining < 60) return 'Expires soon';
  const [duration, unit] =
    remaining < 3600
      ? ([60, 'minute'] as const)
      : remaining < 86_400
        ? ([3600, 'hour'] as const)
        : ([86_400, 'day'] as const);
  return `Expires ${relativeFormat.format(Math.ceil(remaining / duration), unit)}`;
}
