/**
 * Promise timeout helpers.
 *
 * These are intentionally separate from the worker/fork wrappers so timeouts
 * live at the operation level (connect/listen/open/close) rather than acting as
 * a coarse global kill switch.
 */

/**
 * Race a promise against a timer. Rejects with a descriptive message if the
 * timer fires first. The original promise is not cancelled; callers should
 * ensure it cannot leak resources.
 */
export function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);

    promise.then(
      (value) => {
        clearTimeout(timeout);
        resolve(value);
      },
      (err) => {
        clearTimeout(timeout);
        reject(err);
      },
    );
  });
}

/**
 * Wrap a cleanup promise with a timeout. On timeout or error, log a warning
 * and invoke the optional `onTimeout` hook, but never reject. This lets a
 * benchmark cell finish even when a socket/serial close hangs.
 */
export async function withCleanupTimeout(promise: Promise<void>, ms: number, label: string, onTimeout?: () => void): Promise<void> {
  try {
    await withTimeout(promise, ms, label);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[cleanup] ${label}: ${message}\n`);
    onTimeout?.();
  }
}
