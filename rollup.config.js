import commonjs from '@rollup/plugin-commonjs';
import dts from 'rollup-plugin-dts';
import ts from 'rollup-plugin-typescript2';

const override = { compilerOptions: { module: 'ESNext' } };

export default [
  {
    input: 'src/index.ts',
    output: [
      {
        file: 'dist/index.cjs',
        format: 'cjs',
      },
      {
        file: 'dist/index.mjs',
        format: 'esm',
      },
    ],
    plugins: [
      ts({
        tsconfig: 'tsconfig.json',
        tsconfigOverride: override,
      }),
      commonjs(),
    ],
  },
  {
    input: 'src/index.ts',
    output: {
      file: 'dist/index.d.ts',
      format: 'esm',
    },
    external: [],
    plugins: [dts({})],
  },
];
