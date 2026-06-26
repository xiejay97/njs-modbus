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

import type { ErrorCode } from '../error-code';
import type { ServerId } from '../types';

/**
 * Discriminated callback arguments for a slave handler that returns `D`.
 *
 * On success the handler receives `[null, data]`; on failure it receives
 * `[errorCode, undefined]`.
 *
 * @template D Payload type returned on success.
 */
export type CallbackArgs<D> = [errorCode: null, data: D] | [errorCode: ErrorCode, data: undefined];

/**
 * Slave handler callback shape.
 *
 * When `D` is `void` the callback is invoked with only the error code;
 * otherwise it receives the discriminated tuple from {@link CallbackArgs}.
 *
 * @template D Payload type returned on success.
 */
export type Callback<D> = D extends void ? (errorCode: ErrorCode | null) => void : (...args: CallbackArgs<D>) => void;

/**
 * Lazy variant of {@link CallbackArgs}: the data payload is wrapped in a
 * zero-argument factory so the slave can defer response encoding until the
 * framing layer is ready to write.
 *
 * @template D Payload type returned on success.
 */
export type CallbackLazyArgs<D> = [errorCode: null, data: () => D] | [errorCode: ErrorCode, data: undefined];

/**
 * Lazy variant of {@link Callback} used by the slave dispatcher.
 *
 * The payload factory is only called when the response is actually encoded,
 * letting handlers return large or computed payloads without allocation
 * unless the request is authorized and the pipeline is connected.
 *
 * @template D Payload type returned on success.
 */
export type CallbackLazy<D> = (...args: CallbackLazyArgs<D>) => void;

/**
 * Unit model contract implemented by user code and registered with
 * {@link ModbusSlave.addUnit}.
 *
 * Each property is an optional handler for one Modbus function code. The
 * slave dispatcher validates the request shape, invokes the matching handler,
 * and encodes the response. Handlers should follow the callback convention
 * `[errorCode, data]` (or just `errorCode` for void payloads).
 */
export interface ModbusUnitModel {
  /**
   * Unit identifier this model claims.
   *
   * Valid range is `1..247` per the Modbus spec; `0` is reserved for broadcast.
   * Defaults to `1` when omitted; pass an explicit value when a single slave
   * instance hosts multiple unit IDs.
   */
  unit?: number;

  //#region Discrete Inputs

  /**
   * FC 2 — Read Discrete Inputs.
   *
   * @param address Zero-based input starting address (0..0xFFFF).
   * @param length Number of inputs to read (1..2000).
   * @param callback Invoked with `[null, values]` on success or
   *   `[errorCode, undefined]` on failure; `values` may be any `ArrayLike<0 | 1>`
   *   (e.g. `number[]`), where each element represents OFF (`0`) or ON (`1`).
   */
  readDiscreteInputs?: (address: number, length: number, callback: Callback<ArrayLike<0 | 1>>) => void;

  //#endregion

  //#region Coils

  /**
   * FC 1 — Read Coils.
   *
   * @param address Zero-based coil starting address (0..0xFFFF).
   * @param length Number of coils to read (1..2000).
   * @param callback Invoked with `[null, values]` on success or
   *   `[errorCode, undefined]` on failure; `values` may be any `ArrayLike<0 | 1>`
   *   (e.g. `number[]`), where each element represents OFF (`0`) or ON (`1`).
   */
  readCoils?: (address: number, length: number, callback: Callback<ArrayLike<0 | 1>>) => void;

  /**
   * FC 5 — Write Single Coil.
   *
   * @param address Zero-based coil address (0..0xFFFF).
   * @param value Coil state — `0` (OFF) or `1` (ON).
   * @param callback Invoked with `[null]` on success or `[errorCode]` on failure.
   */
  writeSingleCoil?: (address: number, value: number, callback: Callback<void>) => void;

  /**
   * FC 15 — Write Multiple Coils.
   *
   * @param address Zero-based coil starting address (0..0xFFFF).
   * @param value Coil states — array of `0` (OFF) or `1` (ON), length 1..1968.
   * @param callback Invoked with `[null]` on success or `[errorCode]` on failure.
   */
  writeMultipleCoils?: (address: number, value: (0 | 1)[], callback: Callback<void>) => void;

  //#endregion

  //#region Input Registers

  /**
   * FC 4 — Read Input Registers.
   *
   * @param address Zero-based register starting address (0..0xFFFF).
   * @param length Number of registers to read (1..125).
   * @param callback Invoked with `[null, values]` on success or
   *   `[errorCode, undefined]` on failure; `values` may be any `ArrayLike<number>`
   *   of 16-bit words (e.g. `number[]`, `Uint16Array`, `Buffer`).
   */
  readInputRegisters?: (address: number, length: number, callback: Callback<ArrayLike<number>>) => void;

  //#endregion

  //#region Holding Registers

  /**
   * FC 3 — Read Holding Registers.
   *
   * @param address Zero-based register starting address (0..0xFFFF).
   * @param length Number of registers to read (1..125).
   * @param callback Invoked with `[null, values]` on success or
   *   `[errorCode, undefined]` on failure; `values` may be any `ArrayLike<number>`
   *   of 16-bit words (e.g. `number[]`, `Uint16Array`, `Buffer`).
   */
  readHoldingRegisters?: (address: number, length: number, callback: Callback<ArrayLike<number>>) => void;

  /**
   * FC 6 — Write Single Register.
   *
   * @param address Zero-based register address (0..0xFFFF).
   * @param value Big-endian 16-bit value to write (0..0xFFFF).
   * @param callback Invoked with `[null]` on success or `[errorCode]` on failure.
   */
  writeSingleRegister?: (address: number, value: number, callback: Callback<void>) => void;

  /**
   * FC 16 — Write Multiple Registers.
   *
   * @param address Zero-based register starting address (0..0xFFFF).
   * @param value Register values to write as a `number[]` of 16-bit words,
   *   length 1..123.
   * @param callback Invoked with `[null]` on success or `[errorCode]` on failure.
   */
  writeMultipleRegisters?: (address: number, value: number[], callback: Callback<void>) => void;

  /**
   * FC 22 — Mask Write Register.
   *
   * @param address Zero-based register address (0..0xFFFF).
   * @param andMask 16-bit AND mask (0..0xFFFF).
   * @param orMask 16-bit OR mask (0..0xFFFF).
   * @param callback Invoked with `[null]` on success or `[errorCode]` on failure.
   */
  maskWriteRegister?: (address: number, andMask: number, orMask: number, callback: Callback<void>) => void;

  //#endregion

  /**
   * FC 8 / Sub-function 0x0000 — Diagnostics: Return Query Data.
   *
   * The handler receives the 16-bit diagnostic data from the request and may
   * inspect, log, or reject it; the response is always the original request PDU
   * echoed verbatim.
   *
   * @param data 16-bit diagnostic data value from the request (0..0xFFFF).
   * @param callback Invoked with `[null]` on success or `[errorCode]` on failure.
   */
  diagnosticsReturnQueryData?: (data: number, callback: Callback<void>) => void;

  /**
   * FC 17 — Report Server ID.
   *
   * @param callback Invoked with `[null, serverId]` on success or
   *   `[errorCode, undefined]` on failure.
   */
  reportServerId?: (callback: Callback<ServerId>) => void;

  /**
   * FC 43 / MEI 14 — Read Device Identification.
   *
   * Return the slave's TLV identification table keyed by object id (0..255).
   * Object ids 0x07..0x7F are reserved by the spec and rejected by the
   * dispatcher with `SERVER_DEVICE_FAILURE`.
   *
   * @param callback Invoked with `[null, objects]` on success or
   *   `[errorCode, undefined]` on failure.
   */
  readDeviceIdentification?: (callback: Callback<{ [index: number]: string }>) => void;
}

/**
 * Discriminant for {@link ProtocolExceptionEvent} describing the reason a slave
 * produced a Modbus exception response.
 */
export type ProtocolExceptionEventType =
  /** Function code is not supported by this slave or the framing layer. */
  | 'function_illegal'
  /** Function code is legal but no handler is implemented for the target unit. */
  | 'function_not_implemented'
  /** PDU length, value range, or structure violates the Modbus specification. */
  | 'data_value_illegal'
  /** Data address or object id is outside the allowed range. */
  | 'data_address_illegal'
  /** Slave handler detected an internal/device-side failure while building the response. */
  | 'server_device_failure'
  /** Target unit is not registered on this slave session. */
  | 'gateway_path_unavailable';

/**
 * Payload emitted with the `protocolException` event when the slave responds
 * with a Modbus exception function code.
 *
 * @example
 * ```ts
 * slave.on('protocolException', (event) => {
 *   logger.info({ exception: event }, 'modbus exception');
 * });
 * ```
 *
 * @see {@link ProtocolExceptionEventType}
 */
export interface ProtocolExceptionEvent {
  /** Error classification; see {@link ProtocolExceptionEventType}. */
  type: ProtocolExceptionEventType;

  /**
   * Human-readable description of the failure; sufficient to diagnose the
   * problem without inspecting {@link data}.
   */
  message: string;

  /** TCP MBAP transaction identifier (big-endian, 16-bit), when available. */
  transaction?: number;

  /** Modbus unit/slave address byte (0..247). */
  unit: number;

  /** Modbus function code byte (0..255). */
  fc: number;

  /**
   * Snapshot of the PDU payload that triggered the exception.
   * This is a copy of the original bytes and is safe to inspect or log.
   */
  data: Buffer;
}

/**
 * Discriminant for {@link AccessAuditEvent} describing a request that was
 * rejected by the configured access authorizer.
 */
export type AccessAuditEventType =
  /** Unit address was rejected by the configured access authorizer. */
  | 'unit_access_denied'
  /** Address range or table was rejected by the configured access authorizer. */
  | 'address_access_denied'
  /** Runtime authorization denied or returned an exception code. */
  | 'runtime_access_denied';

/**
 * Payload emitted with the `accessAudit` event when a request is rejected by
 * the configured access authorizer.
 *
 * @example
 * ```ts
 * slave.on('accessAudit', (event) => {
 *   logger.warn({ audit: event }, 'modbus access denied');
 * });
 * ```
 *
 * @see {@link AccessAuditEventType} {@link AccessAuthorizer}
 */
export interface AccessAuditEvent {
  /** Audit classification; see {@link AccessAuditEventType}. */
  type: AccessAuditEventType;

  /**
   * Human-readable description of the audit event; sufficient to diagnose the
   * problem without inspecting {@link data}.
   */
  message: string;

  /** TCP MBAP transaction identifier (big-endian, 16-bit), when available. */
  transaction?: number;

  /** Modbus unit/slave address byte (0..247). */
  unit: number;

  /** Modbus function code byte (0..255). */
  fc: number;

  /**
   * Snapshot of the PDU payload that triggered the audit event.
   * This is a copy of the original bytes and is safe to inspect or log.
   */
  data: Buffer;
}

/**
 * Discriminant for {@link PipelineFaultEvent} describing a transport-layer
 * failure while emitting a response frame.
 */
export type PipelineFaultEventType =
  /** The pipeline layer failed to write the encoded response frame. */
  'write_failed';

/**
 * Payload emitted with the `pipelineFault` event when the slave has produced a
 * response but the underlying pipeline layer could not transmit it.
 */
export interface PipelineFaultEvent {
  /** Fault classification; see {@link PipelineFaultEventType}. */
  type: PipelineFaultEventType;

  /**
   * Human-readable description of the failure; sufficient to diagnose the
   * problem without inspecting {@link data} / {@link responseRaw}.
   */
  message: string;

  /** TCP MBAP transaction identifier (big-endian, 16-bit), when available. */
  transaction?: number;

  /** Modbus unit/slave address byte (0..247). */
  unit: number;

  /** Modbus function code byte (0..255). */
  fc: number;

  /**
   * Snapshot of the request PDU payload that triggered the attempted response.
   * This is a copy of the original bytes and is safe to inspect or log.
   */
  data: Buffer;

  /**
   * The raw, encoded response frame that the pipeline layer failed to write.
   * This is the exact buffer passed to the pipeline layer's write operation.
   */
  responseRaw: Buffer;

  /** The error returned by the pipeline layer's write operation. */
  error: Error;
}
