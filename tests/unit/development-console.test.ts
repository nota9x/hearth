import { PassThrough, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';

import { Terminal } from '@xterm/headless';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DevelopmentConsole,
  safeLogText,
} from '../../scripts/development-console';

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

function harness(
  env: Record<string, string | undefined> = {},
  tty = true,
  mode: 'development' | 'preview' = 'development',
) {
  const stdout = stream(tty);
  const stderr = stream(tty);
  const dashboard = new DevelopmentConsole(
    ['web', 'delivery', 'maintenance'],
    stdout.output,
    stderr.output,
    env,
    mode,
  );
  return { dashboard, stdout, stderr };
}

async function screen(chunks: string[], columns = 80, rows = 24) {
  const terminal = new Terminal({
    cols: columns,
    rows,
    scrollback: 1000,
    allowProposedApi: true,
    convertEol: true,
  });
  await new Promise<void>((resolve) =>
    terminal.write(chunks.join(''), resolve),
  );
  const lines = Array.from(
    { length: terminal.buffer.active.length },
    (_, index) =>
      terminal.buffer.active.getLine(index)!.translateToString(true),
  );
  const visible = lines.slice(terminal.buffer.active.baseY);
  terminal.dispose();
  return { lines, visible };
}

afterEach(() => vi.useRealTimers());

describe('development dashboard', () => {
  it.each([true, false])(
    'brands production preview with TTY=%s',
    async (tty) => {
      const { dashboard, stdout } = harness({ NO_COLOR: '' }, tty, 'preview');
      dashboard.setState('web', 'ready', 'Ready on localhost:5173');
      await dashboard.close();
      const result = await screen(stdout.chunks);
      const text = result.lines.join('\n');
      expect(text).toContain('hearth');
      expect(text).toContain('Production Preview');
      expect(text).toContain('[preview]');
      expect(text).not.toContain('Development Server');
    },
  );

  it.each([{}, { NO_COLOR: '' }, { CI: '1', NO_COLOR: '' }])(
    'starts with a copyright log and respects color settings in %j',
    async (env) => {
      const { dashboard, stdout } = harness(env);
      dashboard.log('dev', 'START', 'Starting services…');
      await dashboard.close();
      const result = await screen(stdout.chunks);
      const logs = result.lines.filter((line) => line.includes('[dev]'));
      expect(logs[0]).toContain('hearth  Copyright (C) 2026  a9x Development');
      expect(logs[1]).toContain('Starting services…');
      const output = stdout.chunks.join('');
      expect(output.includes('\u{1B}[1m\u{1B}[33mhearth')).toBe(
        env.NO_COLOR === undefined,
      );
      expect(output.includes('\u{1B}[1m\u{1B}[36ma9x Development')).toBe(
        env.NO_COLOR === undefined,
      );
    },
  );

  it('shows and handles maintenance controls, preserves Ctrl+C, and restores terminal input', async () => {
    const { dashboard, stdout } = harness();
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
    const result = await screen(stdout.chunks);
    expect(result.visible.join('\n')).toContain(
      'Logs · Ctrl+C to stop · M run maintenance',
    );
  });

  it('omits the maintenance shortcut when that service is absent', async () => {
    const { dashboard, stdout } = harness();
    const input = Object.assign(new PassThrough(), {
      isTTY: true,
      isRaw: false,
      setRawMode: vi.fn(),
    }) as unknown as NodeJS.ReadStream;
    dashboard.enableControls(vi.fn(), undefined, input);
    await dashboard.close();
    expect(stdout.chunks.join('')).not.toContain('M run maintenance');
  });

  it('keeps one row per service when startup begins at the bottom of a terminal', async () => {
    vi.useFakeTimers();
    const { dashboard, stdout } = harness();
    for (const service of ['web', 'delivery', 'maintenance'] as const)
      dashboard.setState(service, 'starting', 'Starting Worker…');
    dashboard.log('dev', 'START', 'Beginning startup');
    vi.advanceTimersByTime(160);
    await dashboard.close();
    vi.useRealTimers();
    const result = await screen([
      'previous command\n'.repeat(22),
      ...stdout.chunks,
    ]);
    const visible = result.visible.join('\n');
    expect(visible.match(/Maintenance/g)).toHaveLength(1);
    expect(visible.match(/Delivery/g)).toHaveLength(1);
    expect(visible.match(/Web/g)).toHaveLength(1);
    expect(visible).not.toContain('Checking configuration');
    expect(visible).toMatch(/\d{2}:\d{2}:\d{2}\s+\[dev\]/);
    expect(stdout.chunks.join('')).toContain('48;2;196;113;74m');
  });
  it('resizes a live terminal and retains logs when the window becomes too small', async () => {
    const { dashboard, stdout } = harness();
    const terminal = new Terminal({
      cols: 80,
      rows: 24,
      scrollback: 1000,
      allowProposedApi: true,
      convertEol: true,
    });
    let offset = 0;
    const flush = async () => {
      const text = stdout.chunks.slice(offset).join('');
      offset = stdout.chunks.length;
      await new Promise<void>((resolve) => terminal.write(text, resolve));
    };
    dashboard.serviceLine('web', 'before-resize', true);
    dashboard.setState('delivery', 'ready', 'Ready on localhost:8788');
    await flush();
    terminal.resize(50, 18);
    stdout.output.columns = 50;
    stdout.output.rows = 18;
    stdout.output.emit('resize');
    await flush();
    dashboard.serviceLine('maintenance', 'after-resize', false);
    dashboard.setState('web', 'ready', 'Ready on localhost:5173');
    await flush();
    terminal.resize(30, 8);
    stdout.output.columns = 30;
    stdout.output.rows = 8;
    stdout.output.emit('resize');
    await flush();
    dashboard.serviceLine('delivery', 'tiny-terminal', true);
    await dashboard.close();
    await flush();
    const history = Array.from(
      { length: terminal.buffer.active.length },
      (_, index) =>
        terminal.buffer.active.getLine(index)!.translateToString(true),
    ).join('');
    expect(history.match(/before-resize/g)).toHaveLength(1);
    expect(history.match(/after-resize/g)).toHaveLength(1);
    expect(history.match(/tiny-terminal/g)).toHaveLength(1);
    terminal.dispose();
  });
  it('animates independently until actual readiness, then stops redrawing', async () => {
    vi.useFakeTimers();
    const { dashboard, stdout } = harness();
    dashboard.setState('delivery', 'ready', 'Ready on localhost:8788');
    dashboard.setState('maintenance', 'ready', 'Ready on localhost:8789');
    vi.advanceTimersByTime(160);
    const first = [...stdout.chunks];
    dashboard.setState('web', 'ready', 'Ready on localhost:5173');
    const count = stdout.chunks.length;
    vi.advanceTimersByTime(800);
    expect(stdout.chunks).toHaveLength(count);
    await dashboard.close();
    vi.useRealTimers();
    const starting = await screen(first);
    expect(starting.visible.join('\n')).toContain('⠹  Web');
    expect(starting.visible.join('\n')).toContain('✓  Delivery');
    expect(starting.visible.join('\n')).toContain('✓  Maintenance');
    const ready = await screen(stdout.chunks);
    expect(ready.visible.filter((line) => line.includes('✓'))).toHaveLength(3);
    expect(stdout.chunks.join('')).toContain('\u{1B}[?25h');
  });

  it('preserves every interleaved log exactly once in viewport or scrollback', async () => {
    const { dashboard, stdout, stderr } = harness();
    for (let index = 0; index < 100; index++) {
      const service = (['web', 'delivery', 'maintenance'] as const)[index % 3];
      dashboard.serviceLine(
        service,
        `entry-${String(index).padStart(3, '0')}`,
        index % 7 === 0,
      );
      if (index % 5 === 0)
        dashboard.setState('web', 'starting', `Startup step ${index}`);
    }
    dashboard.serviceLine('web', 'duplicate diagnostic', true);
    dashboard.serviceLine('web', 'duplicate diagnostic', true);
    dashboard.setState('web', 'failed', 'Exited (1)');
    dashboard.setState('delivery', 'stopped', 'Stopped');
    dashboard.setState('maintenance', 'stopped', 'Stopped');
    await dashboard.close();
    const result = await screen(stdout.chunks);
    const history = result.lines.join('\n');
    for (let index = 0; index < 100; index++)
      expect(
        history.match(
          new RegExp(`entry-${String(index).padStart(3, '0')}`, 'g'),
        ),
      ).toHaveLength(1);
    expect(history.match(/duplicate diagnostic/g)).toHaveLength(2);
    expect(result.visible.join('\n')).toContain('✗  Web');
    expect(result.visible.join('\n')).toContain('–  Delivery');
    expect(stderr.chunks).toHaveLength(0);
  });

  it('wraps Unicode and colored long diagnostics without losing text', async () => {
    const { dashboard, stdout } = harness();
    dashboard.serviceLine(
      'maintenance',
      `\u{1B}[31m${'界'.repeat(120)}\u{1B}[0m`,
      true,
    );
    dashboard.serviceLine('delivery', 'after-long-line', false);
    await dashboard.close();
    const result = await screen(stdout.chunks);
    expect(result.lines.join('').match(/界/g)).toHaveLength(120);
    expect(result.visible.join('\n')).toContain('after-long-line');
    expect(result.visible.join('\n')).toContain('Maintenance');
    expect(stdout.chunks.join('')).toContain('\u{1B}[31m');
  });

  it.each([{ CI: '1' }, { TERM: 'dumb' }])('falls back in %j', async (env) => {
    const { dashboard, stdout, stderr } = harness({ ...env, NO_COLOR: '' });
    expect(dashboard.interactive).toBe(false);
    dashboard.serviceLine('web', '\u{1B}[31merror detail\u{1B}[0m', true);
    dashboard.setState('delivery', 'ready', 'Ready on localhost:8788');
    await dashboard.close();
    expect(stdout.chunks.join('')).toContain('[delivery]');
    expect(stderr.chunks.join('')).toContain('error detail');
    expect([...stdout.chunks, ...stderr.chunks].join('')).not.toContain(
      '\u{1B}',
    );
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

  it('respects NO_COLOR while retaining animation on a capable terminal', async () => {
    const { dashboard, stdout } = harness({ NO_COLOR: '', FORCE_COLOR: '1' });
    expect(dashboard.colors).toBe(false);
    expect(dashboard.interactive).toBe(true);
    dashboard.serviceLine('web', '\u{1B}[31mplain\u{1B}[0m', false);
    await dashboard.close();
    expect(stdout.chunks.join('')).not.toContain('\u{1B}[31m');
  });

  it('neutralizes child screen clearing and cursor moves while preserving SGR', () => {
    expect(safeLogText('\u{1B}[2J\u{1B}[H\u{1B}[31merror\u{1B}[0m', true)).toBe(
      '\u{1B}[31merror\u{1B}[0m',
    );
    expect(safeLogText('\u{1B}[31merror\u{1B}[0m', false)).toBe('error');
  });
});
