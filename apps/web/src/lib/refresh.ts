import { writable } from 'svelte/store';

// Serialize refreshes. A mutation during a read schedules one trailing read so
// the mutation cannot be hidden by an older response already in flight.
export function createRefresh(update: () => Promise<void>) {
  const refreshing = writable(false);
  let active: Promise<void> | undefined;
  let pending = false;

  async function drain() {
    refreshing.set(true);
    try {
      do {
        pending = false;
        try {
          await update();
        } catch (error) {
          if (!pending) throw error;
        }
      } while (pending);
    } finally {
      active = undefined;
      refreshing.set(false);
    }
  }

  function refresh(afterMutation = false) {
    if (active) {
      pending ||= afterMutation;
      return active;
    }
    active = drain();
    return active;
  }

  return {
    subscribe: refreshing.subscribe,
    refresh,
  };
}

export function refreshInterval(
  section: string,
  admin: boolean,
  detail: boolean,
  active: boolean,
) {
  if (active) return 5000;
  if (!detail && ['overview', 'images', 'links', 'storage'].includes(section))
    return 15_000;
  return admin && ['users', 'audit-log'].includes(section) ? 60_000 : null;
}

export function watchRefresh(
  refresh: () => void,
  enabled: () => boolean,
  interval: number | null,
) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let hidden = document.visibilityState !== 'visible';
  let lastRequest = -Infinity;
  function update(force = false) {
    if (!(
      document.visibilityState === 'visible' &&
      enabled() &&
      (force || Date.now() - lastRequest >= 1000)
    )) {
      return;
    }

    lastRequest = Date.now();
    refresh();
  }
  function schedule() {
    clearTimeout(timer);
    if (interval !== null && document.visibilityState === 'visible')
      timer = setTimeout(() => {
        update(true);
        schedule();
      }, interval);
  }
  function resume() {
    if (document.visibilityState !== 'visible') {
      hidden = true;
      clearTimeout(timer);
      return;
    }
    // Focus and visibilitychange often arrive together. Always refresh after
    // hiding, but coalesce the companion focus event even if the read is fast.
    update(hidden);
    hidden = false;
    schedule();
  }
  schedule();
  document.addEventListener('visibilitychange', resume);
  window.addEventListener('focus', resume);
  return () => {
    clearTimeout(timer);
    document.removeEventListener('visibilitychange', resume);
    window.removeEventListener('focus', resume);
  };
}
