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

import type { FrameErrorEvent } from './types';
import type { CustomFunctionCode, ModbusFrame } from '../../types';

/**
 * Base class for all Modbus protocol framing layers.
 *
 * Concrete implementations (TCP, RTU, ASCII) own the wire-specific bytes that
 * wrap the protocol-agnostic {@link ApplicationDataUnit}: MBAP headers, CRC16
 * trailers, LRC sums, `:` / `\r\n` delimiters, and timing-driven frame boundaries.
 *
 * The layer exposes typed callbacks (`onFrame`, `onFrameError`) for eager
 * delivery, plus lazy variants (`onFrameLazy`, `onFrameErrorLazy`) for
 * consumers that only need the payload when an observer is actually attached.
 * It also owns a registry for non-standard function codes so that RTU framing
 * can predict custom frame lengths without allocating intermediate buffers.
 *
 * @abstract
 */
export abstract class AbstractProtocolLayer {
  /**
   * Wire protocol identifier implemented by this layer.
   * Set as a `const` literal so downstream type narrowing can distinguish
   * TCP / RTU / ASCII paths without runtime inspection.
   */
  abstract readonly PROTOCOL: 'TCP' | 'RTU' | 'ASCII';

  /**
   * Role of the owning stack.
   * - `MASTER` — initiates requests and decodes responses.
   * - `SLAVE` — listens for requests and encodes responses.
   */
  abstract ROLE: 'MASTER' | 'SLAVE';

  /** Callback invoked when a complete, valid frame is decoded. Receives the frame eagerly. */
  public onFrame?: (frame: ModbusFrame) => void;
  /** Callback invoked when a complete, valid frame is decoded. Receives a lazy producer. */
  public onFrameLazy?: (lazy: () => ModbusFrame) => void;
  /** Callback invoked when a malformed or incomplete frame is discarded. Receives the event eagerly. */
  public onFrameError?: (event: FrameErrorEvent) => void;
  /** Callback invoked when a malformed or incomplete frame is discarded. Receives a lazy producer. */
  public onFrameErrorLazy?: (lazy: () => FrameErrorEvent) => void;

  /**
   * Registry of custom function codes for variable-length frame prediction.
   *
   * Indexed by function-code byte (`0..255`); empty slots are `undefined`.
   * Concrete layers (especially RTU) use this array to decide how many bytes to
   * expect before declaring a frame complete.
   */
  public customFunctionCodes: (CustomFunctionCode | undefined)[] = new Array(256);

  /**
   * Register a custom function code for framing-level length prediction.
   *
   * @param cfc Custom function code descriptor.
   * @returns `void`.
   * @throws When `cfc.fc` is not an integer in `0..255`.
   */
  addCustomFunctionCode(cfc: CustomFunctionCode): void {
    const fc = cfc.fc;
    if ((fc & 0xff) !== fc) {
      throw new Error(`FC must be an integer in 0..255, got ${fc}`);
    }

    this.customFunctionCodes[fc] = cfc;
  }

  /**
   * Remove a previously registered custom function code.
   *
   * @param fc Function code byte (0..255) to deregister.
   * @returns `void`.
   */
  removeCustomFunctionCode(fc: number): void {
    this.customFunctionCodes[fc] = undefined;
  }

  /**
   * Reset any internal framing state (residual bytes, timers, FSM state).
   * Safe to call when the transport signals a disconnect or when re-syncing.
   *
   * @returns `void`.
   */
  flush(): void {}

  /**
   * Decode incoming wire bytes and invoke `onFrame` / `onFrameError` callbacks,
   * falling back to `onFrameLazy` / `onFrameErrorLazy` when the eager variants are
   * not registered.
   *
   * Implementations may retain unprocessed trailing bytes internally to handle
   * fragmented or coalesced network chunks.
   *
   * @param data Raw bytes received from the transport. Must not be modified.
   * @returns `void`.
   */
  abstract decode(data: Buffer): void;

  /**
   * Encode a protocol-agnostic ADU into wire bytes.
   *
   * @param unit Unit / slave address byte (0..247 per spec).
   * @param fc Modbus function code byte (0..255, bit 0x80 reserved for exceptions).
   * @param data PDU payload bytes (everything after the function code, before the checksum).
   * @param transaction TCP MBAP transaction identifier (16-bit unsigned, big-endian
   *   on the wire). Ignored by RTU/ASCII; for TCP masters, omitting auto-increments.
   * @returns The fully framed wire buffer, ready for the transport layer.
   * @throws When the payload exceeds the protocol-specific maximum PDU length.
   */
  abstract encode(unit: number, fc: number, data: Buffer, transaction?: number): Buffer;
}
