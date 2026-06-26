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

import type { CustomFunctionCode } from '../types';

import { generateAduHashFingerprint, generateRequestFingerprint } from './adu-fingerprint';

// Reference implementation that mirrors the original scratchpad-based
// algorithm. Used only to confirm the optimized version stays bit-identical
// for inputs that fit in the 512-byte scratchpad.
function referenceFingerprint(buffer: Buffer | null, n1?: number, n2?: number, n3?: number, n4?: number): number {
  const scratchpad = Buffer.allocUnsafe(512);
  let totalLen = 0;

  if (n1 !== undefined) {
    scratchpad[totalLen++] = n1;
  }
  if (n2 !== undefined) {
    scratchpad[totalLen++] = n2;
  }
  if (n3 !== undefined) {
    scratchpad[totalLen++] = n3;
  }
  if (n4 !== undefined) {
    scratchpad[totalLen++] = n4;
  }

  if (buffer) {
    buffer.copy(scratchpad, totalLen);
    totalLen += buffer.length;
  }

  let h1 = 0;
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  const roundedEnd = totalLen & ~3;
  for (let i = 0; i < roundedEnd; i += 4) {
    let k1 = scratchpad.readUInt32LE(i);
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
    h1 = (h1 << 13) | (h1 >>> 19);
    h1 = Math.imul(h1, 5) + 0xe6546b64;
  }

  let k1 = 0;
  const remainder = totalLen & 3;
  if (remainder >= 3) {
    k1 ^= scratchpad[roundedEnd + 2] << 16;
  }
  if (remainder >= 2) {
    k1 ^= scratchpad[roundedEnd + 1] << 8;
  }
  if (remainder >= 1) {
    k1 ^= scratchpad[roundedEnd];
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }

  h1 ^= totalLen;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;

  return h1 >>> 0;
}

describe('generateAduHashFingerprint', () => {
  it('hashes only header bytes', () => {
    expect(generateAduHashFingerprint(null)).toBe(referenceFingerprint(null));
    expect(generateAduHashFingerprint(null, 0x01)).toBe(referenceFingerprint(null, 0x01));
    expect(generateAduHashFingerprint(null, 0x01, 0x02)).toBe(referenceFingerprint(null, 0x01, 0x02));
    expect(generateAduHashFingerprint(null, 0x01, 0x02, 0x03)).toBe(referenceFingerprint(null, 0x01, 0x02, 0x03));
    expect(generateAduHashFingerprint(null, 0x01, 0x02, 0x03, 0x04)).toBe(referenceFingerprint(null, 0x01, 0x02, 0x03, 0x04));
  });

  it('hashes only a buffer', () => {
    expect(generateAduHashFingerprint(Buffer.from([0xff]))).toBe(referenceFingerprint(Buffer.from([0xff])));
    expect(generateAduHashFingerprint(Buffer.alloc(64).fill(0xab))).toBe(referenceFingerprint(Buffer.alloc(64).fill(0xab)));
    expect(generateAduHashFingerprint(Buffer.alloc(508).fill(0x12))).toBe(referenceFingerprint(Buffer.alloc(508).fill(0x12)));
  });

  it('hashes headers combined with buffers of various alignments', () => {
    const cases: [Buffer, number, number?, number?, number?][] = [
      [Buffer.from([0xff]), 0x01],
      [Buffer.from([0xff, 0xee]), 0x01, 0x02],
      [Buffer.from([0xff, 0xee, 0xdd]), 0x01, 0x02, 0x03],
      [Buffer.from([0xff, 0xee, 0xdd, 0xcc]), 0x01, 0x02, 0x03, 0x04],
      [Buffer.from([0x11, 0x22, 0x33, 0x44, 0x55]), 0x01, 0x02],
      [Buffer.alloc(63).fill(0xab), 0x01, 0x02],
      [Buffer.alloc(64).fill(0xcd), 0x01, 0x02, 0x03],
      [Buffer.alloc(65).fill(0xef), 0x01, 0x02, 0x03, 0x04],
      [Buffer.alloc(508).fill(0x12), 0x01, 0x02, 0x03, 0x04],
      // Remainder 2 and 3 bytes after full 32-bit words to hit tail packing branches.
      [Buffer.alloc(2).fill(0xab), 0],
      [Buffer.alloc(3).fill(0xcd), 0],
      [Buffer.from([0x01]), 0x02],
      [Buffer.from([0x01, 0x02]), 0x03],
    ];

    for (const [buf, n1, n2, n3, n4] of cases) {
      expect(generateAduHashFingerprint(buf, n1, n2, n3, n4)).toBe(referenceFingerprint(buf, n1, n2, n3, n4));
    }
  });

  it('covers all header-byte alignment branches', () => {
    // n2 observed with rem=0 and rem=1
    expect(generateAduHashFingerprint(null, undefined, 0x02)).toBe(referenceFingerprint(null, undefined, 0x02));
    expect(generateAduHashFingerprint(null, 0x01, 0x02)).toBe(referenceFingerprint(null, 0x01, 0x02));

    // n3 observed with rem=0, rem=1, and rem=2
    expect(generateAduHashFingerprint(null, undefined, undefined, 0x03)).toBe(referenceFingerprint(null, undefined, undefined, 0x03));
    expect(generateAduHashFingerprint(null, 0x01, undefined, 0x03)).toBe(referenceFingerprint(null, 0x01, undefined, 0x03));
    expect(generateAduHashFingerprint(null, 0x01, 0x02, 0x03)).toBe(referenceFingerprint(null, 0x01, 0x02, 0x03));

    // n4 observed with rem=0, rem=1, rem=2, and rem=3
    expect(generateAduHashFingerprint(null, undefined, undefined, undefined, 0x04)).toBe(
      referenceFingerprint(null, undefined, undefined, undefined, 0x04),
    );
    expect(generateAduHashFingerprint(null, 0x01, undefined, undefined, 0x04)).toBe(
      referenceFingerprint(null, 0x01, undefined, undefined, 0x04),
    );
    expect(generateAduHashFingerprint(null, 0x01, 0x02, undefined, 0x04)).toBe(referenceFingerprint(null, 0x01, 0x02, undefined, 0x04));
    expect(generateAduHashFingerprint(null, 0x01, 0x02, 0x03, 0x04)).toBe(referenceFingerprint(null, 0x01, 0x02, 0x03, 0x04));
  });

  it('masks header values to a single byte', () => {
    expect(generateAduHashFingerprint(null, 0x0101)).toBe(generateAduHashFingerprint(null, 0x01));
    expect(generateAduHashFingerprint(null, -1)).toBe(generateAduHashFingerprint(null, 0xff));
  });

  it('matches the reference implementation on randomized inputs within the 512-byte limit', () => {
    for (let i = 0; i < 2000; i++) {
      const hdrCount = Math.floor(Math.random() * 5);
      const maxBufLen = 512 - hdrCount;
      const len = Math.floor(Math.random() * (maxBufLen + 1));
      const buf = Buffer.alloc(len);
      for (let j = 0; j < len; j++) {
        buf[j] = Math.floor(Math.random() * 256);
      }
      const args = [
        hdrCount > 0 ? Math.floor(Math.random() * 256) : undefined,
        hdrCount > 1 ? Math.floor(Math.random() * 256) : undefined,
        hdrCount > 2 ? Math.floor(Math.random() * 256) : undefined,
        hdrCount > 3 ? Math.floor(Math.random() * 256) : undefined,
      ] as const;

      expect(generateAduHashFingerprint(buf, ...args)).toBe(referenceFingerprint(buf, ...args));
    }
  });
});

describe('generateRequestFingerprint', () => {
  function makeCustomFc(partial: Partial<CustomFunctionCode> & { fc: number }): CustomFunctionCode {
    return partial;
  }

  it('returns a fingerprint for standard read function codes', () => {
    const data = Buffer.from([0x00, 0x01, 0x00, 0x0a]);
    expect(generateRequestFingerprint(1, 0x03, data)).toBe(generateAduHashFingerprint(data, 1, 0x03));
    expect(generateRequestFingerprint(2, 0x04, data)).toBe(generateAduHashFingerprint(data, 2, 0x04));
  });

  it('returns a fingerprint for standard write function codes', () => {
    const data = Buffer.from([0x00, 0x01, 0x12, 0x34]);
    expect(generateRequestFingerprint(1, 0x06, data)).toBe(generateAduHashFingerprint(data, 1, 0x06));
  });

  it('keys FC 43 by level + objectId only', () => {
    const data = Buffer.from([0x14, 0x01, 0x00]);
    expect(generateRequestFingerprint(1, 0x2b, data)).toBe(generateAduHashFingerprint(Buffer.from([0x01, 0x00]), 1, 0x2b));
  });

  it('keys FC 17 by unit + fc only', () => {
    expect(generateRequestFingerprint(1, 0x11, Buffer.alloc(0))).toBe(generateAduHashFingerprint(null, 1, 0x11));
  });

  it('keys FC 8 by full data body', () => {
    const data = Buffer.from([0x00, 0x00, 0xab, 0xcd]);
    expect(generateRequestFingerprint(1, 0x08, data)).toBe(generateAduHashFingerprint(data, 1, 0x08));
  });

  it('returns null for unknown function codes without a custom descriptor', () => {
    expect(generateRequestFingerprint(1, 0xff, Buffer.from([0x00]))).toBeNull();
  });

  it('uses a custom fingerprint override when provided', () => {
    const customFc = makeCustomFc({ fc: 0x64, requestFingerprint: () => 0xdeadbeef });
    expect(generateRequestFingerprint(1, 0x64, Buffer.from([0x00]), customFc)).toBe(0xdeadbeef);
  });

  it('falls back to full-data hashing for custom FCs without a fingerprint override', () => {
    const data = Buffer.from([0x01, 0x02, 0x03]);
    const customFc = makeCustomFc({ fc: 0x64 });
    expect(generateRequestFingerprint(1, 0x64, data, customFc)).toBe(generateAduHashFingerprint(data, 1, 0x64));
  });
});
