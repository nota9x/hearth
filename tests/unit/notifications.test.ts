import { describe, expect, it, vi } from 'vitest';

import { createNotifications } from '../../apps/web/src/lib/notifications';

function get<T>(deck: {
  subscribe: (callback: (value: T) => void) => () => void;
}) {
  let cards!: T;
  const unsubscribe = deck.subscribe((value) => {
    cards = value;
  });
  unsubscribe();
  return cards;
}

describe('notification deck clock', () => {
  it('carries a dismissible settings link through the existing information deck', () => {
    const deck = createNotifications();
    const id = deck.info('You can revisit onboarding anytime', 8000, {
      guidance: 'Restart guided setup from your settings.',
      link: { href: '/settings', label: 'Open settings' },
    });
    expect(get(deck)).toMatchObject([
      {
        id,
        kind: 'info',
        guidance: 'Restart guided setup from your settings.',
        link: { href: '/settings' },
      },
    ]);
    deck.dismiss(id);
    expect(get(deck)).toEqual([]);
  });
  it('preserves interrupted lifetimes and only expires the front card', () => {
    const deck = createNotifications();
    const first = deck.success('First');
    deck.tick(0);
    deck.tick(2000);
    const second = deck.error('Second', 1000);
    deck.tick(2100);
    deck.tick(3100);
    expect(get(deck).map((card) => card.id)).toEqual([first]);
    expect(get(deck)[0].remaining).toBe(3000);
    deck.dismiss(second); // Stale animation callbacks cannot dismiss the successor.
    deck.tick(3200);
    deck.tick(6200);
    expect(get(deck)).toEqual([]);
  });

  it('pauses near expiry and resumes without restarting', () => {
    const deck = createNotifications();
    deck.info('Almost done');
    deck.tick(0);
    deck.tick(4990);
    deck.tick(9000, true);
    expect(get(deck)[0].remaining).toBe(10);
    deck.tick(9005);
    expect(get(deck)[0].remaining).toBe(5);
    deck.tick(9010);
    expect(get(deck)).toEqual([]);
  });

  it('keeps identical rapid arrivals distinct and promotes in newest-first order', () => {
    const deck = createNotifications();
    const ids = Array.from({ length: 20 }, () => deck.warning('Repeated'));
    expect(new Set(get(deck).map((card) => card.id)).size).toBe(20);
    deck.tick(0);
    deck.tick(4000);
    expect(
      get(deck)
        .slice(1)
        .every((card) => card.remaining === 5000),
    ).toBe(true);
    deck.dismiss(ids[19]);
    const newest = deck.success('Arrived during dismissal');
    deck.dismiss(ids[19]);
    expect(get(deck)[0].id).toBe(newest);
    deck.dismiss(newest);
    expect(get(deck)[0].id).toBe(ids[18]);
    expect(get(deck)[0].remaining).toBe(5000);
  });

  it('resets the clock across hidden/unmounted periods and sanitizes duration', () => {
    const deck = createNotifications();
    deck.error('Error', NaN);
    deck.tick(0);
    deck.tick(1000);
    deck.resetClock();
    deck.tick(100_000);
    expect(get(deck)[0].remaining).toBe(4000);
  });
});

describe('live notifications', () => {
  it('leaves unknown progress undefined and replaces structured details without carrying stale metadata', () => {
    const deck = createNotifications();
    const live = deck.live('Preparing…');
    expect(get(deck)[0].progress).toBeUndefined();
    live.update({
      message: '1 of 2 copied · 50%',
      kind: 'loading',
      progress: 50,
      metadata: '5 KiB / 10 KiB',
      itemsLabel: 'Copy files',
      items: [
        { id: 'a', name: 'a.png', state: 'completed', status: 'Copied' },
        { id: 'b', name: 'b.png', state: 'active', status: 'Copying' },
      ],
    });
    expect(get(deck)[0]).toMatchObject({
      progress: 50,
      metadata: '5 KiB / 10 KiB',
    });
    live.update({ message: '2 of 2 copied', kind: 'success' });
    expect(get(deck)[0]).toMatchObject({
      progress: undefined,
      metadata: undefined,
      items: undefined,
      itemsLabel: undefined,
    });
    deck.dismiss(live.id);
    live.update({ message: 'Stale progress', kind: 'loading', progress: 90 });
    expect(get(deck)).toEqual([]);
  });

  it('retains cancelled operations and permits a retry with the same card and fresh lifetime', () => {
    const deck = createNotifications();
    const cancelled = vi.fn();
    const live = deck.live('Working', cancelled);
    live.cancel();
    expect(cancelled).toHaveBeenCalledOnce();
    expect(get(deck)[0].id).toBe(live.id);
    live.update({
      message: '0 of 1 uploaded · 1 cancelled',
      kind: 'error',
      persistent: true,
      items: [
        { id: 'a', name: 'a.png', state: 'cancelled', status: 'Cancelled' },
      ],
    });
    deck.tick(0);
    deck.tick(60_000);
    expect(get(deck)[0].remaining).toBe(5000);
    live.update({
      message: '0 of 1 uploaded · 0%',
      kind: 'loading',
      progress: 0,
    });
    expect(get(deck)[0]).toMatchObject({
      id: live.id,
      kind: 'loading',
      remaining: 5000,
      persistent: false,
    });
    expect(get(deck)[0].onCancel).toBeTypeOf('function');
    live.update({ message: '1 of 1 uploaded', kind: 'success', progress: 100 });
    expect(get(deck)[0].progress).toBeUndefined();
    deck.tick(70_000);
    deck.tick(75_000);
    expect(get(deck)).toEqual([]);
  });

  it('persists during progress and transitions in place with a fresh lifetime', () => {
    const deck = createNotifications();
    const live = deck.live('Uploading image(s)…');
    deck.tick(0);
    deck.tick(60_000);
    live.progress(40);
    expect(get(deck)[0]).toMatchObject({
      id: live.id,
      kind: 'loading',
      progress: 40,
      remaining: 5000,
    });
    live.success('Uploaded.');
    live.error('Late failure');
    live.progress(90);
    expect(get(deck)).toHaveLength(1);
    expect(get(deck)[0]).toMatchObject({
      id: live.id,
      kind: 'success',
      message: 'Uploaded.',
      progress: undefined,
    });
    deck.tick(90_000);
    deck.tick(94_999);
    expect(get(deck)).toHaveLength(1);
    deck.tick(95_000);
    expect(get(deck)).toEqual([]);
  });

  it('preserves stack order and waiting lifetimes on failure', () => {
    const deck = createNotifications();
    const live = deck.live('Working…');
    const newer = deck.info('Newer');
    deck.tick(0);
    deck.tick(1000);
    live.error('Failed.');
    expect(get(deck).map((card) => card.id)).toEqual([newer, live.id]);
    deck.tick(2000);
    expect(get(deck)[0].remaining).toBe(3000);
    expect(get(deck)[1].remaining).toBe(5000);
    deck.dismiss(newer);
    deck.tick(3000);
    deck.tick(8000);
    expect(get(deck)).toEqual([]);
  });

  it('ignores stale updates after cancellation and bounds progress', () => {
    const deck = createNotifications();
    const live = deck.live('Working…', () => deck.dismiss(live.id));
    live.progress(40);
    live.progress(20);
    live.progress(NaN);
    expect(get(deck)[0].progress).toBe(40);
    live.progress(200);
    expect(get(deck)[0].progress).toBe(100);
    live.cancel();
    live.cancel();
    live.progress(80);
    live.success('Done');
    live.error('Failed');
    expect(get(deck)).toEqual([]);
  });
});

describe('cancellation confirmation', () => {
  it('waits for confirmation, keeps work running on dismissal and aborts only once', () => {
    const deck = createNotifications();
    const abort = vi.fn();
    const live = deck.live('Working…', abort);
    deck.requestCancel(live.id);
    expect(get(deck.confirmation)?.id).toBe(live.id);
    expect(abort).not.toHaveBeenCalled();
    deck.keepRunning();
    deck.confirmCancel();
    expect(abort).not.toHaveBeenCalled();
    deck.requestCancel(live.id);
    deck.confirmCancel();
    deck.confirmCancel();
    live.update({ message: 'Stopping…', kind: 'loading' });
    deck.requestCancel(live.id);
    deck.cancel(live.id);
    expect(abort).toHaveBeenCalledOnce();
    expect(get(deck.confirmation)).toBeNull();
    expect(get(deck)[0]).toMatchObject({ id: live.id, onCancel: undefined });
  });

  it('closes stale confirmations when the operation finishes or is dismissed', () => {
    const deck = createNotifications();
    const abort = vi.fn();
    const live = deck.live('Working…', abort);
    deck.requestCancel(live.id);
    live.success('Done.');
    expect(get(deck.confirmation)).toBeNull();
    deck.confirmCancel();
    deck.requestCancel(live.id);
    expect(get(deck.confirmation)).toBeNull();
    expect(abort).not.toHaveBeenCalled();
    deck.dismiss(live.id);
    const next = deck.live('Next', abort);
    deck.requestCancel(next.id);
    deck.dismiss(next.id);
    expect(get(deck.confirmation)).toBeNull();
    deck.confirmCancel();
    expect(abort).not.toHaveBeenCalled();
  });

  it('does not offer cancellation without abort support or during a commit', () => {
    const deck = createNotifications();
    const uncancellable = deck.live('Working…');
    deck.requestCancel(uncancellable.id);
    deck.cancel(uncancellable.id);
    expect(get(deck.confirmation)).toBeNull();
    expect(get(deck)).toHaveLength(1);
    const abort = vi.fn();
    const live = deck.live('Downloading…', abort);
    deck.requestCancel(live.id);
    live.update({
      message: 'Committing…',
      kind: 'loading',
      cancellable: false,
    });
    expect(get(deck.confirmation)).toBeNull();
    deck.confirmCancel();
    deck.cancel(live.id);
    expect(abort).not.toHaveBeenCalled();
  });

  it('confirms individual items and invalidates a finished item while other work continues', () => {
    const deck = createNotifications();
    const abort = vi.fn();
    const abortItem = vi.fn();
    const live = deck.live('Uploading…', abort);
    const item = {
      id: 'a',
      name: 'a.png',
      state: 'active' as const,
      status: 'Uploading',
      action: {
        kind: 'cancel' as const,
        label: 'Cancel a.png',
        run: abortItem,
      },
    };
    live.update({ message: 'Uploading…', kind: 'loading', items: [item] });
    deck.requestCancel(live.id, item.id);
    expect(abortItem).not.toHaveBeenCalled();
    deck.confirmCancel();
    expect(abortItem).toHaveBeenCalledOnce();
    expect(abort).not.toHaveBeenCalled();
    deck.requestCancel(live.id, item.id);
    live.update({
      message: 'Uploading…',
      kind: 'loading',
      items: [{ ...item, state: 'completed', action: undefined }],
    });
    expect(get(deck.confirmation)).toBeNull();
    deck.confirmCancel();
    expect(abortItem).toHaveBeenCalledOnce();
  });
});
