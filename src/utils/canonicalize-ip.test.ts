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

import { describe, expect, it } from 'vitest';

import { canonicalizeIp } from './canonicalize-ip';

describe('canonicalizeIp', () => {
  it('returns "unknown" for undefined', () => {
    expect(canonicalizeIp(undefined)).toBe('unknown');
  });

  it('returns "unknown" for empty string', () => {
    expect(canonicalizeIp('')).toBe('unknown');
  });

  it('trims whitespace', () => {
    expect(canonicalizeIp('  127.0.0.1  ')).toBe('127.0.0.1');
  });

  it('strips IPv4-mapped IPv6 prefix', () => {
    expect(canonicalizeIp('::ffff:192.168.1.100')).toBe('192.168.1.100');
    expect(canonicalizeIp('::FFFF:10.0.0.1')).toBe('10.0.0.1');
  });

  it('normalizes IPv6 loopback to IPv4 loopback', () => {
    expect(canonicalizeIp('::1')).toBe('127.0.0.1');
  });

  it('lower-cases native IPv6 addresses', () => {
    expect(canonicalizeIp('2001:0DB8:85A3:0000:0000:8A2E:0370:7334')).toBe('2001:0db8:85a3:0000:0000:8a2e:0370:7334');
    expect(canonicalizeIp('FE80::1')).toBe('fe80::1');
  });

  it('leaves plain IPv4 unchanged', () => {
    expect(canonicalizeIp('192.168.1.1')).toBe('192.168.1.1');
    expect(canonicalizeIp('0.0.0.0')).toBe('0.0.0.0');
    expect(canonicalizeIp('255.255.255.255')).toBe('255.255.255.255');
  });
});
