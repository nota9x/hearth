import { Buffer } from 'node:buffer';

import { AppError } from '@hearth/core/common';
import { z } from 'zod';

export function logFailure(
  error: unknown,
  environment: string | undefined,
  event = 'request.failed',
  status?: number,
) {
  console.error(JSON.stringify({ event, status }));
  if (environment !== 'development') return;
  let cause = error;
  while (cause instanceof Error) {
    if (/no such (?:table|column)|has no column named/i.test(cause.message)) {
      console.error(
        'Database schema is missing or outdated. You may need to run pnpm db:migrate from the repository root.',
      );
      return;
    }
    cause = cause.cause;
  }
  console.error(error);
}

export function failure(error: unknown, environment: string | undefined) {
  if (error instanceof z.ZodError)
    return Response.json(
      {
        error: {
          code: 'INVALID_INPUT',
          message: error.issues[0]?.message || 'Check the submitted values.',
        },
      },
      { status: 400 },
    );
  if (error instanceof AppError)
    return Response.json(
      { error: { code: error.code, message: error.message } },
      {
        status: error.status,
        headers: error.status === 429 ? { 'Retry-After': '60' } : {},
      },
    );
  const message = String(error);
  if (message.includes('UNIQUE constraint'))
    return Response.json(
      {
        error: {
          code: 'CONFLICT',
          message: 'That name or link is already in use.',
        },
      },
      { status: 409 },
    );
  if (message.includes('last_admin'))
    return Response.json(
      {
        error: {
          code: 'LAST_ADMIN',
          message: 'Keep at least one active administrator.',
        },
      },
      { status: 409 },
    );
  if (message.includes('delivery_access_denied'))
    return Response.json(
      {
        error: {
          code: 'DELIVERY_UNAVAILABLE',
          message:
            'This delivery domain is no longer available to the image owner.',
        },
      },
      { status: 403 },
    );
  logFailure(error, environment);
  return Response.json(
    {
      error: {
        code: 'UNAVAILABLE',
        message: 'Something went wrong. Please try again.',
      },
    },
    { status: 503 },
  );
}
export async function body(request: Request, limit = 16_384): Promise<unknown> {
  if (Number(request.headers.get('content-length') || 0) > limit)
    throw new AppError(413, 'TOO_LARGE', 'Request is too large.');
  const reader = request.body?.getReader();
  if (!reader) throw new AppError(400, 'INVALID_INPUT', 'Missing request.');
  let size = 0;
  const chunks: Uint8Array[] = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > limit) {
      await reader.cancel();
      throw new AppError(413, 'TOO_LARGE', 'Request is too large.');
    }
    chunks.push(value);
  }
  try {
    return JSON.parse(new TextDecoder().decode(Buffer.concat(chunks)));
  } catch {
    throw new AppError(400, 'INVALID_INPUT', 'Invalid JSON.');
  }
}
