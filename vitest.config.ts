import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    setupFiles: ['tests/helpers/cleanup.ts'],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    maxWorkers: 2,
    sequence: { hooks: 'list' },
    projects: [
      {
        extends: true,
        test: { name: 'unit', include: ['tests/unit/**/*.test.ts'] },
      },
      {
        extends: true,
        test: {
          name: 'integration',
          include: ['tests/integration/**/*.test.ts'],
          globalSetup: ['tests/helpers/build-workers.ts'],
        },
      },
    ],
  },
});
