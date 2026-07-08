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
  [ErrorCode.ILLEGAL_FUNCTION]: 'Illegal function (CODE 0x01)',
  [ErrorCode.ILLEGAL_DATA_ADDRESS]: 'Illegal data address (CODE 0x02)',
  [ErrorCode.ILLEGAL_DATA_VALUE]: 'Illegal data value (CODE 0x03)',
  [ErrorCode.SERVER_DEVICE_FAILURE]: 'Server device failure (CODE 0x04)',
  [ErrorCode.ACKNOWLEDGE]: 'Acknowledge (CODE 0x05)',
  [ErrorCode.SERVER_DEVICE_BUSY]: 'Server device busy (CODE 0x06)',
  [ErrorCode.MEMORY_PARITY_ERROR]: 'Memory parity error (CODE 0x08)',
  [ErrorCode.GATEWAY_PATH_UNAVAILABLE]: 'Gateway path unavailable (CODE 0x0a)',
  [ErrorCode.GATEWAY_TARGET_DEVICE_FAILED_TO_RESPOND]: 'Gateway target device failed to respond (CODE 0x0b)',
};

/** Reverse lookup from the spec-defined English message back to its wire code. */
const MESSAGE_TO_ERROR_CODE: Record<string, ErrorCode> = {};
for (const codeStr of Object.keys(ERROR_MESSAGES)) {
  const code = Number(codeStr) as ErrorCode;
  MESSAGE_TO_ERROR_CODE[ERROR_MESSAGES[code]] = code;
}

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
 * Look up a Modbus exception code from its spec-defined English message text.
 *
 * This is useful when an error has crossed a realm or structured-clone boundary
 * and lost its typed `code` property: the clone preserves `message` but rebuilds
 * the object as a plain `Error` with `name === 'Error'`. Custom messages set on
 * a {@link ModbusError} constructor will not be present in the lookup table and
 * therefore return `undefined`.
 *
 * @param message Error message to resolve; matched exactly against the spec labels.
 * @returns The matching {@link ErrorCode}, or `undefined` if the message is not
 *   a recognised spec label.
 */
export function getErrorCodeByMessage(message: string): ErrorCode | undefined {
  return MESSAGE_TO_ERROR_CODE[message];
}

/**
 * Map an arbitrary `Error` back to a Modbus exception code for transport on
 * the wire. Used by the slave dispatch path when a user handler throws.
 *
 * Recognises `ModbusError` instances by `name === 'ModbusError'` and a valid
 * `code`. If the code is missing or invalid, or if the error has been rebuilt
 * by structured cloning (which drops custom own properties such as `code` and
 * resets `name` to `'Error'`), the function falls back to matching the
 * spec-defined message text via {@link getErrorCodeByMessage}. Everything else
 * is normalized to `SERVER_DEVICE_FAILURE` (0x04), the spec-defined catch-all
 * for internal slave failures.
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
  // Structured cloning preserves `message` but drops custom own properties such
  // as `code`, and resets `name` to `'Error'`. Recover from the spec-defined
  // message text when possible.
  const code = getErrorCodeByMessage(err.message);
  if (code !== undefined) {
    return code;
  }
  return ErrorCode.SERVER_DEVICE_FAILURE;
}
