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

import type { AbstractPipelineLayer } from './abstract-pipeline-layer';
import type { PhysicalLayerState } from './vars';

import EventEmitter from 'node:events';

/**
 * Events emitted by {@link AbstractPhysicalLayer}.
 */
export interface AbstractPhysicalLayerEvents {
  /** The physical layer is open and ready to accept connections. */
  open: [];
  /** A new pipeline connection has been established. */
  connect: [pipeline: AbstractPipelineLayer];
  /**
   * A TCP connection or UDP peer was rejected by a security or resource-limit
   * policy.
   */
  connectionRejected: [
    event: {
      /** Policy that caused the rejection. */
      reason: 'whitelist' | 'max_connections' | 'max_connections_per_ip';
      /** Canonicalized remote IP address. */
      address: string;
      /** Remote port; present for UDP peers and optionally for TCP connections. */
      port?: number;
    },
  ];
  /** The physical layer has closed. */
  close: [];
  /** A non-fatal transport error occurred. */
  error: [error: Error];
}

/**
 * Abstract physical layer that manages the lifecycle of a transport endpoint.
 *
 * Subclasses open a serial port, TCP client/server socket, or UDP socket and
 * emit {@link AbstractPipelineLayer} instances through the `connect` event.
 */
export abstract class AbstractPhysicalLayer extends EventEmitter<AbstractPhysicalLayerEvents> {
  /** Current lifecycle state of the physical layer. */
  abstract readonly state: PhysicalLayerState;

  /**
   * Open the transport endpoint.
   *
   * @param args Transport-specific open arguments (port path, listen options, etc.).
   * @returns `void`.
   */
  abstract open(...args: any[]): void;

  /**
   * Close the transport endpoint.
   *
   * @param cb Optional callback invoked once the layer is closed.
   * @returns `void`.
   */
  abstract close(cb?: (err: Error | null) => void): void;
}
