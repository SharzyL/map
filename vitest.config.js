import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'scripts/**/*.test.mjs'],
  },
  define: {
    __STYLE_HASH__: JSON.stringify('test'),
  },
});
