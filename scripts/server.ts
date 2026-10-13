import { fork, spawnSync } from 'node:child_process';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { configSchema } from '../packages/core/common';
import {
  type Component,
  projects,
  readDevelopmentConfig,
  root,
  type ServerMode,
} from './development-config';
import { DevelopmentConsole } from './development-console';
import {
  findDevelopmentServer,
  portAvailable,
  stopDevelopmentServer,
} from './development-ports';
import { createCron } from './development-scheduler';

export async function startServer(mode: ServerMode) {
  const service = mode === 'preview' ? 'preview' : 'dev';
  const command = mode === 'preview' ? 'pnpm preview' : 'pnpm dev';
  const selected = process.argv.slice(2);
  if (selected.some((name) => !Object.hasOwn(projects, name)))
    throw new Error(`Usage: ${command} [web|delivery|maintenance]`);
  const components = (
    selected.length > 0 ? [...new Set(selected)] : Object.keys(projects)
  ) as Component[];
  const children: ReturnType<typeof fork>[] = [];
  let maintenanceChild: ReturnType<typeof fork> | undefined;
  const closed: Promise<void>[] = [];
  const dashboard = new DevelopmentConsole(
    components,
    process.stdout,
    process.stderr,
    process.env,
    mode,
  );
  const log = dashboard.log.bind(dashboard);
  const failed = new Set<Component>();
  function fail(component: Component, message: string) {
    failed.add(component);
    dashboard.setState(component, 'failed', message);
  }
  let stopping = false;
  const startedAt = performance.now();

  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    log(service, 'STOP', 'Stopping services…');
    const fallback = setTimeout(() => {
      for (const child of children) {
        if (child.exitCode !== null || child.signalCode !== null || !child.pid)
          continue;
        log(
          service,
          'WARN',
          `Process ${child.pid} did not stop within 15 seconds; terminating its process tree.`,
        );
        if (process.platform === 'win32')
          spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
            windowsHide: true,
            stdio: 'ignore',
          });
        else process.kill(-child.pid, 'SIGKILL');
      }
    }, 15_000);
    for (const child of children) if (child.connected) child.send('shutdown');
    await Promise.all(closed);
    clearTimeout(fallback);
    log(service, 'DONE', 'All services stopped.');
    for (const component of components)
      if (!failed.has(component))
        dashboard.setState(component, 'stopped', 'Stopped');
    await dashboard.close();
    process.exit(failed.size > 0 ? 1 : code);
  }
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  try {
    log(service, 'START', `Starting ${components.join(', ')}…`);
    const configs = await Promise.all(
      components.map((component) => readDevelopmentConfig(component)),
    );
    const web = await readDevelopmentConfig('web');
    configSchema.parse(web.vars);
    if (web.vars.APP_ORIGIN !== `http://127.0.0.1:${web.dev.port}`)
      throw new Error(
        'Set web APP_ORIGIN to its loopback dev port. The web server must use that same port.',
      );
    for (const config of configs) {
      if (
        JSON.stringify(config.d1_databases) !==
          JSON.stringify(web.d1_databases) ||
        JSON.stringify(config.r2_buckets) !== JSON.stringify(web.r2_buckets)
      )
        throw new Error(
          `${config.config}: DB and BUCKET must match the web local resource identifiers.`,
        );
      if (config.triggers)
        for (const cron of config.triggers.crons) createCron(cron).stop();
      if (await portAvailable(config.dev.port)) continue;
      let pid: number | undefined;
      if (process.stdin.isTTY && process.stdout.isTTY && !process.env.CI) {
        try {
          pid = await findDevelopmentServer(config.dev.port);
        } catch {
          log(
            service,
            'WARN',
            `Unable to identify the owner of port ${config.dev.port}.`,
          );
        }
      }
      if (
        pid &&
        (await dashboard.confirm(
          `Port ${config.dev.port} is occupied by Hearth. Terminate the existing local servers?`,
        ))
      ) {
        log(service, 'STOP', `Terminating existing local server (${pid})…`);
        await stopDevelopmentServer(pid, config.dev.port);
      } else {
        fail(
          components[configs.indexOf(config)],
          `Port ${config.dev.port} unavailable`,
        );
        throw new Error(
          `Port ${config.dev.port} is unavailable (${config.directory}). Stop the existing server before running ${command}.`,
        );
      }
    }
    const delivery = await readDevelopmentConfig('delivery');
    if (
      web.vars.LOCAL_DELIVERY_PORT !== String(delivery.dev.port) ||
      delivery.vars.APP_ORIGIN !== web.vars.APP_ORIGIN
    )
      throw new Error(
        'Web LOCAL_DELIVERY_PORT and delivery APP_ORIGIN must match the local service ports.',
      );
    if (stopping) process.exit(0);
    await Promise.all(
      components.map(
        (component, index) =>
          new Promise<void>((resolve, reject) => {
            dashboard.setState(
              component,
              'starting',
              component === 'web' && mode === 'development'
                ? 'Starting Vite…'
                : 'Starting Worker…',
            );
            const child = fork(
              path.join(root, 'scripts/development-service.ts'),
              [component, mode],
              {
                cwd: root,
                silent: true,
                detached: process.platform !== 'win32',
                windowsHide: true,
                env: {
                  ...process.env,
                  FORCE_COLOR: dashboard.colors
                    ? (process.env.FORCE_COLOR ?? '1')
                    : '0',
                },
              },
            );
            children.push(child);
            if (component === 'maintenance') maintenanceChild = child;
            closed.push(
              new Promise<void>((resolve) =>
                child.once('close', () => resolve()),
              ),
            );
            for (const stream of [child.stdout!, child.stderr!])
              createInterface({ input: stream }).on('line', (line) =>
                dashboard.serviceLine(component, line, stream === child.stderr),
              );
            const timeout = setTimeout(() => {
              fail(component, 'Startup timed out');
              reject(
                new Error(
                  `${component} did not start within 60 seconds. Check its labeled output.`,
                ),
              );
            }, 60_000);
            child.on('message', (message) => {
              if (message !== 'ready' || stopping || failed.has(component)) {
                return;
              }

              clearTimeout(timeout);
              dashboard.setState(
                component,
                'ready',
                `Ready on http://127.0.0.1:${configs[index].dev.port}`,
              );
              resolve();
            });
            child.once('error', (error) => {
              clearTimeout(timeout);
              fail(component, 'Unable to start process');
              reject(error);
              if (!stopping) void shutdown(1);
            });
            child.once('exit', (code, signal) => {
              clearTimeout(timeout);
              if (stopping) {
                if (code && !signal)
                  fail(component, `Shutdown exited (${code})`);
                else if (!failed.has(component))
                  dashboard.setState(component, 'stopped', 'Stopped');
                return;
              }

              const error = new Error(
                `${component} exited (${signal || code}). Check its labeled output.`,
              );
              fail(component, `Exited (${signal || code})`);
              log(component, 'ERROR', error.message);
              reject(error);
              void shutdown(1);
            });
          }),
      ),
    );
    dashboard.enableControls(
      () => void shutdown(),
      maintenanceChild
        ? () => {
            if (!stopping && maintenanceChild?.connected)
              maintenanceChild.send('maintenance');
          }
        : undefined,
    );
    log(
      service,
      'READY',
      `All services ready in ${((performance.now() - startedAt) / 1000).toFixed(1)}s. Press Ctrl+C to stop.`,
    );
  } catch (error) {
    log(
      service,
      'ERROR',
      error instanceof Error ? error.message : String(error),
    );
    await shutdown(1);
  }
}
