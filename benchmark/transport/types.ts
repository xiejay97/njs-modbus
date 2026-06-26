/**
 * Transport abstraction contracts.
 *
 * Provides a thin, library-agnostic wrapper over raw TCP sockets and serial
 * PTY streams. Benchmark code talks to these transports instead of directly
 * touching `net.Socket` or `SerialPort`, keeping the chaos/transport suites
 * decoupled from I/O implementation details.
 */

import type { ChildProcess } from 'node:child_process';

/** A transport handle exposes the minimal surface needed by benchmarks. */
export interface TransportHandle {
  /** Human-readable path (host:port or PTY device). */
  readonly path: string;
  /** Write a raw buffer. If a callback is provided, it is called when the kernel has accepted it. */
  write: (data: Buffer, callback?: (err?: Error) => void) => void;
  /** Gracefully close the underlying stream. */
  end: () => Promise<void>;
  /** Register a data handler; returned callback removes it. */
  onData: (handler: (chunk: Buffer) => void) => () => void;
  /**
   * Disable Nagle's algorithm (TCP-only). No-op for transports where it does
   * not apply.
   */
  setNoDelay?: (noDelay: boolean) => void;
}

/** TCP-specific tuning options. */
export interface TcpTransportOptions {
  /** Host to connect to or bind on. Defaults to 127.0.0.1. */
  host?: string;
  /**
   * Disable Nagle's algorithm. Defaults to true — benchmarks need precise
   * chunk boundaries, not coalesced segments.
   */
  noDelay?: boolean;
  /** Optional `SO_SNDBUF` size (bytes). Leave undefined to use OS default. */
  sendBufferSize?: number;
  /** Optional `SO_RCVBUF` size (bytes). Leave undefined to use OS default. */
  receiveBufferSize?: number;
}

/** Serial/PTY tuning options. */
export interface SerialTransportOptions {
  /** Baud rate. Defaults to 115200. */
  baudRate?: number;
  /** Data bits. Defaults to 8. */
  dataBits?: number;
  /** Stop bits. Defaults to 1. */
  stopBits?: number;
  /** Parity. Defaults to 'none'. */
  parity?: 'none' | 'even' | 'odd';
}

/** A pair of connected PTY devices created by socat. */
export interface PtyPair {
  /** The socat child process that owns the PTYs. */
  proc: ChildProcess;
  /** Path to the first endpoint (typically used by the client/master). */
  masterPath: string;
  /** Path to the second endpoint (typically used by the server/slave). */
  slavePath: string;
}

/** TCP server handle returned by {@link createRawTcpServer}. */
export interface TcpServerHandle {
  /** Local port the server is listening on. */
  port: number;
  /** Close the server and drop all sockets. */
  close: () => Promise<void>;
}

/** Serial server handle returned by {@link createSerialServer}. */
export interface SerialServerHandle {
  /** Path the server is bound to. */
  path: string;
  /** Close the server. */
  close: () => Promise<void>;
}
