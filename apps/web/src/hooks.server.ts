import { authenticateSession } from '@hearth/core/auth';
import { getInstanceName } from '@hearth/core/branding';
import { configSchema } from '@hearth/core/common';
import type { Env } from '@hearth/core/env';
import {
  acceptsErrorHtml,
  httpErrorContent,
  httpErrorHeaders,
  renderHttpErrorDocument,
} from '@hearth/core/http-error';
import { appOrigin } from '@hearth/core/public-urls';
import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { env as bindings } from 'cloudflare:workers';

import { logFailure } from '#lib/server/http.ts';

const env: Env = bindings;

const resolveRequest: Handle = async ({ event, resolve }) => {
  if (!env.DB)
    return Response.json(
      {
        error: {
          code: 'UNAVAILABLE',
          message: 'The server is unavailable. Please try again shortly.',
        },
      },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  event.locals.env = env;
  configSchema.parse(event.locals.env);
  if (
    event.locals.env.ENVIRONMENT === 'production' &&
    event.url.origin !== appOrigin(event.locals.env)
  )
    return new Response('Use the configured Hearth application origin.', {
      status: 421,
      headers: { 'Cache-Control': 'no-store' },
    });
  event.locals.user = await authenticateSession(
    event.locals.env.DB,
    event.cookies.get(
      event.locals.env.ENVIRONMENT === 'production'
        ? '__Host-hearth'
        : 'hearth-local',
    ),
  );
  if (
    !['GET', 'HEAD', 'OPTIONS'].includes(event.request.method) &&
    !event.url.pathname.startsWith('/api/v1/') &&
    event.request.headers.get('origin') !== event.locals.env.APP_ORIGIN
  )
    return Response.json(
      {
        error: {
          code: 'INVALID_ORIGIN',
          message: `Open ${event.locals.env.APP_ORIGIN} and try again. This address cannot submit dashboard requests.`,
        },
      },
      { status: 403, headers: { 'Cache-Control': 'no-store' } },
    );
  return resolve(event);
};

export const handleError: HandleServerError = ({ error, kind }) => {
  const status = kind === 'unknown' ? 500 : error.status;
  if (status >= 500) logFailure(error, env.ENVIRONMENT, 'page.failed', status);
  return { status, message: httpErrorContent(status).heading };
};

export const handle: Handle = async (input) => {
  const { event } = input;
  let response: Response;
  try {
    response = await resolveRequest(input);
  } catch (error) {
    logFailure(error, env.ENVIRONMENT);
    response = Response.json(
      {
        error: { code: 'UNAVAILABLE', message: httpErrorContent(500).heading },
      },
      { status: 500 },
    );
  }
  const api =
    event.url.pathname === '/api' || event.url.pathname.startsWith('/api/');
  if (
    !api &&
    !event.isDataRequest &&
    response.status >= 400 &&
    acceptsErrorHtml(event.request)
  ) {
    const origin = env.APP_ORIGIN ?? '';
    let name = event.locals.siteName;
    if (!name && env.DB) {
      try {
        name = await getInstanceName(env.DB);
      } catch {
        /*
        Error pages survive storage outages.
        */
      }
    }
    const headers = httpErrorHeaders(origin);
    for (const header of ['Allow', 'Retry-After', 'WWW-Authenticate']) {
      const value = response.headers.get(header);
      if (value) headers.set(header, value);
    }
    for (const cookie of response.headers.getSetCookie())
      headers.append('Set-Cookie', cookie);
    await response.body?.cancel();
    response = new Response(
      event.request.method === 'HEAD'
        ? null
        : renderHttpErrorDocument(response.status, 'page', name, origin),
      { status: response.status, headers },
    );
  }
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'no-referrer');
  response.headers.set('X-Frame-Options', 'DENY');
  response.headers.set('Cache-Control', 'private, no-store');
  response.headers.set(
    'Permissions-Policy',
    'camera=(), microphone=(), geolocation=()',
  );
  if (env.ENVIRONMENT === 'production')
    response.headers.set('Strict-Transport-Security', 'max-age=31536000');
  return response;
};
