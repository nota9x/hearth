import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

import { describe, expect, it, vi } from 'vitest';

import { DevelopmentConsole, safeLogText } from '../../cli/development/console';

function stream(tty = true) {
  const chunks: string[] = [];
  const output = Object.assign(
    new Writable({
      write(chunk: Buffer, _encoding, callback) {
        if (chunk.length > 0) chunks.push(chunk.toString());
        callback();
      },
    }),
    { isTTY: tty, columns: 80, rows: 24, hasColors: () => tty },
  ) as unknown as NodeJS.WriteStream;
  return { output, chunks };
}

function harness(env: Record<string, string | undefined> = {}, tty = true) {
  const stdout = stream(tty);
  const stderr = stream(tty);
  const dashboard = new DevelopmentConsole(
    ['web', 'delivery', 'maintenance'],
    stdout.output,
    stderr.output,
    env,
  );
  return { dashboard, stdout, stderr };
}

describe('development dashboard', () => {
  it('shows and handles maintenance controls, preserves Ctrl+C, and restores terminal input', async () => {
    const { dashboard } = harness();
    const raw = vi.fn();
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: raw,
    }) as unknown as NodeJS.ReadStream;
    const shutdown = vi.fn();
    const maintenance = vi.fn();
    dashboard.enableControls(shutdown, maintenance, input);
    input.write('m');
    input.write('M');
    input.write('x');
    input.write('\u{3}');
    expect(maintenance).toHaveBeenCalledTimes(2);
    expect(shutdown).toHaveBeenCalledTimes(1);
    expect(raw).toHaveBeenCalledWith(true);
    await dashboard.close();
    expect(raw).toHaveBeenLastCalledWith(false);
    expect(input.listenerCount('keypress')).toBe(0);
  });

  it('keeps redirected stdout and stderr plain and separate', async () => {
    const { dashboard, stdout, stderr } = harness({}, false);
    dashboard.serviceLine('web', 'stdout line', false);
    dashboard.serviceLine('web', 'stderr line', true);
    dashboard.serviceLine(
      'delivery',
      '[wrangler:info] Ready on http://localhost:8788',
      false,
    );
    dashboard.serviceLine(
      'delivery',
      '[wrangler:info] Ready on http://localhost:8788',
      true,
    );
    await dashboard.close();
    expect(stdout.chunks.join('')).toContain('stdout line');
    expect(stdout.chunks.join('')).not.toContain('stderr line');
    expect(stderr.chunks.join('')).toContain('stderr line');
    expect(stderr.chunks.join('')).toContain('Ready on');
    const text = [...stdout.chunks, ...stderr.chunks].join('');
    expect(stripVTControlCharacters(text)).toBe(text);
  });

  it('neutralizes child screen clearing and cursor moves while preserving SGR', () => {
    expect(safeLogText('\u{1B}[2J\u{1B}[H\u{1B}[31merror\u{1B}[0m', true)).toBe(
      '\u{1B}[31merror\u{1B}[0m',
    );
    expect(safeLogText('\u{1B}[31merror\u{1B}[0m', false)).toBe('error');
  });
});
