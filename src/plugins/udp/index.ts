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
 * UDP transport plugin public API.
 *
 * Re-exports the client and server pipeline / physical layer implementations.
 */

/** UDP client pipeline and physical layer implementations. */
export { UdpClientPipelineLayer, UdpClientPhysicalLayer } from './udp-client-physical-layer';
/** UDP server pipeline and physical layer implementations. */
export { UdpServerPipelineLayer, UdpServerPhysicalLayer } from './udp-server-physical-layer';
/** UDP server security and resource-limit options. */
export type { UdpConnectionSecurityOptions } from '../connection-security-options';
