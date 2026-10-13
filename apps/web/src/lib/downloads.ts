import type { DownloadImage, DownloadManifest } from '@hearth/core/images';
import { archiveFilenames } from '@hearth/core/serve';
import { writable } from 'svelte/store';

import { action } from './client';
import type { NotificationItem } from './notifications';
import {
  createSpeedMeter,
  notificationBytes as bytes,
  notify,
} from './notifications';

export const zipMemoryLimit = 64 * 1024 * 1024;
export const downloads = writable({
  active: false,
  individual: [] as DownloadImage[],
});
const operation = {
  controller: undefined as AbortController | undefined,
  owner: undefined as string | null | undefined,
  generation: 0,
};

export function setDownloadOwner(value: string | null) {
  if (operation.owner === value) return;
  operation.owner = value;
  operation.generation++;
  operation.controller?.abort();
  operation.controller = undefined;
  downloads.set({ active: false, individual: [] });
}

function saveUrl(url: string, name: string) {
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
}

export function memoryZipWriter(limit = zipMemoryLimit) {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  let size = 0;
  return {
    stream: new WritableStream<Uint8Array>({
      write(chunk) {
        size += chunk.byteLength;
        if (size > limit)
          throw new Error(
            'This ZIP exceeds the memory limit. Download the images individually or use a browser that supports saving directly to disk.',
          );
        chunks.push(new Uint8Array(chunk));
      },
      abort() {
        chunks.length = 0;
      },
    }),
    blob: () => new Blob(chunks, { type: 'application/zip' }),
  };
}

export interface ZipProgress {
  completed: number;
  transferred: number;
  item: NotificationItem;
}

export async function writeImageZip(
  manifest: DownloadManifest,
  destination: WritableStream<Uint8Array>,
  signal: AbortSignal,
  progress: (snapshot: ZipProgress) => void,
  onFinalize?: () => void,
) {
  const { ZipWriter } = await import('@zip.js/zip.js/lib/zip-core-writer.js');
  let outputError: Error | undefined;
  const sink = destination.getWriter();
  const stream = new WritableStream<Uint8Array>({
    async write(chunk) {
      try {
        signal.throwIfAborted();
        await sink.write(chunk);
      } catch (error) {
        outputError =
          error instanceof Error
            ? error
            : new Error('Could not write the ZIP.');
        throw outputError;
      }
    },
  });
  const zip = new ZipWriter(stream, {
    level: 0,
    bufferedWrite: false,
    useWebWorkers: false,
    keepOrder: true,
  });
  const names = archiveFilenames(
    manifest.images.map((image) => image.filename),
  );
  const failed = manifest.failed.map(
    (failure) => `${failure.filename ?? failure.id}: ${failure.message}`,
  );
  let completed = 0;
  let transferred = 0;
  try {
    for (const [index, image] of manifest.images.entries()) {
      signal.throwIfAborted();
      let imageBytes = 0;
      function report(
        state: 'active' | 'saving' | 'completed' | 'failed',
        error?: string,
      ) {
        progress({
          completed,
          transferred,
          item: {
            id: image.id,
            name: image.filename,
            state,
            status:
              state === 'completed'
                ? 'Downloaded'
                : state === 'failed'
                  ? 'Failed'
                  : state === 'saving'
                    ? 'Saving to ZIP'
                    : 'Downloading',
            metadata:
              state === 'completed'
                ? bytes(image.size)
                : `${bytes(imageBytes)} / ${bytes(image.size)}`,
            error,
          },
        });
      }
      report('active');
      try {
        const response = await fetch(image.url, { signal, cache: 'no-store' });
        if (!response.ok || !response.body) {
          await response.body?.cancel();
          throw new Error(`Download failed (HTTP ${response.status}).`);
        }
        const source = response.body.pipeThrough(
          new TransformStream<Uint8Array, Uint8Array>({
            transform(chunk, target) {
              imageBytes += chunk.byteLength;
              transferred += chunk.byteLength;
              target.enqueue(chunk);
              report('active');
            },
            flush() {
              if (imageBytes !== image.size)
                throw new Error('The image download was incomplete.');
              report('saving');
            },
          }),
        );
        await zip.add(names[index], source, { signal });
        completed++;
        report('completed');
      } catch (error) {
        signal.throwIfAborted();
        if (outputError) throw outputError;
        zip.remove(names[index]);
        report(
          'failed',
          error instanceof Error ? error.message : 'Download failed.',
        );
        failed.push(
          `${image.filename}: ${error instanceof Error ? error.message : 'Download failed.'}`,
        );
      }
    }
    if (!completed)
      throw new Error(`No images could be downloaded. ${failed.join(' ')}`);
    if (failed.length > 0) {
      const bytes = new TextEncoder().encode(failed.join('\n'));
      await zip.add(
        'download-errors.txt',
        new ReadableStream<Uint8Array>({
          start(target) {
            target.enqueue(bytes);
            target.close();
          },
        }),
        { signal },
      );
    }
    signal.throwIfAborted();
    await zip.close();
    signal.throwIfAborted();
    onFinalize?.();
    await sink.close();
    return { completed, failed };
  } catch (error) {
    await Promise.allSettled([sink.abort(error)]);
    throw error;
  } finally {
    sink.releaseLock();
  }
}

interface SavePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName: string;
    types: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{ createWritable(): Promise<WritableStream<Uint8Array>> }>;
}

export async function downloadImages(ids: string[], individually = false) {
  if (operation.controller || ids.length === 0) return;
  const current = new AbortController();
  operation.controller = current;
  const generation = operation.generation;
  const notice = notify.live('Preparing downloads…', () => current.abort(), {
    cancellation: {
      title: 'Cancel download?',
      message:
        'The download is still in progress. Cancelling will stop preparation and transfers and discard any unfinished ZIP. Downloads already handed to your browser must be stopped in the browser’s downloads.',
      confirmLabel: 'Cancel Download',
      keepLabel: 'Keep Downloading',
    },
  });
  notice.update({
    message: `0 of ${ids.length} downloaded`,
    kind: 'loading',
    metadata: 'Preparing downloads…',
  });
  downloads.set({ active: true, individual: [] });
  let destination: WritableStream<Uint8Array> | undefined;
  let items: NotificationItem[] = [];
  let completedCount = 0;
  try {
    const picker = (globalThis as SavePickerWindow).showSaveFilePicker;
    const handle =
      picker && !individually && ids.length > 1
        ? await picker.call(globalThis, {
            suggestedName: 'hearth-images.zip',
            types: [
              {
                description: 'ZIP archive',
                accept: { 'application/zip': ['.zip'] },
              },
            ],
          })
        : undefined;
    current.signal.throwIfAborted();
    const manifest: DownloadManifest = { images: [], failed: [] };
    for (let offset = 0; offset < ids.length; offset += 100) {
      const batch = await action<DownloadManifest>(
        'image-download',
        { ids: ids.slice(offset, offset + 100) },
        current.signal,
      );
      manifest.images.push(...batch.images);
      manifest.failed.push(...batch.failed);
    }
    current.signal.throwIfAborted();
    const byId = new Map<string, NotificationItem>([
      ...manifest.images.map((image): [string, NotificationItem] => [
        image.id,
        {
          id: image.id,
          name: image.filename,
          state: 'pending',
          status: 'Pending',
          metadata: bytes(image.size),
        },
      ]),
      ...manifest.failed.map((failure): [string, NotificationItem] => [
        failure.id,
        {
          id: failure.id,
          name: failure.filename ?? failure.id,
          state: 'failed',
          status: 'Failed',
          error: failure.message,
        },
      ]),
    ]);
    items = Array.from(byId, ([, item]) => item);
    if (manifest.images.length === 0)
      throw new Error(
        manifest.failed.map((failure) => failure.message).join(' '),
      );
    if (individually || ids.length === 1) {
      for (const image of manifest.images) saveUrl(image.url, image.filename);
      notice.update({
        message: `${manifest.images.length} of ${ids.length} downloads started${manifest.failed.length > 0 ? ` · ${manifest.failed.length} failed` : ''}`,
        kind: manifest.failed.length > 0 ? 'error' : 'success',
        persistent: manifest.failed.length > 0,
        itemsLabel: 'Download files',
        items: items.map((item) =>
          item.state === 'failed'
            ? item
            : { ...item, state: 'started', status: 'Download started' },
        ),
      });
      return;
    }
    const estimated = manifest.images.reduce(
      (sum, image) =>
        sum +
        image.size +
        new TextEncoder().encode(image.filename).length * 2 +
        1024,
      4096,
    );
    if (!handle && estimated > zipMemoryLimit) {
      downloads.set({ active: false, individual: manifest.images });
      notice.update({
        message: `0 of ${ids.length} downloaded${manifest.failed.length > 0 ? ` · ${manifest.failed.length} unavailable` : ''}`,
        kind: 'error',
        guidance:
          'This selection is too large for an in-memory ZIP. Use Download individually below, or a browser that supports saving directly to disk.',
        items,
        itemsLabel: 'Download files',
      });
      return;
    }
    const memory = handle ? undefined : memoryZipWriter();
    destination = handle ? await handle.createWritable() : memory!.stream;
    current.signal.throwIfAborted();
    const total = manifest.images.reduce((sum, image) => sum + image.size, 0);
    let lastUpdate = 0;
    const meter = createSpeedMeter();
    meter(Date.now(), 0);
    const result = await writeImageZip(
      manifest,
      destination,
      current.signal,
      ({ completed, transferred, item }) => {
        const changed = byId.get(item.id)?.state !== item.state;
        byId.set(item.id, item);
        completedCount = completed;
        if (!changed && Date.now() - lastUpdate < 200) return;
        lastUpdate = Date.now();
        const percent =
          total > 0 ? Math.min(99, (transferred / total) * 100) : undefined;
        const speed = meter(lastUpdate, transferred);
        items = Array.from(byId, ([, item]) => item);
        notice.update({
          message: `${completed} of ${ids.length} downloaded${percent === undefined ? '' : ` · ${Math.floor(percent)}%`}`,
          progress: percent,
          kind: 'loading',
          metadata: `${bytes(transferred)} / ${bytes(total)}${speed === null ? '' : ` · ${bytes(speed)}/s`}`,
          items,
          itemsLabel: 'Download files',
        });
      },
      () => {
        notice.update({
          message: 'Saving ZIP…',
          kind: 'loading',
          cancellable: false,
          items,
          itemsLabel: 'Download files',
        });
      },
    );
    current.signal.throwIfAborted();
    if (memory) {
      const url = URL.createObjectURL(memory.blob());
      saveUrl(url, 'hearth-images.zip');
      setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    notice.update({
      message: `${result.completed} of ${ids.length} ${memory ? 'prepared for download' : 'downloaded'}${result.failed.length > 0 ? ` · ${result.failed.length} failed` : ''}`,
      kind: result.failed.length > 0 ? 'error' : 'success',
      persistent: result.failed.length > 0,
      guidance:
        result.failed.length > 0
          ? 'See download-errors.txt in the ZIP.'
          : undefined,
      items: Array.from(byId, ([, item]) => item),
      itemsLabel: 'Download files',
    });
  } catch (error) {
    await Promise.allSettled(destination ? [destination.abort(error)] : []);
    if (generation !== operation.generation) {
      notify.dismiss(notice.id);
      return;
    }
    if (
      current.signal.aborted ||
      (error instanceof DOMException && error.name === 'AbortError')
    ) {
      notice.update({
        message: 'Download cancelled.',
        kind: 'info',
        guidance: destination
          ? 'The unfinished ZIP was discarded. No archive was saved.'
          : 'No downloads were started.',
        items: items.map((item) =>
          item.state === 'failed'
            ? item
            : { ...item, state: 'cancelled', status: 'Cancelled' },
        ),
        itemsLabel: 'Download files',
        persistent: items.length > 0,
      });
    } else {
      const message =
        error instanceof Error
          ? error.message
          : 'Download failed. Please try again.';
      notice.update({
        message: `${completedCount} of ${ids.length} downloaded · failed`,
        kind: 'error',
        guidance: message,
        items: items.map((item) =>
          item.state === 'active' || item.state === 'saving'
            ? { ...item, state: 'failed', status: 'Failed', error: message }
            : item,
        ),
        itemsLabel: 'Download files',
      });
    }
  } finally {
    if (operation.controller === current) operation.controller = undefined;
    if (generation === operation.generation)
      downloads.update((state) => ({ ...state, active: false }));
  }
}
