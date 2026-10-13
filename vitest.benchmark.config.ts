import { defineConfig } from 'vitest/config';

import original from './vitest.config.ts';

export default defineConfig({
  resolve: original.resolve,
  test: {
    include: ['tests/benchmarks/**/*.test.ts'],
    globalSetup: ['tests/helpers/build-workers.ts'],
    testTimeout: 180_000,
    hookTimeout: 30_000,
    maxWorkers: 1,
  },
});
