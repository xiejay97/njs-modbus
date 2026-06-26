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
 * Compute Modbus ASCII LRC (Longitudinal Redundancy Check, V1.1b3 §2.5.2.2).
 *
 * Algorithm — sum all bytes in the range, take the two's complement of the
 * low 8 bits, return as a single byte. Equivalent to the spec's
 * `((-sum) & 0xff)` formulation.
 *
 * On the wire ASCII frames carry the LRC as two hex characters
 * before the `\r\n` terminator — caller is responsible for hex encoding.
 *
 * @param data Source bytes (the binary-decoded PDU including unit + FC + payload).
 * @param start Inclusive byte offset where the LRC computation starts.
 * @param end Exclusive byte offset where the LRC computation stops.
 * @returns 8-bit LRC value in `[0, 0xFF]`.
 *
 * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
 */
export function lrc(data: Uint8Array, start: number, end: number): number {
  let sum = 0;

  for (let i = start; i < end; i++) {
    sum += data[i];
  }

  return -sum & 0xff;
}
