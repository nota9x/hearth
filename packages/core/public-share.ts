import { deliveryErrorBranding } from './branding';
import { DELIVERY_PROBE_PATH, serveDeliveryProbe } from './delivery-probe';
import {
  acceptsErrorHtml,
  httpErrorHeaders,
  renderHttpErrorDocument,
} from './http-error';
import { serveObject } from './serve';
import {
  checkShareCooldown,
  recordFailedShareLookup,
  SHARE_COOLDOWN_SECONDS,
} from './share-protection';

export type DeliveryEnvironment = Omit<
  DeliveryBindings,
  'ENVIRONMENT' | 'APP_ORIGIN'
> & { ENVIRONMENT: string; APP_ORIGIN: string };

async function unavailable(
  request: Request,
  environment: DeliveryEnvironment,
  status = 404,
) {
  const html = acceptsErrorHtml(request);
  const headers = html
    ? httpErrorHeaders(environment.APP_ORIGIN)
    : new Headers({
        'Content-Type': 'text/plain;charset=UTF-8',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        Vary: 'Accept, Sec-Fetch-Dest',
      });
  if (status === 429)
    headers.set('Retry-After', String(SHARE_COOLDOWN_SECONDS));
  else if (status === 405) headers.set('Allow', 'GET, HEAD');
  if (request.method === 'HEAD') return new Response(null, { status, headers });
  const name = html
    ? await deliveryErrorBranding(environment, status === 429)
    : '';
  const text = html
    ? renderHttpErrorDocument(status, 'image', name, environment.APP_ORIGIN)
    : status === 429
      ? 'Too many requests'
      : status === 503
        ? 'Temporarily unavailable'
        : status === 405
          ? 'Method not allowed'
          : 'Not found';
  return new Response(text, {
    status,
    headers,
  });
}

export async function resolvePublicShare(
  request: Request,
  environment: DeliveryEnvironment,
): Promise<Response> {
  if (!['GET', 'HEAD'].includes(request.method))
    return unavailable(request, environment, 405);
  const url = new URL(request.url);
  if (url.pathname === DELIVERY_PROBE_PATH)
    return serveDeliveryProbe(request, environment);
  const protection = await checkShareCooldown(request, environment);
  if (protection?.blocked) return unavailable(request, environment, 429);
  const failed = async () =>
    unavailable(
      request,
      environment,
      (await recordFailedShareLookup(
        protection,
        environment.SHARE_FAILURE_LIMIT,
      ))
        ? 429
        : 404,
    );
  const slug = url.pathname.slice(1);
  if (!/^[A-Za-z0-9_-]{3,64}$/.test(slug)) return failed();
  try {
    const timestamp = Math.floor(Date.now() / 1000);
    // Authoritative checks precede even conditional responses. Host restriction
    // controls share creation, deliberately not delivery of existing links.
    const row = await environment.DB.prepare(
      `SELECT i.objectKey,i.mime,i.filename FROM aliases a
      JOIN delivery_domains h ON h.id=a.deliveryDomainId JOIN images i ON i.id=a.imageId JOIN users u ON u.id=i.userId
      WHERE h.hostname=? AND h.enabled=1 AND a.slug=? AND a.disabledAt IS NULL
      AND (a.expiresAt IS NULL OR a.expiresAt>?) AND i.deletedAt IS NULL
      AND (i.expiresAt IS NULL OR i.expiresAt>?) AND u.status='active' LIMIT 1`,
    )
      .bind(url.hostname, slug, timestamp, timestamp)
      .first<{ objectKey: string; mime: string; filename: string }>();
    if (!row) return failed();
    const response = await serveObject(
      environment.BUCKET,
      row.objectKey,
      request,
      row.mime,
      row.filename,
    );
    if (response.status !== 404) return response;
    await response.body?.cancel();
    return failed();
  } catch {
    console.error(JSON.stringify({ event: 'delivery.unavailable' }));
    return unavailable(request, environment, 503);
  }
}
