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

import type { WhitelistEntry } from '../utils/ip-whitelist';

/**
 * Shared security and resource-limit options for TCP and UDP server physical
 * layers.
 *
 * The same field names are used for both transports. For UDP, `maxConnections`
 * and `maxConnectionsPerIp` limit concurrent peers rather than OS-level
 * connections.
 */
export interface ConnectionSecurityOptions {
  /**
   * Allowed remote addresses. Each entry is either an exact IP string, an IPv4
   * CIDR string, or a predicate that receives the canonicalized address.
   *
   * If omitted or empty, all addresses are allowed.
   */
  whitelist?: WhitelistEntry[];

  /**
   * Maximum number of concurrent connections (TCP) or peers (UDP).
   *
   * If omitted, no limit is enforced. `0` is treated as "no limit".
   */
  maxConnections?: number;

  /**
   * Maximum number of concurrent connections (TCP) or peers (UDP) allowed from
   * a single remote IP address.
   *
   * If omitted, no limit is enforced. `0` is treated as "no limit".
   */
  maxConnectionsPerIp?: number;

  /**
   * Inactivity timeout before a connection or peer pipeline is automatically
   * destroyed (unit: ms).
   *
   * If omitted, no idle timeout is enforced for either TCP or UDP. `0`
   * disables the timer.
   */
  idleTimeout?: number;
}

/**
 * Security and resource-limit options for {@link TcpServerPhysicalLayer}.
 */
export type TcpConnectionSecurityOptions = ConnectionSecurityOptions;

/**
 * Security and resource-limit options for {@link UdpServerPhysicalLayer}.
 */
export type UdpConnectionSecurityOptions = ConnectionSecurityOptions;

/**
 * Security and resource-limit options for {@link TlsServerPhysicalLayer}.
 */
export type TlsConnectionSecurityOptions = ConnectionSecurityOptions;
