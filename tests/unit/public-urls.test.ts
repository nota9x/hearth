import { expect, it } from 'vitest';

import { configuredHostname } from '../../packages/core/delivery-domains';
import {
  appUrl,
  contentUrl,
  deliveryOrigin,
} from '../../packages/core/public-urls';

const environment = {
  ENVIRONMENT: 'production',
  APP_ORIGIN: 'https://app.example.com',
};
it('constructs application and delivery URLs outside a request context', () => {
  expect(contentUrl('images.example.net', 'aB3xQ', environment)).toBe(
    'https://images.example.net/aB3xQ',
  );
  expect(appUrl(environment, '/api/v1/images')).toBe(
    'https://app.example.com/api/v1/images',
  );
  expect(() => appUrl(environment, '//attacker.com')).toThrow();
  expect(
    deliveryOrigin('images.localhost', {
      ...environment,
      ENVIRONMENT: 'development',
      LOCAL_DELIVERY_PORT: '8789',
    }),
  ).toBe(['http:', '', 'images.localhost:8789'].join('/'));
});
it('accepts loopback and any localhost subdomain only on the configured development port', () => {
  const local = {
    ...environment,
    ENVIRONMENT: 'development',
    APP_ORIGIN: 'http://127.0.0.1:5173',
    LOCAL_DELIVERY_PORT: '8788',
  };
  for (const [input, hostname] of [
    ['127.0.0.1:8788', '127.0.0.1'],
    ['127.0.0.1', '127.0.0.1'],
    [' Shots.Localhost:8788 ', 'shots.localhost'],
    ['nested.shots.localhost:8788', 'nested.shots.localhost'],
    ['nested.shots.localhost', 'nested.shots.localhost'],
  ]) {
    expect(configuredHostname(input, local)).toBe(hostname);
    expect(contentUrl(hostname, 'local-image', local)).toBe(
      `http://${hostname}:8788/local-image`,
    );
    expect(() => configuredHostname(input, environment)).toThrow();
  }
  for (const input of [
    '127.0.0.1:5173',
    'shots.localhost:8789',
    'http://127.0.0.1:8788',
    '127.0.0.1:8788/path',
    '127.0.0.2:8788',
    'shots.127.0.0.1:8788',
    'bad..localhost:8788',
    'images.example.com:8788',
  ])
    expect(() => configuredHostname(input, local)).toThrow();
  expect(
    configuredHostname('127.0.0.1:9000', {
      ...local,
      LOCAL_DELIVERY_PORT: '9000',
    }),
  ).toBe('127.0.0.1');
  expect(() =>
    configuredHostname('127.0.0.1:8788', {
      ...local,
      APP_ORIGIN: 'http://127.0.0.1:8788',
    }),
  ).toThrow('The application hostname cannot also be a delivery domain.');
  expect(() => deliveryOrigin('127.0.0.1', environment)).toThrow();
});
