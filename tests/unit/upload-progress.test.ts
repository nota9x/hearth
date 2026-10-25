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
  setRequestHeader = vi.fn<(name: string, value: string) => void>();
  send = vi.fn<(body: FormData) => void>();
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
const tick = () => vi.advanceTimersByTimeAsync(0);
const requests = () => UploadRequest.requests;
const keysFor = (filename: string) =>
  requests()
    .filter(
      (request) =>
        (request.send.mock.calls[0][0].get('file') as File).name === filename,
    )
    .map(
      (request) =>
        request.setRequestHeader.mock.calls.find(
          ([name]) => name === 'Idempotency-Key',
        )?.[1],
    );
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
  UploadRequest.requests = [];
});

describe('global upload queue', () => {
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
  it('continues after failures and retries with the same key without resending successes', async () => {
    const { uploads, notifications, snapshot, refresh } = setup(2);
    const done = uploads.start(files(3), refresh);
    const originalKey = keysFor('0.png')[0];
    const secondKey = keysFor('1.png')[0];
    expect(originalKey).toMatch(/^[a-f0-9]{64}$/);
    expect(secondKey).not.toBe(originalKey);
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
    expect(keysFor('0.png')).toEqual([originalKey, originalKey]);
    requests()[3].finish();
    await tick();
    expect(keysFor('1.png')).toEqual([secondKey]);
    expect(snapshot()).toMatchObject({ completed: 3, failed: 0 });
    expect(get(notifications)[0].kind).toBe('success');
    expect(refresh).toHaveBeenCalledTimes(2);
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
  it('does not lose uploads added during refresh and performs one trailing refresh', async () => {
    const { uploads, refresh, snapshot } = setup();
    const { promise, resolve: release } = Promise.withResolvers<void>();
    refresh.mockReturnValueOnce(promise);
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
  it('backs off the shared queue on 429 and retries the same operation', async () => {
    const { uploads, snapshot, refresh } = setup(1);
    const done = uploads.start(files(2), refresh);
    const originalKey = keysFor('0.png')[0];
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
    expect(keysFor('0.png')).toEqual([originalKey, originalKey]);
  });
});

describe('transport cleanup', () => {
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
});
