import { writable } from 'svelte/store';

import type {
  createNotifications,
  NotificationItemState,
} from './notifications';
import {
  createSpeedMeter,
  notificationBytes as bytes,
  notify,
} from './notifications';
import { uploadImage, UploadRateLimit } from './upload';

// Two files reached the local throughput plateau with ~12 MiB of explicit Worker
// buffers and lower tail latency than 3/6/8. Keep per-file parts serial; see docs/development/architecture.md#uploads.
export const UPLOAD_CONCURRENCY = 2;
export type UploadStatus =
  'queued' | 'uploading' | 'processing' | 'completed' | 'failed' | 'cancelled';
export interface UploadItem {
  id: string;
  name: string;
  size: number;
  status: UploadStatus;
  loaded: number;
  total: number;
  measured: boolean;
  error?: string;
  warning?: string;
}
const itemStates: Record<UploadStatus, NotificationItemState> = {
  queued: 'pending',
  uploading: 'active',
  processing: 'saving',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
};
const itemStatuses: Record<UploadStatus, string> = {
  queued: 'Queued',
  uploading: 'Uploading',
  processing: 'Saving',
  completed: 'Uploaded',
  failed: 'Failed',
  cancelled: 'Cancelled',
};
export function summarize(items: UploadItem[]) {
  const counts = {
    completed: 0,
    unshared: 0,
    active: 0,
    queued: 0,
    failed: 0,
    cancelled: 0,
  };
  let transferred = 0,
    totalBytes = 0;
  for (const item of items) {
    if (item.status === 'uploading' || item.status === 'processing')
      counts.active++;
    else counts[item.status]++;
    if (item.warning) counts.unshared++;
    transferred += item.loaded;
    totalBytes += item.total;
  }
  return {
    ...counts,
    total: items.length,
    transferred,
    totalBytes,
    // 100% requires confirmed success; bytes may finish before the commit.
    percent:
      items.length > 0 && counts.completed === items.length
        ? 100
        : Math.min(99, totalBytes ? (transferred / totalBytes) * 100 : 0),
  };
}

export function createUploads(
  notifications: ReturnType<typeof createNotifications>,
  options: { concurrency?: number; transfer?: typeof uploadImage } = {},
) {
  const concurrency = options.concurrency ?? UPLOAD_CONCURRENCY;
  if (!Number.isSafeInteger(concurrency) || concurrency < 1 || concurrency > 8)
    throw new RangeError('Upload concurrency must be between 1 and 8.');
  const transfer = options.transfer ?? uploadImage;
  const uploading = writable(false);
  const state = writable({
    items: [] as UploadItem[],
    ...summarize([]),
    speed: null as number | null,
    eta: null as number | null,
    refreshError: false,
  });
  type Entry = {
    item: UploadItem;
    file?: File;
    controller?: AbortController;
    rateLimits?: number;
  };
  let entries: Entry[] = [];
  let queue: Entry[] = [];
  let head = 0;
  let running = 0;
  let notification: ReturnType<typeof notifications.live> | undefined;
  let refresh: (() => Promise<void>) | undefined;
  let dirty = false;
  let refreshing = false;
  let refreshError = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  let transferred = 0;
  let blockedUntil = 0;
  let meter = createSpeedMeter();
  let waiters: (() => void)[] = [];
  let generation = 0;
  let owner: string | undefined;
  let identities = new WeakMap<File, Entry>();

  function publish() {
    const items = entries.map(({ item }) => ({ ...item }));
    const summary = summarize(items);
    const active = summary.active + summary.queued > 0;
    const speed = active ? meter(Date.now(), transferred) : null;
    const remaining = items
      .filter((item) => ['queued', 'uploading'].includes(item.status))
      .reduce((sum, item) => sum + Math.max(0, item.total - item.loaded), 0);
    const eta = speed && remaining > 0 ? remaining / speed : null;
    state.set({ items, ...summary, speed, eta, refreshError });
    uploading.set(active);
    const message = `${summary.completed} of ${summary.total} uploaded${active ? ` · ${Math.floor(summary.percent)}%` : ''}${summary.failed ? ` · ${summary.failed} failed` : ''}${summary.cancelled ? ` · ${summary.cancelled} cancelled` : ''}`;
    notification?.update({
      message,
      progress: summary.percent,
      kind: active
        ? 'loading'
        : summary.failed || summary.cancelled
          ? 'error'
          : summary.unshared
            ? 'warning'
            : 'success',
      persistent: summary.failed + summary.cancelled + summary.unshared > 0,
      guidance: refreshError
        ? 'Refresh the page to see saved images.'
        : undefined,
      metadata: `${bytes(summary.transferred)} / ${items.some((item) => !item.measured) ? 'about ' : ''}${bytes(summary.totalBytes)}${speed === null ? '' : ` · ${bytes(speed)}/s`}`,
      itemsLabel: 'Upload files',
      items: items.map((item) => ({
        id: item.id,
        name: item.name,
        state: itemStates[item.status],
        status: item.warning
          ? 'Saved without a share link'
          : itemStatuses[item.status],
        metadata:
          item.measured &&
          (item.status === 'uploading' || item.status === 'processing')
            ? `${bytes(item.loaded)} / ${bytes(item.total)}`
            : bytes(item.size),
        error: item.error,
        warning: item.warning,
        action:
          item.status === 'failed' || item.status === 'cancelled'
            ? {
                kind: 'retry',
                label: `Retry ${item.name}`,
                run: () => retry(item.id),
              }
            : item.status === 'completed'
              ? undefined
              : {
                  kind: 'cancel',
                  label: `Cancel ${item.name}`,
                  run: () => cancel(item.id),
                },
      })),
    });
  }

  function clear() {
    if (
      running ||
      queue.slice(head).some(({ item }) => item.status === 'queued')
    )
      return;
    entries = [];
    identities = new WeakMap<File, Entry>();
    queue = [];
    head = 0;
    notification = undefined;
    transferred = 0;
    meter = createSpeedMeter();
    publish();
  }

  function ensureNotification() {
    notification ??= notifications.live('Preparing uploads…', cancelRemaining, {
      cancellation: {
        title: 'Cancel upload?',
        message:
          'The upload is still in progress. Cancelling will stop the current upload and any queued files. Images already saved will be kept.',
        confirmLabel: 'Cancel Upload',
        keepLabel: 'Keep Uploading',
      },
      onDismiss: clear,
    });
    if (timer) {
      return;
    }

    meter = createSpeedMeter();
    meter(Date.now(), transferred);
    timer = setInterval(() => {
      if (blockedUntil && Date.now() >= blockedUntil) {
        blockedUntil = 0;
        pump();
      } else publish();
    }, 200);
  }

  async function settle() {
    if (running || refreshing || head < queue.length) return;
    if (dirty && refresh) {
      const currentGeneration = generation;
      dirty = false;
      refreshing = true;
      try {
        await refresh();
        if (currentGeneration === generation) refreshError = false;
      } catch {
        if (currentGeneration === generation) refreshError = true;
      } finally {
        refreshing = false;
      }
      // Files can be added while a dashboard read is pending.
      if (running || head < queue.length) return;
      if (dirty) {
        await settle();
        return;
      }
    }
    clearInterval(timer);
    timer = undefined;
    queue = [];
    head = 0;
    publish();
    const done = waiters;
    waiters = [];
    for (const resolve of done) resolve();
  }

  async function run(entry: Entry) {
    const currentGeneration = generation;
    const { item } = entry;
    const controller = new AbortController();
    entry.controller = controller;
    item.status = 'uploading';
    item.error = undefined;
    running++;
    try {
      const result = await transfer(
        entry.file!,
        item.id,
        controller.signal,
        (value) => {
          if (controller.signal.aborted) return;
          transferred += Math.max(0, value.loaded - item.loaded);
          item.loaded = value.loaded;
          item.total = value.total;
          item.measured = true;
          item.status =
            value.loaded === value.total ? 'processing' : 'uploading';
        },
      );
      // A confirmed success wins a cancellation race.
      item.status = 'completed';
      item.warning = result.sharingWarning ?? undefined;
      entry.file = undefined;
      if (currentGeneration === generation) dirty = true;
    } catch (error) {
      if (
        currentGeneration === generation &&
        error instanceof UploadRateLimit &&
        !controller.signal.aborted &&
        (entry.rateLimits ?? 0) < 3
      ) {
        entry.rateLimits = (entry.rateLimits ?? 0) + 1;
        blockedUntil = Date.now() + 60_000;
        item.status = 'queued';
        item.loaded = 0;
        item.total = entry.file!.size;
        item.measured = false;
        queue.push(entry);
      } else item.status = controller.signal.aborted ? 'cancelled' : 'failed';
      item.error = error instanceof Error ? error.message : 'Upload failed.';
      // An aborted/lost response may have committed. Refresh without confirmation too.
      if (currentGeneration === generation) dirty = true;
    } finally {
      entry.controller = undefined;
      running--;
      pump();
    }
  }

  function pump() {
    while (running < concurrency && head < queue.length) {
      const entry = queue[head];
      if (entry.item.status === 'queued' && Date.now() < blockedUntil) break;
      head++;
      if (entry.item.status === 'queued') void run(entry);
    }
    void settle();
    publish();
  }

  function start(files: File[], update: () => Promise<void>) {
    if (files.length === 0) return Promise.resolve();
    refresh = update;
    for (const file of files) {
      // Repeated delivery of the same selection never creates another operation.
      if (identities.has(file)) continue;
      const entry: Entry = {
        file,
        item: {
          id: Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
            byte.toString(16).padStart(2, '0'),
          ).join(''),
          name: file.name,
          size: file.size,
          status: 'queued',
          loaded: 0,
          total: file.size,
          measured: false,
        },
      };
      identities.set(file, entry);
      entries.push(entry);
      queue.push(entry);
    }
    ensureNotification();
    const done = new Promise<void>((resolve) => {
      waiters.push(resolve);
    });
    pump();
    return done;
  }

  function cancel(id: string) {
    const entry = entries.find(({ item }) => item.id === id);
    if (!entry) return;
    if (entry.controller) entry.controller.abort();
    else if (entry.item.status === 'queued') {
      entry.item.status = 'cancelled';
      entry.item.error = 'Cancelled before transfer.';
    }
    pump();
  }
  function cancelRemaining() {
    // Mark queued files before abort callbacks can release capacity.
    for (const entry of entries)
      if (entry.item.status === 'queued') {
        entry.item.status = 'cancelled';
        entry.item.error = 'Cancelled before transfer.';
      }
    for (const entry of entries) entry.controller?.abort();
    pump();
  }
  function retry(id: string) {
    const entry = entries.find(({ item }) => item.id === id);
    if (
      !entry?.file ||
      entry.controller ||
      !['failed', 'cancelled'].includes(entry.item.status)
    )
      return;
    Object.assign(entry.item, {
      status: 'queued',
      loaded: 0,
      total: entry.file.size,
      measured: false,
      error: undefined,
    });
    entry.rateLimits = 0;
    queue.push(entry);
    ensureNotification();
    pump();
  }
  function setOwner(userId: string | undefined) {
    if (owner === userId) return;
    owner = userId;
    generation++;
    // A sign-out/account change must never send retained files as another user.
    for (const entry of entries) entry.controller?.abort();
    entries = [];
    queue = [];
    head = 0;
    identities = new WeakMap<File, Entry>();
    dirty = false;
    refresh = undefined;
    refreshError = false;
    blockedUntil = 0;
    transferred = 0;
    meter = createSpeedMeter();
    clearInterval(timer);
    timer = undefined;
    if (notification) notifications.dismiss(notification.id);
    notification = undefined;
    for (const resolve of waiters) resolve();
    waiters = [];
    publish();
  }
  return {
    subscribe: uploading.subscribe,
    state,
    start,
    cancel,
    cancelRemaining,
    retry,
    setOwner,
  };
}

export const uploads = createUploads(notify);
