/**
 * Worker thread helper.
 *
 * Wraps `worker_threads.Worker` with a single message result, timeout
 * handling, and guaranteed termination. Used by CPU-bound benchmarks that
 * do not need `child_process.fork` isolation.
 */

import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';

function resolveModulePath(modulePath: string): string {
  if (modulePath.startsWith('file://')) {
    return fileURLToPath(modulePath);
  }
  return modulePath;
}

export interface WorkerOptions<TInput> {
  /** Absolute or relative path to the worker module. */
  modulePath: string;
  /** Data passed to `workerData` inside the worker. */
  workerData: TInput;
  /** Extra Node.js exec arguments (e.g. `['--import', 'tsx/esm']`). */
  execArgv?: string[];
}

/**
 * Spawn a worker thread and wait for a single message containing the
 * result. Rejects on timeout, worker error, or non-zero exit without a
 * result.
 */
export function runWorkerThread<TInput, TOutput>(options: WorkerOptions<TInput>): Promise<TOutput> {
  const { modulePath, workerData, execArgv = [] } = options;

  return new Promise((resolve, reject) => {
    const worker = new Worker(resolveModulePath(modulePath), {
      workerData,
      execArgv,
    });

    let settled = false;

    function cleanup(): void {
      settled = true;
      worker.terminate().catch(() => {
        /* ignore */
      });
    }

    worker.on('message', (msg: any) => {
      if (settled) {
        return;
      }
      cleanup();
      if (msg && msg.error) {
        reject(new Error(msg.error));
      } else {
        resolve(msg as TOutput);
      }
    });

    worker.on('error', (err) => {
      if (settled) {
        return;
      }
      cleanup();
      reject(err);
    });

    worker.on('exit', (code) => {
      if (settled) {
        return;
      }
      cleanup();
      reject(new Error(`Worker exited with code ${code ?? 'null'} without a result`));
    });
  });
}
