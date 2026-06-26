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

import type { ErrorCode } from './error-code';

/**
 * Modbus Application Data Unit (ADU) — the protocol-agnostic, transport-stripped
 * representation passed between the application layer and the master/slave
 * orchestrators.
 *
 * Concretely the framing layers strip away their transport header / trailer
 * (MBAP for TCP, address + CRC for RTU, `:` / `\r\n` + LRC for ASCII) and
 * emit a normalized ADU; the inverse path encodes the ADU back onto the wire.
 */
export interface ApplicationDataUnit {
  /**
   * MBAP transaction identifier (TCP only). Set on TCP, undefined on RTU/ASCII.
   * 16-bit unsigned, big-endian on the wire (per Modbus Messaging on TCP/IP §3.1).
   */
  transaction?: number;

  /**
   * Unit / slave address byte (0..247 per spec; 0 = broadcast, 248..255 reserved).
   */
  unit: number;

  /**
   * Modbus function code (1 byte, 0..255; bit 0x80 reserved for exceptions).
   */
  fc: number;

  /**
   * PDU payload — bytes after the function code and before the transport
   * checksum (i.e. neither CRC16 nor LRC nor MBAP header is included here).
   */
  data: Buffer;
}

/**
 * A parsed Modbus frame as emitted by the framing layer.
 *
 * Extends {@link ApplicationDataUnit} with the raw, on-wire buffer that
 * produced it. The raw buffer is useful for audit logging, replay, and
 * diagnostic events.
 */
export type ModbusFrame = ApplicationDataUnit & { buffer: Buffer };

/**
 * Slave-side configuration block used to answer FC 17 (`REPORT_SERVER_ID`).
 *
 * Bytes are emitted in the order: `serverId` array → `runIndicatorStatus`
 * (0x00 OFF / 0xFF ON) → `additionalData`.
 */
export interface ServerId {
  /**
   * Server ID as a byte array (e.g. single-byte IDs use `[id]`).
   */
  serverId?: Uint8Array;

  /**
   * Run-indicator status; encoded as 0xFF (ON) or 0x00 (OFF) on the wire.
   */
  runIndicatorStatus?: boolean;

  /**
   * Additional data bytes. Using Buffer avoids intermediate array conversions.
   */
  additionalData?: Buffer;
}

/**
 * Slave-side configuration block used to answer FC 43 / MEI 14
 * (`READ_DEVICE_IDENTIFICATION`, V1.1b3 §6.21).
 *
 * Each entry in `objects` represents a TLV (id, length-prefixed string) tuple
 * on the wire; the framing layer fragments the response when the cumulative
 * payload would exceed the 253-byte PDU limit and toggles `moreFollows`
 * accordingly.
 */
export interface DeviceIdentification {
  /**
   * Echoed Read Device ID code (1..4); see `ReadDeviceIDCode`.
   */
  readDeviceIDCode: number;

  /**
   * Conformity level reported back to the master (0x81/0x82/0x83).
   */
  conformityLevel: number;

  /**
   * `true` when the response is fragmented and more objects follow.
   */
  moreFollows: boolean;

  /**
   * Next object id to query when `moreFollows` is set; 0 when terminated.
   */
  nextObjectId: number;

  /**
   * TLV objects to return; each `value` is encoded as ASCII bytes.
   */
  objects: { id: number; value: string }[];
}

/**
 * Modbus ADU queue processing strategy.
 *
 * Controls pruning, deduplication, and scheduling behavior when new requests arrive.
 */
export type ModbusQueueStrategy =
  /** Strict first-in-first-out, execute in queued order. */
  | 'fifo'
  /**
   * Last-arrived overwrites; new requests clear all stale unexecuted items in
   * the queue. This is the default used by {@link ModbusMaster} and
   * {@link ModbusSlave} when no strategy is specified.
   */
  | 'drop-stale'
  /** Smart deduplication based on ADU fingerprint. */
  | 'deduplicate'
  /**
   * Concurrent async dispatch (⚠️ Modbus TCP or multi-link Master only, use
   * with caution on RTU bus).
   */
  | 'concurrent';

/**
 * Defines a non-standard / user-defined Modbus function code.
 *
 * Registration paths:
 * - `RtuApplicationLayer.addCustomFunctionCode(cfc)` — framing only.
 * - `ModbusSlave.addCustomFunctionCode(cfc)` — framing + slave-side dispatch via `handle`.
 * - `ModbusMaster.addCustomFunctionCode(cfc)` + `ModbusMaster.sendCustomFC(...)` — framing + request issuance.
 *
 * The two `predict*` callbacks declare how to derive the total RTU frame length
 * (PDU + 2-byte CRC) from leading bytes; they are required so the framing FSM
 * can advance without the deleted sliding-window CRC fallback.
 *
 * Return `0` to signal "need more bytes before I can decide".
 * Return `-1` to signal "cannot determine the length".
 * Return a positive integer (>= 4, <= 256) for the total frame length.
 */
export interface CustomFunctionCode {
  /**
   * Function code byte (0..255, excluding 0x80 exception bit).
   */
  fc: number;

  /**
   * Optional address-range extractor for access-control gating.
   *
   * @param unit Unit / slave address byte (0..247).
   * @param fc Function code byte.
   * @param data PDU payload bytes (after the FC).
   * @returns Address ranges touched by this request, keyed by table name.
   *
   * @example Declare that a custom FC touches holding registers 0..N-1.
   * ```ts
   * {
   *   fc: 0x65,
   *   requestAddressRange: (_unit, _fc, data) => ({
   *     holdingRegisters: [[0, data.length - 1]],
   *   }),
   * }
   * ```
   */
  requestAddressRange?: (
    unit: number,
    fc: number,
    data: Buffer,
  ) => { [P in 'discreteInputs' | 'coils' | 'inputRegisters' | 'holdingRegisters']?: [startAddress: number, endAddress: number][] };

  /**
   * Optional fingerprint extractor for deduplication queue strategy.
   *
   * @param unit Unit / slave address byte (0..247).
   * @param fc Function code byte.
   * @param data PDU payload bytes (after the FC).
   * @returns 32-bit unsigned fingerprint, or `null` to disable deduplication for this request.
   */
  requestFingerprint?: (unit: number, fc: number, data: Buffer) => number;
}

/**
 * Optional access-control policy evaluated by the master before a request
 * enters the queue and by the slave before a request is dispatched to a
 * unit handler.
 *
 * Each hook may return synchronously or asynchronously:
 * - `true` — allow the operation.
 * - `false` — deny with {@link UnauthorizedAccessError}.
 * - {@link ErrorCode} — deny and surface as a typed {@link ModbusError}.
 *
 * Omit a hook to disable that gate.
 *
 * @example Synchronous unit whitelist.
 * ```ts
 * { checkUnit: (unit) => unit === 1 }
 * ```
 *
 * @example Asynchronous authorization against an external directory.
 * ```ts
 * {
 *   checkUnit: async (unit) => {
 *     const allowed = await policyService.isUnitAllowed(unit);
 *     return allowed;
 *   },
 * }
 * ```
 *
 * @example Returning a typed Modbus exception code.
 * ```ts
 * { checkRuntime: () => ErrorCode.SERVER_DEVICE_BUSY }
 * ```
 */
export interface AccessAuthorizer {
  /**
   * Authorize the target unit / slave address.
   *
   * @param unit Unit / slave address byte (0..247, inclusive).
   * @returns `true`, `false`, or an {@link ErrorCode}.
   */
  checkUnit?: (unit: number) => ErrorCode | boolean | Promise<ErrorCode | boolean>;

  /**
   * Authorize the address range touched by the request.
   *
   * Only invoked for standard function codes and for custom function codes
   * that declare {@link CustomFunctionCode.requestAddressRange}.
   *
   * @param unit Unit / slave address byte (0..247, inclusive).
   * @param table Modbus table being accessed.
   * @param addressRange Inclusive zero-based `[startAddress, endAddress]` pair.
   * @returns `true`, `false`, or an {@link ErrorCode}.
   */
  checkAddress?: (
    unit: number,
    table: 'discreteInputs' | 'coils' | 'inputRegisters' | 'holdingRegisters',
    addressRange: [startAddress: number, endAddress: number],
  ) => ErrorCode | boolean | Promise<ErrorCode | boolean>;

  /**
   * Last-chance runtime authorization evaluated immediately before wire I/O.
   *
   * On the master this runs after the queue drains; on the slave it runs
   * after the unit handler produces a successful response.
   *
   * @param unit Unit / slave address byte (0..247, inclusive).
   * @param fc Function code byte (0..255).
   * @param data PDU payload bytes (length 0..253).
   * @returns `true`, `false`, or an {@link ErrorCode}.
   */
  checkRuntime?: (unit: number, fc: number, data: Buffer) => ErrorCode | boolean | Promise<ErrorCode | boolean>;
}
