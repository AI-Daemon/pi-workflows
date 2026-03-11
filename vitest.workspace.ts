import { defineWorkspace } from 'vitest/config';

export default defineWorkspace([
  {
    test: {
      name: 'unit',
      include: ['tests/unit/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'integration',
      include: ['tests/integration/**/*.test.ts'],
    },
  },
  {
    test: {
      name: 'e2e',
      include: ['tests/e2e/**/*.e2e.test.ts'],
      testTimeout: 30000,
      hookTimeout: 10000,
      sequence: {
        concurrent: false,
      },
    },
  },
]);
