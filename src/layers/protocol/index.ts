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
 * Protocol framing layer public API.
 *
 * Re-exports the abstract base, concrete TCP / RTU / ASCII framing layers,
 * and the frame-error event types used by all three.
 */

/**
 * Frame-error discriminant and event payload.
 */
export type { FrameErrorEventType, FrameErrorEvent } from './types';

/**
 * Base class for all Modbus protocol framing layers.
 */
export { AbstractProtocolLayer } from './abstract-protocol-layer';

/**
 * User-facing options for the Modbus ASCII framing layer.
 */
export type { AsciiProtocolLayerOptions } from './ascii-protocol-layer';
/**
 * Modbus ASCII framing layer implementation.
 */
export { AsciiProtocolLayer } from './ascii-protocol-layer';

/**
 * User-facing options for the Modbus RTU framing layer.
 */
export type { RtuProtocolLayerOptions } from './rtu-protocol-layer';
/**
 * Modbus RTU framing layer implementation.
 */
export { RtuProtocolLayer } from './rtu-protocol-layer';

/**
 * Modbus TCP/IP framing layer implementation.
 */
export { TcpProtocolLayer } from './tcp-protocol-layer';
