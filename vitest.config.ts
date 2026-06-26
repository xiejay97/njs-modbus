import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,

    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts'],
      reporter: ['text', 'html', 'json'],
    },

    testTimeout: 5000,
  },
  resolve: {
    tsconfigPaths: true,
  },
  define: {
    __VERSION__: `"${JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version}"`,
  },
});
