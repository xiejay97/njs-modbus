import type { EventEmitter } from 'node:events';

/** Drain the microtask queue so that pending event handlers run. */
export function flushPromises(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

/** Promise-ified event wait with an optional timeout. */
export function waitForEvent<T = unknown>(emitter: EventEmitter, event: string, timeoutMs = 1000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error(`Timeout waiting for "${event}"`));
    }, timeoutMs);

    const handler = (value: T) => {
      cleanup();
      resolve(value);
    };

    const cleanup = () => {
      clearTimeout(timer);
      emitter.off(event, handler as (...args: unknown[]) => void);
    };

    emitter.once(event, handler as (...args: unknown[]) => void);
  });
}

/** Attach collectors to a protocol layer's frame callbacks. */
export function collectFrames<T, E = { message: string }>(target: {
  onFrame?: ((frame: T) => void) | null;
  onFrameError?: ((event: E) => void) | null;
}): {
  frames: T[];
  errors: E[];
} {
  const frames: T[] = [];
  const errors: E[] = [];
  target.onFrame = (frame) => frames.push(frame);
  target.onFrameError = (event) => errors.push(event);
  return { frames, errors };
}
