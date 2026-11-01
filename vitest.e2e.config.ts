import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

/** Live end-to-end runs against real Claude and real Roblox Studio (slow, costs usage). */
export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
    },
  },
  test: {
    include: ['tests/e2e/**/*.e2e.ts'],
    environment: 'node',
    // Never model in the user's running Kiln app from tests (tests that want Kiln point KILN_RUNTIME at their own).
    env: { SHURIKEN_NO_KILN: '1' },
    testTimeout: 3 * 60 * 60 * 1000,
    hookTimeout: 10 * 60 * 1000,
    pool: 'forks',
    fileParallelism: false,
  },
});
