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
 * Utility modules public API.
 *
 * Re-exports the small, hot-path helpers used by the framing layers and
 * orchestrators. Each function is documented in its source file.
 */

/** Unit and address authorization helpers. */
export { runCheckUnit, runCheckAddress } from './access-authorizer';
/** ADU hashing and request fingerprinting helpers. */
export { generateAduHashFingerprint, generateRequestFingerprint } from './adu-fingerprint';
/** Baud-rate ↔ millisecond conversion for RTU timing. */
export { bitsToMs } from './bits-to-ms';
/** Inclusive numeric range membership test. */
export { checkRange } from './check-range';
/** IP address canonicalization for equality comparison. */
export { canonicalizeIp } from './canonicalize-ip';
/** IP whitelist matcher with exact and CIDR support. */
export type { WhitelistEntry } from './ip-whitelist';
export { createIpMatcher, createIpMatchers } from './ip-whitelist';
/** Minimal typed event emitter. */
export { CompactEventEmitter } from './compact-event';
/** CRC-16 lookup table and single / dual-segment CRC computation. */
export { crcFixed, crcDual, CRC_TABLE } from './crc';
/** Modbus ASCII LRC computation. */
export { lrc } from './lrc';
/** Hybrid direct-timer / binary-heap timeout manager. */
export { TimerHeap } from './timer-heap';
