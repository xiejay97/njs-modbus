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
 * Modbus protocol exception codes (V1.1b3 §7).
 *
 * The wire-byte appears immediately after a function code with the exception
 * bit (0x80) set. Values are sparse on purpose — 0x00, 0x07, 0x09 and gaps
 * above 0x0B are reserved by the spec and must not be used by custom slaves.
 */
export enum ErrorCode {
  /** Function code received in the request is not supported. */
  ILLEGAL_FUNCTION = 0x01,
  /** Data address in the request is not allowed on this slave. */
  ILLEGAL_DATA_ADDRESS = 0x02,
  /** Value in the request data field is not allowed for this function. */
  ILLEGAL_DATA_VALUE = 0x03,
  /** An unrecoverable error occurred while the slave was processing the request. */
  SERVER_DEVICE_FAILURE = 0x04,
  /** Slave has accepted the request and is processing it, but this will take time. */
  ACKNOWLEDGE = 0x05,
  /** Slave is engaged in processing a long-duration program command. */
  SERVER_DEVICE_BUSY = 0x06,
  /** Slave parity error in memory or associated device. */
  MEMORY_PARITY_ERROR = 0x08,
  /** Gateway could not allocate an internal communication path to the target device. */
  GATEWAY_PATH_UNAVAILABLE = 0x0a,
  /** No response was received from the target device behind the gateway. */
  GATEWAY_TARGET_DEVICE_FAILED_TO_RESPOND = 0x0b,
}

const ERROR_MESSAGES: Record<ErrorCode, string> = {
  [ErrorCode.ILLEGAL_FUNCTION]: 'Illegal function',
  [ErrorCode.ILLEGAL_DATA_ADDRESS]: 'Illegal data address',
  [ErrorCode.ILLEGAL_DATA_VALUE]: 'Illegal data value',
  [ErrorCode.SERVER_DEVICE_FAILURE]: 'Server device failure',
  [ErrorCode.ACKNOWLEDGE]: 'Acknowledge',
  [ErrorCode.SERVER_DEVICE_BUSY]: 'Server device busy',
  [ErrorCode.MEMORY_PARITY_ERROR]: 'Memory parity error',
  [ErrorCode.GATEWAY_PATH_UNAVAILABLE]: 'Gateway path unavailable',
  [ErrorCode.GATEWAY_TARGET_DEVICE_FAILED_TO_RESPOND]: 'Gateway target device failed to respond',
};

/**
 * Strongly-typed `Error` subclass that carries a Modbus exception code.
 *
 * Throwing this from a slave handler causes the slave dispatcher to encode
 * the exception response (FC | 0x80 followed by `code`); throwing it from a
 * master callback path surfaces the slave's reported exception to user code.
 *
 * The `name` property is fixed to `'ModbusError'` so {@link getCodeByError}
 * can reliably identify it across realm / V8 isolate boundaries without
 * relying on `instanceof`.
 */
export class ModbusError extends Error {
  /**
   * @param code Modbus exception code carried on the wire.
   * @param message Human-readable description; defaults to the spec-defined
   *   English label for `code`.
   */
  constructor(
    public readonly code: ErrorCode,
    message = ERROR_MESSAGES[code],
  ) {
    super(message);
    this.name = 'ModbusError';
  }
}

/**
 * Construct a {@link ModbusError} from a wire-level exception code.
 *
 * @param code Modbus exception code byte (0x01..0x0B per V1.1b3 §7).
 * @returns Newly allocated `ModbusError` with the spec-defined message.
 */
export function getErrorByCode(code: ErrorCode): ModbusError {
  return new ModbusError(code);
}

/**
 * Map an arbitrary `Error` back to a Modbus exception code for transport on
 * the wire. Used by the slave dispatch path when a user handler throws.
 *
 * Recognises `ModbusError` instances by `name === 'ModbusError'` and a valid
 * `code`; everything else is normalized to `SERVER_DEVICE_FAILURE` (0x04),
 * the spec-defined catch-all for internal slave failures.
 *
 * @param err Error thrown by user code (or surfaced by the runtime).
 * @returns A wire-encodable {@link ErrorCode}; never throws.
 */
export function getCodeByError(err: Error): ErrorCode {
  if (err.name === 'ModbusError' && 'code' in err) {
    const code = (err as ModbusError).code;
    if (code in ErrorCode) {
      return code;
    }
  }
  return ErrorCode.SERVER_DEVICE_FAILURE;
}
