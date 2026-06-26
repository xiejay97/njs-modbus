/*
 * Copyright (c) 2026 xiejay97
 *
 * Licensed under the Business Source License 1.1 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * Change Date: 2029-06-24
 *
 * On the date above, in accordance with the Change Date, the Licensed Work
 * will be made available under the Apache License, Version 2.0.
 *
 * You may obtain a copy of the License at
 *     https://mariadb.com/bsl11/
 */

/**
 * Events emitted by an {@link AbstractPipelineAdapter}.
 */
export interface AbstractPipelineAdapterEvents {
  /** Raw bytes received from the transport, passed to protocol layers. */
  data: [data: Buffer];
}

/**
 * Structural contract for a write-only adapter that sits between a protocol
 * layer and the underlying transport.
 *
 * Implementations are provided by the plugin layer (serial / TCP / UDP); the
 * protocol layer only needs the {@link write} contract and the `data` event.
 */
export interface AbstractPipelineAdapter {
  /**
   * Write a raw frame to the transport.
   *
   * @param data Encoded frame bytes to transmit; must not be modified.
   * @param cb Optional callback invoked once the write completes or fails.
   */
  write: (data: Buffer, cb?: (err: Error | null) => void) => void;

  /** Subscribe to the `data` event. */
  on: (event: 'data', listener: (data: Buffer) => void) => this;
  /** Subscribe once to the `data` event. */
  once: (event: 'data', listener: (data: Buffer) => void) => this;
  /** Unsubscribe from the `data` event. */
  off: (event: 'data', listener: (data: Buffer) => void) => this;
  /** Emit a `data` event. */
  emit: (event: 'data', data: Buffer) => boolean;
}
