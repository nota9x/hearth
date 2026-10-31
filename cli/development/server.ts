/* eslint-disable unicorn/prefer-await -- Attach child completion and configuration updates without blocking concurrent services. */
import { watch } from 'node:fs';
import { access } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { createInterface } from 'node:readline';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { execa } from 'execa';

import { type Component, components, projects, root } from '../project.ts';
import type { ServerOptions } from './command.ts';
import { persistence, prepareSession, type ServerMode } from './config.ts';
import { DevelopmentConsole } from './console.ts';
import {
  findDevelopmentServer,
  portAvailable,
  stopDevelopmentServer,
} from './ports.ts';
import { createCron, startScheduler } from './scheduler.ts';

export function toolExecutable(component: Component, mode: ServerMode) {
  try {
    if (component === 'web' && mode === 'development') {
      const require = createRequire(
        path.join(root, projects.web, 'package.json'),
      );
      return path.join(
        path.dirname(require.resolve('vite/package.json')),
        'bin/vite.js',
      );
    }
    // The exported Wrangler main is its native CLI without its extra launcher process.
    return fileURLToPath(import.meta.resolve('wrangler'));
  } catch (error) {
    throw new Error(
      `${component === 'web' && mode === 'development' ? 'Vite' : 'Wrangler'} is unavailable. Run pnpm install --frozen-lockfile, then retry.`,
      { cause: error },
    );
  }
}

async function waitForServer(
  component: Component,
  host: string,
  port: number,
  signal: AbortSignal,
) {
  const address = ['0.0.0.0', '::', '[::]'].includes(host) ? '127.0.0.1' : host;
  const hostname =
    address.includes(':') && !address.startsWith('[')
      ? `[${address}]`
      : address;
  const deadline = AbortSignal.timeout(60_000);
  const combined = AbortSignal.any([signal, deadline]);
  while (!combined.aborted) {
    try {
      const response = await fetch(
        `http://${hostname}:${port}${component === 'web' ? '/login' : '/'}`,
        { signal: AbortSignal.any([combined, AbortSignal.timeout(1500)]) },
      );
      await response.body?.cancel();
      if (component === 'web' && !response.ok)
        throw new Error(
          `Web returned HTTP ${response.status}. Check bindings and run pnpm db:migrate.`,
        );
      return;
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Web returned'))
        throw error;
      try {
        await delay(100, undefined, { signal: combined });
      } catch {
        break;
      }
    }
  }
  if (!signal.aborted)
    throw new Error(
      `${component} did not start within 60 seconds. Check its labeled output.`,
    );
  signal.throwIfAborted();
}

export async function startServer(
  mode: ServerMode,
  selected: Component[],
  options: ServerOptions,
  native: Record<Component, string[]>,
) {
  const informational = selected.filter((component) =>
    native[component].some((token) =>
      ['--help', '-h', '--version', '-v'].includes(token),
    ),
  );
  if (informational.length > 0) {
    if (selected.length !== 1)
      throw new Error('Native help/version requires one selected service.');
    const component = selected[0];
    const result = await execa(
      process.execPath,
      [
        toolExecutable(component, mode),
        ...(component === 'web' && mode === 'development' ? [] : ['dev']),
        ...native[component],
      ],
      {
        cwd: path.join(root, projects[component]),
        stdio: 'inherit',
        reject: false,
        killDescendants: true,
      },
    );
    process.exitCode = result.exitCode ?? 1;
    return;
  }
  const service = mode === 'preview' ? 'preview' : 'dev';
  const dashboard = new DevelopmentConsole(
    selected,
    process.stdout,
    process.stderr,
    process.env,
    mode,
  );
  const log = dashboard.log.bind(dashboard);
  const maintenanceLog = dashboard.log.bind(dashboard, 'maintenance');
  const controller = new AbortController();
  const children: Promise<unknown>[] = [];
  const failed = new Set<Component>();
  const watchers: ReturnType<typeof watch>[] = [];
  let session: Awaited<ReturnType<typeof prepareSession>> | undefined;
  let scheduler: ReturnType<typeof startScheduler> | undefined;
  let updates = Promise.resolve();
  let stopping = false;
  let code = 0;
  const { promise: stopped, resolve: finish } = Promise.withResolvers<void>();
  let stopPromise: Promise<void> | undefined;
  function stop(exitCode = 0) {
    if (stopping) return stopPromise!;
    stopping = true;
    code = exitCode;
    log(service, 'STOP', 'Stopping services…');
    stopPromise = (async () => {
      const deadline = setTimeout(() => controller.abort(), 15_000);
      try {
        await scheduler?.stop();
      } finally {
        clearTimeout(deadline);
        controller.abort();
        finish();
      }
    })();
    return stopPromise;
  }
  const interrupt = () => {
    void stop();
  };
  process.on('SIGINT', interrupt);
  process.on('SIGTERM', interrupt);
  try {
    log(service, 'START', `Starting ${selected.join(', ')}…`);
    session = await prepareSession(mode, selected, options, native);
    if (stopping) return;
    const current = session;
    for (const component of selected) {
      const config = current.configs[component];
      const crons = config.triggers?.crons ?? [];
      for (const cron of crons) createCron(cron).stop();
      if (await portAvailable(config.dev.port)) continue;
      const pid =
        process.stdin.isTTY && process.stdout.isTTY && !process.env.CI
          ? await findDevelopmentServer(config.dev.port).catch(() => {})
          : undefined;
      if (
        pid &&
        (await dashboard.confirm(
          `Port ${config.dev.port} is occupied by Hearth. Terminate the existing local servers?`,
        ))
      )
        await stopDevelopmentServer(pid, config.dev.port);
      else
        throw new Error(
          `Port ${config.dev.port} is unavailable (${config.directory}). Stop the existing server before running pnpm ${service}.`,
        );
    }
    if (mode === 'preview' && selected.includes('web')) {
      try {
        await access(
          path.resolve(current.configs.web.directory, current.configs.web.main),
        );
      } catch {
        throw new Error(
          'Built web Worker is missing. Run pnpm build before pnpm preview.',
        );
      }
    }
    const startedAt = performance.now();
    const startService = async (component: Component) => {
      if (stopping) return;
      const config = current.configs[component];
      const vite = component === 'web' && mode === 'development';
      const interactive = current.tools[component].interactive;
      const arguments_ = [vite ? config.directory : 'dev'];
      if (options['log-level']) {
        if (vite)
          arguments_.push(
            '--logLevel',
            options['log-level'] === 'debug' ? 'info' : options['log-level'],
          );
        else
          arguments_.push(
            '--log-level',
            options['log-level'] === 'silent' ? 'none' : options['log-level'],
          );
        if (vite && options['log-level'] === 'debug')
          arguments_.push('--debug');
      }
      if (vite) {
        if (options.open) arguments_.push('--open');
        if (options.force) arguments_.push('--force');
      }
      arguments_.push(...current.tools[component].tokens);
      if (vite)
        arguments_.push(
          '--host',
          config.dev.ip,
          '--port',
          String(config.dev.port),
          '--strictPort',
          '--clearScreen',
          'false',
        );
      else
        arguments_.push(
          '--config',
          current.files[component],
          '--ip',
          config.dev.ip,
          '--port',
          String(config.dev.port),
          '--local',
          '--persist-to',
          persistence,
          '--types',
          'false',
          ...(interactive ? [] : ['--show-interactive-dev-session', 'false']),
          ...(component === 'maintenance' ? ['--test-scheduled'] : []),
        );
      dashboard.setState(
        component,
        'starting',
        vite ? 'Starting Vite…' : 'Starting Worker…',
      );
      if (interactive) await dashboard.close();
      const child = execa(
        process.execPath,
        [
          '--import',
          pathToFileURL(path.join(root, 'cli/development/tool-process.mjs'))
            .href,
          toolExecutable(component, mode),
          ...arguments_,
        ],
        {
          cwd: config.directory,
          env: {
            HEARTH_LOCAL_CONFIG: current.files.web,
            FORCE_COLOR:
              process.env.NO_COLOR === undefined
                ? dashboard.colors
                  ? (process.env.FORCE_COLOR ?? '1')
                  : '0'
                : undefined,
          },
          stdin: interactive ? 'inherit' : 'pipe',
          stdout: interactive ? 'inherit' : 'pipe',
          stderr: interactive ? 'inherit' : 'pipe',
          ipc: true,
          buffer: false,
          reject: false,
          cancelSignal: controller.signal,
          gracefulCancel: true,
          forceKillAfterDelay: 15_000,
          killDescendants: true,
        },
      );
      for (const stream of [child.stdout, child.stderr])
        if (stream)
          createInterface({ input: stream }).on('line', (line) =>
            dashboard.serviceLine(component, line, stream === child.stderr),
          );
      const completion = child
        .then(async (result) => {
          if (stopping) {
            if (result.isForcefullyTerminated) {
              failed.add(component);
              dashboard.setState(component, 'failed', 'Shutdown timed out');
              code ||= 1;
              log(
                component,
                'WARN',
                'Service did not stop within 15 seconds; its process tree was terminated.',
              );
            } else if (!result.isCanceled && result.exitCode)
              code ||= result.exitCode;
            return;
          }
          if (interactive && result.exitCode === 0) {
            await stop();
            return;
          }
          const status = result.exitCode ?? 1;
          failed.add(component);
          dashboard.setState(
            component,
            'failed',
            `Exited (${result.signal || status})`,
          );
          log(
            component,
            'ERROR',
            `${component} exited (${result.signal || status}). Check its labeled output.`,
          );
          await stop(status || (interactive ? 0 : 1));
        })
        .catch(async (error: unknown) => {
          if (stopping) {
            return;
          }

          failed.add(component);
          dashboard.setState(component, 'failed', 'Unable to start process');
          log(
            component,
            'ERROR',
            error instanceof Error ? error.message : String(error),
          );
          await stop(1);
        });
      children.push(completion);
      if (vite)
        await waitForServer(
          component,
          config.dev.ip,
          config.dev.port,
          controller.signal,
        );
      else {
        const timeout = setTimeout(() => {
          failed.add(component);
          dashboard.setState(component, 'failed', 'Startup timed out');
          log(
            component,
            'ERROR',
            `${component} did not start within 60 seconds. Check its labeled output.`,
          );
          void stop(1);
        }, 60_000);
        try {
          await child.getOneMessage({
            filter: (message) =>
              typeof message === 'string' &&
              (JSON.parse(message) as { event?: string }).event ===
                'DEV_SERVER_READY',
          });
        } catch {
          // Preserve the native exit code when a Worker exits before readiness.
          await completion;
        } finally {
          clearTimeout(timeout);
        }
        if (component === 'web' && !stopping)
          await waitForServer(
            component,
            config.dev.ip,
            config.dev.port,
            controller.signal,
          );
      }
      if (stopping) return;
      dashboard.setState(
        component,
        'ready',
        `Ready on http://${config.dev.ip}:${config.dev.port}`,
      );
    };
    // The SvelteKit platform proxy resolves external bindings when it starts.
    const maintenanceFirst = selected.includes('maintenance');
    if (maintenanceFirst) await startService('maintenance');
    await Promise.all(
      selected
        .filter(
          (component) => !(maintenanceFirst && component === 'maintenance'),
        )
        .map((component) => startService(component)),
    );
    if (stopping) return;
    if (selected.includes('maintenance'))
      scheduler = startScheduler(
        current.configs.maintenance.triggers!.crons,
        `http://127.0.0.1:${current.configs.maintenance.dev.port}`,
        maintenanceLog,
        controller.signal,
      );
    for (const component of components)
      watchers.push(
        watch(current.configs[component].directory, (_event, filename) => {
          if (filename !== 'wrangler.jsonc' || stopping) return;
          updates = updates
            .then(async () => {
              if (stopping) return;
              const updated = await current.refresh(component);
              if (!(component === 'maintenance' && scheduler)) {
                return;
              }

              for (const cron of updated.triggers!.crons)
                createCron(cron).stop();
              await scheduler.stop();
              if (!stopping)
                scheduler = startScheduler(
                  updated.triggers!.crons,
                  `http://127.0.0.1:${current.configs.maintenance.dev.port}`,
                  maintenanceLog,
                  controller.signal,
                );
            })
            .catch((error: unknown) => {
              log(
                component,
                'ERROR',
                error instanceof Error ? error.message : String(error),
              );
            });
        }),
      );
    if (selected.every((component) => !current.tools[component].interactive))
      dashboard.enableControls(
        interrupt,
        scheduler
          ? () => {
              void scheduler?.run();
            }
          : undefined,
      );
    log(
      service,
      'READY',
      `All services ready in ${((performance.now() - startedAt) / 1000).toFixed(1)}s. Press Ctrl+C to stop.`,
    );
    await stopped;
  } catch (error) {
    if (!stopping) {
      log(
        service,
        'ERROR',
        error instanceof Error ? error.message : String(error),
      );
      await stop(1);
    }
  } finally {
    for (const watcher of watchers) watcher.close();
    try {
      await updates;
      await stop();
      await Promise.all(children);
      await session?.cleanup();
    } finally {
      for (const component of selected)
        if (!failed.has(component))
          dashboard.setState(component, 'stopped', 'Stopped');
      log(service, 'DONE', 'All services stopped.');
      await dashboard.close();
      process.removeListener('SIGINT', interrupt);
      process.removeListener('SIGTERM', interrupt);
      process.exitCode = code;
    }
  }
}
