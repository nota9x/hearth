import { readFileSync } from 'node:fs';
import path from 'node:path';

import ts from 'typescript';
import { inject } from 'vitest';

declare module 'vitest' {
  export interface ProvidedContext {
    workerBundles: string;
  }
}

export function workerCompatibility(
  name: 'web' | 'delivery' | 'maintenance' = 'web',
) {
  const file =
    name === 'web'
      ? 'apps/web/wrangler.jsonc'
      : `workers/${name}/wrangler.jsonc`;
  const config = ts.parseConfigFileTextToJson(file, readFileSync(file, 'utf8'))
    .config as {
    compatibility_date: string;
    compatibility_flags: string[];
  };
  return {
    cf: false as const,
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
  };
}

export function workerBundle(
  name: 'upload' | 'delivery' | 'maintenance-fault',
) {
  const file = {
    upload: 'upload-worker.js',
    delivery: 'index.js',
    'maintenance-fault': 'maintenance-worker.js',
  }[name];
  return path.join(inject('workerBundles'), name, file);
}
