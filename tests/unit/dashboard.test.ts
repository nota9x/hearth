import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  acceptsFileDrag,
  isFileDrag,
  listenForFileDrop,
} from '../../apps/web/src/lib/file-drop';
import { createRefresh, watchRefresh } from '../../apps/web/src/lib/refresh';
import {
  reconcileSelection,
  selectionState,
  selectVisible,
} from '../../apps/web/src/lib/selection';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function transfer(
  types: string[],
  items: { kind: string; type: string }[] = [],
) {
  return { types, items } as unknown as DataTransfer;
}

describe('file drag detection', () => {
  it('tracks nested enters, respects handled drops, and removes every listener', () => {
    const window = new EventTarget();
    const document = Object.assign(new EventTarget(), { hidden: false });
    vi.stubGlobal('window', window);
    vi.stubGlobal('document', document);
    vi.stubGlobal('Element', class {});
    vi.stubGlobal('addEventListener', window.addEventListener.bind(window));
    vi.stubGlobal(
      'removeEventListener',
      window.removeEventListener.bind(window),
    );
    const show = vi.fn(),
      upload = vi.fn();
    const cleanup = listenForFileDrop(show, upload);
    const drag = (type: string) =>
      Object.assign(new Event(type, { cancelable: true }), {
        dataTransfer: {
          types: ['Files'],
          items: [],
          files: [new File(['image'], 'image.png')],
        },
      });
    window.dispatchEvent(drag('dragenter'));
    window.dispatchEvent(drag('dragenter'));
    window.dispatchEvent(drag('dragleave'));
    expect(show).toHaveBeenLastCalledWith(true);
    window.dispatchEvent(drag('dragleave'));
    expect(show).toHaveBeenLastCalledWith(false);
    const handled = drag('drop');
    handled.preventDefault();
    window.dispatchEvent(handled);
    expect(upload).not.toHaveBeenCalled();
    const drop = drag('drop');
    window.dispatchEvent(drop);
    expect(drop.defaultPrevented).toBe(true);
    expect(upload).toHaveBeenCalledOnce();
    cleanup();
    show.mockClear();
    upload.mockClear();
    window.dispatchEvent(drag('dragenter'));
    window.dispatchEvent(drag('drop'));
    window.dispatchEvent(new Event('blur'));
    document.dispatchEvent(new Event('visibilitychange'));
    expect(show).not.toHaveBeenCalled();
    expect(upload).not.toHaveBeenCalled();
  });
  it('ignores text, links, and UI drags', () => {
    for (const value of [
      null,
      transfer(['text/plain']),
      transfer(['text/uri-list']),
      transfer([]),
    ]) {
      expect(isFileDrag(value)).toBe(false);
      expect(acceptsFileDrag(value)).toBe(false);
    }
  });
  it('recognizes supported, mixed, and browser-protected file drags', () => {
    for (const type of [
      'image/png',
      'image/jpeg',
      'image/gif',
      'image/webp',
      'image/avif',
      '',
    ])
      expect(
        acceptsFileDrag(transfer(['Files'], [{ kind: 'file', type }])),
      ).toBe(true);
    expect(acceptsFileDrag(transfer(['Files']))).toBe(true);
    expect(
      acceptsFileDrag(
        transfer(['Files'], [{ kind: 'file', type: 'text/plain' }]),
      ),
    ).toBe(false);
    expect(
      acceptsFileDrag(
        transfer(
          ['Files'],
          [
            { kind: 'file', type: 'text/plain' },
            { kind: 'file', type: 'image/gif' },
          ],
        ),
      ),
    ).toBe(true);
  });
});

describe('visible selection', () => {
  it('supports empty, none, some, all, and deselect all', () => {
    expect(selectionState([], [])).toEqual({
      checked: false,
      indeterminate: false,
    });
    expect(selectionState([], ['a', 'b'])).toEqual({
      checked: false,
      indeterminate: false,
    });
    expect(selectionState(['a'], ['a', 'b'])).toEqual({
      checked: false,
      indeterminate: true,
    });
    const all = selectVisible(['a'], ['a', 'b'], true);
    expect(all).toEqual(['a', 'b']);
    expect(selectionState(all, ['a', 'b'])).toEqual({
      checked: true,
      indeterminate: false,
    });
    expect(selectVisible(all, ['a', 'b'], false)).toEqual([]);
  });
  it('prunes stale images without selecting newly refreshed images', () => {
    expect(reconcileSelection(['a', 'b'], ['b', 'c'])).toEqual(['b']);
    expect(reconcileSelection(['a'], [])).toEqual([]);
  });
  it('preserves member grants outside the bounded editor list', () => {
    expect(selectVisible(['outside', 'a'], ['a', 'b'], false)).toEqual([
      'outside',
    ]);
    expect(selectVisible(['outside'], ['a', 'b'], true)).toEqual([
      'outside',
      'a',
      'b',
    ]);
  });
});

describe('dashboard refresh', () => {
  it('coalesces reads and queues a trailing read after a mutation', async () => {
    let release!: () => void;
    // ES2022 has no Promise.withResolvers type.
    const update = vi.fn(
      () =>
        // eslint-disable-next-line unicorn/prefer-promise-with-resolvers
        new Promise<void>((resolve) => {
          release = resolve;
        }),
    );
    const dashboard = createRefresh(update);
    const first = dashboard.refresh();
    const duplicate = dashboard.refresh();
    const mutation = dashboard.refresh(true);
    expect(update).toHaveBeenCalledOnce();
    release();
    await Promise.resolve();
    expect(update).toHaveBeenCalledTimes(2);
    release();
    await Promise.all([first, duplicate, mutation]);
  });
  it('recovers after failure without a stale-data gate on subsequent refreshes', async () => {
    const update = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValue(undefined);
    const dashboard = createRefresh(update);
    await expect(dashboard.refresh()).rejects.toThrow('offline');
    await dashboard.refresh();
    await dashboard.refresh();
    expect(update).toHaveBeenCalledTimes(3);
  });

  it('refreshes immediately after even a brief hidden period and deduplicates focus', () => {
    vi.useFakeTimers();
    const document = Object.assign(new EventTarget(), {
      visibilityState: 'visible',
    });
    const window = new EventTarget();
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    const refresh = vi.fn();
    const cleanup = watchRefresh(refresh, () => true, 15_000);
    vi.advanceTimersByTime(15_000);
    expect(refresh).toHaveBeenCalledOnce();
    document.visibilityState = 'hidden';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(100);
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledTimes(2);
    cleanup();
  });
  it('refreshes on focus without polling when the interval is null', () => {
    vi.useFakeTimers();
    const document = Object.assign(new EventTarget(), {
      visibilityState: 'visible',
    });
    const window = new EventTarget();
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    const refresh = vi.fn();
    const cleanup = watchRefresh(refresh, () => true, null);
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(refresh).not.toHaveBeenCalled();
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
    cleanup();
    vi.advanceTimersByTime(1000);
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledOnce();
  });
  it('pauses hidden/disabled pages, resumes on focus, and cleans up', () => {
    vi.useFakeTimers();
    const document = Object.assign(new EventTarget(), {
      visibilityState: 'visible',
    });
    const window = new EventTarget();
    vi.stubGlobal('document', document);
    vi.stubGlobal('window', window);
    const refresh = vi.fn();
    let enabled = true;
    const cleanup = watchRefresh(refresh, () => enabled, 60_000);
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledOnce();
    document.visibilityState = 'hidden';
    vi.advanceTimersByTime(120_000);
    window.dispatchEvent(new Event('focus'));
    expect(refresh).toHaveBeenCalledOnce();
    document.visibilityState = 'visible';
    document.dispatchEvent(new Event('visibilitychange'));
    expect(refresh).toHaveBeenCalledTimes(2);
    enabled = false;
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    cleanup();
    enabled = true;
    window.dispatchEvent(new Event('focus'));
    vi.advanceTimersByTime(60_000);
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});
