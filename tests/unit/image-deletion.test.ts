import { afterEach, describe, expect, it, vi } from 'vitest';

import { dashboard } from '../../apps/web/src/lib/dashboard';
import {
  deleteSelectedImages,
  imageDeletion,
  reconcileDeletedImages,
  setDeletionOwner,
} from '../../apps/web/src/lib/deletion';
import { notify } from '../../apps/web/src/lib/notifications';

vi.mock('../../apps/web/src/lib/dashboard', () => ({
  dashboard: { refresh: vi.fn() },
}));

function get<T>(store: {
  subscribe: (callback: (value: T) => void) => () => void;
}) {
  let value!: T;
  const unsubscribe = store.subscribe((current) => {
    value = current;
  });
  unsubscribe();
  return value;
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  for (const card of get(notify)) notify.dismiss(card.id);
});

describe('background image deletion', () => {
  it('stops future batches after confirmation and reconciles the current batch', async () => {
    setDeletionOwner('cancel-batches');
    const ids = Array.from({ length: 101 }, (_, index) => `image-${index}`);
    let release!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    vi.mocked(dashboard.refresh).mockRejectedValue(new Error('offline'));
    const done = deleteSelectedImages(ids);
    const notice = get(notify)[0];
    expect(notice.onCancel).toBeTypeOf('function');
    notify.requestCancel(notice.id);
    expect(get(notify)[0].items?.[100].state).toBe('pending');
    notify.confirmCancel();
    expect(get(notify)[0].items?.[100].state).toBe('cancelled');
    expect(get(notify)[0].onCancel).toBeUndefined();
    release(
      Response.json({
        deletedIds: ids.slice(0, 100),
        alreadyRemovedIds: [],
        failed: [],
      }),
    );
    await done;
    expect(fetch).toHaveBeenCalledOnce();
    expect(get(imageDeletion)).toEqual({
      pending: [],
      removed: ids.slice(0, 100),
    });
    const result = get(notify).find((card) => card.id === notice.id)!;
    expect(result).toMatchObject({
      message: '100 of 101 deleted · 1 cancelled',
      persistent: true,
      onCancel: undefined,
    });
    expect(result.items?.[0].state).toBe('completed');
    expect(result.items?.[100]).toMatchObject({
      state: 'cancelled',
      status: 'Not deleted',
    });
  });

  it('discards in-flight results on account changes', async () => {
    setDeletionOwner('previous-owner');
    let release!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
          new Promise<Response>((resolve) => {
            release = resolve;
          }),
      ),
    );
    const done = deleteSelectedImages(['a']);
    setDeletionOwner('next-owner');
    release(
      Response.json({ deletedIds: ['a'], alreadyRemovedIds: [], failed: [] }),
    );
    await done;
    expect(get(imageDeletion)).toEqual({ pending: [], removed: [] });
    expect(get(notify)).toEqual([]);
  });
  it('registers pending IDs immediately, deduplicates overlap and preserves partial results through refresh', async () => {
    setDeletionOwner('partial');
    let respond!: (response: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi.fn(
        () =>
          // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
          new Promise<Response>((resolve) => {
            respond = resolve;
          }),
      ),
    );
    let refreshed!: () => void;
    vi.mocked(dashboard.refresh).mockImplementation(
      () =>
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        new Promise<void>((resolve) => {
          refreshed = resolve;
        }),
    );
    const operation = deleteSelectedImages(['a', 'b'], {
      a: 'file-a.png',
      b: 'file-b.png',
    });
    expect(get(imageDeletion).pending).toEqual(['a', 'b']);
    expect(get(notify)[0]).toMatchObject({ progress: undefined });
    expect(get(notify)[0].items?.[0]).toMatchObject({
      id: 'a',
      name: 'file-a.png',
      state: 'active',
    });
    await deleteSelectedImages(['a']);
    expect(fetch).toHaveBeenCalledOnce();
    respond(
      Response.json({
        deletedIds: ['a'],
        alreadyRemovedIds: [],
        failed: [{ id: 'b', code: 'UNAVAILABLE', message: 'Try again.' }],
      }),
    );
    await vi.waitFor(() => expect(get(imageDeletion).removed).toEqual(['a']));
    expect(get(notify)[0].kind).toBe('error');
    expect(get(notify)[0].items?.map((item) => item.state)).toEqual([
      'completed',
      'failed',
    ]);
    expect(get(notify)[0].items?.[1].error).toBe('Try again.');
    expect(get(notify)[0].kind).toBe('error');
    expect(get(notify)[0].persistent).toBe(true);
    refreshed();
    await operation;
    expect(get(imageDeletion)).toEqual({ pending: [], removed: [] });
  });
  it('retains successful removals when refresh fails and does not misreport deletion failure', async () => {
    setDeletionOwner('refresh-failure');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json({
            deletedIds: ['a'],
            alreadyRemovedIds: [],
            failed: [],
          }),
        ),
      ),
    );
    vi.mocked(dashboard.refresh).mockRejectedValue(new Error('offline'));
    await deleteSelectedImages(['a']);
    expect(get(imageDeletion).removed).toEqual(['a']);
    expect(get(notify).some((card) => card.message === '1 of 1 deleted')).toBe(
      true,
    );
    expect(get(notify)[0].message).toContain('could not refresh');
    reconcileDeletedImages(['a']);
    expect(get(imageDeletion).removed).toEqual(['a']);
    reconcileDeletedImages([]);
    expect(get(imageDeletion).removed).toEqual([]);
  });
});
