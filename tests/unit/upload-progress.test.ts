import { afterEach, describe, expect, it, vi } from 'vitest';

import { createNotifications } from '../../apps/web/src/lib/notifications';
import { uploadImage } from '../../apps/web/src/lib/upload';
import { createUploads } from '../../apps/web/src/lib/uploads';

function get<T>(store: {
  subscribe: (callback: (value: T) => void) => () => void;
}): T {
  let result!: T;
  store.subscribe((value) => {
    result = value;
  })();
  return result;
}

class UploadRequest extends EventTarget {
  static requests: UploadRequest[] = [];
  upload = new EventTarget();
  status = 201;
  responseText = JSON.stringify({
    id: 'img_test',
    url: 'https://images.example.com/hello',
    sharingWarning: null,
  });
  open = vi.fn();
  setRequestHeader = vi.fn();
  send = vi.fn();
  abort = vi.fn(() => this.dispatchEvent(new Event('abort')));
  constructor() {
    super();
    UploadRequest.requests.push(this);
  }
  progress(loaded: number, total: number) {
    this.upload.dispatchEvent(
      Object.assign(new Event('progress'), {
        lengthComputable: true,
        loaded,
        total,
      }),
    );
  }
  finish(status = 201) {
    this.status = status;
    this.dispatchEvent(new Event('load'));
  }
}
const tick = async () => {
  for (let index = 0; index < 10; index++) await Promise.resolve();
};
const requests = () => UploadRequest.requests;
function files(count: number) {
  return Array.from(
    { length: count },
    (_, index) => new File(['abcd'], `${index}.png`),
  );
}
function setup(concurrency = 3) {
  vi.useFakeTimers();
  vi.stubGlobal('XMLHttpRequest', UploadRequest);
  const notifications = createNotifications();
  const uploads = createUploads(notifications, { concurrency });
  const refresh = vi.fn().mockResolvedValue(undefined);
  return {
    uploads,
    notifications,
    refresh,
    snapshot: () => get(uploads.state),
  };
}
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  UploadRequest.requests = [];
});

describe('global upload queue', () => {
  it('keeps a large batch lazy and cancels it without opening queued requests', async () => {
    const { uploads, snapshot, refresh } = setup();
    const selected = files(2000);
    const read = vi.spyOn(selected[1999], 'arrayBuffer');
    const done = uploads.start(selected, refresh);
    expect(requests()).toHaveLength(3);
    expect(snapshot()).toMatchObject({ total: 2000, active: 3, queued: 1997 });
    expect(read).not.toHaveBeenCalled();
    uploads.cancelRemaining();
    await done;
    expect(requests()).toHaveLength(3);
    expect(snapshot()).toMatchObject({ cancelled: 2000, active: 0, queued: 0 });
  });
  it('isolates account changes from old completions and retained files', async () => {
    const { uploads, snapshot, refresh } = setup(1);
    uploads.setOwner('alice');
    const old = uploads.start(files(3), refresh);
    uploads.setOwner('bob');
    const next = uploads.start(files(1), refresh);
    await tick();
    expect(requests()).toHaveLength(2);
    expect(requests()[0].abort).toHaveBeenCalledOnce();
    expect(snapshot()).toMatchObject({ total: 1, active: 1, queued: 0 });
    requests()[1].finish();
    await Promise.all([old, next]);
    expect(snapshot()).toMatchObject({ total: 1, completed: 1, cancelled: 0 });
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('bounds concurrency, advances several transfers, drains the queue and refreshes once', async () => {
    const { uploads, snapshot, refresh } = setup();
    const done = uploads.start(files(5), refresh);
    expect(requests()).toHaveLength(3);
    requests()[0].progress(2, 4);
    requests()[1].progress(1, 4);
    await vi.advanceTimersByTimeAsync(200);
    expect(snapshot()).toMatchObject({
      active: 3,
      queued: 2,
      completed: 0,
      transferred: 3,
      totalBytes: 20,
      percent: 15,
    });
    requests()[1].finish();
    await tick();
    expect(requests()).toHaveLength(4);
    expect(snapshot()).toMatchObject({ active: 3, queued: 1, completed: 1 });
    requests()[0].finish();
    await tick();
    expect(requests()).toHaveLength(5);
    for (const request of requests().slice(2)) request.finish();
    await done;
    expect(snapshot()).toMatchObject({
      active: 0,
      queued: 0,
      completed: 5,
      failed: 0,
      percent: 100,
    });
    expect(refresh).toHaveBeenCalledOnce();
    expect(get(uploads)).toBe(false);
  });
  it('keeps processing distinct from transfer completion without fabricated bytes', async () => {
    const { uploads, notifications, snapshot, refresh } = setup();
    const done = uploads.start(files(1), refresh);
    requests()[0].progress(100, 100);
    await vi.advanceTimersByTimeAsync(200);
    expect(snapshot()).toMatchObject({
      transferred: 100,
      totalBytes: 100,
      percent: 99,
      completed: 0,
    });
    expect(snapshot().items[0].status).toBe('processing');
    expect(get(notifications)[0]).toMatchObject({
      progress: 99,
    });
    expect(get(notifications)[0].items?.[0]).toMatchObject({
      name: '0.png',
      state: 'saving',
      action: { kind: 'cancel' },
    });
    requests()[0].finish();
    await done;
    expect(snapshot().percent).toBe(100);
    expect(get(notifications)[0]).toMatchObject({
      kind: 'success',
      progress: undefined,
    });
    expect(get(notifications)[0].items?.[0].action).toBeUndefined();
  });
  it('completes private saves with a persistent warning and never resends them', async () => {
    const { uploads, notifications, snapshot, refresh } = setup(1);
    const done = uploads.start(files(1), refresh);
    requests()[0].responseText = JSON.stringify({
      id: 'img_saved',
      url: null,
      sharingWarning: 'No instance default is configured.',
    });
    requests()[0].finish();
    await done;
    expect(snapshot()).toMatchObject({ completed: 1, failed: 0, unshared: 1 });
    expect(get(notifications)[0]).toMatchObject({
      kind: 'warning',
      items: [
        {
          status: 'Saved without a share link',
          warning: 'No instance default is configured.',
        },
      ],
    });
    expect(get(notifications)[0].items?.[0].action).toBeUndefined();
    uploads.retry(snapshot().items[0].id);
    await tick();
    expect(requests()).toHaveLength(1);
  });
  it('continues after failures and retries with the same key without resending successes', async () => {
    const { uploads, notifications, snapshot, refresh } = setup(2);
    const done = uploads.start(files(3), refresh);
    requests()[0].responseText = JSON.stringify({
      error: { message: 'Unsupported file.' },
    });
    requests()[0].finish(400);
    await tick();
    requests()[1].finish();
    requests()[2].finish();
    await done;
    expect(snapshot()).toMatchObject({ completed: 2, failed: 1, active: 0 });
    expect(snapshot().items[0].error).toBe('Unsupported file.');
    expect(get(notifications)[0].kind).toBe('error');
    const id = snapshot().items[0].id;
    uploads.retry(id);
    uploads.retry(id);
    expect(requests()).toHaveLength(4);
    expect(requests()[3].setRequestHeader).toHaveBeenCalledWith(
      'Idempotency-Key',
      id,
    );
    requests()[3].finish();
    await tick();
    expect(snapshot()).toMatchObject({ completed: 3, failed: 0 });
    expect(get(notifications)[0].kind).toBe('success');
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('cancels queued and active files and never starts cancelled work', async () => {
    const { uploads, snapshot, refresh } = setup(1);
    const done = uploads.start(files(3), refresh);
    uploads.cancel(snapshot().items[1].id);
    uploads.cancel(snapshot().items[0].id);
    await tick();
    expect(requests()[0].abort).toHaveBeenCalledOnce();
    expect(requests()).toHaveLength(2);
    requests()[1].finish();
    await done;
    expect(snapshot()).toMatchObject({ cancelled: 2, completed: 1, queued: 0 });
    expect(refresh).toHaveBeenCalledOnce();
    uploads.retry(snapshot().items[0].id);
    expect(requests()[2].setRequestHeader).toHaveBeenCalledWith(
      'Idempotency-Key',
      snapshot().items[0].id,
    );
    requests()[2].finish();
    await tick();
  });
  it('cancels the entire queue through the real notification and preserves partial results', async () => {
    const { uploads, notifications, snapshot, refresh } = setup(2);
    const done = uploads.start(files(5), refresh);
    requests()[0].finish();
    await tick();
    notifications.requestCancel(get(notifications)[0].id);
    expect(requests()[1].abort).not.toHaveBeenCalled();
    notifications.confirmCancel();
    await done;
    expect(requests()).toHaveLength(3);
    expect(snapshot()).toMatchObject({ completed: 1, cancelled: 4, active: 0 });
    expect(get(notifications)[0]).toMatchObject({
      kind: 'error',
      persistent: true,
      onCancel: undefined,
    });
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('closes confirmation and permits normal dismissal after transfer, even while refresh is pending', async () => {
    const { uploads, notifications, refresh } = setup();
    let refreshed!: () => void;
    refresh.mockImplementationOnce(
      () =>
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        new Promise<void>((resolve) => {
          refreshed = resolve;
        }),
    );
    const done = uploads.start(files(1), refresh);
    const notice = get(notifications)[0];
    notifications.requestCancel(notice.id);
    requests()[0].finish();
    await tick();
    expect(get(notifications.confirmation)).toBeNull();
    expect(get(notifications)[0]).toMatchObject({
      kind: 'success',
      onCancel: undefined,
    });
    notifications.confirmCancel();
    expect(requests()[0].abort).not.toHaveBeenCalled();
    notifications.dismiss(notice.id);
    expect(get(notifications)).toEqual([]);
    refreshed();
    await done;
  });
  it('survives navigation subscriptions, integrates another batch and deduplicates a selection', async () => {
    const { uploads, snapshot, refresh } = setup(2);
    const selected = files(2);
    const unsubscribe = uploads.subscribe(() => {});
    const first = uploads.start(selected, refresh);
    unsubscribe();
    const duplicate = uploads.start(selected, refresh);
    const second = uploads.start(files(2), refresh);
    expect(requests()).toHaveLength(2);
    expect(snapshot()).toMatchObject({ total: 4, active: 2, queued: 2 });
    requests()[0].finish();
    requests()[1].finish();
    await tick();
    requests()[2].finish();
    requests()[3].finish();
    await Promise.all([first, duplicate, second]);
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('does not lose uploads added during refresh and performs one trailing refresh', async () => {
    const { uploads, refresh, snapshot } = setup();
    let release!: () => void;
    refresh.mockImplementationOnce(
      () =>
        // ES2022 does not include Promise.withResolvers.
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const first = uploads.start(files(1), refresh);
    requests()[0].finish();
    await tick();
    const second = uploads.start(files(1), refresh);
    requests()[1].finish();
    await tick();
    release();
    await Promise.all([first, second]);
    expect(snapshot().completed).toBe(2);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it('keeps confirmed success when dashboard refresh fails and releases state on dismissal', async () => {
    const { uploads, notifications, snapshot, refresh } = setup();
    refresh.mockRejectedValue(new Error('Navigation interrupted refresh'));
    const done = uploads.start(files(1), refresh);
    requests()[0].finish();
    await done;
    expect(get(notifications)[0]).toMatchObject({
      kind: 'success',
    });
    expect(get(notifications)[0].guidance).toContain('Refresh the page');
    expect(snapshot().completed).toBe(1);
    notifications.dismiss(get(notifications)[0].id);
    expect(snapshot().total).toBe(0);
    const next = uploads.start(files(1), refresh);
    requests()[1].finish();
    await next;
    expect(get(notifications)[0].guidance).toContain('Refresh the page');
    expect(snapshot().completed).toBe(1);
  });
  it('backs off the shared queue on 429 and retries the same operation', async () => {
    const { uploads, snapshot, refresh } = setup(1);
    const done = uploads.start(files(2), refresh);
    requests()[0].finish(429);
    await tick();
    expect(snapshot().queued).toBe(2);
    await vi.advanceTimersByTimeAsync(59_000);
    expect(requests()).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(requests()).toHaveLength(2);
    requests()[1].finish();
    await tick();
    requests()[2].finish();
    await done;
    expect(snapshot().completed).toBe(2);
    expect(requests()[2].setRequestHeader).toHaveBeenCalledWith(
      'Idempotency-Key',
      snapshot().items[0].id,
    );
  });
});

describe('transport cleanup', () => {
  it.each([
    ['QUOTA_EXCEEDED', 'Not enough storage in your quota'],
    ['GLOBAL_STORAGE_LIMIT_EXCEEDED', 'Not enough instance storage'],
  ])(
    'preserves %s and presents actionable quota feedback',
    async (code, message) => {
      const { uploads, notifications, refresh } = setup();
      const result = uploadImage(
        files(1)[0],
        crypto.randomUUID(),
        new AbortController().signal,
        vi.fn(),
      );
      requests()[0].responseText = JSON.stringify({
        error: { code, message: 'Limit exceeded.' },
      });
      requests()[0].finish(413);
      await expect(result).rejects.toMatchObject({
        code,
        status: 413,
      });
      await expect(result).rejects.toThrow(message);
      const done = uploads.start(files(1), refresh);
      requests()[1].responseText = requests()[0].responseText;
      requests()[1].finish(413);
      await done;
      expect(get(notifications)[0]).toMatchObject({
        kind: 'error',
        persistent: true,
      });
      expect(get(notifications)[0].items?.[0].error).toContain(message);
      expect(refresh).toHaveBeenCalledOnce();
    },
  );
  it('allows slow progress and times out inactivity with safe retry feedback', async () => {
    setup();
    const result = uploadImage(
      files(1)[0],
      crypto.randomUUID(),
      new AbortController().signal,
      vi.fn(),
    );
    // eslint-disable-next-line vitest/valid-expect
    const rejected = expect(result).rejects.toThrow('stalled for two minutes');
    for (let index = 1; index <= 4; index++) {
      await vi.advanceTimersByTimeAsync(60_000);
      requests()[0].progress(index, 10);
    }
    expect(requests()[0].abort).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(120_000);
    await rejected;
    expect(requests()[0].abort).toHaveBeenCalledOnce();
  });
  it.each(['error', 'timeout', 'load'])(
    'removes the abort listener after %s failure',
    async (event) => {
      setup();
      const controller = new AbortController();
      const result = uploadImage(
        files(1)[0],
        crypto.randomUUID(),
        controller.signal,
        vi.fn(),
      );
      requests()[0].status = 400;
      requests()[0].dispatchEvent(new Event(event));
      await expect(result).rejects.toThrow();
      requests()[0].progress(1, 2);
      await vi.advanceTimersByTimeAsync(120_000);
      controller.abort();
      expect(requests()[0].abort).not.toHaveBeenCalled();
    },
  );
  it('does not send an already cancelled request', async () => {
    setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadImage(files(1)[0], crypto.randomUUID(), controller.signal, vi.fn()),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests()).toHaveLength(0);
  });
});
