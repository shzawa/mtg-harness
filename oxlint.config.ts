import { defineConfig } from 'oxlint';

export default defineConfig({
  plugins: ['typescript', 'unicorn', 'oxc', 'vitest'],
  categories: {
    correctness: 'error',
  },
  rules: {
    'typescript/no-explicit-any': 'error',
    'vitest/no-focused-tests': 'error',
    'vitest/valid-expect': ['error', { maxArgs: 2 }],
  },
  overrides: [
    {
      files: ['tests/release.test.ts', 'tests/e2e.test.ts'],
      rules: {
        // Command-dispatch mocks and dialog helpers assert within real branches.
        'vitest/no-conditional-expect': 'off',
      },
    },
    {
      files: ['tests/e2e.test.ts'],
      rules: {
        'vitest/expect-expect': [
          'error',
          {
            assertFunctionNames: ['expect', 'closeWithConfirmation', 'closeWithoutConfirmation'],
          },
        ],
      },
    },
  ],
});
