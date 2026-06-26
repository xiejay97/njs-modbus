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
 * Transport plugin public API.
 *
 * Re-exports the abstract pipeline / physical layer contracts, their lifecycle
 * state enums, and the concrete serial / TCP / UDP implementations.
 */

/** Shared security and resource-limit options for server physical layers. */
export type { ConnectionSecurityOptions } from './connection-security-options';

/** Abstract pipeline layer contract and its event map. */
export { AbstractPipelineLayer } from './abstract-pipeline-layer';
/** Abstract physical layer contract and its event map. */
export { AbstractPhysicalLayer } from './abstract-physical-layer';
/** Lifecycle state enums for physical and pipeline layers. */
export { PhysicalLayerState, PipelineLayerState } from './vars';

/** Serial-port physical / pipeline layer implementations. */
export * from './serial';
/** TCP client / server physical / pipeline layer implementations. */
export * from './tcp';
/** TLS client / server physical / pipeline layer implementations. */
export * from './tls';
/** UDP client / server physical / pipeline layer implementations. */
export * from './udp';
