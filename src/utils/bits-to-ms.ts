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
 * Convert a number of bits to milliseconds at a given baud rate.
 *
 * Used to derive Modbus RTU timing intervals from bit counts — e.g. 38.5 bits
 * = 3.5 character times at 11 bits/char (t3.5 inter-frame silence), or 16.5
 * bits = 1.5 character times (t1.5 inter-character timeout), per Modbus V1.02
 * §2.5.1.1.
 *
 * @param baudRate Serial port baud rate (unit: bits per second, e.g. 9600, 19200).
 * @param bits Number of bits whose duration is being measured (unit: bit).
 * @returns Duration in milliseconds (unit: ms, floating-point — caller decides how to round).
 */
export function bitsToMs(baudRate: number, bits: number): number {
  return (bits * 1000) / baudRate;
}
