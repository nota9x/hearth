import { readFile } from 'node:fs/promises';

import {
  BlobReader,
  TextWriter,
  Uint8ArrayWriter,
  ZipReader,
} from '@zip.js/zip.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ZipProgress } from '../../apps/web/src/lib/downloads';
import {
  downloadImages,
  downloads,
  memoryZipWriter,
  setDownloadOwner,
  writeImageZip,
  zipMemoryLimit,
} from '../../apps/web/src/lib/downloads';
import { notify } from '../../apps/web/src/lib/notifications';
import { dateTime, relativeExpiry } from '../../packages/core/common';
import type { DownloadManifest } from '../../packages/core/images';
import { archiveFilenames, downloadFilename } from '../../packages/core/serve';

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

async function entries(blob: Blob) {
  const zip = new ZipReader(new BlobReader(blob), { useWebWorkers: false });
  const result = await zip.getEntries();
  return { zip, result: result.filter((entry) => !entry.directory) };
}

const manifestFor = (names: string[], size = 3): DownloadManifest => ({
  images: names.map((filename, index) => ({
    id: `image-${index}`,
    filename,
    mime: 'image/png',
    size,
    url: `/api/media/image-${index}?download`,
  })),
  failed: [],
});

describe('download names and expiry', () => {
  it('preserves spaces, Unicode and emoji while removing unsafe names', () => {
    expect(downloadFilename(String.raw`folder\..\summer café 🐈.png`)).toBe(
      'summer café 🐈.png',
    );
    expect(downloadFilename('a\r\n?b.png')).toBe('a_b.png');
    expect(downloadFilename('CON.png')).toBe('_CON.png');
    expect(downloadFilename('..')).toBe('image');
    expect(downloadFilename('odd\u{D800}.png')).toBe('odd_.png');
    expect(
      archiveFilenames([
        'a.png',
        'a.png',
        'A.png',
        'a (2).png',
        'download-errors.txt',
      ]),
    ).toEqual([
      'a.png',
      'a (2).png',
      'A (3).png',
      'a (2) (2).png',
      'download-errors (2).txt',
    ]);
  });
  it('formats absolute expiry and meaningful relative states', () => {
    const timestamp = 1_000_000;
    expect(dateTime(null)).toBe('Never');
    expect(dateTime(timestamp)).toBe(
      new Intl.DateTimeFormat('en', {
        dateStyle: 'medium',
        timeStyle: 'short',
      }).format(timestamp * 1000),
    );
    expect(relativeExpiry(null, timestamp)).toBe('');
    expect(relativeExpiry(timestamp - 1, timestamp)).toBe('Expired');
    expect(relativeExpiry(timestamp, timestamp)).toBe('Expired');
    expect(relativeExpiry(timestamp + 59, timestamp)).toBe('Expires soon');
    expect(relativeExpiry(timestamp + 42 * 60, timestamp)).toBe(
      'Expires in 42 minutes',
    );
    expect(relativeExpiry(timestamp + 6 * 3600, timestamp)).toBe(
      'Expires in 6 hours',
    );
    expect(relativeExpiry(timestamp + 2 * 86_400, timestamp)).toBe(
      'Expires in 2 days',
    );
  });
});

describe('client ZIP streaming', () => {
  it('reports explicit item transitions by ID, including repeated filenames and failures', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('abc'))
        .mockResolvedValueOnce(new Response('Denied', { status: 403 })),
    );
    const progress = vi.fn<(snapshot: ZipProgress) => void>();
    await writeImageZip(
      manifestFor(['same.png', 'same.png']),
      memoryZipWriter().stream,
      new AbortController().signal,
      progress,
    );
    const snapshots = progress.mock.calls.map(([snapshot]) => snapshot);
    expect(
      snapshots
        .filter((snapshot) => snapshot.item.id === 'image-0')
        .map((snapshot) => snapshot.item.state),
    ).toEqual(['active', 'active', 'saving', 'completed']);
    expect(snapshots.at(-1)).toMatchObject({
      completed: 1,
      transferred: 3,
      item: {
        id: 'image-1',
        state: 'failed',
        error: 'Download failed (HTTP 403).',
      },
    });
  });

  it.each(['png', 'jpeg', 'webp', 'avif', 'gif', 'animated.gif'])(
    'stores %s originals without recompression',
    async (format) => {
      const bytes =
        format === 'png'
          ? Uint8Array.from(
              atob(
                'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
              ),
              (character) => character.codePointAt(0)!,
            )
          : await readFile(
              `tests/fixtures/${format === 'animated.gif' ? format : `upload.${format}`}`,
            );
      const manifest = manifestFor([`summer café ${format}`], bytes.length);
      vi.stubGlobal(
        'fetch',
        vi.fn(() => Promise.resolve(new Response(bytes))),
      );
      const memory = memoryZipWriter();
      const saved = await writeImageZip(
        manifest,
        memory.stream,
        new AbortController().signal,
        vi.fn(),
      );
      expect(saved).toEqual({ completed: 1, failed: [] });
      const { zip, result } = await entries(memory.blob());
      expect(result[0].compressionMethod).toBe(0);
      expect(await result[0].getData(new Uint8ArrayWriter())).toEqual(
        new Uint8Array(bytes),
      );
      await zip.close();
    },
  );
  it('continues after HTTP failures and mid-stream truncation, keeping unique successful entries', async () => {
    const manifest = manifestFor([
      'same.png',
      'missing.png',
      'truncated.png',
      'same.png',
    ]);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(new Response('one'))
        .mockResolvedValueOnce(new Response('Denied', { status: 403 }))
        .mockResolvedValueOnce(new Response('x'))
        .mockResolvedValueOnce(new Response('two')),
    );
    const memory = memoryZipWriter();
    const saved = await writeImageZip(
      manifest,
      memory.stream,
      new AbortController().signal,
      vi.fn(),
    );
    expect(saved.completed).toBe(2);
    expect(saved.failed).toHaveLength(2);
    const { zip, result } = await entries(memory.blob());
    expect(result.map((entry) => entry.filename)).toEqual([
      'same.png',
      'same (2).png',
      'download-errors.txt',
    ]);
    const report = await result[2].getData(new TextWriter());
    expect(report).toContain('missing.png: Download failed (HTTP 403)');
    expect(report).toContain(
      'truncated.png: The image download was incomplete.',
    );
    await zip.close();
  });
  it('aborts on a failed destination rather than reporting partial success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('abc'))),
    );
    await expect(
      writeImageZip(
        manifestFor(['one.png', 'two.png']),
        new WritableStream({
          write() {
            throw new Error('disk full');
          },
        }),
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow('disk full');
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('enforces actual output limits and cancellation', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('abc'))),
    );
    const memory = memoryZipWriter(16);
    await expect(
      writeImageZip(
        manifestFor(['one.png']),
        memory.stream,
        new AbortController().signal,
        vi.fn(),
      ),
    ).rejects.toThrow('memory limit');
    const cancel = new AbortController();
    cancel.abort();
    await expect(
      writeImageZip(
        manifestFor(['one.png']),
        memoryZipWriter().stream,
        cancel.signal,
        vi.fn(),
      ),
    ).rejects.toThrow();
  });
  it('aborts the destination when cancelled during an image stream', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(new Response('abc'))),
    );
    const cancel = new AbortController();
    const aborted = vi.fn();
    const sink = new WritableStream<Uint8Array>({ write() {}, abort: aborted });
    await expect(
      writeImageZip(
        manifestFor(['one.png', 'two.png']),
        sink,
        cancel.signal,
        ({ transferred }) => {
          if (transferred) cancel.abort();
        },
      ),
    ).rejects.toThrow();
    expect(aborted).toHaveBeenCalledOnce();
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('streams a large selection to a slow sink without fetching the next image early', async () => {
    const size = 1024 * 1024;
    let produced = 0;
    let written = 0;
    let maximumAhead = 0;
    vi.stubGlobal(
      'fetch',
      vi.fn(() => {
        let remaining = size;
        return Promise.resolve(
          new Response(
            new ReadableStream<Uint8Array>({
              pull(target) {
                if (!remaining) {
                  target.close();
                  return;
                }
                const chunk = new Uint8Array(Math.min(remaining, 64 * 1024));
                remaining -= chunk.length;
                produced += chunk.length;
                maximumAhead = Math.max(maximumAhead, produced - written);
                target.enqueue(chunk);
              },
            }),
          ),
        );
      }),
    );
    const sink = new WritableStream<Uint8Array>({
      async write(chunk) {
        await new Promise((resolve) => setTimeout(resolve, 1));
        written += chunk.length;
      },
    });
    const result = await writeImageZip(
      manifestFor(
        Array.from({ length: 70 }, (_, index) => `${index}.png`),
        size,
      ),
      sink,
      new AbortController().signal,
      vi.fn(),
    );
    expect(result.completed).toBe(70);
    expect(maximumAhead).toBeLessThan(size);
    expect(produced).toBeGreaterThan(zipMemoryLimit);
  });
});

describe('download preparation', () => {
  it('aborts an active ZIP transfer only after confirmation and discards partial output', async () => {
    vi.stubGlobal('showSaveFilePicker', undefined);
    const click = vi.fn();
    vi.stubGlobal('document', { createElement: () => ({ click }) });
    const manifest = manifestFor(['one.png', 'two.png', 'three.png']);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(Response.json(manifest))
        .mockResolvedValueOnce(new Response('abc'))
        .mockImplementationOnce(
          (_url: string, options: RequestInit) =>
            new Promise<Response>((_resolve, reject) => {
              options.signal!.addEventListener(
                'abort',
                () => reject(new DOMException('Aborted', 'AbortError')),
                { once: true },
              );
            }),
        ),
    );
    setDownloadOwner('cancel-active-zip');
    const done = downloadImages(['image-0', 'image-1', 'image-2']);
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    const notice = get(notify)[0];
    expect(notice.items?.[0].state).toBe('completed');
    notify.requestCancel(notice.id);
    expect(get(downloads).active).toBe(true);
    const signal = vi.mocked(fetch).mock.calls[2][1]!.signal!;
    expect(signal.aborted).toBe(false);
    notify.confirmCancel();
    await done;
    expect(signal.aborted).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(3);
    expect(click).not.toHaveBeenCalled();
    expect(get(downloads).active).toBe(false);
    expect(get(notify)[0]).toMatchObject({
      id: notice.id,
      kind: 'info',
      onCancel: undefined,
      guidance: 'The unfinished ZIP was discarded. No archive was saved.',
    });
    expect(get(notify)[0].items?.map((item) => item.state)).toEqual([
      'cancelled',
      'cancelled',
      'cancelled',
    ]);
  });

  it('removes cancellation during the final disk commit and reports saved success', async () => {
    let finish!: () => void;
    const abort = vi.fn();
    const destination = new WritableStream<Uint8Array>({
      write() {},
      close: () =>
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
      abort,
    });
    vi.stubGlobal('showSaveFilePicker', () =>
      Promise.resolve({ createWritable: () => Promise.resolve(destination) }),
    );
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce(
          Response.json(manifestFor(['one.png', 'two.png'])),
        )
        .mockImplementation(() => Promise.resolve(new Response('abc'))),
    );
    setDownloadOwner('disk-commit');
    const done = downloadImages(['image-0', 'image-1']);
    await vi.waitFor(() => expect(finish).toBeTypeOf('function'));
    const notice = get(notify)[0];
    expect(notice).toMatchObject({
      message: 'Saving ZIP…',
      kind: 'loading',
      onCancel: undefined,
    });
    notify.requestCancel(notice.id);
    expect(get(notify.confirmation)).toBeNull();
    finish();
    await done;
    expect(abort).not.toHaveBeenCalled();
    expect(get(notify)[0]).toMatchObject({ kind: 'success' });
  });

  it('opens the disk picker before preparation and streams the ZIP to its writable', async () => {
    const order: string[] = [];
    const memory = memoryZipWriter();
    const picker = vi.fn(() => {
      order.push('picker');
      return Promise.resolve({
        createWritable: () => Promise.resolve(memory.stream),
      });
    });
    vi.stubGlobal('showSaveFilePicker', picker);
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockImplementationOnce(() => {
          order.push('manifest');
          return Promise.resolve(
            Response.json(manifestFor(['one.png', 'two.png'])),
          );
        })
        .mockResolvedValueOnce(new Response('abc'))
        .mockResolvedValueOnce(new Response('def')),
    );
    setDownloadOwner('disk');
    await downloadImages(['image-0', 'image-1']);
    expect(order).toEqual(['picker', 'manifest']);
    const { zip, result } = await entries(memory.blob());
    expect(result).toHaveLength(2);
    await zip.close();
    expect(get(notify)[0].kind).toBe('success');
    expect(get(notify)[0].progress).toBeUndefined();
    expect(get(notify)[0].items?.map((item) => item.state)).toEqual([
      'completed',
      'completed',
    ]);
  });
  it('cancels cleanly when the disk picker is dismissed', async () => {
    vi.stubGlobal(
      'showSaveFilePicker',
      vi.fn(() => Promise.reject(new DOMException('Dismissed', 'AbortError'))),
    );
    vi.stubGlobal('fetch', vi.fn());
    setDownloadOwner('picker-cancel');
    await downloadImages(['a', 'b']);
    expect(fetch).not.toHaveBeenCalled();
    expect(get(downloads).active).toBe(false);
    expect(get(notify)[0].kind).toBe('info');
  });
  it('aborts preparation on account change without publishing old results', async () => {
    vi.stubGlobal('showSaveFilePicker', undefined);
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_url: string, options: RequestInit) =>
          new Promise<Response>((_resolve, reject) => {
            options.signal!.addEventListener(
              'abort',
              () => reject(new DOMException('Aborted', 'AbortError')),
              { once: true },
            );
          }),
      ),
    );
    setDownloadOwner('old-account');
    const pending = downloadImages(['one']);
    setDownloadOwner('new-account');
    await pending;
    expect(get(downloads)).toEqual({ active: false, individual: [] });
    expect(get(notify)).toEqual([]);
  });
  it('starts a single native download using the authenticated original route', async () => {
    const click = vi.fn();
    const link = { href: '', download: '', click };
    vi.stubGlobal('document', { createElement: () => link });
    vi.stubGlobal('window', {});
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(Response.json(manifestFor(['space name.png']))),
      ),
    );
    setDownloadOwner('single');
    await downloadImages(['image-0']);
    expect(link.href).toBe('/api/media/image-0?download');
    expect(link.download).toBe('space name.png');
    expect(click).toHaveBeenCalledOnce();
    expect(get(notify)[0]).toMatchObject({ progress: undefined });
    expect(get(notify)[0].items?.[0]).toMatchObject({
      name: 'space name.png',
      state: 'started',
    });
  });
  it('offers individual downloads instead of allocating a large archive', async () => {
    vi.stubGlobal('window', {});
    const manifest = manifestFor(['one.png', 'two.png'], zipMemoryLimit);
    vi.stubGlobal(
      'fetch',
      vi.fn(() => Promise.resolve(Response.json(manifest))),
    );
    setDownloadOwner('fallback');
    await downloadImages(['image-0', 'image-1']);
    expect(get(downloads).individual).toEqual(manifest.images);
    expect(fetch).toHaveBeenCalledOnce();
  });
});
