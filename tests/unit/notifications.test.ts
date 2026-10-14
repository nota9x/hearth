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

describe('live notifications', () => {
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
