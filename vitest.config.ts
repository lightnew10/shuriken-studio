import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@core': resolve(__dirname, 'src/core'),
    },
  },
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Never model in the user's running Kiln app, and never reach their Studio (its MCP server, a new Studio, its windows), from tests.
    // Tests that want Kiln point KILN_RUNTIME at their own; tests that want Studio use the simulated one (helpers/studio-sim).
    env: { SHURIKEN_NO_KILN: '1', SHURIKEN_NO_STUDIO: '1' },
    testTimeout: 30000,
    pool: 'forks',
    // Temporary folders of a run live under one folder, removed when it ends.
    globalSetup: ['tests/helpers/temp-root.ts'],
  },
});
