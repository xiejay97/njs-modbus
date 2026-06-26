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
 * Lifecycle states of a physical layer (serial port, TCP server/client, UDP socket).
 */
export enum PhysicalLayerState {
  OPENING = 'opening',
  OPEN = 'open',
  CLOSING = 'closing',
  CLOSED = 'closed',
}

/**
 * Lifecycle states of a pipeline layer (a single connection / stream).
 */
export enum PipelineLayerState {
  CONNECTED = 'connected',
  DESTROYING = 'destroying',
  DESTROYED = 'destroyed',
}
