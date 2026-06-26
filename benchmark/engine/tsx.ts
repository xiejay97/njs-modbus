/**
 * tsx execution-argument helpers.
 *
 * Centralizes the `execArgv` passed to worker threads and forked children so
 * that sub-processes resolve `njs-modbus` consistently with the parent process.
 */

const NJS_DIST_CONDITION = 'dist';
const NJS_DEV_CONDITION = 'dev';

function isDistMode(): boolean {
  const nodeOptions = process.env['NODE_OPTIONS'] ?? '';
  return (
    nodeOptions.includes(`conditions=${NJS_DIST_CONDITION}`) ||
    process.execArgv.some((arg) => arg.includes(`conditions=${NJS_DIST_CONDITION}`))
  );
}

/**
 * Build the `execArgv` for worker threads / forked children running under tsx.
 *
 * In source mode we pass `--conditions=dev` so children resolve to
 * `src/index.ts` just like the parent. In dist mode we pass
 * `--conditions=dist` so children resolve to `dist/index.mjs`.
 *
 * @param extra - Additional Node.js flags to append (e.g. `['--expose-gc']`).
 * @returns The execArgv array to pass to `Worker` or `fork`.
 */
export function getTsxExecArgv(extra: string[] = []): string[] {
  const condition = isDistMode() ? NJS_DIST_CONDITION : NJS_DEV_CONDITION;
  return [`--conditions=${condition}`, '--import', 'tsx', ...extra];
}
