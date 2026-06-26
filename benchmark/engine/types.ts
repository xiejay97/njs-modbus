/**
 * Execution engine types.
 *
 * Provides a protocol- and library-independent contract for scheduling
 * benchmark tasks across forked children, worker threads, or in-process
 * execution.
 */

/** Process model used to isolate a task. */
export type ProcessModelKind = 'fork' | 'worker' | 'in-process';

/** Minimal surface needed from a dynamic slot client. */
export interface SlotClientLike {
  acquire: (count?: number) => Promise<void>;
  release: (count?: number) => Promise<void>;
}

/** A single benchmark task. */
export interface ExecutionTask<TInput, TOutput> {
  /** Unique task identifier. */
  id: string;
  /** Input passed to the task executor. */
  input: TInput;
  /** Execute the task and return its output. */
  execute: (input: TInput) => Promise<TOutput>;
}

/** Result of executing one task. */
export interface ExecutionResult<TOutput> {
  taskId: string;
  /** Resolved output, or `null` if the task threw. */
  output: TOutput | null;
  /** Human-readable error message when `output` is `null`. */
  error?: string;
  /** Wall-clock duration of the task in milliseconds. */
  durationMs: number;
}

/** Options for running a batch of tasks. */
export interface ExecutionOptions {
  /** Static concurrency cap or dynamic slot client. */
  concurrency: number | SlotClientLike;
}
