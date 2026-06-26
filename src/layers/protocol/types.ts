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
 * Discriminant for {@link FrameErrorEvent} describing why a frame was rejected by
 * a protocol framing layer.
 */
export type FrameErrorEventType =
  /** ASCII hex body contained a character outside `0..9` / `A..F` (or lowercase when strict). */
  | 'hex_character_invalid'
  /** ASCII LRC sum-of-bytes check did not match the trailing LRC byte. */
  | 'lrc_check_failed'
  /** ASCII hex body exceeded the 512-character limit. */
  | 'frame_too_long'
  /** ASCII hex body was shorter than the 6 characters required for unit + FC + LRC. */
  | 'frame_length_insufficient'
  /** ASCII hex body had an odd character count or TCP MBAP length field was out of range. */
  | 'frame_length_invalid'
  /** RTU t3.5 inter-frame silence expired before a complete frame was assembled. */
  | 't3.5_timeout'
  /** RTU t1.5 inter-character timeout expired (emitted only when strict timing is enabled). */
  | 't1.5_timeout'
  /** TCP MBAP protocol identifier was not `0x0000`. */
  | 'protocol_id_invalid';

/**
 * Payload emitted with the `frameError` event when a protocol layer discards a
 * malformed, incomplete, or out-of-spec frame.
 */
export interface FrameErrorEvent {
  /** Error classification; see {@link FrameErrorEventType}. */
  type: FrameErrorEventType;

  /**
   * Human-readable description of the failure; sufficient to diagnose the
   * problem without reading {@link raw}.
   */
  message: string;

  /**
   * The raw, unprocessable bytes that caused the failure.
   * This is a snapshot of the bad frame data and is safe to inspect or log.
   * Its length is capped at the protocol-specific maximum frame length.
   */
  raw: Buffer;

  /** TCP MBAP transaction identifier (big-endian, 16-bit), when available. */
  transaction?: number;

  /** Modbus function code byte (0..255), extracted from the frame when available. */
  fc?: number;
}
