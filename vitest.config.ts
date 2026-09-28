import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one database; keep files sequential.
    fileParallelism: false,
  },
});
