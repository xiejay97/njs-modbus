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

import { FunctionCode } from '../vars';

/**
 * Compute a 32-bit MurmurHash3-x86 fingerprint over up to four single-byte
 * header arguments concatenated with an optional binary buffer.
 *
 * Used as the canonical hashing primitive for `aduFingerprint` — the
 * deduplication queue strategy keys on this value, so the algorithm must be
 * stable across releases (any change here invalidates in-flight queue state
 * for callers running a mixed-version cluster).
 *
 * The four header bytes are packed little-endian into the same 32-bit word
 * as the buffer payload, so e.g. `(unit, fc, length-byte)` with no buffer
 * produces the exact same hash as a 3-byte buffer with no header.
 *
 * @param buffer Trailing binary payload, or `null` for header-only hashing.
 * @param n1 Optional 1st header byte (low 8 bits used; rest discarded).
 * @param n2 Optional 2nd header byte.
 * @param n3 Optional 3rd header byte.
 * @param n4 Optional 4th header byte.
 * @returns 32-bit unsigned hash in `[0, 0xFFFFFFFF]`.
 *
 * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
 */
export function generateAduHashFingerprint(buffer: Buffer | null, n1?: number, n2?: number, n3?: number, n4?: number): number {
  const c1 = 0xcc9e2d51;
  const c2 = 0x1b873593;

  let h1 = 0;
  let k1 = 0;
  let rem = 0; // bytes accumulated in the current 32-bit word (0..3)
  let totalLen = 0;

  // 1. Inline state machine for header bytes (little-endian packing).
  if (n1 !== undefined) {
    totalLen++;
    k1 = n1 & 0xff;
    rem = 1;
  }

  if (n2 !== undefined) {
    totalLen++;
    const b = n2 & 0xff;
    if (rem === 0) {
      k1 = b;
      rem = 1;
    } else if (rem === 1) {
      k1 |= b << 8;
      rem = 2;
    } else if (rem === 2) {
      k1 |= b << 16;
      rem = 3;
    } else {
      k1 |= b << 24;
      let word = k1;
      word = Math.imul(word, c1);
      word = (word << 15) | (word >>> 17);
      word = Math.imul(word, c2);
      h1 ^= word;
      h1 = (h1 << 13) | (h1 >>> 19);
      h1 = Math.imul(h1, 5) + 0xe6546b64;
      k1 = 0;
      rem = 0;
    }
  }

  if (n3 !== undefined) {
    totalLen++;
    const b = n3 & 0xff;
    if (rem === 0) {
      k1 = b;
      rem = 1;
    } else if (rem === 1) {
      k1 |= b << 8;
      rem = 2;
    } else if (rem === 2) {
      k1 |= b << 16;
      rem = 3;
    } else {
      k1 |= b << 24;
      let word = k1;
      word = Math.imul(word, c1);
      word = (word << 15) | (word >>> 17);
      word = Math.imul(word, c2);
      h1 ^= word;
      h1 = (h1 << 13) | (h1 >>> 19);
      h1 = Math.imul(h1, 5) + 0xe6546b64;
      k1 = 0;
      rem = 0;
    }
  }

  if (n4 !== undefined) {
    totalLen++;
    const b = n4 & 0xff;
    if (rem === 0) {
      k1 = b;
      rem = 1;
    } else if (rem === 1) {
      k1 |= b << 8;
      rem = 2;
    } else if (rem === 2) {
      k1 |= b << 16;
      rem = 3;
    } else {
      k1 |= b << 24;
      let word = k1;
      word = Math.imul(word, c1);
      word = (word << 15) | (word >>> 17);
      word = Math.imul(word, c2);
      h1 ^= word;
      h1 = (h1 << 13) | (h1 >>> 19);
      h1 = Math.imul(h1, 5) + 0xe6546b64;
      k1 = 0;
      rem = 0;
    }
  }

  // 2. Mix the trailing payload buffer.
  if (buffer) {
    const len = buffer.length;
    totalLen += len;
    let i = 0;

    // If the header bytes left a sub-32-bit residue, top it up with the leading bytes of `buffer` first.
    if (rem !== 0 && i < len) {
      const need = 4 - rem;
      if (len >= need) {
        if (rem === 1) {
          k1 |= (buffer[i] << 8) | (buffer[i + 1] << 16) | (buffer[i + 2] << 24);
        } else if (rem === 2) {
          k1 |= (buffer[i] << 16) | (buffer[i + 1] << 24);
        } else {
          k1 |= buffer[i] << 24;
        }
        i += need;

        let word = k1;
        word = Math.imul(word, c1);
        word = (word << 15) | (word >>> 17);
        word = Math.imul(word, c2);
        h1 ^= word;
        h1 = (h1 << 13) | (h1 >>> 19);
        h1 = Math.imul(h1, 5) + 0xe6546b64;
        k1 = 0;
        rem = 0;
      } else {
        // Trimmed branch: at this point `len` is strictly less than `need`, and can only be 1 or 2.
        if (rem === 1) {
          k1 |= len === 1 ? buffer[0] << 8 : (buffer[0] << 8) | (buffer[1] << 16);
        } else {
          // Here `rem` must be 2 and `len` must be 1.
          k1 |= buffer[0] << 16;
        }
        rem += len;
        i = len;
      }
    }

    // 3. Fast lane: hammer through aligned 32-bit blocks (pulled straight from the Buffer, zero-copy).
    const roundedEnd = (len - i) & ~3;
    const end = i + roundedEnd;
    for (; i < end; i += 4) {
      let word = buffer[i] | (buffer[i + 1] << 8) | (buffer[i + 2] << 16) | (buffer[i + 3] << 24);
      word = Math.imul(word, c1);
      word = (word << 15) | (word >>> 17);
      word = Math.imul(word, c2);
      h1 ^= word;
      h1 = (h1 << 13) | (h1 >>> 19);
      h1 = Math.imul(h1, 5) + 0xe6546b64;
    }

    // 4. Mop up the misaligned trailing bytes (< 4 bytes).
    const tail = len - i;
    if (tail > 0) {
      if (tail === 1) {
        k1 = buffer[i];
        rem = 1;
      } else if (tail === 2) {
        k1 = buffer[i] | (buffer[i + 1] << 8);
        rem = 2;
      } else {
        k1 = buffer[i] | (buffer[i + 1] << 8) | (buffer[i + 2] << 16);
        rem = 3;
      }
    }
  }

  // 5. Mix the final stray fragment word.
  if (rem > 0) {
    k1 = Math.imul(k1, c1);
    k1 = (k1 << 15) | (k1 >>> 17);
    k1 = Math.imul(k1, c2);
    h1 ^= k1;
  }

  // 6. MurmurHash3 final golden avalanche mix (fmix32).
  h1 ^= totalLen;
  h1 ^= h1 >>> 16;
  h1 = Math.imul(h1, 0x85ebca6b);
  h1 ^= h1 >>> 13;
  h1 = Math.imul(h1, 0xc2b2ae35);
  h1 ^= h1 >>> 16;

  return h1 >>> 0; // force-coerce to an unsigned 32-bit int
}

/**
 * Compute the canonical 32-bit deduplication fingerprint for a single ADU.
 *
 * Used by `queueStrategy: 'deduplicate'` to detect requests that are byte-
 * equivalent at the protocol level — same unit, same FC, same address
 * window, same write payload — so the queue can collapse stale duplicates
 * (and merge containing read intervals) without re-issuing them on the wire.
 *
 * The function inspects only the parts of `data` that carry semantic identity
 * for each FC family — for FC 17 (no parameters) only `unit + fc` are mixed,
 * for FC 43 only the level + objectId tuple is mixed, etc. This keeps the
 * fingerprint stable across irrelevant wire-padding differences.
 *
 * @param unit Unit / slave address byte (0..247).
 * @param fc Modbus function code (0..255, excluding 0x80 exception bit).
 * @param data PDU payload bytes (after the function code, no checksum).
 * @param cfc Custom-FC descriptor — when present, its `requestFingerprint`
 *   override is used; otherwise the full `data` body is hashed.
 * @returns 32-bit unsigned fingerprint, or `null` when the FC is neither a standard
 *   code nor a registered custom code (the queue then falls back to
 *   no-deduplication for the request).
 *
 * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
 */
export function generateRequestFingerprint(unit: number, fc: number, data: Buffer, cfc?: CustomFunctionCode): number | null {
  if (cfc) {
    if (cfc.requestFingerprint) {
      return cfc.requestFingerprint(unit, fc, data);
    }
    return generateAduHashFingerprint(data, unit, fc);
  }

  switch (fc) {
    case FunctionCode.READ_COILS:
    case FunctionCode.READ_DISCRETE_INPUTS:
    case FunctionCode.READ_HOLDING_REGISTERS:
    case FunctionCode.READ_INPUT_REGISTERS:
      // Stateless read: physical interval is already encoded in data[0..3].
      return generateAduHashFingerprint(data, unit, fc);

    case FunctionCode.WRITE_SINGLE_COIL:
    case FunctionCode.WRITE_SINGLE_REGISTER:
    case FunctionCode.WRITE_MULTIPLE_COILS:
    case FunctionCode.WRITE_MULTIPLE_REGISTERS:
    case FunctionCode.MASK_WRITE_REGISTER:
    case FunctionCode.READ_WRITE_MULTIPLE_REGISTERS:
    case FunctionCode.DIAGNOSTICS:
      // Stateful write/mixed/echo: lock the full data body so only exact duplicates overwrite.
      return generateAduHashFingerprint(data, unit, fc);

    case FunctionCode.READ_DEVICE_IDENTIFICATION:
      // FC 43/14: data = [0x14, level, objectId]; key by level + objectId.
      // Pass the two payload bytes as header args to avoid a subarray allocation
      // on the deduplication hot path.
      return generateAduHashFingerprint(null, unit, fc, data[1], data[2]);

    case FunctionCode.REPORT_SERVER_ID:
      // FC 17 has no parameters.
      return generateAduHashFingerprint(null, unit, fc);

    default:
      return null;
  }
}
