import { isIP } from 'node:net';

import { digest } from './digest';
import { appUrl } from './public-urls';

export const SHARE_COOLDOWN_SECONDS = 60;
export const SHARE_PROTECTION_CACHE = 'hearth:share-protection:v1';

export function shareClientIdentity(request: Request): string {
  const ip = request.headers.get('cf-connecting-ip')?.trim() || '';
  const version = isIP(ip);
  if (version === 4) return `ipv4:${ip}`;
  if (version !== 6 || ip.includes('%')) return 'unknown';

  // URL canonicalization also turns IPv4-mapped suffixes into hex groups.
  const canonical = new URL(`http://[${ip}]/`).hostname.slice(1, -1);
  const [left, right] = canonical.split('::', 2);
  const start = left ? left.split(':') : [];
  const end = right ? right.split(':') : [];
  const groups =
    right === undefined
      ? start
      : [
          ...start,
          ...Array.from({ length: 8 - start.length - end.length }, () => '0'),
          ...end,
        ];
  const words = groups.map((group) => Number.parseInt(group, 16));
  if (words.slice(0, 5).every((word) => word === 0) && words[5] === 0xff_ff)
    return `ipv4:${words[6] >>> 8}.${words[6] & 255}.${words[7] >>> 8}.${words[7] & 255}`;
  return `ipv6:${words
    .slice(0, 4)
    .map((word) => word.toString(16))
    .join(':')}/64`;
}

function protectionFailure() {
  // Sample outages rather than producing one log for every request.
  if (Math.random() < 0.01)
    console.warn(JSON.stringify({ event: 'delivery.protection_unavailable' }));
}

interface Protection {
  key: string;
  cache: Cache;
  cacheKey: Request;
  blocked: boolean;
}

export async function checkShareCooldown(
  request: Request,
  environment: { ENVIRONMENT: string; APP_ORIGIN: string },
): Promise<Protection | null> {
  if (environment.ENVIRONMENT === 'development') return null;
  try {
    const key = await digest(shareClientIdentity(request), 'share-failure-ip');
    const cache = await caches.open(SHARE_PROTECTION_CACHE);
    const cacheKey = new Request(
      appUrl(environment, `/.hearth/share-cooldown/${key}`),
    );
    const marker = await cache.match(cacheKey);
    return {
      key,
      cache,
      cacheKey,
      blocked:
        Number(marker?.headers.get('X-Hearth-Cooldown-Until')) > Date.now(),
    };
  } catch {
    protectionFailure();
    return null;
  }
}

export async function recordFailedShareLookup(
  protection: Protection | null,
  binding: RateLimit,
): Promise<boolean> {
  if (!protection) return false;
  try {
    const result = await binding.limit({ key: protection.key });
    if (result.success) return false;
    await protection.cache.put(
      protection.cacheKey,
      new Response(null, {
        headers: {
          'Cache-Control': `public, max-age=${SHARE_COOLDOWN_SECONDS}`,
          'X-Hearth-Cooldown-Until': String(
            Date.now() + SHARE_COOLDOWN_SECONDS * 1000,
          ),
        },
      }),
    );
    console.warn(JSON.stringify({ event: 'delivery.share_cooldown' }));
    return true;
  } catch {
    protectionFailure();
    return false;
  }
}
