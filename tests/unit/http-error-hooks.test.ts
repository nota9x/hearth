import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { handle, handleError } from '../../apps/web/src/hooks.server';
import { load } from '../../apps/web/src/lib/server/dashboard';
import { failure } from '../../apps/web/src/lib/server/http';

const cloudflare = vi.hoisted(() => ({ env: {} }));
vi.mock('cloudflare:workers', () => ({
  env: cloudflare.env,
  waitUntil: () => {},
}));

const origin = 'https://app.example.com';
function input(
  path = '/missing',
  response = new Response('private failure', { status: 404 }),
  options: {
    method?: string;
    data?: boolean;
    production?: boolean;
  } = {},
) {
  const first = vi.fn(() => Promise.resolve({ value: 'Custom Hearth' }));
  const DB = { prepare: vi.fn(() => ({ bind: vi.fn(() => ({ first })) })) };
  const resolve = vi.fn(() => Promise.resolve(response));
  const event = {
    url: new URL(path, origin),
    request: new Request(new URL(path, origin), {
      method: options.method ?? 'GET',
      headers: { Accept: 'text/html', Origin: origin },
    }),
    isDataRequest: options.data ?? false,
    cookies: { get: () => {} },
    locals: {},
  };
  Object.assign(cloudflare.env, {
    DB,
    APP_ORIGIN: origin,
    ENVIRONMENT: options.production ? 'production' : 'test',
    TURNSTILE_SITE_KEY: 'real-site-key',
    MAX_UPLOAD_BYTES: '26214400',
  });
  return { event, resolve, first, env: cloudflare.env };
}
afterEach(() => vi.restoreAllMocks());

describe('application error integration', () => {
  it.each([404, 429, 503])(
    'replaces %i document failures with safe branded HTML',
    async (status) => {
      const cancel = vi.fn();
      const response = new Response(new ReadableStream({ cancel }), {
        status,
        headers: {
          Allow: 'GET, HEAD',
          'Retry-After': '60',
          'Content-Length': '123',
          ETag: 'private-etag',
        },
      });
      const test = input('/missing', response);
      const result = await handle(test as unknown as Parameters<Handle>[0]);
      expect(result.status).toBe(status);
      expect(await result.text()).toContain('Custom Hearth');
      expect(result.headers.get('Allow')).toBe('GET, HEAD');
      expect(result.headers.get('Retry-After')).toBe('60');
      expect(result.headers.has('ETag')).toBe(false);
      expect(result.headers.has('Content-Length')).toBe(false);
      expect(result.headers.get('Cache-Control')).toBe('private, no-store');
      expect(result.headers.get('Content-Security-Policy')).toContain(
        "default-src 'none'",
      );
      expect(cancel).toHaveBeenCalledOnce();
    },
  );
  it('renders invalid-binding errors without layout or branding storage', async () => {
    const test = input('/missing');
    for (const key of Object.keys(cloudflare.env))
      Reflect.deleteProperty(cloudflare.env, key);
    const response = await handle(test as unknown as Parameters<Handle>[0]);
    expect(response.status).toBe(503);
    expect(await response.text()).toContain('hearth');
    expect(response.headers.get('X-Frame-Options')).toBe('DENY');
    expect(test.resolve).not.toHaveBeenCalled();
    expect(test.first).not.toHaveBeenCalled();
  });
  it('renders wrong-origin 421 navigation with canonical recovery', async () => {
    const test = input('/missing', undefined, { production: true });
    test.event.url = new URL('https://wrong.example.com/missing');
    const response = await handle(test as unknown as Parameters<Handle>[0]);
    expect(response.status).toBe(421);
    expect(await response.text()).toContain(`href="${origin}/"`);
    expect(response.headers.get('Strict-Transport-Security')).toBe(
      'max-age=31536000',
    );
    expect(test.resolve).not.toHaveBeenCalled();
  });
  it('sanitizes unexpected exceptions and unavailable branding', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const test = input();
    test.resolve.mockRejectedValue(
      new Error('D1 /secret/path internal-id password'),
    );
    test.first.mockRejectedValue(new Error('another private exception'));
    const response = await handle(test as unknown as Parameters<Handle>[0]);
    const html = await response.text();
    expect(response.status).toBe(500);
    expect(html).toContain('Something went wrong on our end');
    expect(html).toContain('hearth');
    expect(html).not.toMatch(/secret|internal-id|password|private exception/);
    expect(
      handleError({
        kind: 'unknown',
        event: test.event,
      } as unknown as Parameters<HandleServerError>[0]),
    ).toEqual({ status: 500, message: 'Something went wrong on our end' });
  });
  it.each([
    'D1_ERROR: no such table: users: SQLITE_ERROR',
    'D1_ERROR: no such column: users.name: SQLITE_ERROR',
    'D1_ERROR: table users has no column named name: SQLITE_ERROR',
  ])(
    'suggests migrations for development schema errors: %s',
    async (message) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      const test = input('/api/example');
      Object.assign(test.env, { ENVIRONMENT: 'development' });
      const error = new Error('Failed query: private SQL and parameters', {
        cause: new Error(message),
      });
      test.resolve.mockRejectedValue(error);
      const response = await handle(test as unknown as Parameters<Handle>[0]);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('pnpm db:migrate');
      expect(log).toHaveBeenLastCalledWith(
        expect.stringContaining('pnpm db:migrate'),
      );
      expect(log).not.toHaveBeenCalledWith(error);

      log.mockClear();
      await handleError({
        error,
        event: test.event,
        kind: 'unknown',
      } as unknown as Parameters<HandleServerError>[0]);
      expect(log).toHaveBeenLastCalledWith(
        expect.stringContaining('pnpm db:migrate'),
      );

      log.mockClear();
      expect(failure(error, 'development').status).toBe(503);
      expect(log).toHaveBeenLastCalledWith(
        expect.stringContaining('pnpm db:migrate'),
      );
    },
  );
  it.each([
    ['production', 'D1_ERROR: no such table: users'],
    ['test', 'D1_ERROR: no such table: users'],
  ])(
    'keeps %s errors free of migration hints and details',
    (environment, message) => {
      const log = vi.spyOn(console, 'error').mockImplementation(() => {});
      failure(new Error(message), environment);
      expect(log).toHaveBeenCalledExactlyOnceWith(
        JSON.stringify({ event: 'request.failed' }),
      );
    },
  );
  it.each([
    new Error('D1_ERROR: database is locked'),
    new Error('Failed query', {
      cause: new Error('D1_ERROR: database is locked'),
    }),
    'Unexpected failure',
  ])('logs development error details when no hint applies', async (error) => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    const response = failure(error, 'development');
    expect(log).toHaveBeenCalledTimes(2);
    expect(log).toHaveBeenNthCalledWith(
      1,
      JSON.stringify({ event: 'request.failed' }),
    );
    expect(log).toHaveBeenLastCalledWith(error);
    expect(await response.json()).toEqual({
      error: {
        code: 'UNAVAILABLE',
        message: 'Something went wrong. Please try again.',
      },
    });
  });
  it.each(['/api/actions/delete', '/api/v1/images', '/api/media/id'])(
    'preserves operational JSON for %s',
    async (path) => {
      const body = {
        error: { code: 'EXAMPLE', message: 'Recoverable failure' },
      };
      const test = input(path, Response.json(body, { status: 403 }));
      const response = await handle(test as unknown as Parameters<Handle>[0]);
      expect(await response.json()).toEqual(body);
      expect(response.headers.get('Content-Type')).toContain(
        'application/json',
      );
      expect(test.first).not.toHaveBeenCalled();
    },
  );
  it('preserves SvelteKit data errors and successful documents', async () => {
    for (const options of [{ data: true }, {}]) {
      const status = options.data ? 404 : 200;
      const original = new Response('original', { status });
      const test = input('/missing', original, options);
      const response = await handle(test as unknown as Parameters<Handle>[0]);
      expect(await response.text()).toBe('original');
      expect(test.first).not.toHaveBeenCalled();
    }
  });
  it('keeps HEAD empty with the same error headers', async () => {
    const get = await handle(input() as unknown as Parameters<Handle>[0]);
    const head = await handle(
      input('/missing', undefined, {
        method: 'HEAD',
      }) as unknown as Parameters<Handle>[0],
    );
    expect(await head.text()).toBe('');
    expect(Object.fromEntries(head.headers)).toEqual(
      Object.fromEntries(get.headers),
    );
  });
  it('preserves separate session cookies when replacing a document', async () => {
    const headers = new Headers();
    headers.append('Set-Cookie', 'first=; Max-Age=0; Path=/');
    headers.append('Set-Cookie', 'second=; Max-Age=0; Path=/');
    const test = input(
      '/missing',
      new Response('failure', { status: 403, headers }),
    );
    const response = await handle(test as unknown as Parameters<Handle>[0]);
    expect(response.headers.getSetCookie()).toEqual(headers.getSetCookie());
  });
  it.each([
    'does-not-exist',
    'login/extra',
    'settings/img_00000000000000000000000000000000',
    'images/img_00000000000000000000000000000000/extra',
  ])('returns 404 for unknown anonymous route %s', async (path) => {
    const event = {
      depends: vi.fn(),
      locals: { user: null },
      params: { path },
      url: new URL(path, origin),
    };
    await expect(
      load(event as unknown as Parameters<typeof load>[0]),
    ).rejects.toMatchObject({ status: 404 });
  });
  it.each(['', 'images', 'links', 'settings', 'admin/users'])(
    'preserves authentication redirects for %s',
    async (path) => {
      const event = {
        depends: vi.fn(),
        locals: { user: null },
        params: { path },
        url: new URL(path, origin),
      };
      await expect(
        load(event as unknown as Parameters<typeof load>[0]),
      ).rejects.toMatchObject({ status: 303, location: '/login' });
    },
  );
});
