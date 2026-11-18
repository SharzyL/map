import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The Worker's station files: always the fixtures, whatever was built here
  resolve: {
    alias: {
      'station-data': new URL('./src/worker/api/fixtures/stations', import.meta.url).pathname,
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
  define: {
    __STYLE_HASH__: JSON.stringify('test'),
  },
});
