import { describe, expect, it } from 'vitest';

import {
  acceptsErrorHtml,
  httpErrorHeaders,
  renderHttpErrorDocument,
} from '../../packages/core/http-error';

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
    ['text/html', 'image', false],
    ['application/json', undefined, false],
    ['text/html;q=0,*/*;q=1', 'document', false],
    ['text/html;q=.5,application/json;q=1', undefined, false],
    ['text/html;q=1,application/json;q=.5', undefined, true],
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
