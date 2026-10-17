import { readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import ts from 'typescript';
import { z } from 'zod';

import { configSchema } from '../../packages/core/common';
import { type Component, components, projects, root } from '../project';
import type { ServerOptions } from './command';

export { type Component, projects, root } from '../project';
export const persistence = path.join(root, 'apps/web/.wrangler/state');
export type ServerMode = 'development' | 'preview';

const schema = z.looseObject({
  main: z.string(),
  vars: z.record(z.string(), z.string()).default({}),
  dev: z.looseObject({
    ip: z.string().default('127.0.0.1'),
    port: z.number().int().min(1).max(65_535),
    // Let the OS assign inspector ports when starting Workers concurrently.
    inspector_port: z.number().int().min(0).max(65_535).default(0),
  }),
  d1_databases: z
    .array(
      z.object({ binding: z.literal('DB'), database_id: z.string().min(1) }),
    )
    .nonempty(),
  r2_buckets: z
    .array(
      z.object({
        binding: z.literal('BUCKET'),
        bucket_name: z.string().min(1),
      }),
    )
    .nonempty(),
  triggers: z.object({ crons: z.array(z.string()).nonempty() }).optional(),
});

export async function readDevelopmentConfig(component: Component) {
  const directory = path.join(root, projects[component]);
  const config = path.join(directory, 'wrangler.jsonc');
  const parsed = ts.parseConfigFileTextToJson(
    config,
    await readFile(config, 'utf8'),
  );
  if (parsed.error) throw new Error(`Invalid JSONC in ${config}`);
  const result = schema.safeParse(parsed.config);
  if (!result.success)
    throw new Error(
      `Invalid local configuration in ${config}: ${result.error.message}`,
    );
  if (component === 'maintenance' && !result.data.triggers)
    throw new Error(
      `Missing triggers.crons in ${config}. Configure the production maintenance schedule there.`,
    );
  return {
    directory,
    config,
    source: parsed.config as Record<string, unknown>,
    ...result.data,
  };
}

function portNumber(value: string | number) {
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535)
    throw new Error(`Invalid port "${value}". Use an integer from 1 to 65535.`);
  return port;
}

export function nativeOptions(
  component: Component,
  mode: ServerMode,
  tokens: string[],
) {
  const vite = component === 'web' && mode === 'development';
  const output: string[] = [];
  let port: number | undefined;
  let host: string | undefined;
  let interactive = false;
  for (let index = 0; index < tokens.length; index++) {
    const token = tokens[index];
    const equals = token.indexOf('=');
    const key = (equals === -1 ? token : token.slice(0, equals)).replaceAll(
      /[A-Z]/g,
      (letter) => `-${letter.toLowerCase()}`,
    );
    const inline = equals === -1 ? undefined : token.slice(equals + 1);
    const value = () => {
      const result = inline ?? tokens[++index];
      if (!result || result.startsWith('-'))
        throw new Error(`${key} requires a value.`);
      return result;
    };
    switch (key) {
      case '--port': {
        port = portNumber(value());
        continue;
      }
      case vite ? '--host' : '--ip': {
        host =
          vite &&
          inline === undefined &&
          (tokens[index + 1] === undefined || tokens[index + 1].startsWith('-'))
            ? '0.0.0.0'
            : value();
        continue;
      }
      case '--local-protocol': {
        if (value() !== 'http')
          throw new Error('Hearth local sessions require HTTP.');
        continue;
      }
      case '--local':
      case '-l':
      case '--strict-port':
      case '--remote':
      case '-r':
      case '--https': {
        const enabled =
          inline ??
          (['true', 'false'].includes(tokens[index + 1])
            ? tokens[++index]
            : 'true');
        const required = ['--local', '-l', '--strict-port'].includes(key)
          ? 'true'
          : 'false';
        if (enabled !== required)
          throw new Error(
            `${component}: ${key} conflicts with Hearth's managed local session.`,
          );
        continue;
      }
      default: {
        if (
          [
            '--config',
            '-c',
            '--cwd',
            '--env',
            '-e',
            '--env-file',
            '--persist-to',
            '--no-local',
            '--no-strict-port',
            '--https-key-path',
            '--https-cert-path',
          ].includes(key) ||
          /^-[cer].+/.test(key)
        )
          throw new Error(
            `${component}: ${key} conflicts with Hearth's managed HTTP, configuration, or local storage. Use Hearth host/port options or edit the checked-in local configuration.`,
          );
        if (!vite && key === '--var') {
          const variables = inline === undefined ? [] : [inline];
          if (inline === undefined) {
            let next = index + 1;
            while (next < tokens.length && !tokens[next].startsWith('-'))
              variables.push(tokens[next++]);
          }

          if (
            variables.some((entry) =>
              /^(?:APP_ORIGIN|LOCAL_DELIVERY_PORT|ENVIRONMENT|DB|BUCKET)[:=]/.test(
                entry,
              ),
            )
          )
            throw new Error(
              `${component}: use Hearth options for reserved origin, environment, and storage bindings.`,
            );
        }
        if (!vite && key === '--show-interactive-dev-session')
          interactive = (inline ?? tokens[index + 1]) !== 'false';
        output.push(token);
      }
    }
  }
  if (!vite && host && !['127.0.0.1', '0.0.0.0', 'localhost'].includes(host))
    throw new Error(
      `${component} must listen on 127.0.0.1 or 0.0.0.0 so local domain validation can reach it.`,
    );
  return {
    tokens: output,
    port,
    host: host === 'localhost' && !vite ? '127.0.0.1' : host,
    interactive,
  };
}

export async function prepareSession(
  mode: ServerMode,
  selected: Component[],
  options: ServerOptions,
  native: Record<Component, string[]>,
) {
  if (options.port && selected.length !== 1)
    throw new Error(
      '--port requires one service. Use --web-port, --delivery-port, or --maintenance-port.',
    );
  if (
    (options.open !== undefined || options.force !== undefined) &&
    (mode !== 'development' || !selected.includes('web'))
  )
    throw new Error('--open and --force require the web development service.');
  const loaded = await Promise.all(
    components.map((component) => readDevelopmentConfig(component)),
  );
  const configs = Object.fromEntries(
    components.map((component, index) => [component, loaded[index]]),
  ) as Record<Component, Awaited<ReturnType<typeof readDevelopmentConfig>>>;
  const web = configs.web;
  configSchema.parse(web.vars);
  if (
    web.vars.APP_ORIGIN !== `http://127.0.0.1:${web.dev.port}` ||
    configs.delivery.vars.APP_ORIGIN !== web.vars.APP_ORIGIN ||
    web.vars.LOCAL_DELIVERY_PORT !== String(configs.delivery.dev.port)
  )
    throw new Error(
      'Local APP_ORIGIN and LOCAL_DELIVERY_PORT must match the configured web and delivery ports.',
    );
  for (const config of loaded) {
    if (
      JSON.stringify(config.d1_databases) !==
        JSON.stringify(web.d1_databases) ||
      JSON.stringify(config.r2_buckets) !== JSON.stringify(web.r2_buckets)
    )
      throw new Error(
        `${config.config}: DB and BUCKET must match the web local resource identifiers.`,
      );
    if (JSON.stringify(config.source).includes('"remote":true'))
      throw new Error(
        `${config.config}: remote bindings are not supported by local Hearth workflows.`,
      );
  }
  const tools = Object.fromEntries(
    components.map((component) => [
      component,
      nativeOptions(component, mode, native[component]),
    ]),
  ) as Record<Component, ReturnType<typeof nativeOptions>>;
  if (
    selected.length !== 1 &&
    selected.some((component) => tools[component].interactive)
  )
    throw new Error(
      'Native interactive controls require a single selected service.',
    );
  for (const component of components) {
    const config = configs[component];
    config.dev.port =
      tools[component].port ??
      portNumber(
        (selected.length === 1 && selected[0] === component
          ? options.port
          : undefined) ??
          options[`${component}-port`] ??
          config.dev.port,
      );
    config.dev.ip =
      tools[component].host ??
      (component === 'web' ? options.host : undefined) ??
      config.dev.ip;
    if (
      component !== 'web' &&
      !['127.0.0.1', '0.0.0.0'].includes(config.dev.ip)
    )
      throw new Error(`${component} must retain IPv4 loopback access.`);
  }
  if (
    new Set(selected.map((component) => configs[component].dev.port)).size !==
    selected.length
  )
    throw new Error('Selected services must use distinct listen ports.');
  const originHost = ['0.0.0.0', '::', '[::]'].includes(web.dev.ip)
    ? '127.0.0.1'
    : web.dev.ip.includes(':') && !web.dev.ip.startsWith('[')
      ? `[${web.dev.ip}]`
      : web.dev.ip;
  const origin =
    options['app-origin'] ?? `http://${originHost}:${web.dev.port}`;
  const url = new URL(origin);
  if (
    url.protocol !== 'http:' ||
    url.origin !== origin ||
    Number(url.port || 80) !== web.dev.port
  )
    throw new Error(
      '--app-origin must be a canonical HTTP origin using the effective web port.',
    );
  web.vars.APP_ORIGIN = configs.delivery.vars.APP_ORIGIN = origin;
  web.vars.LOCAL_DELIVERY_PORT = String(configs.delivery.dev.port);
  const session = crypto.randomUUID();
  const files = components.map((component) =>
    path.join(configs[component].directory, `hearth-${session}.local.jsonc`),
  );
  async function refresh(component: Component) {
    const original = await readDevelopmentConfig(component);
    // Runtime addresses and security variables stay stable until the next launch.
    const current = configs[component];
    const source = {
      ...original.source,
      dev: current.dev,
      vars: {
        ...original.vars,
        ...Object.fromEntries(
          Object.entries(current.vars).filter(([key]) =>
            ['APP_ORIGIN', 'LOCAL_DELIVERY_PORT', 'ENVIRONMENT'].includes(key),
          ),
        ),
      },
    };
    if (JSON.stringify(source).includes('"remote":true'))
      throw new Error(
        'Remote bindings cannot be enabled during a local session.',
      );
    if (
      JSON.stringify(original.d1_databases) !==
        JSON.stringify(current.d1_databases) ||
      JSON.stringify(original.r2_buckets) !== JSON.stringify(current.r2_buckets)
    )
      throw new Error('Restart Hearth after changing local storage bindings.');
    await writeFile(
      files[components.indexOf(component)],
      JSON.stringify(source),
      { mode: 0o600 },
    );
    return original;
  }
  async function cleanup() {
    await Promise.all(files.map((file) => rm(file, { force: true })));
  }
  try {
    for (const component of components) await refresh(component);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return {
    configs,
    tools,
    files: Object.fromEntries(
      components.map((component, index) => [component, files[index]]),
    ) as Record<Component, string>,
    refresh,
    cleanup,
  };
}
