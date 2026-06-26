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

import { createIpMatcher, createIpMatchers } from './ip-whitelist';

describe('createIpMatcher', () => {
  it('matches exact IPv4 address', () => {
    const matcher = createIpMatcher('192.168.1.1');
    expect(matcher('192.168.1.1')).toBe(true);
    expect(matcher('192.168.1.2')).toBe(false);
  });

  it('canonicalizes exact IPv4-mapped IPv6 entries', () => {
    const matcher = createIpMatcher('::ffff:192.168.1.1');
    expect(matcher('192.168.1.1')).toBe(true);
    expect(matcher('::ffff:192.168.1.1')).toBe(true);
  });

  it('matches IPv4 CIDR /24', () => {
    const matcher = createIpMatcher('192.168.0.0/24');
    expect(matcher('192.168.0.1')).toBe(true);
    expect(matcher('192.168.0.255')).toBe(true);
    expect(matcher('192.168.1.1')).toBe(false);
  });

  it('matches IPv4 CIDR /16', () => {
    const matcher = createIpMatcher('10.0.0.0/16');
    expect(matcher('10.0.0.1')).toBe(true);
    expect(matcher('10.0.255.255')).toBe(true);
    expect(matcher('10.1.0.1')).toBe(false);
  });

  it('matches IPv4 CIDR /32', () => {
    const matcher = createIpMatcher('192.168.1.1/32');
    expect(matcher('192.168.1.1')).toBe(true);
    expect(matcher('192.168.1.2')).toBe(false);
  });

  it('matches IPv4 CIDR /0', () => {
    const matcher = createIpMatcher('0.0.0.0/0');
    expect(matcher('1.2.3.4')).toBe(true);
    expect(matcher('255.255.255.255')).toBe(true);
  });

  it('matches predicate functions', () => {
    const matcher = createIpMatcher((address) => address === '127.0.0.1');
    expect(matcher('127.0.0.1')).toBe(true);
    expect(matcher('127.0.0.2')).toBe(false);
  });

  it('receives canonicalized address in predicate', () => {
    const matcher = createIpMatcher((address) => address === '192.168.1.1');
    expect(matcher('::ffff:192.168.1.1')).toBe(true);
  });

  it('canonicalizes CIDR base address', () => {
    const matcher = createIpMatcher('::ffff:192.168.0.0/24');
    expect(matcher('192.168.0.5')).toBe(true);
  });

  it('throws on invalid CIDR prefix', () => {
    expect(() => createIpMatcher('192.168.0.0/33')).toThrow();
    expect(() => createIpMatcher('192.168.0.0/abc')).toThrow();
  });

  it('throws on invalid CIDR octet', () => {
    expect(() => createIpMatcher('192.168.0.256/24')).toThrow();
  });
});

describe('createIpMatchers', () => {
  it('allows all addresses when entries is empty', () => {
    const matcher = createIpMatchers([]);
    expect(matcher('1.2.3.4')).toBe(true);
    expect(matcher('0.0.0.0')).toBe(true);
  });

  it('allows all addresses when entries is undefined', () => {
    const matcher = createIpMatchers(undefined);
    expect(matcher('1.2.3.4')).toBe(true);
  });

  it('combines multiple entries with OR semantics', () => {
    const matcher = createIpMatchers(['127.0.0.1', '10.0.0.0/8', (address) => address === '8.8.8.8']);
    expect(matcher('127.0.0.1')).toBe(true);
    expect(matcher('10.5.6.7')).toBe(true);
    expect(matcher('8.8.8.8')).toBe(true);
    expect(matcher('192.168.1.1')).toBe(false);
  });
});
