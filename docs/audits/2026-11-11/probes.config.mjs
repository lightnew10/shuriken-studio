import { resolve } from 'node:path';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: { alias: { '@shared': resolve('src/shared'), '@core': resolve('src/core') } },
  test: {
    include: ['docs/audits/2026-11-11/probes.test.ts'],
    environment: 'node', pool: 'forks', maxWorkers: 1,
    env: { SHURIKEN_NO_KILN: '1', SHURIKEN_NO_STUDIO: '1' },
    globalSetup: ['tests/helpers/temp-root.ts'],
  },
});
