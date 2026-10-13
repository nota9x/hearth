type Handoff = { userId: string; key: string; expiresAt: number };
const pending = {
  handoff: null as Handoff | null,
  timer: undefined as ReturnType<typeof setTimeout> | undefined,
};

export function clearOnboardingKey() {
  pending.handoff = null;
  clearTimeout(pending.timer);
  pending.timer = undefined;
  if (typeof window !== 'undefined')
    window.removeEventListener('pagehide', clearOnboardingKey);
}

export function holdOnboardingKey(userId: string, key: string) {
  clearOnboardingKey();
  if (typeof window === 'undefined') return;
  pending.handoff = { userId, key, expiresAt: Date.now() + 15 * 60_000 };
  pending.timer = setTimeout(clearOnboardingKey, 15 * 60_000);
  window.addEventListener('pagehide', clearOnboardingKey, { once: true });
}

export function takeOnboardingKey(userId: string) {
  const value = pending.handoff;
  clearOnboardingKey();
  return value?.userId === userId && value.expiresAt > Date.now()
    ? value
    : null;
}
