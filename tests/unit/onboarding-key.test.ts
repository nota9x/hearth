import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  clearOnboardingKey,
  holdOnboardingKey,
  takeOnboardingKey,
} from '../../apps/web/src/lib/onboarding-key';

const windowEvents = new EventTarget();
beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal('window', windowEvents);
});
afterEach(() => {
  clearOnboardingKey();
});

describe('one-time onboarding credential handoff', () => {
  it('hands the key only to its account and consumes it once', () => {
    holdOnboardingKey('owner', 'private-key');
    expect(takeOnboardingKey('another-account')).toBeNull();
    holdOnboardingKey('owner', 'private-key');
    expect(takeOnboardingKey('owner')).toEqual({
      userId: 'owner',
      key: 'private-key',
      expiresAt: Date.now() + 900_000,
    });
    expect(takeOnboardingKey('owner')).toBeNull();
  });
  it('expires after fifteen minutes', () => {
    holdOnboardingKey('owner', 'private-key');
    vi.advanceTimersByTime(900_000);
    expect(takeOnboardingKey('owner')).toBeNull();
  });
  it('drops the credential when the document leaves, including back-forward cache', () => {
    holdOnboardingKey('owner', 'private-key');
    windowEvents.dispatchEvent(new Event('pagehide'));
    expect(takeOnboardingKey('owner')).toBeNull();
  });
  it('never retains a credential during server rendering', () => {
    vi.stubGlobal('window', undefined);
    holdOnboardingKey('owner', 'private-key');
    expect(takeOnboardingKey('owner')).toBeNull();
  });
});
