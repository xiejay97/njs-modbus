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

import type { PipelineLayerState } from './vars';

import EventEmitter from 'node:events';

/**
 * Events emitted by {@link AbstractPipelineLayer}.
 */
export interface AbstractPipelineLayerEvents {
  /** Raw bytes received from the transport, forwarded to the protocol layer. */
  data: [data: Buffer];
  /** The pipeline layer has closed. */
  close: [];
  /** A frame was transmitted on the wire. */
  tx: [buffer: Buffer];
  /** A raw chunk was received from the transport. */
  rx: [buffer: Buffer];
}

/**
 * Abstract pipeline layer that owns a single connection / stream.
 *
 * Pipeline layers bridge the physical transport and the protocol layer:
 * they emit `data` events carrying raw bytes and expose `write` for outbound
 * frames. Implementations are transport-specific (serial, TCP, UDP).
 */
export abstract class AbstractPipelineLayer extends EventEmitter<AbstractPipelineLayerEvents> {
  /** Current lifecycle state of the pipeline. */
  abstract readonly state: PipelineLayerState;

  /**
   * Write a raw frame to the transport.
   *
   * @param data Encoded frame bytes (unit: byte). Must not be modified.
   * @param cb Optional callback invoked on completion or error.
   * @returns `void`.
   */
  abstract write(data: Buffer, cb?: (err: Error | null) => void): void;

  /**
   * Tear down the pipeline.
   *
   * @param cb Optional callback invoked once the layer is destroyed.
   * @returns `void`.
   */
  abstract destroy(cb?: (err: Error | null) => void): void;
}
