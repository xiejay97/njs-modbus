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

import type { ErrorCode, ModbusError } from '../error-code';
import type { AccessAuthorizer, CustomFunctionCode } from '../types';

import { getErrorByCode } from '../error-code';
import { FunctionCode, UnauthorizedAccessError } from '../vars';

/**
 * Normalize the result of `AccessAuthorizer.checkUnit` and invoke `callback`.
 *
 * Synchronous `boolean`, numeric {@link ErrorCode}, and `Promise` results
 * are all handled; if no `checkUnit` hook is configured the callback fires
 * with no error.
 *
 * @param checkUnit The authorizer hook, if any.
 * @param unit Unit / slave address byte (0..247).
 * @param callback Called with either `[null, undefined]` on success,
 *   `[UnauthorizedAccessError, undefined]` on denial, or
 *   `[ModbusError, ErrorCode]` when the hook returns a numeric code.
 * @returns `void`.
 */
export function runCheckUnit(
  checkUnit: AccessAuthorizer['checkUnit'] | undefined,
  unit: number,
  callback: (...args: [error: UnauthorizedAccessError | null, code: undefined] | [error: ModbusError, code: number]) => void,
): void {
  if (!checkUnit) {
    callback(null, undefined);
    return;
  }

  const auth = checkUnit(unit);
  if (auth === true) {
    callback(null, undefined);
  } else if (auth === false) {
    callback(new UnauthorizedAccessError(`Unit ${unit} not authorized`), undefined);
  } else if (typeof auth === 'number') {
    callback(getErrorByCode(auth), auth);
  } else {
    auth.then((res) => {
      if (res === false) {
        callback(new UnauthorizedAccessError(`Unit ${unit} not authorized`), undefined);
      } else if (typeof res === 'number') {
        callback(getErrorByCode(res), res);
      } else {
        callback(null, undefined);
      }
    });
  }
}

/**
 * Normalize the result of `AccessAuthorizer.checkAddress` and invoke `callback`.
 *
 * For standard function codes the address range is derived from the request
 * PDU; for custom function codes the range comes from
 * {@link CustomFunctionCode.requestAddressRange}. If no `checkAddress` hook
 * is configured the callback fires with no error.
 *
 * @param checkAddress The authorizer hook, if any.
 * @param unit Unit / slave address byte (0..247).
 * @param fc Function code byte (0..255).
 * @param data Request PDU payload bytes (unit: byte).
 * @param customFC Custom function-code descriptor, if the FC is non-standard.
 * @param callback Called with either `[null, undefined]` on success,
 *   `[UnauthorizedAccessError, undefined]` on denial, or
 *   `[ModbusError, ErrorCode]` when the hook returns a numeric code.
 * @returns `void`.
 */
export function runCheckAddress(
  checkAddress: AccessAuthorizer['checkAddress'] | undefined,
  unit: number,
  fc: number,
  data: Buffer,
  customFC: CustomFunctionCode | undefined,
  callback: (...args: [error: UnauthorizedAccessError | null, code: undefined] | [error: ModbusError, code: number]) => void,
): void {
  if (!checkAddress) {
    callback(null, undefined);
    return;
  }

  if (customFC) {
    if (customFC.requestAddressRange) {
      const ranges = customFC.requestAddressRange(unit, fc, data);
      let pendingChecks = 0;
      let hasChecks = false;
      let denied = false;

      const onCheckComplete = (result: boolean | ErrorCode, tableName: string, range: [number, number]) => {
        if (denied) {
          return;
        }
        pendingChecks--;
        if (result === false) {
          denied = true;
          callback(
            new UnauthorizedAccessError(
              `Unit ${unit} address range [${range[0]}, ${range[1]}] on ${tableName} not authorized for custom function code 0x${fc.toString(16).padStart(2, '0')}`,
            ),
            undefined,
          );
        } else if (typeof result === 'number') {
          denied = true;
          callback(getErrorByCode(result), result);
        } else if (pendingChecks === 0) {
          callback(null, undefined);
        }
      };

      const tables: ('discreteInputs' | 'coils' | 'inputRegisters' | 'holdingRegisters')[] = [
        'coils',
        'discreteInputs',
        'inputRegisters',
        'holdingRegisters',
      ];
      for (const tableName of tables) {
        const tableRanges = ranges[tableName];
        if (tableRanges && tableRanges.length > 0) {
          for (const range of tableRanges) {
            pendingChecks++;
            hasChecks = true;
            const auth = checkAddress(unit, tableName, range);
            if (auth === true) {
              onCheckComplete(true, tableName, range);
            } else if (auth === false || typeof auth === 'number') {
              onCheckComplete(auth, tableName, range);
            } else {
              auth.then((result) => onCheckComplete(result, tableName, range));
            }
          }
        }
      }

      if (!hasChecks) {
        callback(null, undefined);
      }
      return;
    }
    callback(null, undefined);
    return;
  }

  let table: 'coils' | 'discreteInputs' | 'holdingRegisters' | 'inputRegisters' | undefined;
  let startAddr = 0;
  let endAddr = 0;

  switch (fc) {
    case FunctionCode.READ_COILS:
    case FunctionCode.WRITE_SINGLE_COIL:
    case FunctionCode.WRITE_MULTIPLE_COILS:
      table = 'coils';
      break;
    case FunctionCode.READ_DISCRETE_INPUTS:
      table = 'discreteInputs';
      break;
    case FunctionCode.READ_HOLDING_REGISTERS:
    case FunctionCode.WRITE_SINGLE_REGISTER:
    case FunctionCode.WRITE_MULTIPLE_REGISTERS:
    case FunctionCode.MASK_WRITE_REGISTER:
    case FunctionCode.READ_WRITE_MULTIPLE_REGISTERS:
      table = 'holdingRegisters';
      break;
    case FunctionCode.READ_INPUT_REGISTERS:
      table = 'inputRegisters';
      break;
  }

  if (table) {
    switch (fc) {
      case FunctionCode.READ_COILS:
      case FunctionCode.READ_DISCRETE_INPUTS:
      case FunctionCode.READ_HOLDING_REGISTERS:
      case FunctionCode.READ_INPUT_REGISTERS:
      case FunctionCode.WRITE_MULTIPLE_COILS:
      case FunctionCode.WRITE_MULTIPLE_REGISTERS: {
        if (data.length < 4) {
          table = undefined;
          break;
        }
        const address = (data[0] << 8) | data[1];
        const quantity = (data[2] << 8) | data[3];
        startAddr = address;
        endAddr = address + quantity - 1;
        break;
      }
      case FunctionCode.WRITE_SINGLE_COIL:
      case FunctionCode.WRITE_SINGLE_REGISTER:
      case FunctionCode.MASK_WRITE_REGISTER: {
        if (data.length < 2) {
          table = undefined;
          break;
        }
        const address = (data[0] << 8) | data[1];
        startAddr = address;
        endAddr = address;
        break;
      }
      case FunctionCode.READ_WRITE_MULTIPLE_REGISTERS: {
        if (data.length < 8) {
          table = undefined;
          break;
        }
        const readAddress = (data[0] << 8) | data[1];
        const readQuantity = (data[2] << 8) | data[3];
        const writeAddress = (data[4] << 8) | data[5];
        const writeQuantity = (data[6] << 8) | data[7];
        startAddr = Math.min(readAddress, writeAddress);
        endAddr = Math.max(readAddress + readQuantity - 1, writeAddress + writeQuantity - 1);
        break;
      }
    }
  }

  if (!table) {
    callback(null, undefined);
    return;
  }

  const auth = checkAddress(unit, table, [startAddr, endAddr]);
  if (auth === true) {
    callback(null, undefined);
  } else if (auth === false) {
    callback(new UnauthorizedAccessError(`Unit ${unit} address range [${startAddr}, ${endAddr}] on ${table} not authorized`), undefined);
  } else if (typeof auth === 'number') {
    callback(getErrorByCode(auth), auth);
  } else {
    auth.then((res) => {
      if (res === false) {
        callback(
          new UnauthorizedAccessError(`Unit ${unit} address range [${startAddr}, ${endAddr}] on ${table} not authorized`),
          undefined,
        );
      } else if (typeof res === 'number') {
        callback(getErrorByCode(res), res);
      } else {
        callback(null, undefined);
      }
    });
  }
}
