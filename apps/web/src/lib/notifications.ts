import { writable } from 'svelte/store';

export type NotificationKind =
  'success' | 'info' | 'warning' | 'error' | 'loading';
export type NotificationItemState =
  | 'pending'
  | 'active'
  | 'saving'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'started';
export interface CancellationConfirmation {
  title: string;
  message: string;
  confirmLabel: string;
  keepLabel: string;
}
export interface NotificationItem {
  id: string;
  name: string;
  state: NotificationItemState;
  status: string;
  metadata?: string;
  error?: string;
  warning?: string;
  action?: { kind: 'cancel' | 'retry'; label: string; run: () => void };
}
export interface LiveSnapshot {
  message: string;
  kind: NotificationKind;
  progress?: number;
  metadata?: string;
  guidance?: string;
  items?: NotificationItem[];
  itemsLabel?: string;
  persistent?: boolean;
  cancellable?: boolean;
}
export interface Notification {
  id: number;
  kind: NotificationKind;
  message: string;
  duration: number;
  remaining: number;
  progress?: number;
  onCancel?: () => void;
  cancellation?: CancellationConfirmation;
  metadata?: string;
  guidance?: string;
  link?: { href: string; label: string };
  items?: NotificationItem[];
  itemsLabel?: string;
  persistent?: boolean;
  onDismiss?: () => void;
}

export const notificationBytes = (value: number): string =>
  value < 1024
    ? `${Math.round(value)} B`
    : value < 1_048_576
      ? `${(value / 1024).toFixed(1)} KiB`
      : value < 1_073_741_824
        ? `${(value / 1_048_576).toFixed(1)} MiB`
        : `${(value / 1_073_741_824).toFixed(1)} GiB`;

// A trailing five-second window includes idle time and ignores sub-second samples.
export function createSpeedMeter() {
  const samples: { time: number; bytes: number }[] = [];
  return (time: number, bytes: number) => {
    samples.push({ time, bytes });
    while (samples.length > 2 && samples[1].time <= time - 5000)
      samples.shift();
    const first = samples[0];
    const elapsed = time - first.time;
    return elapsed >= 1000
      ? Math.max(0, ((bytes - first.bytes) * 1000) / elapsed)
      : null;
  };
}

/**
One clock for the entire deck. Waiting cards never consume their lifetime.
*/
export function createNotifications() {
  const store = writable<Notification[]>([]);
  type CancellationRequest = {
    id: number;
    itemId?: string;
    details: CancellationConfirmation;
  };
  const confirmation = writable<CancellationRequest | null>(null);
  let requested: CancellationRequest | null = null;
  let cards: Notification[] = [];
  let sequence = 0;
  let previous: number | undefined;
  function cancellationTarget(id: number, itemId?: string) {
    const card = cards.find((entry) => entry.id === id);
    if (card?.kind !== 'loading') return;
    if (itemId !== undefined) {
      const action = card.items?.find((item) => item.id === itemId)?.action;
      return action?.kind === 'cancel' ? action.run : undefined;
    }
    return card.onCancel;
  }
  function keepRunning() {
    requested = null;
    confirmation.set(null);
  }
  function publish() {
    if (requested && !cancellationTarget(requested.id, requested.itemId))
      keepRunning();
    store.set([...cards]);
  }
  function requestCancel(id: number, itemId?: string) {
    if (!cancellationTarget(id, itemId)) return;
    const card = cards.find((entry) => entry.id === id)!;
    requested = {
      id,
      itemId,
      details: card.cancellation ?? {
        title: 'Cancel operation?',
        message:
          'This operation is still in progress. Cancelling will stop the remaining work.',
        confirmLabel: 'Cancel Operation',
        keepLabel: 'Keep Running',
      },
    };
    if (itemId !== undefined)
      requested.details = {
        ...requested.details,
        message:
          'This file is still in progress or queued. Cancelling will stop this file. Other files will continue.',
      };
    confirmation.set(requested);
  }
  function confirmCancel() {
    const target = requested;
    keepRunning();
    if (!target) return;
    if (target.itemId === undefined) cancel(target.id);
    else cancellationTarget(target.id, target.itemId)?.();
  }
  function push(
    kind: NotificationKind,
    message: string,
    duration = 5000,
    details: Pick<Notification, 'guidance' | 'link'> = {},
  ) {
    const lifetime = Number.isFinite(duration) ? Math.max(1, duration) : 5000;
    const id = ++sequence;
    cards = [
      {
        id,
        kind,
        message,
        duration: lifetime,
        remaining: lifetime,
        ...details,
      },
      ...cards,
    ];
    previous = undefined;
    publish();
    return id;
  }
  function dismiss(id: number) {
    const card = cards.find((entry) => entry.id === id);
    if (cards[0]?.id === id) previous = undefined;
    cards = cards.filter((card) => card.id !== id);
    card?.onDismiss?.();
    publish();
  }
  function cancel(id: number) {
    const card = cards.find((entry) => entry.id === id);
    if (!card || card.kind !== 'loading' || !card.onCancel) return;
    const abort = card.onCancel;
    card.onCancel = undefined;
    publish();
    abort();
  }
  function live(
    message: string,
    onCancel?: () => void,
    options: Pick<Notification, 'cancellation' | 'onDismiss'> = {},
  ) {
    const id = push('loading', message);
    const card = cards.find((entry) => entry.id === id)!;
    let cancelled = false;
    const abort = onCancel
      ? () => {
          cancelled = true;
          onCancel();
        }
      : undefined;
    card.onCancel = abort;
    Object.assign(card, options);
    publish();
    function finish(kind: 'success' | 'error', message: string) {
      if (!cards.includes(card) || card.kind !== 'loading') return;
      Object.assign(card, {
        kind,
        message,
        progress: undefined,
        metadata: undefined,
        onCancel: undefined,
      });
      if (cards[0] === card) previous = undefined;
      publish();
    }
    return {
      id,
      update(snapshot: LiveSnapshot) {
        if (!cards.includes(card)) return;
        if (card.kind !== 'loading' && snapshot.kind === 'loading')
          cancelled = false;
        if (card.kind !== snapshot.kind) {
          card.remaining = card.duration;
          if (cards[0] === card) previous = undefined;
        }
        Object.assign(card, {
          metadata: undefined,
          guidance: undefined,
          items: undefined,
          itemsLabel: undefined,
          persistent: false,
          ...snapshot,
          progress: snapshot.kind === 'loading' ? snapshot.progress : undefined,
          onCancel:
            !cancelled &&
            snapshot.kind === 'loading' &&
            snapshot.cancellable !== false
              ? abort
              : undefined,
        });
        publish();
      },
      progress(value: number) {
        if (
          !cards.includes(card) ||
          card.kind !== 'loading' ||
          !Number.isFinite(value)
        )
          return;
        card.progress = Math.max(card.progress ?? 0, Math.min(100, value));
        publish();
      },
      success: (message: string) => finish('success', message),
      error: (message: string) => finish('error', message),
      cancel: () => cancel(id),
    };
  }
  function tick(now: number, paused = false) {
    const elapsed = previous === undefined ? 0 : Math.max(0, now - previous);
    previous = now;
    const active = cards[0];
    if (!active || paused || active.kind === 'loading' || active.persistent)
      return;
    active.remaining = Math.max(0, active.remaining - elapsed);
    if (active.remaining === 0) dismiss(active.id);
    else publish();
  }
  return {
    subscribe: store.subscribe,
    dismiss,
    cancel,
    confirmation: { subscribe: confirmation.subscribe },
    requestCancel,
    confirmCancel,
    keepRunning,
    tick,
    live,
    resetClock: () => {
      previous = undefined;
    },
    success: (message: string, duration?: number) =>
      push('success', message, duration),
    info: (
      message: string,
      duration?: number,
      details?: Pick<Notification, 'guidance' | 'link'>,
    ) => push('info', message, duration, details),
    warning: (message: string, duration?: number) =>
      push('warning', message, duration),
    error: (message: string, duration?: number) =>
      push('error', message, duration),
  };
}

// Called only by browser event handlers; the root layout owns rendering/clock.
export const notify = createNotifications();
