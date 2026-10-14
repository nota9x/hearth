import { describe, expect, it } from 'vitest';

import {
  resolveExpiryPolicy,
  unrestrictedExpiryPolicy,
  validateImageExpiry,
} from '../../packages/core/expiry-policy';

const unrestricted = unrestrictedExpiryPolicy;
const createdAt = 1_000_000;
describe('expiry policy calculations', () => {
  it('inherits defaults, permits independent tightening and relaxing, and exempts administrators', () => {
    const instance = { requireExpiry: true, maxLifetimeSeconds: 86_400 };
    expect(
      resolveExpiryPolicy(instance, { role: 'user', expiryPolicy: null }),
    ).toEqual({ ...instance, source: 'instance' });
    expect(
      resolveExpiryPolicy(unrestricted, {
        role: 'user',
        expiryPolicy: instance,
      }),
    ).toEqual({ ...instance, source: 'custom' });
    expect(
      resolveExpiryPolicy(instance, {
        role: 'user',
        expiryPolicy: { requireExpiry: false },
      }),
    ).toEqual({
      requireExpiry: false,
      maxLifetimeSeconds: 86_400,
      source: 'custom',
    });
    expect(
      resolveExpiryPolicy(instance, {
        role: 'user',
        expiryPolicy: { requireExpiry: false, maxLifetimeSeconds: null },
      }),
    ).toEqual({ ...unrestricted, source: 'custom' });
    expect(
      resolveExpiryPolicy(instance, { role: 'admin', expiryPolicy: instance }),
    ).toEqual({ ...unrestricted, source: 'administrator' });
  });
  it('accepts the exact creation-time limit and rejects one second beyond and expired dates', () => {
    const policy = { requireExpiry: false, maxLifetimeSeconds: 3600 };
    expect(() =>
      validateImageExpiry(policy, createdAt, createdAt + 3600, createdAt + 100),
    ).not.toThrow();
    expect(() =>
      validateImageExpiry(policy, createdAt, createdAt + 3601, createdAt + 100),
    ).toThrow('at most 1 hour');
    expect(() =>
      validateImageExpiry(
        policy,
        createdAt,
        createdAt + 3600,
        createdAt + 3600,
      ),
    ).toThrow('future expiration');
  });
});
