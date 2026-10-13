import { parseHostname } from './domain-format';

export interface PublicUrlEnvironment {
  APP_ORIGIN: string;
  ENVIRONMENT: string;
  LOCAL_DELIVERY_PORT?: string;
}

export function appOrigin(
  environment: Pick<PublicUrlEnvironment, 'APP_ORIGIN'>,
) {
  const url = new URL(environment.APP_ORIGIN);
  if (
    !['http:', 'https:'].includes(url.protocol) ||
    url.origin !== environment.APP_ORIGIN ||
    url.username ||
    url.password
  )
    throw new Error('APP_ORIGIN must be a canonical HTTP(S) origin.');
  return url.origin;
}

export function appUrl(
  environment: Pick<PublicUrlEnvironment, 'APP_ORIGIN'>,
  path: string,
) {
  if (!path.startsWith('/') || path.startsWith('//'))
    throw new Error('Use an absolute application path.');
  const origin = appOrigin(environment);
  const result = new URL(path, origin);
  if (result.origin !== origin)
    throw new Error('Application URLs must stay on the application origin.');
  return result.href;
}

export function deliveryOrigin(
  hostname: string,
  environment: PublicUrlEnvironment,
) {
  const name =
    hostname === '127.0.0.1' && environment.ENVIRONMENT === 'development'
      ? hostname
      : parseHostname(hostname);
  if (
    environment.ENVIRONMENT === 'development' &&
    (name === '127.0.0.1' || name.endsWith('.localhost'))
  ) {
    const port = environment.LOCAL_DELIVERY_PORT || '8788';
    if (!/^\d+$/.test(port) || Number(port) < 1 || Number(port) > 65_535)
      throw new Error('Invalid local delivery port.');
    return `http://${name}:${port}`;
  }
  return `https://${name}`;
}

export function contentUrl(
  hostname: string,
  slug: string,
  environment: PublicUrlEnvironment,
) {
  if (!/^[\w-]{3,64}$/.test(slug))
    throw new Error('Invalid public resource path.');
  return `${deliveryOrigin(hostname, environment)}/${slug}`;
}

export function deletionUrl(
  imageId: string,
  token: string,
  environment: PublicUrlEnvironment,
) {
  return appUrl(
    environment,
    `/delete/${encodeURIComponent(imageId)}#${encodeURIComponent(token)}`,
  );
}
