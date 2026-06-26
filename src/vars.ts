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
 * Standard Modbus function codes (V1.1b3 §6).
 *
 * Values are the wire-byte that follows the unit / MBAP header. Bit 0x80 is
 * reserved as the exception flag (see `EXCEPTION_OFFSET`); function
 * codes never overlap with the exception space.
 */
export enum FunctionCode {
  /** FC 1 — Read Coils. */
  READ_COILS = 0x01,
  /** FC 2 — Read Discrete Inputs. */
  READ_DISCRETE_INPUTS = 0x02,
  /** FC 3 — Read Holding Registers. */
  READ_HOLDING_REGISTERS = 0x03,
  /** FC 4 — Read Input Registers. */
  READ_INPUT_REGISTERS = 0x04,
  /** FC 5 — Write Single Coil. */
  WRITE_SINGLE_COIL = 0x05,
  /** FC 6 — Write Single Register. */
  WRITE_SINGLE_REGISTER = 0x06,
  /** FC 8 — Diagnostics. */
  DIAGNOSTICS = 0x08,
  /** FC 15 — Write Multiple Coils. */
  WRITE_MULTIPLE_COILS = 0x0f,
  /** FC 16 — Write Multiple Registers. */
  WRITE_MULTIPLE_REGISTERS = 0x10,
  /** FC 17 — Report Server ID. */
  REPORT_SERVER_ID = 0x11,
  /** FC 22 — Mask Write Register. */
  MASK_WRITE_REGISTER = 0x16,
  /** FC 23 — Read/Write Multiple Registers. */
  READ_WRITE_MULTIPLE_REGISTERS = 0x17,
  /** FC 43 — Read Device Identification. */
  READ_DEVICE_IDENTIFICATION = 0x2b,
}

/**
 * Exception response FC = request FC | EXCEPTION_OFFSET (V1.1b3 §7).
 *
 * A slave signals an error by OR-ing the original function code with this bit;
 * the body of the response then carries a single {@link ErrorCode} byte.
 */
export const EXCEPTION_OFFSET = 0x80;

/**
 * Coil ON value (`0xFF00`) used in FC 5 / FC 15 payloads (V1.1b3 §6.5/§6.11).
 *
 * The Modbus spec mandates exactly these two magic values — any other 16-bit
 * pattern is illegal and slaves must reject it with `ILLEGAL_DATA_VALUE`.
 */
export const COIL_ON = 0xff00;
/**
 * Coil OFF value (`0x0000`) used in FC 5 / FC 15 payloads (V1.1b3 §6.5/§6.11).
 */
export const COIL_OFF = 0x0000;

/**
 * MEI sub-function selector for FC 0x2B that designates Read Device
 * Identification (V1.1b3 §6.21). The byte appears immediately after the FC.
 */
export const MEI_READ_DEVICE_ID = 0x0e;

/**
 * Sub-function code 0x0000 for FC 0x08 — Diagnostics: Return Query Data
 * (V1.1b3 §6.8). The slave echoes the 4-byte request PDU verbatim.
 */
export const DIAGNOSTICS_RETURN_QUERY_DATA = 0x0000;

/**
 * Modbus V1.1b3 PDU quantity limits.
 *
 * Hard ceilings derived from the 253-byte PDU envelope; any request that
 * exceeds these bounds must be answered with `ILLEGAL_DATA_VALUE`.
 */
export const LIMITS = {
  /** Minimum quantity for FC 1 / FC 2 read-coil requests. */
  READ_COILS_MIN: 0x0001,
  /** Maximum quantity for FC 1 / FC 2 read-coil requests (2000 coils). */
  READ_COILS_MAX: 0x07d0,
  /** Minimum quantity for FC 3 / FC 4 read-register requests. */
  READ_REGISTERS_MIN: 0x0001,
  /** Maximum quantity for FC 3 / FC 4 read-register requests (125 registers). */
  READ_REGISTERS_MAX: 0x007d,
  /** Maximum quantity for FC 15 write-coil requests (1968 coils). */
  WRITE_COILS_MAX: 0x07b0,
  /** Maximum quantity for FC 16 write-register requests (123 registers). */
  WRITE_REGISTERS_MAX: 0x007b,
  /** Maximum write quantity for FC 23 read/write requests (121 registers). */
  RW_REGISTERS_WRITE_MAX: 0x0079,
} as const;

/**
 * Read Device ID code values inside an FC 0x2B / MEI 0x0E request.
 *
 * Selects how much identification data the slave should stream back; values
 * 0x01..0x03 are stream selectors, 0x04 is single-object random access.
 */
export enum ReadDeviceIDCode {
  /** Basic stream — objects 0x00..0x02. */
  BASIC_STREAM = 0x01,
  /** Regular stream — objects 0x00..0x06. */
  REGULAR_STREAM = 0x02,
  /** Extended stream — objects 0x00..0x06 plus extended range. */
  EXTENDED_STREAM = 0x03,
  /** Specific access — single object by id. */
  SPECIFIC_ACCESS = 0x04,
}

/**
 * Conformity level reported in an FC 0x2B / MEI 0x0E response.
 *
 * High bit (0x80) is set when the slave also supports individual access
 * (per spec §6.21); the low nibble is the streaming-conformity tier.
 */
export enum ConformityLevel {
  /** Basic conformity — only objects 0x00..0x02. */
  BASIC = 0x81,
  /** Regular conformity — objects 0x00..0x06. */
  REGULAR = 0x82,
  /** Extended conformity — extended object range supported. */
  EXTENDED = 0x83,
}

/**
 * Shared zero-length `Buffer` reused as a sentinel for empty PDU payloads.
 *
 * Keeping a single immutable instance avoids per-call `Buffer.alloc(0)`
 * allocations on the framing hot path.
 */
export const EMPTY_BUFFER = Buffer.alloc(0);

/**
 * Error thrown when an access-control hook denies a request.
 *
 * This is a normal `Error` subclass with a fixed `name` so callers can
 * distinguish access denials from transport or protocol failures.
 */
export class UnauthorizedAccessError extends Error {
  /**
   * @param message Human-readable denial reason.
   */
  constructor(message = 'Unauthorized access attempt intercepted') {
    super(message);
    this.name = 'UnauthorizedAccessError';
  }
}
