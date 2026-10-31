import { createHmac, timingSafeEqual } from 'node:crypto';

import { digest } from './digest.ts';

export const DELIVERY_PROBE_PATH = '/.well-known/hearth-delivery';
export const DELIVERY_PROBE_KEY = 'system/delivery-health';
export const deliveryProbeKey = (nonce: string) =>
  `${DELIVERY_PROBE_KEY}/${nonce}`;
export const DELIVERY_PROBE_CONTENT = 'Hearth image delivery health check v1\n';

export function probeSignature(key: string, ...values: string[]) {
  return createHmac('sha256', key).update(JSON.stringify(values)).digest('hex');
}
export function matchesSignature(actual: string, expected: string) {
  return (
    /^[a-f0-9]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(actual, 'hex'), Buffer.from(expected, 'hex'))
  );
}

export async function serveDeliveryProbe(
  request: Request,
  environment: { DB: D1Database; BUCKET: R2Bucket; ENVIRONMENT?: string },
) {
  const url = new URL(request.url),
    nonce = url.searchParams.get('nonce') || '',
    deadline = url.searchParams.get('until') || '',
    signature = url.searchParams.get('signature') || '';
  const unavailable = () =>
    new Response('Not found', {
      status: 404,
      headers: { 'Cache-Control': 'no-store' },
    });
  const timestamp = Math.floor(Date.now() / 1000);
  if (
    request.method !== 'GET' ||
    !/^[a-f0-9]{32}$/.test(nonce) ||
    !/^\d{10}$/.test(deadline) ||
    Number(deadline) < timestamp ||
    Number(deadline) > timestamp + 60
  )
    return unavailable();
  const localHostname = request.headers.get('X-Hearth-Local-Hostname');
  const hostname =
    environment.ENVIRONMENT === 'development' &&
    ['127.0.0.1', 'localhost'].includes(url.hostname) &&
    localHostname?.endsWith('.localhost')
      ? localHostname
      : url.hostname;
  const domain = await environment.DB.prepare(
    'SELECT id,validationKey FROM delivery_domains WHERE hostname=?',
  )
    .bind(hostname)
    .first<{ id: string; validationKey: string }>();
  if (
    !domain ||
    !matchesSignature(
      signature,
      probeSignature(
        domain.validationKey,
        'request',
        domain.id,
        hostname,
        nonce,
        deadline,
      ),
    )
  )
    return unavailable();
  let object: R2ObjectBody | null;
  try {
    object = await environment.BUCKET.get(deliveryProbeKey(nonce));
  } catch {
    console.error(JSON.stringify({ event: 'delivery.health_storage_failed' }));
    return new Response('Storage check failed', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  if (!object || object.size > 1024) {
    await object?.body.cancel();
    return new Response('Storage check failed', {
      status: 503,
      headers: { 'Cache-Control': 'no-store' },
    });
  }
  const hash = await digest(await object.text(), 'delivery-probe');
  return Response.json(
    {
      domainId: domain.id,
      nonce,
      hash,
      proof: probeSignature(
        domain.validationKey,
        'response',
        domain.id,
        hostname,
        nonce,
        deadline,
        hash,
      ),
    },
    {
      headers: {
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
      },
    },
  );
}
