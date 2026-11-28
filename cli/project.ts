import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');
export const projects = {
  web: 'apps/web',
  delivery: 'workers/delivery',
  maintenance: 'workers/maintenance',
} as const;
export const webWorkerEntry = '.svelte-kit/cloudflare/worker/index.js';
export type Component = keyof typeof projects;
export const components = Object.keys(projects) as Component[];
