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
 * Canonicalize an IP address string for rigid equality comparison.
 *
 * Normalizes common forms encountered from `socket.remoteAddress` and user
 * configuration so that semantically identical addresses compare equal:
 *
 * - IPv4-mapped IPv6 (`::ffff:192.168.1.1`) → plain IPv4.
 * - IPv6 loopback shorthand (`::1`) → `127.0.0.1`.
 * - Native IPv6 addresses are lower-cased.
 *
 * @param ip Raw IP string, typically from `socket.remoteAddress` or a whitelist
 *   entry. May be `undefined`.
 * @returns The canonicalized IP string, or `'unknown'` when `ip` is falsy.
 */
export function canonicalizeIp(ip: string | undefined): string {
  if (!ip) {
    return 'unknown';
  }

  const trimmed = ip.trim();

  // Strip IPv4-mapped IPv6 prefix (e.g. ::ffff:192.168.1.100 -> 192.168.1.100).
  if (trimmed.startsWith('::ffff:') || trimmed.startsWith('::FFFF:')) {
    return trimmed.substring(7);
  }

  // Normalize IPv6 loopback shorthand to IPv4 loopback for unified matching.
  if (trimmed === '::1') {
    return '127.0.0.1';
  }

  // Lower-case native IPv6 addresses so hexadecimal casing does not matter.
  if (trimmed.includes(':')) {
    return trimmed.toLowerCase();
  }

  return trimmed;
}
