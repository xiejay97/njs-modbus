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

import { lrc } from './lrc';

describe('lrc', () => {
  it('should return a value that makes the byte sum zero modulo 256', () => {
    const data = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a]);
    const value = lrc(data, 0, data.length);
    const sum = data.reduce((acc, b) => acc + b, 0) + value;

    expect(sum & 0xff).toBe(0);
  });

  it('should handle an empty range', () => {
    expect(lrc(Buffer.alloc(0), 0, 0)).toBe(0);
  });

  it('should compute the same LRC for a subrange', () => {
    const data = Buffer.from([0xff, 0x01, 0x03, 0x00, 0x00, 0x00, 0x0a]);
    expect(lrc(data, 1, data.length)).toBe(lrc(data.subarray(1), 0, data.length - 1));
  });
});
