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

import { canonicalizeIp } from './canonicalize-ip';

/**
 * A single whitelist entry: an exact IP string, an IPv4 CIDR string, or a
 * custom predicate.
 *
 * String entries are canonicalized at construction time. Predicate functions
 * receive the already-canonicalized remote address.
 */
export type WhitelistEntry = string | ((address: string) => boolean);

/**
 * Parse an IPv4 CIDR string into a subnet matcher.
 *
 * @param cidr A CIDR string such as `"192.168.0.0/24"`.
 * @returns A matcher for the subnet, or `null` if `cidr` is not a valid IPv4
 *   CIDR string.
 * @note IPv6 CIDR is not supported by this implementation.
 */
function parseIpv4Cidr(cidr: string): ((address: string) => boolean) | null {
  const slashIndex = cidr.indexOf('/');
  if (slashIndex === -1) {
    return null;
  }

  const ipPart = cidr.substring(0, slashIndex);
  const prefixPart = cidr.substring(slashIndex + 1);

  const prefix = parseInt(prefixPart, 10);
  if (Number.isNaN(prefix) || prefix < 0 || prefix > 32) {
    return null;
  }

  const octets = ipPart.split('.');
  if (octets.length !== 4) {
    return null;
  }

  let network = 0;
  for (let i = 0; i < 4; i++) {
    const octet = parseInt(octets[i], 10);
    if (Number.isNaN(octet) || octet < 0 || octet > 255) {
      return null;
    }
    network = (network << 8) | octet;
  }

  const mask = prefix === 0 ? 0 : 0xffffffff << (32 - prefix);
  network &= mask;

  return (address: string) => {
    const canonical = canonicalizeIp(address);
    const addrOctets = canonical.split('.');
    if (addrOctets.length !== 4) {
      return false;
    }

    let addr = 0;
    for (let i = 0; i < 4; i++) {
      const octet = parseInt(addrOctets[i], 10);
      if (Number.isNaN(octet) || octet < 0 || octet > 255) {
        return false;
      }
      addr = (addr << 8) | octet;
    }

    return (addr & mask) === network;
  };
}

/**
 * Create a matcher for a single whitelist entry.
 *
 * @param entry An exact IP string, an IPv4 CIDR string, or a predicate function
 *   that receives the canonicalized remote address.
 * @returns A function that returns `true` when the supplied address matches
 *   this entry.
 * @throws `Error` when `entry` is a CIDR string that cannot be parsed.
 */
export function createIpMatcher(entry: WhitelistEntry): (address: string) => boolean {
  if (typeof entry === 'function') {
    return (address: string) => entry(canonicalizeIp(address));
  }

  const canonical = canonicalizeIp(entry);
  if (canonical.includes('/')) {
    const cidrMatcher = parseIpv4Cidr(canonical);
    if (!cidrMatcher) {
      throw new Error(`Invalid IPv4 CIDR whitelist entry: ${entry}`);
    }
    return cidrMatcher;
  }

  return (address: string) => canonicalizeIp(address) === canonical;
}

/**
 * Create a matcher that tests whether an address matches any whitelist entry.
 *
 * An empty or omitted list allows every address.
 *
 * @param entries Array of whitelist entries. Each entry is canonicalized at
 *   construction time.
 * @returns A function that returns `true` when the supplied address matches at
 *   least one entry, or `true` unconditionally when `entries` is empty.
 * @throws `Error` when any string entry is a CIDR string that cannot be parsed.
 */
export function createIpMatchers(entries?: WhitelistEntry[]): (address: string) => boolean {
  if (!entries || entries.length === 0) {
    return () => true;
  }

  const matchers = entries.map(createIpMatcher);
  return (address: string) => {
    for (let i = 0; i < matchers.length; i++) {
      if (matchers[i](address)) {
        return true;
      }
    }
    return false;
  };
}
