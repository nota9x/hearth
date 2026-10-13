import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  deliveryErrorBranding,
  ERROR_BRANDING_SECONDS,
} from '../../packages/core/branding';
import {
  acceptsErrorHtml,
  httpErrorHeaders,
  renderHttpErrorDocument,
} from '../../packages/core/http-error';

afterEach(() => vi.unstubAllGlobals());

describe('safe HTTP error presentation', () => {
  it('escapes branding and uses only a safe configured origin', () => {
    const html = renderHttpErrorDocument(
      404,
      'image',
      '<script>"&</script>',
      'https://app.example.com',
    );
    expect(html).toContain('&lt;script&gt;&quot;&amp;&lt;/script&gt;');
    expect(html).not.toContain('<script>');
    expect(
      renderHttpErrorDocument(401, 'page', '', 'javascript:alert(1)'),
    ).toContain('href="/login"');
    expect(renderHttpErrorDocument(404, 'page', '  ')).toContain('hearth');
    expect(
      httpErrorHeaders('https://app.example.com').get(
        'Content-Security-Policy',
      ),
    ).toContain("font-src 'self' https://app.example.com");
  });
});

describe('document negotiation', () => {
  it.each([
    ['text/html', undefined, true],
    ['text/html', 'document', true],
    ['text/html', 'image', false],
    ['text/html', 'empty', false],
    ['*/*', undefined, false],
    ['', undefined, false],
    ['application/json', undefined, false],
    ['text/html;q=0,*/*;q=1', 'document', false],
    ['text/html;q=.5,application/json;q=1', undefined, false],
    ['text/html;q=.5,text/plain;q=1', undefined, false],
    ['text/html;q=1,application/json;q=.5', undefined, true],
    ['text/html;q=bogus', undefined, false],
  ] as const)(
    'negotiates %s with destination %s',
    (accept, destination, expected) => {
      const headers = new Headers({ Accept: accept });
      if (destination !== undefined) headers.set('Sec-Fetch-Dest', destination);
      expect(
        acceptsErrorHtml(
          new Request('https://shots.example.com/missing', { headers }),
        ),
      ).toBe(expected);
    },
  );
});

function fixture(value: string | null = 'My Hearth') {
  const first = vi.fn(() => Promise.resolve(value === null ? null : { value }));
  const prepare = vi.fn(() => ({ bind: vi.fn(() => ({ first })) }));
  const DB = { prepare } as unknown as D1Database;
  return { DB, prepare, first, APP_ORIGIN: 'https://app.example.com' };
}
describe('existing instance branding', () => {
  it('caches only branding and uses it without DB work during cooldown', async () => {
    const test = fixture();
    let entry: Response | undefined;
    const put = vi.fn((_key: Request, response: Response) => {
      entry = response;
      return Promise.resolve();
    });
    vi.stubGlobal('caches', {
      open: vi.fn(() =>
        Promise.resolve({ match: () => Promise.resolve(entry?.clone()), put }),
      ),
    });
    expect(await deliveryErrorBranding(test, true)).toBe('hearth');
    expect(test.prepare).not.toHaveBeenCalled();
    expect(await deliveryErrorBranding(test)).toBe('My Hearth');
    expect(await deliveryErrorBranding(test, true)).toBe('My Hearth');
    expect(await deliveryErrorBranding(test)).toBe('My Hearth');
    expect(test.prepare).toHaveBeenCalledOnce();
    expect(put).toHaveBeenCalledOnce();
    expect(put.mock.calls[0][0].url).toBe(
      'https://app.example.com/.hearth/error-branding',
    );
    expect(put.mock.calls[0][1].headers.get('Cache-Control')).toBe(
      `public, max-age=${ERROR_BRANDING_SECONDS}`,
    );
    entry = undefined;
    expect(await deliveryErrorBranding(test)).toBe('My Hearth');
    expect(test.prepare).toHaveBeenCalledTimes(2);
  });
  it('survives cache and database outages', async () => {
    const test = fixture();
    vi.stubGlobal('caches', {
      open: vi.fn(() => Promise.reject(new Error('unavailable'))),
    });
    expect(await deliveryErrorBranding(test)).toBe('My Hearth');
    test.first.mockRejectedValue(new Error('internal DB path'));
    expect(await deliveryErrorBranding(test)).toBe('hearth');
    expect(await deliveryErrorBranding(test, true)).toBe('hearth');
  });
});
