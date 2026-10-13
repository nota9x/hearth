import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type DeliveryEnvironment,
  resolvePublicShare,
} from '../../packages/core/public-share';
import {
  SHARE_COOLDOWN_SECONDS,
  shareClientIdentity,
} from '../../packages/core/share-protection';

const ip = '203.0.113.42';
const row = { objectKey: 'original', mime: 'image/png', filename: 'image.png' };

function request(path = '/hello', options: RequestInit = {}, actor = ip) {
  const headers = new Headers(options.headers);
  if (actor) headers.set('CF-Connecting-IP', actor);
  return new Request(
    path.startsWith('https://') ? path : `https://shots.example.com${path}`,
    { ...options, headers },
  );
}

function fixture(threshold = 60) {
  const entries = new Map<string, Response>();
  const counts = new Map<string, { count: number; started: number }>();
  const match = vi.fn((key: Request) =>
    Promise.resolve(entries.get(key.url)?.clone()),
  );
  const put = vi.fn((key: Request, marker: Response) => {
    entries.set(key.url, marker.clone());
    return Promise.resolve();
  });
  const open = vi.fn(() => Promise.resolve({ match, put }));
  vi.stubGlobal('caches', { open });
  const limit = vi.fn(({ key }: { key: string }) => {
    let counter = counts.get(key);
    if (!counter || Date.now() - counter.started >= 60_000) {
      counter = { count: 0, started: Date.now() };
      counts.set(key, counter);
    }
    return Promise.resolve({ success: ++counter.count <= threshold });
  });
  const first = vi.fn<() => Promise<typeof row | null>>(() =>
    Promise.resolve(row),
  );
  const bind = vi.fn((hostname: string) => ({
    first:
      hostname === 'shots.example.com' ? first : () => Promise.resolve(null),
  }));
  const prepare = vi.fn(() => ({ bind }));
  const get = vi.fn<R2Bucket['get']>(() =>
    Promise.resolve({
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode('bytes'));
          controller.close();
        },
      }),
      size: 5,
      httpEtag: '"original"',
    } as R2ObjectBody),
  );
  const environment: DeliveryEnvironment = {
    // Fixtures implement only the binding methods exercised by public delivery.
    DB: { prepare } as unknown as D1Database,
    BUCKET: { get } as unknown as R2Bucket,
    APP_ORIGIN: 'https://app.example.com',
    ENVIRONMENT: 'test',
    SHARE_FAILURE_LIMIT: { limit },
  };
  return { environment, first, prepare, get, limit, entries, open, match, put };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-04T12:00:00Z'));
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('share failure accounting and cooldown', () => {
  it('never spends failure quota on successful previews, HEADs or downloads', async () => {
    const { environment, limit } = fixture();
    for (let index = 0; index < 80; index++) {
      const response = await resolvePublicShare(
        request(index % 2 ? '/hello?download' : '/hello?preview', {
          method: index % 3 ? 'GET' : 'HEAD',
          headers: { 'User-Agent': 'Discordbot' },
        }),
        environment,
      );
      expect(response.status).toBe(200);
      expect(response.headers.get('Cache-Control')).toBe(
        'public, max-age=0, must-revalidate',
      );
      expect(await response.text()).toBe(index % 3 === 0 ? '' : 'bytes');
    }
    expect(limit).not.toHaveBeenCalled();
  });

  it('counts only failures in mixed traffic', async () => {
    const { environment, first, limit, put } = fixture(10);
    for (const [count, valid] of [
      [5, false],
      [20, true],
      [5, false],
    ] as const) {
      first.mockResolvedValue(valid ? row : null);
      for (let index = 0; index < count; index++)
        await expect(
          resolvePublicShare(request(), environment),
        ).resolves.toHaveProperty('status', valid ? 200 : 404);
    }
    expect(limit).toHaveBeenCalledTimes(10);
    expect(put).not.toHaveBeenCalled();
    await expect(
      resolvePublicShare(request(), environment),
    ).resolves.toHaveProperty('status', 429);
  });

  it('blocks all guesses before storage access and does not extend cooldown', async () => {
    const { environment, first, prepare, get, limit, put } = fixture(2);
    first.mockResolvedValue(null);
    await expect(
      resolvePublicShare(request('/missing'), environment),
    ).resolves.toHaveProperty('status', 404);
    await expect(
      resolvePublicShare(request('/missing'), environment),
    ).resolves.toHaveProperty('status', 404);
    const activation = await resolvePublicShare(
      request('/missing'),
      environment,
    );
    expect(activation.status).toBe(429);
    expect(activation.headers.get('Retry-After')).toBe('60');
    expect(activation.headers.get('Cache-Control')).toBe('private, no-store');
    expect(await activation.text()).toBe('Too many requests');
    first.mockResolvedValue(row);
    prepare.mockClear();
    get.mockClear();
    for (const path of [
      '/hello',
      '/missing',
      '/hello?download',
      '/s/hello',
      'https://other.example.com/hello',
      'https://outside.test/hello',
    ]) {
      vi.setSystemTime(Date.now() + 1000);
      const response = await resolvePublicShare(
        request(path, {
          headers: {
            'If-None-Match': '"original"',
            'Cache-Control': 'no-cache',
            'X-Forwarded-For': '198.51.100.1',
          },
        }),
        environment,
      );
      expect(response.status).toBe(429);
    }
    const head = await resolvePublicShare(
      request('/hello', { method: 'HEAD' }),
      environment,
    );
    expect(head.status).toBe(429);
    expect(await head.text()).toBe('');
    expect(prepare).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(limit).toHaveBeenCalledTimes(3);
    expect(put).toHaveBeenCalledTimes(1);
    expect(console.warn).toHaveBeenCalledExactlyOnceWith(
      JSON.stringify({ event: 'delivery.share_cooldown' }),
    );
    vi.setSystemTime(Date.now() + SHARE_COOLDOWN_SECONDS * 1000);
    await expect(
      resolvePublicShare(request(), environment),
    ).resolves.toHaveProperty('status', 200);
    first.mockResolvedValue(null);
    await expect(
      resolvePublicShare(request(), environment),
    ).resolves.toHaveProperty('status', 404);
  });

  it('isolates IPs and shares counters across deliveryDomains, methods and query variants', async () => {
    const { environment, first, limit } = fixture(2);
    first.mockResolvedValue(null);
    await resolvePublicShare(request('/bad', { method: 'HEAD' }), environment);
    await resolvePublicShare(
      request('https://other.example.com/bad?preview'),
      environment,
    );
    await expect(
      resolvePublicShare(request('/bad?download'), environment),
    ).resolves.toHaveProperty('status', 429);
    expect(new Set(limit.mock.calls.map(([input]) => input.key)).size).toBe(1);
    expect(limit.mock.calls[0][0].key).not.toContain(ip);
    await expect(
      resolvePublicShare(request('/bad', {}, '198.51.100.1'), environment),
    ).resolves.toHaveProperty('status', 404);
    first.mockResolvedValue(row);
    await expect(
      resolvePublicShare(request('/hello', {}, '198.51.100.1'), environment),
    ).resolves.toHaveProperty('status', 200);
  });

  it('counts unknown deliveryDomains, malformed paths and missing objects once', async () => {
    const { environment, get, limit, prepare } = fixture();
    for (const path of [
      'https://outside.test/hello',
      '/s/hello',
      '/a',
      '/hello/preview',
    ])
      await expect(
        resolvePublicShare(request(path), environment),
      ).resolves.toHaveProperty('status', 404);
    expect(prepare).toHaveBeenCalledTimes(1);
    get.mockResolvedValue(null);
    await expect(
      resolvePublicShare(request(), environment),
    ).resolves.toHaveProperty('status', 404);
    expect(limit).toHaveBeenCalledTimes(5);
    expect(console.warn).not.toHaveBeenCalled();
  });

  it('restores cooldown after cache eviction and tolerates concurrent failures', async () => {
    const { environment, first, entries, put } = fixture(2);
    first.mockResolvedValue(null);
    await Promise.all(
      Array.from({ length: 4 }, () =>
        resolvePublicShare(request(), environment),
      ),
    );
    await expect(
      resolvePublicShare(request(), environment),
    ).resolves.toHaveProperty('status', 429);
    entries.clear();
    const writes = put.mock.calls.length;
    await expect(
      resolvePublicShare(request(), environment),
    ).resolves.toHaveProperty('status', 429);
    expect(put).toHaveBeenCalledTimes(writes + 1);
    first.mockResolvedValue(row);
    await expect(
      resolvePublicShare(request(), environment),
    ).resolves.toHaveProperty('status', 429);
  });

  it('does not cache misses or prevent a newly created share for another client', async () => {
    const { environment, first, put } = fixture(1);
    first.mockResolvedValue(null);
    await expect(
      resolvePublicShare(request(), environment),
    ).resolves.toHaveProperty('status', 404);
    expect(put).not.toHaveBeenCalled();
    first.mockResolvedValue(row);
    await expect(
      resolvePublicShare(request(), environment),
    ).resolves.toHaveProperty('status', 200);
    first.mockResolvedValue(null);
    await resolvePublicShare(request(), environment);
    first.mockResolvedValue(row);
    await expect(
      resolvePublicShare(request('/hello', {}, '198.51.100.2'), environment),
    ).resolves.toHaveProperty('status', 200);
  });

  it('uses a shared bucket for missing and invalid identities', async () => {
    const { environment, first } = fixture(1);
    first.mockResolvedValue(null);
    await expect(
      resolvePublicShare(request('/hello', {}, ''), environment),
    ).resolves.toHaveProperty('status', 404);
    await expect(
      resolvePublicShare(request('/hello', {}, 'not-an-ip'), environment),
    ).resolves.toHaveProperty('status', 429);
    first.mockResolvedValue(row);
    await expect(
      resolvePublicShare(request('/hello', {}, 'fe80::1%eth0'), environment),
    ).resolves.toHaveProperty('status', 429);
  });

  it('only disables enforcement for explicit development configuration', async () => {
    const { environment, first, limit, open } = fixture(1);
    environment.ENVIRONMENT = 'development';
    first.mockResolvedValue(null);
    for (let index = 0; index < 5; index++)
      await expect(
        resolvePublicShare(request(), environment),
      ).resolves.toHaveProperty('status', 404);
    expect(open).not.toHaveBeenCalled();
    expect(limit).not.toHaveBeenCalled();
  });
});

describe('identity normalization', () => {
  it.each([
    ['203.0.113.42', 'ipv4:203.0.113.42'],
    ['2001:db8:1:2::abcd', 'ipv6:2001:db8:1:2/64'],
    ['2001:0DB8:0001:0002:1234:5678:abcd:ffff', 'ipv6:2001:db8:1:2/64'],
    ['::1', 'ipv6:0:0:0:0/64'],
    ['::ffff:203.0.113.42', 'ipv4:203.0.113.42'],
    ['::ffff:cb00:712a', 'ipv4:203.0.113.42'],
    ['', 'unknown'],
    ['203.0.113.42, 198.51.100.1', 'unknown'],
    ['fe80::1%eth0', 'unknown'],
  ])('normalizes %s', (actor, identity) => {
    expect(shareClientIdentity(request('/hello', {}, actor))).toBe(identity);
  });

  it('ignores all spoofable forwarding and secondary IP headers', () => {
    expect(
      shareClientIdentity(
        request('/hello', {
          headers: {
            'X-Forwarded-For': '198.51.100.1',
            'X-Real-IP': '198.51.100.2',
            'CF-Connecting-IPv6': '2001:db8:9:9::1',
            'True-Client-IP': '198.51.100.3',
          },
        }),
      ),
    ).toBe(`ipv4:${ip}`);
  });

  it('groups IPv6 privacy addresses without grouping neighboring /64s', async () => {
    const { environment, first } = fixture(1);
    first.mockResolvedValue(null);
    await resolvePublicShare(
      request('/hello', {}, '2001:db8:1:2::1'),
      environment,
    );
    await expect(
      resolvePublicShare(
        request('/hello', {}, '2001:db8:1:2::99'),
        environment,
      ),
    ).resolves.toHaveProperty('status', 429);
    await expect(
      resolvePublicShare(request('/hello', {}, '2001:db8:1:3::1'), environment),
    ).resolves.toHaveProperty('status', 404);
  });
});

describe('protection outages', () => {
  it('does not query D1 or R2 for blocked HTML navigation, including valid links', async () => {
    const test = fixture(0);
    test.first.mockResolvedValue(null);
    await resolvePublicShare(request('/missing'), test.environment);
    test.prepare.mockClear();
    test.get.mockClear();
    for (const path of ['/hello', '/missing', '/hello?download']) {
      const response = await resolvePublicShare(
        request(path, {
          headers: { Accept: 'text/html', 'Sec-Fetch-Dest': 'document' },
        }),
        test.environment,
      );
      expect(response.status).toBe(429);
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(await response.text()).toContain(
        'class="brand-mark__name">hearth</span>',
      );
    }
    expect(test.prepare).not.toHaveBeenCalled();
    expect(test.get).not.toHaveBeenCalled();
    expect(test.limit).toHaveBeenCalledOnce();
  });
  it.each(['open', 'match', 'put', 'limit'] as const)(
    'fails open on %s failure while checking eligibility',
    async (operation) => {
      const test = fixture(0);
      test[operation].mockRejectedValue(new Error('state unavailable'));
      test.first.mockResolvedValue(null);
      await expect(
        resolvePublicShare(request(), test.environment),
      ).resolves.toHaveProperty('status', 404);
      expect(test.prepare).toHaveBeenCalledOnce();
      test.first.mockResolvedValue(row);
      await expect(
        resolvePublicShare(request(), test.environment),
      ).resolves.toHaveProperty('status', 200);
    },
  );

  it.each(['first', 'get'] as const)(
    'keeps storage %s failures as 503 without charging failure quota',
    async (operation) => {
      const test = fixture();
      test[operation].mockRejectedValue(new Error('backend unavailable'));
      await expect(
        resolvePublicShare(request(), test.environment),
      ).resolves.toHaveProperty('status', 503);
      expect(test.limit).not.toHaveBeenCalled();
    },
  );
});
