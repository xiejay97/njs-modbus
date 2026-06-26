/**
 * Concurrency-controlled task scheduler.
 *
 * Supports both a static concurrency cap and a dynamic slot client
 * (e.g., `SlotClient` from `../slot-client.js`). Tasks are returned in input
 * order; errors are captured as `ExecutionResult.error` rather than thrown.
 */

import type { ExecutionOptions, ExecutionResult, ExecutionTask, SlotClientLike } from './types';

export function isSlotClient(value: number | SlotClientLike): value is SlotClientLike {
  return (
    typeof value === 'object' &&
    value !== null &&
    'acquire' in value &&
    'release' in value &&
    typeof (value as SlotClientLike).acquire === 'function' &&
    typeof (value as SlotClientLike).release === 'function'
  );
}

/**
 * Run a batch of tasks with bounded concurrency.
 *
 * When `options.concurrency` is a `SlotClientLike`, each task acquires one
 * slot before starting and releases it on completion. This lets fast tasks
 * lend capacity to slow tasks dynamically.
 */
export async function runTasks<TInput, TOutput>(
  tasks: ExecutionTask<TInput, TOutput>[],
  options: ExecutionOptions,
): Promise<ExecutionResult<TOutput>[]> {
  const { concurrency } = options;
  const useSlots = isSlotClient(concurrency);

  const results = new Array<ExecutionResult<TOutput>>(tasks.length);
  let next = 0;

  async function spawn(): Promise<void> {
    while (true) {
      const i = next++;
      if (i >= tasks.length) {
        return;
      }

      if (useSlots) {
        await (concurrency as SlotClientLike).acquire(1);
      }
      try {
        const task = tasks[i];
        const start = performance.now();
        try {
          const output = await task.execute(task.input);
          results[i] = {
            taskId: task.id,
            output,
            durationMs: performance.now() - start,
          };
        } catch (err) {
          results[i] = {
            taskId: task.id,
            output: null,
            error: err instanceof Error ? err.message : String(err),
            durationMs: performance.now() - start,
          };
        }
      } finally {
        if (useSlots) {
          await (concurrency as SlotClientLike).release(1);
        }
      }
    }
  }

  const limit = useSlots ? tasks.length : Math.min(concurrency as number, tasks.length);
  await Promise.all(Array.from({ length: limit }, () => spawn()));
  return results;
}
