import {
  BlobReader,
  TextWriter,
  Uint8ArrayWriter,
  ZipReader,
} from '@zip.js/zip.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  downloadImages,
  downloads,
  memoryZipWriter,
  setDownloadOwner,
  writeImageZip,
  zipMemoryLimit,
} from '../../apps/web/src/lib/downloads';
import { notify } from '../../apps/web/src/lib/notifications';
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

describe('safe download names', () => {
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
});

describe('client ZIP streaming', () => {
  it('stores binary originals without recompression', async () => {
    const bytes = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGP4////fwAJ+wP9KobjigAAAABJRU5ErkJggg==',
      'base64',
    );
    const manifest = manifestFor(['summer café.png'], bytes.length);
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
  });
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
});
