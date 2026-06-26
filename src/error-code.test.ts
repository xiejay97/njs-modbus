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

import { ErrorCode, getCodeByError, getErrorByCode, ModbusError } from './error-code';

describe('ErrorCode', () => {
  it('should map every ErrorCode to a human-readable message', () => {
    for (const code of Object.values(ErrorCode).filter((v): v is ErrorCode => typeof v === 'number')) {
      const err = getErrorByCode(code);
      expect(err).toBeInstanceOf(ModbusError);
      expect(err.code).toBe(code);
      expect(err.message).toBeTruthy();
      expect(err.name).toBe('ModbusError');
    }
  });

  it('should recover the ErrorCode from a ModbusError', () => {
    const err = getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS);
    expect(getCodeByError(err)).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
  });

  it('should fallback to SERVER_DEVICE_FAILURE for non-ModbusError instances', () => {
    expect(getCodeByError(new Error('generic'))).toBe(ErrorCode.SERVER_DEVICE_FAILURE);
    expect(getCodeByError(new TypeError('type'))).toBe(ErrorCode.SERVER_DEVICE_FAILURE);
  });

  it('should fallback to SERVER_DEVICE_FAILURE for errors without a known code', () => {
    const fake = Object.assign(new Error('fake'), { name: 'ModbusError', code: 0xff });
    expect(getCodeByError(fake)).toBe(ErrorCode.SERVER_DEVICE_FAILURE);
  });

  it('should allow a custom message on ModbusError', () => {
    const err = new ModbusError(ErrorCode.ACKNOWLEDGE, 'custom');
    expect(err.message).toBe('custom');
    expect(err.code).toBe(ErrorCode.ACKNOWLEDGE);
  });
});
