/**
 * Raw TCP transport helpers.
 *
 * Enforces the benchmark's socket purity rules:
 *   - Nagle is always disabled (`setNoDelay(true)`) unless explicitly opted out.
 *   - Optional fixed `SO_SNDBUF/SO_RCVBUF` via CLI-friendly flags.
 *   - Writes preserve caller boundaries so sticky/scene chunking reaches the
 *     kernel exactly as requested.
 */

import type { TcpServerHandle, TcpTransportOptions, TransportHandle } from './types';

import net from 'node:net';

import { withCleanupTimeout } from '../engine/timeout';

const DEFAULT_HOST = '127.0.0.1';
const CONNECT_TIMEOUT_MS = 10000;
const CLEANUP_TIMEOUT_MS = 10000;

function applySocketOptions(socket: net.Socket, options: TcpTransportOptions): void {
  // Nagle control is the primary correctness knob for chaos/transport tests.
  const noDelay = options.noDelay ?? true;
  socket.setNoDelay(noDelay);

  if (options.sendBufferSize !== undefined) {
    // setSendBufferSize was added in Node 18.10; cast for older @types/node.
    (socket as unknown as { setSendBufferSize: (size: number) => void }).setSendBufferSize(options.sendBufferSize);
  }
  if (options.receiveBufferSize !== undefined) {
    (socket as unknown as { setReceiveBufferSize: (size: number) => void }).setReceiveBufferSize(options.receiveBufferSize);
  }
}

/**
 * Connect a raw TCP client with benchmark-appropriate defaults.
 *
 * The returned handle uses `socket.write` callbacks so callers can await
 * per-chunk backpressure. `setNoDelay` is exposed so late-binding callers
 * can still toggle Nagle.
 */
export function connectRawTcpClient(port: number, options: TcpTransportOptions = {}): Promise<TransportHandle> {
  const host = options.host ?? DEFAULT_HOST;

  return new Promise((resolve, reject) => {
    const socket = new net.Socket();
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`raw TCP client connect to ${host}:${port} timed out after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    socket.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    socket.connect({ port, host }, () => {
      clearTimeout(timer);
      socket.off('error', reject);
      applySocketOptions(socket, options);

      const handle: TransportHandle = {
        path: `${host}:${port}`,
        write: (data, callback) => {
          socket.write(data, (err) => callback?.(err ?? undefined));
        },
        end: () =>
          withCleanupTimeout(
            new Promise<void>((res) => {
              if (socket.destroyed) {
                res();
                return;
              }
              socket.end(() => res());
            }),
            CLEANUP_TIMEOUT_MS,
            'raw TCP socket end',
            () => {
              try {
                socket.destroy();
              } catch {
                /* ignore */
              }
            },
          ),
        onData: (handler) => {
          socket.on('data', handler);
          return () => {
            socket.off('data', handler);
          };
        },
        setNoDelay: (noDelay) => {
          socket.setNoDelay(noDelay);
        },
      };

      resolve(handle);
    });
  });
}

/**
 * Create a raw TCP server that hands off incoming sockets to a handler.
 *
 * Used by library adapters when they need to create their own server, but
 * still want consistent buffer/Nagle defaults for accepted sockets.
 */
export function createRawTcpServer(
  port: number,
  onConnection: (socket: net.Socket) => void,
  options: TcpTransportOptions = {},
): Promise<TcpServerHandle> {
  const host = options.host ?? DEFAULT_HOST;

  return new Promise((resolve, reject) => {
    const sockets = new Set<net.Socket>();
    const server = net.createServer((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
      applySocketOptions(socket, options);
      onConnection(socket);
    });

    const timer = setTimeout(() => {
      server.close();
      reject(new Error(`raw TCP server listen on ${host}:${port} timed out after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);

    server.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });

    server.listen(port, host, () => {
      clearTimeout(timer);
      server.off('error', reject);
      resolve({
        port: (server.address() as net.AddressInfo).port,
        close: () =>
          withCleanupTimeout(
            new Promise<void>((res) => {
              for (const socket of sockets) {
                try {
                  socket.destroy();
                } catch {
                  /* ignore */
                }
              }
              server.close(() => res());
            }),
            CLEANUP_TIMEOUT_MS,
            'raw TCP server close',
          ),
      });
    });
  });
}

/**
 * Promise wrapper for a single callback-based write.
 * Use only at boundaries; prefer `writeChunks` for hot paths.
 */
export function writeAsync(handle: TransportHandle, data: Buffer): Promise<void> {
  return new Promise((resolve, reject) => {
    handle.write(data, (err) => (err ? reject(err) : resolve()));
  });
}

/**
 * Write a sequence of chunks without coalescing.
 *
 * Each chunk is awaited individually so that sticky/fragment scene frames
 * hit the wire as separate `write` calls. This matters when the parser under
 * test relies on receiving precise boundaries.
 */
export async function writeChunks(handle: TransportHandle, chunks: readonly Buffer[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let i = 0;
    function next(err?: Error): void {
      if (err) {
        reject(err);
        return;
      }
      if (i >= chunks.length) {
        resolve();
        return;
      }
      handle.write(chunks[i++] ?? Buffer.alloc(0), next);
    }
    next();
  });
}

/**
 * Lower-level variant: write chunks directly to a `net.Socket`.
 *
 * Prefer `writeChunks(handle, chunks)` when a `TransportHandle` is available.
 */
export async function writeSocketChunks(socket: net.Socket, chunks: readonly Buffer[]): Promise<void> {
  return new Promise((resolve, reject) => {
    let i = 0;
    function next(err?: Error): void {
      if (err) {
        reject(err);
        return;
      }
      if (i >= chunks.length) {
        resolve();
        return;
      }
      socket.write(chunks[i++] ?? Buffer.alloc(0), next);
    }
    next();
  });
}
