import type { Handle, HandleServerError } from '@sveltejs/kit/hooks';
import { describe, expect, it, vi } from 'vitest';

import { handle, handleError } from '../../apps/web/src/hooks.server';
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

describe('application error integration', () => {
  it('replaces document failures with safe branded HTML and protocol headers', async () => {
    const status = 503;
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
  });
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
  it('keeps production logs free of schema details', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    failure(new Error('D1_ERROR: no such table: users'), 'production');
    expect(log).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ event: 'request.failed' }),
    );
  });
  it('preserves operational API JSON', async () => {
    const body = {
      error: { code: 'EXAMPLE', message: 'Recoverable failure' },
    };
    const test = input('/api/v1/images', Response.json(body, { status: 403 }));
    const response = await handle(test as unknown as Parameters<Handle>[0]);
    expect(await response.json()).toEqual(body);
    expect(response.headers.get('Content-Type')).toContain('application/json');
    expect(test.first).not.toHaveBeenCalled();
  });
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
});
