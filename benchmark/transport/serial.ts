/**
 * Serial transport helpers.
 *
 * Wraps socat PTY pair creation and SerialPort bindings. The benchmark core
 * only sees a `TransportHandle`; the serial-specific plumbing (baud rate,
 * path discovery) lives here.
 */

import type { PtyPair, SerialServerHandle, SerialTransportOptions, TransportHandle } from './types';

import { spawn } from 'node:child_process';

import { withCleanupTimeout, withTimeout } from '../engine/timeout';

const DEFAULT_BAUD_RATE = 115200;
const CONNECT_TIMEOUT_MS = 10000;
const CLEANUP_TIMEOUT_MS = 10000;

/** Spawn a socat PTY pair and return the two device paths. */
export function spawnPtyPair(): Promise<PtyPair> {
  return new Promise((resolve, reject) => {
    const proc = spawn('socat', ['-d', '-d', 'pty,raw,echo=0', 'pty,raw,echo=0'], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    const stderr = proc.stderr;
    if (!stderr) {
      reject(new Error('socat process has no stderr'));
      return;
    }

    const paths: string[] = [];
    let resolved = false;

    function finish(): void {
      if (resolved) {
        return;
      }
      resolved = true;
      stderr.removeAllListeners('data');
    }

    proc.once('error', (err) => {
      finish();
      reject(new Error(`socat failed: ${err.message}`));
    });

    proc.once('exit', (code) => {
      finish();
      reject(new Error(`socat exited prematurely with code ${code}`));
    });

    stderr.on('data', (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      for (const line of text.split('\n')) {
        const match = /PTY is (\/\S+)/.exec(line);
        if (match) {
          paths.push(match[1]);
          if (paths.length === 2) {
            finish();
            // Brief pause lets socat finish tty setup before callers open the paths.
            setTimeout(() => {
              resolve({ proc, masterPath: paths[0], slavePath: paths[1] });
            }, 50);
          }
        }
      }
    });

    setTimeout(() => {
      if (resolved) {
        return;
      }
      finish();
      try {
        proc.kill('SIGTERM');
      } catch {
        /* ignore */
      }
      reject(new Error('socat did not announce two PTY paths within 3s'));
    }, 3000);
  });
}

/** Terminate a socat PTY pair. */
export function closePtyPair(pair: PtyPair): void {
  try {
    pair.proc.kill('SIGTERM');
  } catch {
    /* ignore */
  }
}

interface SerialPortModule {
  SerialPort: new (options: Record<string, unknown>) => SerialPortLike;
}

interface SerialPortLike {
  path: string;
  on: (event: string, handler: (...args: unknown[]) => void) => void;
  off: (event: string, handler: (...args: unknown[]) => void) => void;
  write: (data: Buffer, cb?: (err: Error | null) => void) => void;
  close: (cb?: (err: Error | null) => void) => void;
  open: (cb?: (err: Error | null) => void) => void;
}

async function loadSerialport(): Promise<SerialPortModule> {
  // serialport is an optional peer dependency; lazy-load so the benchmark can
  // still run TCP-only tests when it is not installed.
  const mod = await import('serialport');
  return mod as unknown as SerialPortModule;
}

function buildSerialOptions(path: string, options: SerialTransportOptions): Record<string, unknown> {
  return {
    path,
    baudRate: options.baudRate ?? DEFAULT_BAUD_RATE,
    dataBits: options.dataBits ?? 8,
    stopBits: options.stopBits ?? 1,
    parity: options.parity ?? 'none',
    autoOpen: false,
  };
}

function wrapSerialPort(port: SerialPortLike, path: string): TransportHandle {
  return {
    path,
    write: (data, callback) => {
      port.write(data, (err) => callback?.(err ?? undefined));
    },
    end: () =>
      withCleanupTimeout(
        new Promise<void>((resolve) => {
          port.close(() => resolve());
        }),
        CLEANUP_TIMEOUT_MS,
        `serial port ${path} close`,
      ),
    onData: (handler) => {
      const wrapped = (chunk: unknown) => handler(chunk as Buffer);
      port.on('data', wrapped);
      return () => {
        port.off('data', wrapped);
      };
    },
  };
}

/** Open a SerialPort at the given PTY path. */
export async function connectSerialPort(path: string, options: SerialTransportOptions = {}): Promise<TransportHandle> {
  const { SerialPort } = await loadSerialport();
  const port = new SerialPort(buildSerialOptions(path, options));

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => reject(err as Error);
      port.on('error', onError);
      port.open((err) => {
        port.off('error', onError);
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    }),
    CONNECT_TIMEOUT_MS,
    `serial port ${path} open`,
  );

  return wrapSerialPort(port, path);
}

/** Create a SerialPort-based server handle bound to a PTY path. */
export async function createSerialServer(path: string, options: SerialTransportOptions = {}): Promise<SerialServerHandle> {
  const { SerialPort } = await loadSerialport();
  const port = new SerialPort(buildSerialOptions(path, options));

  await withTimeout(
    new Promise<void>((resolve, reject) => {
      const onError = (err: unknown) => reject(err as Error);
      port.on('error', onError);
      port.open((err) => {
        port.off('error', onError);
        if (err) {
          reject(err);
          return;
        }
        resolve();
      });
    }),
    CONNECT_TIMEOUT_MS,
    `serial server ${path} open`,
  );

  return {
    path,
    close: () =>
      withCleanupTimeout(
        new Promise<void>((resolve) => {
          port.close(() => resolve());
        }),
        CLEANUP_TIMEOUT_MS,
        `serial server ${path} close`,
      ),
  };
}
