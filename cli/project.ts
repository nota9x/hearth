import path from 'node:path';

export const root = path.resolve(import.meta.dirname, '..');
export const projects = {
  web: 'apps/web',
  delivery: 'workers/delivery',
  maintenance: 'workers/maintenance',
} as const;
export type Component = keyof typeof projects;
export const components = Object.keys(projects) as Component[];
