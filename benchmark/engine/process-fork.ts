/**
 * Forked child process helper.
 *
 * Wraps `child_process.fork` with a single IPC result and guaranteed cleanup.
 * Used by benchmarks that need process-level isolation (chaos, transport,
 * serial-port compatibility).
 */

import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

function resolveModulePath(modulePath: string): string {
  if (modulePath.startsWith('file://')) {
    return fileURLToPath(modulePath);
  }
  return modulePath;
}

export interface ForkOptions {
  /** Absolute or relative path to the worker module. */
  modulePath: string;
  /** Environment variables passed to the child. */
  env?: Record<string, string>;
  /** Extra Node.js exec arguments (e.g. `['--import', 'tsx/esm', '--expose-gc']`). */
  execArgv?: string[];
}

/** Grace period for the IPC channel to flush a result after the child exits. */
const IPC_FLUSH_GRACE_MS = 500;

/**
 * Fork a child process and wait for a single IPC message containing the
 * result. Rejects on process error, or exit without a result.
 */
export function runForkedChild<TOutput>(options: ForkOptions): Promise<TOutput> {
  const { modulePath, env, execArgv = [] } = options;

  return new Promise((resolve, reject) => {
    const child = fork(resolveModulePath(modulePath), [], {
      execArgv,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });

    let settled = false;
    let graceTimer: NodeJS.Timeout | null = null;

    function cleanup(): void {
      settled = true;
      if (graceTimer !== null) {
        clearTimeout(graceTimer);
        graceTimer = null;
      }
    }

    child.once('message', (msg: any) => {
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

    child.once('error', (err) => {
      if (settled) {
        return;
      }
      cleanup();
      reject(err);
    });

    child.once('exit', (code) => {
      if (settled) {
        return;
      }
      if (code !== 0) {
        cleanup();
        reject(new Error(`Child exited with code ${code} without a result`));
        return;
      }
      // The child exited successfully but the result message has not arrived
      // yet. Give the IPC channel a brief grace period to flush before treating
      // the run as a failure.
      graceTimer = setTimeout(() => {
        if (settled) {
          return;
        }
        cleanup();
        reject(new Error(`Child exited with code ${code} without a result`));
      }, IPC_FLUSH_GRACE_MS);
    });
  });
}
