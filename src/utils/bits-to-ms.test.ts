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

import { bitsToMs } from './bits-to-ms';

describe('bitsToMs', () => {
  it('should convert bits to milliseconds at a given baud rate', () => {
    expect(bitsToMs(9600, 9600)).toBe(1000);
    expect(bitsToMs(9600, 4800)).toBe(500);
  });

  it('should return fractional milliseconds', () => {
    expect(bitsToMs(115200, 1152)).toBe(10);
  });
});
