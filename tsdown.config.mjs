import { readFileSync } from 'node:fs';
import { URL } from 'node:url';

import { defineConfig } from 'tsdown';

export default defineConfig({
  format: ['esm', 'cjs'],
  tsconfig: './tsconfig.build.json',
  dts: {
    generator: 'tsgo',
  },
  exports: false,
  platform: 'node',
  target: 'node18',
  deps: {
    neverBundle: true,
  },
  treeshake: {
    moduleSideEffects: false,
  },
  unused: {
    level: 'error',
  },
  define: {
    __VERSION__: `"${JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf-8')).version}"`,
  },
});
