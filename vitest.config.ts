import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The web app's tsconfig keeps `jsx: preserve` for Next.js; tests render components directly.
  oxc: { jsx: { runtime: 'automatic' } },
  test: {
    include: ['apps/*/src/**/*.test.ts', 'packages/**/src/**/*.test.ts'],
    environment: 'node',
    // Integration tests share one database; keep files sequential.
    fileParallelism: false,
  },
});
