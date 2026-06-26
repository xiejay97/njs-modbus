/**
 * Execution engine public API.
 *
 * Schedules benchmark tasks with bounded concurrency and runs them in the
 * requested process model (fork / worker thread / in-process).
 */

export type * from './types';
export { isSlotClient, runTasks } from './task-scheduler';
export { runForkedChild, type ForkOptions } from './process-fork';
export { runWorkerThread, type WorkerOptions } from './process-worker';
export { withCleanupTimeout, withTimeout } from './timeout';
