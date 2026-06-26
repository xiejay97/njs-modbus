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
 * TCP transport plugin public API.
 *
 * Re-exports the shared pipeline layer and the client / server physical layers.
 */

/** TCP pipeline layer implementation backed by a `node:net` `Socket`. */
export { TcpPipelineLayer } from './tcp-pipeline-layer';
/** TCP client physical layer implementation. */
export { TcpClientPhysicalLayer } from './tcp-client-physical-layer';
/** TCP server physical layer implementation. */
export { TcpServerPhysicalLayer } from './tcp-server-physical-layer';
/** TCP server security and resource-limit options. */
export type { TcpConnectionSecurityOptions } from '../connection-security-options';
