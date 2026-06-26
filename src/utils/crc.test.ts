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

import { crcFixed, crcDual, CRC_TABLE } from './crc';

describe('crcFixed', () => {
  it('should return the initial CRC seed for an empty range', () => {
    expect(crcFixed(Buffer.alloc(0), 0, 0)).toBe(0xffff);
  });

  it('should produce a CRC that validates the full frame', () => {
    const body = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a]);
    const crc = crcFixed(body, 0, body.length);
    const frame = Buffer.concat([body, Buffer.from([crc & 0xff, (crc >>> 8) & 0xff])]);

    expect(crcFixed(frame, 0, frame.length)).toBe(0);
  });

  it('should match crcDual when the range is split', () => {
    const data = Buffer.from([0x01, 0x03, 0x00, 0x00, 0x00, 0x0a]);
    const whole = crcFixed(data, 0, data.length);
    const split = crcDual(data, 0, 3, data, 3, 3);

    expect(split).toBe(whole);
  });
});

describe('CRC_TABLE', () => {
  it('should contain the standard Modbus CRC-16 lookup table', () => {
    expect(CRC_TABLE).toHaveLength(256);
    expect(CRC_TABLE[0]).toBe(0x0000);
    expect(CRC_TABLE[1]).toBe(0xc0c1);
  });
});
