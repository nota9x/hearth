import { defineCommand } from 'citty';

import { reportError, validateOptions } from '../options.ts';
import { type Component, components } from '../project.ts';
import type { ServerMode } from './config.ts';

export const serverArguments = {
  services: {
    type: 'positional',
    required: false,
    description:
      'Services: web, delivery, maintenance (default: all). Use -- <tool args> for one service, or -- web <args> -- delivery <args>.',
  },
  'log-level': {
    type: 'enum',
    options: ['debug', 'info', 'warn', 'error', 'silent'] as string[],
    description: 'Native tool logging level.',
  },
  open: {
    type: 'boolean',
    description: 'Open the Vite development server in a browser.',
  },
  force: {
    type: 'boolean',
    description: 'Rebuild the Vite development dependency cache.',
  },
  port: {
    type: 'string',
    description: 'Listen port when selecting one service.',
  },
  'web-port': { type: 'string', description: 'Web listen port.' },
  'delivery-port': { type: 'string', description: 'Delivery listen port.' },
  'maintenance-port': {
    type: 'string',
    description: 'Maintenance listen port.',
  },
  host: {
    type: 'string',
    description: 'Web listen host (default: 127.0.0.1).',
  },
  'app-origin': {
    type: 'string',
    description: 'Canonical HTTP browser origin for this session.',
  },
} as const;

export interface ServerOptions {
  port?: string;
  'web-port'?: string;
  'delivery-port'?: string;
  'maintenance-port'?: string;
  host?: string;
  'app-origin'?: string;
  'log-level'?: string;
  open?: boolean;
  force?: boolean;
}

export function selectServices(selected: string[]): Component[] {
  for (const name of selected)
    if (!components.includes(name as Component))
      throw new Error(
        `Unknown service "${name}". Select web, delivery, or maintenance; use --help for examples.`,
      );
  return selected.length > 0
    ? ([...new Set(selected)] as Component[])
    : [...components];
}

export function toolArguments(selected: Component[], forwarded: string[]) {
  const result: Record<Component, string[]> = {
    web: [],
    delivery: [],
    maintenance: [],
  };
  if (forwarded.length === 0) return result;
  if (
    selected.length === 1 &&
    !components.includes(forwarded[0] as Component)
  ) {
    result[selected[0]] = forwarded;
    return result;
  }
  let remaining = forwarded;
  while (remaining.length > 0) {
    const [target, ...tokens] = remaining;
    if (!selected.includes(target as Component))
      throw new Error(
        `Target tool arguments explicitly: -- web <args> -- delivery <args>. "${target}" is not a selected service.`,
      );
    const separator = tokens.indexOf('--');
    const group = separator === -1 ? tokens : tokens.slice(0, separator);
    if (group.length === 0)
      throw new Error(`No tool arguments supplied for ${target}.`);
    result[target as Component].push(...group);
    remaining = separator === -1 ? [] : tokens.slice(separator + 1);
    if (separator !== -1 && remaining.length === 0)
      throw new Error('A trailing -- requires a service and tool arguments.');
  }
  return result;
}

export function serverCommand(mode: ServerMode, forwarded: string[]) {
  return defineCommand({
    meta: {
      name: mode === 'preview' ? 'preview' : 'dev',
      description:
        mode === 'preview'
          ? 'Preview built Hearth Workers with local storage.'
          : 'Run Hearth with Vite HMR and local Workers.',
    },
    args: serverArguments,
    async run({ args, rawArgs }) {
      try {
        validateOptions(rawArgs, serverArguments);
        const selected = selectServices(args._);
        const native = toolArguments(selected, forwarded);
        const { startServer } = await import('./server.ts');
        await startServer(mode, selected, args, native);
      } catch (error) {
        reportError(error);
      }
    },
  });
}
