import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['domains/**/*.test.ts'],
    // Infrastructure tests synthesize real stacks (with bundling), so they need headroom.
    testTimeout: 120_000,
  },
});
