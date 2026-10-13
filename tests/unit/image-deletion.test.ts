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

  it('does not expose cancellation once the only deletion batch has been sent', async () => {
    setDeletionOwner('single-cannot-abort');
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
    vi.mocked(dashboard.refresh).mockResolvedValue(undefined);
    const done = deleteSelectedImages(['a']);
    const notice = get(notify)[0];
    expect(notice.onCancel).toBeUndefined();
    notify.requestCancel(notice.id);
    expect(get(notify.confirmation)).toBeNull();
    release(
      Response.json({ deletedIds: ['a'], alreadyRemovedIds: [], failed: [] }),
    );
    await done;
    expect(get(notify)[0].kind).toBe('success');
  });

  it('reports confirmed counts between batches without a percentage or premature completion', async () => {
    setDeletionOwner('batch-progress');
    const ids = Array.from({ length: 101 }, (_, index) => `image-${index}`);
    let release!: (value: Response) => void;
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json({
            deletedIds: ids.slice(0, 100),
            alreadyRemovedIds: [],
            failed: [],
          }),
        )
        .mockImplementationOnce(
          () =>
            // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
            new Promise<Response>((resolve) => {
              release = resolve;
            }),
        ),
    );
    vi.mocked(dashboard.refresh).mockResolvedValue(undefined);
    const done = deleteSelectedImages(ids);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
    expect(get(notify)[0]).toMatchObject({
      kind: 'loading',
      progress: undefined,
    });
    expect(get(notify)[0].items?.[100]).toMatchObject({
      name: 'image-100',
      state: 'active',
    });
    release(
      Response.json({
        deletedIds: [ids[100]],
        alreadyRemovedIds: [],
        failed: [],
      }),
    );
    await done;
    expect(get(notify)[0]).toMatchObject({
      kind: 'success',
      progress: undefined,
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

  it('deletes selections larger than one request in batches', async () => {
    setDeletionOwner('all-pages');
    const ids = Array.from({ length: 101 }, (_, index) => `image-${index}`);
    const batches: string[][] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn((_url: string, init: RequestInit) => {
        const input = JSON.parse(init.body as string) as { ids: string[] };
        const batch = input.ids;
        batches.push(batch);
        return Promise.resolve(
          Response.json({
            deletedIds: batch,
            alreadyRemovedIds: [],
            failed: [],
          }),
        );
      }),
    );
    vi.mocked(dashboard.refresh).mockResolvedValue(undefined);
    await deleteSelectedImages(ids);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(batches).toEqual([ids.slice(0, 100), ids.slice(100)]);
    expect(get(notify)[0].kind).toBe('success');
    expect(get(notify)[0].progress).toBeUndefined();
    expect(
      get(notify)[0].items?.every((item) => item.state === 'completed'),
    ).toBe(true);
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
  it('reports authorization failure without removing images', async () => {
    setDeletionOwner('unauthorized');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          Response.json(
            { error: { message: 'Please sign in to continue.' } },
            { status: 401 },
          ),
        ),
      ),
    );
    vi.mocked(dashboard.refresh).mockResolvedValue(undefined);
    await deleteSelectedImages(['a']);
    expect(get(imageDeletion)).toEqual({ pending: [], removed: [] });
    expect(get(notify)[0].guidance).toBe('Please sign in to continue.');
    expect(get(notify)[0].kind).toBe('error');
  });
});
