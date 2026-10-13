import { instanceName } from './branding-view';

export const ERROR_BRANDING_CACHE = 'hearth:error-branding:v1';
export const ERROR_BRANDING_SECONDS = 60;
export async function getInstanceName(binding: D1Database) {
  const row = await binding
    .prepare('SELECT value FROM app_settings WHERE key=?')
    .bind('siteName')
    .first<{ value: string }>();
  return instanceName(row?.value);
}
export async function deliveryErrorBranding(
  environment: { DB: D1Database; APP_ORIGIN: string },
  cachedOnly = false,
) {
  let cache: Cache | undefined;
  const key = new Request(
    new URL('/.hearth/error-branding', environment.APP_ORIGIN),
  );
  try {
    cache = await caches.open(ERROR_BRANDING_CACHE);
    const cached = await cache.match(key);
    if (cached) return instanceName(await cached.text());
  } catch {
    // Branding must never prevent an error response or bypass a cooldown.
  }
  if (cachedOnly) return instanceName();
  try {
    const name = await getInstanceName(environment.DB);
    if (cache) {
      try {
        await cache.put(
          key,
          new Response(name, {
            headers: {
              'Cache-Control': `public, max-age=${ERROR_BRANDING_SECONDS}`,
            },
          }),
        );
      } catch {
        /*
        Optional cache.
        */
      }
    }
    return name;
  } catch {
    return instanceName();
  }
}
