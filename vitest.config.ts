import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['packages/*/src/**/*.test.ts'],
    environment: 'node',
  },
  resolve: {
    alias: {
      '@sr/schema': new URL('./packages/schema/src/index.ts', import.meta.url).pathname,
      '@sr/core': new URL('./packages/core/src/index.ts', import.meta.url).pathname,
      '@sr/storage': new URL('./packages/storage/src/index.ts', import.meta.url).pathname,
    },
  },
});
