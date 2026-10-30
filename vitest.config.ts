import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'release',
          environment: 'node',
          include: ['tests/release.test.ts', 'tests/licenses.test.ts'],
        },
      },
      {
        test: {
          name: 'e2e',
          environment: 'node',
          include: ['tests/e2e.test.ts'],
          fileParallelism: false,
          hookTimeout: 30_000,
        },
      },
    ],
  },
});
