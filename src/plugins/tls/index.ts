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
 * TLS transport plugin public API.
 *
 * Re-exports the shared pipeline layer and the client / server physical layers.
 */

/** TLS pipeline layer implementation backed by a `node:tls` `TLSSocket`. */
export { TlsPipelineLayer } from './tls-pipeline-layer';
/** TLS client physical layer implementation. */
export { TlsClientPhysicalLayer } from './tls-client-physical-layer';
/** TLS server physical layer implementation. */
export { TlsServerPhysicalLayer } from './tls-server-physical-layer';
/** TLS server security and resource-limit options. */
export type { TlsConnectionSecurityOptions } from '../connection-security-options';
