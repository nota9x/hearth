import { isIP } from 'node:net';

import { z } from 'zod';

import { requireAdmin } from './auth';
import { AppError, now } from './common';
import { randomSecret } from './crypto';
import type { User } from './db';
import { configuredHostname, domainDetails } from './delivery-domains';
import {
  DELIVERY_PROBE_CONTENT,
  DELIVERY_PROBE_PATH,
  deliveryProbeKey,
  matchesSignature,
  probeSignature,
} from './delivery-probe';
import { digest } from './digest';
import { deliveryOrigin, type PublicUrlEnvironment } from './public-urls';
import { deleteStoredObjects, writeStoredObject } from './storage';

export interface DomainDiagnostics {
  outcome: 'passed' | 'failed' | 'inconclusive';
  stage: 'dns' | 'delivery' | 'storage' | 'complete';
  message: string;
  checkedAt: number;
}
type ValidationEnvironment = PublicUrlEnvironment & {
  DB: D1Database;
  BUCKET: R2Bucket;
};

// Custom Domains resolve to Cloudflare's public edge. Refuse every other network.
const edgeV4 = [
  ['173.245.48.0', 20],
  ['103.21.244.0', 22],
  ['103.22.200.0', 22],
  ['103.31.4.0', 22],
  ['141.101.64.0', 18],
  ['108.162.192.0', 18],
  ['190.93.240.0', 20],
  ['188.114.96.0', 20],
  ['197.234.240.0', 22],
  ['198.41.128.0', 17],
  ['162.158.0.0', 15],
  ['104.16.0.0', 13],
  ['104.24.0.0', 14],
  ['172.64.0.0', 13],
  ['131.0.72.0', 22],
] as const;
function ipv4(value: string) {
  return (
    value
      .split('.')
      .reduce((result, part) => result * 256 + Number(part), 0) >>> 0
  );
}
export function isCloudflareAddress(value: string) {
  if (isIP(value) === 4) {
    if (value.split('.').some((part) => Number(part) > 255)) return false;
    const address = ipv4(value);
    return edgeV4.some(
      ([network, bits]) =>
        address >>> (32 - bits) === ipv4(network) >>> (32 - bits),
    );
  }
  if (isIP(value) !== 6) return false;
  const [first, second] = value.toLowerCase().split(':', 2);
  const prefix = `${first.padStart(4, '0')}${second?.padStart(4, '0') || '0000'}`;
  return (
    [
      '2400cb00',
      '26064700',
      '2803f800',
      '2405b500',
      '24058100',
      '2c0ff248',
    ].includes(prefix) ||
    (first === '2a06' && (Number.parseInt(second, 16) & 0xff_f8) === 0x98_c0)
  );
}

async function boundedBody(response: Response, maximum: number) {
  const reader = response.body?.getReader();
  if (!reader) return '';
  let size = 0;
  const parts: Uint8Array[] = [];
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error('Response exceeded check limit.');
      parts.push(value);
    }
    return new TextDecoder().decode(Buffer.concat(parts));
  } finally {
    await reader.cancel();
  }
}

const dnsSchema = z.object({
  Status: z.number(),
  Answer: z.array(z.object({ type: z.number(), data: z.string() })).optional(),
});
export async function checkDeliveryDomain(
  domain: { id: string; hostname: string; validationKey: string },
  environment: ValidationEnvironment,
): Promise<DomainDiagnostics> {
  const checkedAt = now(),
    result = (
      outcome: DomainDiagnostics['outcome'],
      stage: DomainDiagnostics['stage'],
      message: string,
    ): DomainDiagnostics => ({ outcome, stage, message, checkedAt });
  const signal = AbortSignal.timeout(10_000);
  const local =
    environment.ENVIRONMENT === 'development' &&
    (domain.hostname === '127.0.0.1' || domain.hostname.endsWith('.localhost'));
  if (!local) {
    try {
      const responses = await Promise.all(
        [1, 28].map(async (type) => {
          const endpoint = new URL('https://cloudflare-dns.com/dns-query');
          endpoint.searchParams.set('name', domain.hostname);
          endpoint.searchParams.set('type', String(type));
          const response = await fetch(endpoint, {
            headers: { Accept: 'application/dns-json' },
            redirect: 'error',
            signal,
          });
          if (!response.ok) {
            await response.body?.cancel();
            throw new Error('Resolver unavailable.');
          }
          return dnsSchema.parse(
            JSON.parse(await boundedBody(response, 16_384)),
          );
        }),
      );
      if (responses.some((response) => ![0, 3].includes(response.Status)))
        return result(
          'inconclusive',
          'dns',
          'The DNS resolver could not complete this check. Your previous health status has been kept. Try again later.',
        );
      const addresses = responses.flatMap((response) =>
        (response.Answer || [])
          .filter((answer) => answer.type === 1 || answer.type === 28)
          .map((answer) => answer.data),
      );
      if (addresses.length === 0)
        return result(
          'failed',
          'dns',
          'This hostname does not resolve yet. Add it as a Custom Domain on the Hearth delivery Worker, then revalidate after DNS updates.',
        );
      if (addresses.some((address) => !isCloudflareAddress(address)))
        return result(
          'failed',
          'dns',
          'DNS does not point exclusively to Cloudflare’s public edge. Configure this exact hostname as a delivery Worker Custom Domain and remove conflicting DNS records.',
        );
    } catch {
      return result(
        'inconclusive',
        'dns',
        'DNS could not be checked right now. Your previous health status has been kept. Try again later.',
      );
    }
  }
  const nonce = randomSecret(16),
    deadline = String(now() + 30);
  let expectedHash: string;
  try {
    const { writer } = await writeStoredObject(
      environment.DB,
      environment.BUCKET,
      deliveryProbeKey(nonce),
      'probe',
      new TextEncoder().encode(DELIVERY_PROBE_CONTENT),
    );
    await environment.DB.batch([writer.finalizeStatement()]);
    expectedHash = await digest(DELIVERY_PROBE_CONTENT, 'delivery-probe');
  } catch (error) {
    return result(
      'inconclusive',
      'storage',
      error instanceof AppError
        ? error.message
        : 'Hearth could not prepare its storage check. Your previous domain health has been kept. Check instance storage and try again.',
    );
  }
  try {
    const endpoint = new URL(
      DELIVERY_PROBE_PATH,
      deliveryOrigin(domain.hostname, environment),
    );
    endpoint.searchParams.set('nonce', nonce);
    endpoint.searchParams.set('until', deadline);
    endpoint.searchParams.set(
      'signature',
      probeSignature(
        domain.validationKey,
        'request',
        domain.id,
        domain.hostname,
        nonce,
        deadline,
      ),
    );
    const headers: Record<string, string> = { Accept: 'application/json' };
    if (local) {
      headers['X-Hearth-Local-Hostname'] = domain.hostname;
      endpoint.hostname = '127.0.0.1';
    }
    const response = await fetch(endpoint, {
      redirect: 'manual',
      signal,
      headers,
    });
    if (!response.ok) {
      await response.body?.cancel();
      return result(
        'failed',
        'delivery',
        response.status >= 300 && response.status < 400
          ? 'The delivery hostname redirects. Point it directly to the delivery Worker; redirects cannot be validated.'
          : response.status === 503
            ? 'Delivery returned a service error. Verify the Worker deployment and that web and delivery share the same D1 database and R2 bucket.'
            : 'Hearth delivery did not answer on this hostname. Attach it to the delivery Worker as a Custom Domain and check its deployment.',
      );
    }
    const proof = z
      .object({
        domainId: z.string(),
        nonce: z.string(),
        hash: z.string(),
        proof: z.string(),
      })
      .parse(JSON.parse(await boundedBody(response, 2048)));
    if (
      proof.domainId !== domain.id ||
      proof.nonce !== nonce ||
      proof.hash !== expectedHash ||
      !matchesSignature(
        proof.proof,
        probeSignature(
          domain.validationKey,
          'response',
          domain.id,
          domain.hostname,
          nonce,
          deadline,
          expectedHash,
        ),
      )
    )
      return result(
        'failed',
        'delivery',
        'This hostname does not serve this Hearth instance. Verify the delivery Worker uses the same D1 database and R2 bucket as the application.',
      );
    return result(
      'passed',
      'complete',
      local
        ? 'The local delivery Worker answered and read the storage check. Production DNS and TLS were not checked.'
        : 'Cloudflare DNS, HTTPS delivery, instance identity, and an R2 read passed.',
    );
  } catch {
    return result(
      'failed',
      'delivery',
      local
        ? 'The local delivery Worker could not be reached. Start it on the configured port with the same D1 and R2 state, then revalidate.'
        : 'The HTTPS delivery check could not complete. Check the Custom Domain’s TLS status and Worker deployment, then revalidate.',
    );
  } finally {
    try {
      await deleteStoredObjects(environment.DB, environment.BUCKET, [
        deliveryProbeKey(nonce),
      ]);
    } catch {
      console.error(
        JSON.stringify({ event: 'delivery.probe_cleanup_pending' }),
      );
    }
  }
}

export async function validateDeliveryDomain(
  environment: ValidationEnvironment,
  actor: User,
  domainId: string,
) {
  requireAdmin(actor);
  const domain = await domainDetails(environment.DB, actor, domainId);
  configuredHostname(domain.hostname, environment);
  const checkId = randomSecret(16);
  const secret = await environment.DB.prepare(
    'UPDATE delivery_domains SET checkId=? WHERE id=? RETURNING validationKey',
  )
    .bind(checkId, domainId)
    .first<{ validationKey: string }>();
  if (!secret)
    throw new AppError(404, 'NOT_FOUND', 'Delivery domain not found.');
  const diagnostics = await checkDeliveryDomain(
    { ...domain, validationKey: secret.validationKey },
    environment,
  );
  const update = await environment.DB.prepare(
    `UPDATE delivery_domains SET health=CASE WHEN ?='inconclusive' THEN health WHEN ?='passed' THEN 'active' WHEN lastHealthyAt IS NOT NULL THEN 'unhealthy' ELSE 'misconfigured' END,
    lastCheckedAt=?,lastHealthyAt=CASE WHEN ?='passed' THEN ? ELSE lastHealthyAt END,diagnostics=?,revision=revision+1,updatedAt=? WHERE id=? AND checkId=?`,
  )
    .bind(
      diagnostics.outcome,
      diagnostics.outcome,
      diagnostics.checkedAt,
      diagnostics.outcome,
      diagnostics.checkedAt,
      JSON.stringify(diagnostics),
      now(),
      domainId,
      checkId,
    )
    .run();
  if (!update.meta.changes)
    throw new AppError(
      409,
      'CHECK_SUPERSEDED',
      'A newer validation check replaced this one. Refresh the domain details.',
    );
  return domainDetails(environment.DB, actor, domainId);
}
