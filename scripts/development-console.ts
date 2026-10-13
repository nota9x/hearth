import { createInterface, emitKeypressEvents } from 'node:readline';
import { stripVTControlCharacters, styleText } from 'node:util';

import { createLogUpdate } from 'log-update';
import wrapAnsi from 'wrap-ansi';

import type { Component, ServerMode } from './development-config';

type Service = Component | 'dev' | 'preview';
type Status = 'START' | 'READY' | 'INFO' | 'WARN' | 'ERROR' | 'STOP' | 'DONE';
export type ServiceState = 'starting' | 'ready' | 'failed' | 'stopped';

const serviceColors = {
  web: 'cyan',
  delivery: 'green',
  maintenance: 'magenta',
  dev: 'blue',
  preview: 'blue',
} as const;
const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const labels = { web: 'Web', delivery: 'Delivery', maintenance: 'Maintenance' };
// SGR is the only terminal control sequence accepted from child output.
// eslint-disable-next-line no-control-regex
const sgr = /(\u{1B}\[[\d;:]*m)/u;

// Child output may style text, but must never move the dashboard's cursor.
export function safeLogText(input: string, colors: boolean) {
  return input
    .split(sgr)
    .map((part) =>
      colors && sgr.test(part)
        ? part
        : stripVTControlCharacters(part).replaceAll('\r', ''),
    )
    .join('');
}

export class DevelopmentConsole {
  private readonly update;
  private readonly states = new Map<
    Component,
    { state: ServiceState; message: string }
  >();
  private logs: string[] = [];
  private frame = 0;
  private animation?: ReturnType<typeof setInterval>;
  private pending?: ReturnType<typeof setTimeout>;
  private closed = false;
  private paused = false;
  private stopControls?: () => void;
  private maintenanceControl = false;
  private readonly controlsAllowed: boolean;
  private readonly resize = () => {
    // Clear using the old geometry before fitting a frame to the new dimensions.
    this.update.clear();
    this.render();
  };

  readonly interactive: boolean;
  readonly colors: boolean;

  constructor(
    components: Component[],
    private readonly output: NodeJS.WriteStream = process.stdout,
    private readonly errors: NodeJS.WriteStream = process.stderr,
    env: Record<string, string | undefined> = process.env,
    private readonly mode: ServerMode = 'development',
  ) {
    this.controlsAllowed = output.isTTY && !env.CI;
    this.interactive =
      output.isTTY &&
      errors.isTTY &&
      !env.CI &&
      env.TERM !== 'dumb' &&
      output.columns >= 40 &&
      output.rows >= components.length + 10;
    this.colors =
      env.NO_COLOR === undefined &&
      env.NODE_DISABLE_COLORS === undefined &&
      env.FORCE_COLOR !== '0' &&
      (env.FORCE_COLOR !== undefined || output.hasColors?.());
    this.update = createLogUpdate(output, { showCursor: true });
    for (const component of components)
      this.states.set(component, {
        state: 'starting',
        message: 'Checking configuration…',
      });
    this.log(
      this.mode === 'preview' ? 'preview' : 'dev',
      'INFO',
      `${this.paint(['bold', 'yellow'], 'hearth')}  ${this.paint('dim', 'Copyright (C) 2026')}  ${this.paint(['bold', 'cyan'], 'a9x Development')}`,
    );
    if (this.interactive) {
      output.write('\u{1B}[?25l');
      output.on('resize', this.resize);
      this.animation = setInterval(() => {
        this.frame = (this.frame + 1) % frames.length;
        this.render();
      }, 80);
      this.render();
    } else {
      output.write(`\n${this.banner()}\n\n`);
      for (const component of components)
        this.log(component, 'START', 'Checking configuration…');
    }
  }

  private paint(format: Parameters<typeof styleText>[0], text: string) {
    return this.colors
      ? styleText(format, text, { validateStream: false })
      : text;
  }

  private banner() {
    const badge = this.colors
      ? '\u{1B}[1;38;2;22;19;17;48;2;196;113;74m hearth \u{1B}[0m'
      : ' hearth ';
    return `  ${badge}  ${this.paint('bold', this.mode === 'preview' ? 'Production Preview' : 'Development Server')}`;
  }

  private header(width: number) {
    const lines = [this.banner(), ''];
    for (const [service, { state, message }] of this.states) {
      const icon = {
        starting: this.paint(serviceColors[service], frames[this.frame]),
        ready: this.paint('green', '✓'),
        failed: this.paint('red', '✗'),
        stopped: this.paint('dim', '–'),
      }[state];
      lines.push(
        `  ${icon}  ${this.paint('bold', labels[service].padEnd(13))} ${this.paint(state === 'failed' ? 'red' : state === 'ready' ? 'green' : 'dim', message)}`,
      );
    }
    lines.push(
      '',
      this.paint(
        'dim',
        `  ${'─'.repeat(Math.max(0, Math.min(width - 4, 64)))}`,
      ),
      `  ${this.paint('dim', `Logs · Ctrl+C to stop${this.maintenanceControl ? ' · M run maintenance' : ''} · scroll up for history`)}`,
      '',
    );
    return lines.map(
      (line) =>
        wrapAnsi(line, width, {
          hard: true,
          trim: false,
          wordWrap: false,
        }).split('\n', 1)[0],
    );
  }

  private render() {
    if (this.closed || this.paused || !this.interactive) return;
    const width = Math.max(1, this.output.columns || 80);
    const height = this.output.rows || 24;
    const header = this.header(width);
    const entries = this.logs.map((line) =>
      wrapAnsi(line, width, { hard: true, trim: false, wordWrap: false }).split(
        '\n',
      ),
    );
    if (width < 40 || height < header.length + 4) {
      // Small windows get ordinary output; retain all logs rather than clipping diagnostics.
      if (entries.length > 0) this.update.persist(entries.flat().join('\n'));
      this.logs = [];
      const summary = [...this.states].map(
        ([service, { state }]) => `  ${labels[service]}  ${state}`,
      );
      this.update(
        [header[0], ...summary].slice(0, Math.max(1, height - 1)).join('\n'),
      );
      return;
    }
    const capacity = height - header.length - 2;
    let excess =
      entries.reduce((total, entry) => total + entry.length, 0) - capacity;
    const overflow: string[] = [];
    while (excess > 0) {
      const first = entries[0];
      const count = Math.min(excess, first.length);
      overflow.push(...first.splice(0, count));
      excess -= count;
      if (first.length === 0) {
        entries.shift();
        this.logs.shift();
      } else this.logs[0] = first.join('\n');
    }
    if (overflow.length > 0) this.update.persist(overflow.join('\n'));
    const rows = entries.flat();
    // Keep a fixed-height frame. Cursor-down patches cannot add rows at the
    // bottom of a terminal; a growing frame leaves stale rows in ConPTY.
    const padding = Array.from({ length: capacity - rows.length }, () => '');
    this.update([...header, ...padding, ...rows].join('\n') + '\n');
  }

  enableControls(
    shutdown: () => void,
    maintenance?: () => void,
    input: NodeJS.ReadStream = process.stdin,
  ) {
    if (!input.isTTY || !this.controlsAllowed) return;
    const wasRaw = input.isRaw;
    emitKeypressEvents(input);
    const keypress = (
      _text: string,
      key: { name: string; ctrl?: boolean; meta?: boolean },
    ) => {
      if (key.ctrl && key.name === 'c') shutdown();
      else if (!key.ctrl && !key.meta && key.name === 'm') maintenance?.();
    };
    input.on('keypress', keypress);
    input.setRawMode(true);
    input.resume();
    this.stopControls = () => {
      input.off('keypress', keypress);
      input.setRawMode(wasRaw);
      input.pause();
    };
    this.maintenanceControl = !!maintenance;
    this.render();
  }

  setState(service: Component, state: ServiceState, message: string) {
    if (this.closed) return;
    const previous = this.states.get(service);
    if (previous?.state === state && previous.message === message) return;
    this.states.set(service, { state, message });
    let starting = false;
    for (const entry of this.states.values())
      if (entry.state === 'starting') starting = true;
    if (!starting) {
      clearInterval(this.animation);
      this.animation = undefined;
    }
    if (this.interactive) this.render();
    else
      this.log(
        service,
        { starting: 'START', ready: 'READY', failed: 'ERROR', stopped: 'STOP' }[
          state
        ] as Status,
        message,
      );
  }

  log(service: Service, status: Status, message: string) {
    const stderr = status === 'ERROR' || status === 'WARN';
    for (const input of message.split(/\r?\n/)) {
      const text = safeLogText(input, this.colors);
      const label = this.paint(
        ['bold', serviceColors[service]],
        `[${service}]`.padEnd(13),
      );
      const badge = this.paint(
        stderr ? (status === 'ERROR' ? 'red' : 'yellow') : 'dim',
        status.padEnd(5),
      );
      const time = this.paint(
        'dim',
        new Date().toLocaleTimeString('en-GB', { hour12: false }),
      );
      const line = `  ${time}  ${label} ${badge}  ${text}${this.colors ? '\u{1B}[0m' : ''}`;
      if (this.interactive && !this.closed) this.logs.push(line);
      else (stderr ? this.errors : this.output).write(`${line}\n`);
    }
    if (this.interactive && !this.closed && !this.pending)
      this.pending = setTimeout(() => {
        this.pending = undefined;
        this.render();
      }, 33);
  }

  serviceLine(service: Component, input: string, stderr: boolean) {
    const plain = stripVTControlCharacters(input);
    // This is redundant with the authoritative ready IPC message. Never filter stderr.
    if (!stderr && /^\[wrangler:info\]\s*Ready on https?:\/\//.test(plain))
      return;
    const status = stderr
      ? 'ERROR'
      : /^\[wrangler:warn\]|^\[warn\]|^Skipped overlapping/.test(plain)
        ? 'WARN'
        : /^\[wrangler:error\]/.test(plain)
          ? 'ERROR'
          : 'INFO';
    this.log(service, status, input);
  }

  async confirm(question: string) {
    if (!process.stdin.isTTY || !this.output.isTTY || process.env.CI)
      return false;
    this.paused = true;
    if (this.interactive) {
      if (this.logs.length > 0) this.update.persist(this.logs.join('\n'));
      else this.update.clear();
      this.logs = [];
      this.update.done();
      this.output.write('\u{1B}[?25h');
    }
    const input = createInterface({
      input: process.stdin,
      output: this.output,
    });
    try {
      return await new Promise<boolean>((resolve) => {
        input.once('close', () => resolve(false));
        input.question(`  ${question} [y/N] `, (answer) => {
          resolve(/^y(?:es)?$/i.test(answer.trim()));
          input.close();
        });
      });
    } finally {
      input.close();
      this.paused = false;
      if (this.interactive && !this.closed) {
        this.output.write('\u{1B}[?25l');
        this.render();
      }
    }
  }

  async close() {
    if (this.closed) return;
    this.stopControls?.();
    clearInterval(this.animation);
    clearTimeout(this.pending);
    this.output.off('resize', this.resize);
    this.render();
    this.closed = true;
    if (this.interactive) {
      this.update.done();
      this.output.write('\u{1B}[?25h');
    }
    await Promise.all(
      [this.output, this.errors].map(
        (stream) =>
          new Promise<void>((resolve) => stream.write('', () => resolve())),
      ),
    );
  }
}
