import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The data the Worker bundles: always the fixtures, whatever was built here
  resolve: {
    alias: {
      'build-data': new URL('./src/worker/api/fixtures/build-data', import.meta.url).pathname,
    },
  },
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs', 'data_builder/**/*.test.mjs'],
  },
  define: {
    __STYLE_HASH__: JSON.stringify('test'),
  },
});
