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

import { ErrorCode, ModbusError } from '../error-code';
import { runCheckAddress, runCheckUnit } from './access-authorizer';
import { UnauthorizedAccessError } from '../vars';

describe('runCheckUnit', () => {
  it('allows when no checkUnit hook is configured', () => {
    runCheckUnit(undefined, 1, (err, code) => {
      expect(err).toBeNull();
      expect(code).toBeUndefined();
    });
  });

  it('allows when checkUnit returns true', () => {
    runCheckUnit(
      () => true,
      1,
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
  });

  it('denies with UnauthorizedAccessError when checkUnit returns false', () => {
    runCheckUnit(
      () => false,
      1,
      (err, code) => {
        expect(err).toBeInstanceOf(UnauthorizedAccessError);
        expect(err?.message).toContain('Unit 1 not authorized');
        expect(code).toBeUndefined();
      },
    );
  });

  it('denies with a numeric error code when checkUnit returns an ErrorCode', () => {
    runCheckUnit(
      () => ErrorCode.ILLEGAL_FUNCTION,
      1,
      (err, code) => {
        expect(err).toBeInstanceOf(ModbusError);
        expect((err as ModbusError).code).toBe(ErrorCode.ILLEGAL_FUNCTION);
        expect(code).toBe(ErrorCode.ILLEGAL_FUNCTION);
      },
    );
  });

  it('allows when checkUnit returns a resolving true promise', async () => {
    let result: [UnauthorizedAccessError | ModbusError | null, number | undefined] | null = null;
    runCheckUnit(
      () => Promise.resolve(true),
      1,
      (err, code) => {
        result = [err, code];
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(result).toEqual([null, undefined]);
  });

  it('denies when checkUnit returns a resolving false promise', async () => {
    let result: [UnauthorizedAccessError | ModbusError | null, number | undefined] | null = null;
    runCheckUnit(
      () => Promise.resolve(false),
      1,
      (err, code) => {
        result = [err, code];
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(result?.[0]).toBeInstanceOf(UnauthorizedAccessError);
    expect(result?.[1]).toBeUndefined();
  });

  it('denies with a numeric code when checkUnit returns a resolving number promise', async () => {
    let result: [UnauthorizedAccessError | ModbusError | null, number | undefined] | null = null;
    runCheckUnit(
      () => Promise.resolve(ErrorCode.ILLEGAL_DATA_ADDRESS),
      1,
      (err, code) => {
        result = [err, code];
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(result?.[0]).toBeInstanceOf(ModbusError);
    expect(result?.[1]).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
  });
});

describe('runCheckAddress', () => {
  it('allows when no checkAddress hook is configured', () => {
    runCheckAddress(undefined, 1, 0x03, Buffer.from([0x00, 0x01, 0x00, 0x0a]), undefined, (err, code) => {
      expect(err).toBeNull();
      expect(code).toBeUndefined();
    });
  });

  it('allows for unknown FC when no table can be derived', () => {
    runCheckAddress(
      () => false,
      1,
      0x7f,
      Buffer.from([0x00, 0x01]),
      undefined,
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
  });

  it('allows for standard read when checkAddress returns true', () => {
    runCheckAddress(
      () => true,
      1,
      0x03,
      Buffer.from([0x00, 0x01, 0x00, 0x0a]),
      undefined,
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
  });

  it('denies for standard read when checkAddress returns false', () => {
    runCheckAddress(
      () => false,
      1,
      0x03,
      Buffer.from([0x00, 0x01, 0x00, 0x0a]),
      undefined,
      (err, code) => {
        expect(err).toBeInstanceOf(UnauthorizedAccessError);
        expect(err?.message).toContain('holdingRegisters');
        expect(code).toBeUndefined();
      },
    );
  });

  it('denies with a numeric error code for standard read', () => {
    runCheckAddress(
      () => ErrorCode.ILLEGAL_DATA_ADDRESS,
      1,
      0x03,
      Buffer.from([0x00, 0x01, 0x00, 0x0a]),
      undefined,
      (err, code) => {
        expect(err).toBeInstanceOf(ModbusError);
        expect(code).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
      },
    );
  });

  it('handles async checkAddress denials', async () => {
    let result: [UnauthorizedAccessError | ModbusError | null, number | undefined] | null = null;
    runCheckAddress(
      () => Promise.resolve(false),
      1,
      0x03,
      Buffer.from([0x00, 0x01, 0x00, 0x0a]),
      undefined,
      (err, code) => {
        result = [err, code];
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(result?.[0]).toBeInstanceOf(UnauthorizedAccessError);
    expect(result?.[1]).toBeUndefined();
  });

  it('allows when data is too short to derive a range', () => {
    runCheckAddress(
      () => false,
      1,
      0x03,
      Buffer.from([0x00]),
      undefined,
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
  });

  it('handles write single register address range', () => {
    const ranges: [string, [number, number]][] = [];
    runCheckAddress(
      (_unit, table, range) => {
        ranges.push([table, range]);
        return true;
      },
      1,
      0x06,
      Buffer.from([0x00, 0x10]),
      undefined,
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
    expect(ranges).toEqual([['holdingRegisters', [16, 16]]]);
  });

  it('handles FC 23 read/write address range', () => {
    const ranges: [string, [number, number]][] = [];
    runCheckAddress(
      (_unit, table, range) => {
        ranges.push([table, range]);
        return true;
      },
      1,
      0x17,
      Buffer.from([0x00, 0x10, 0x00, 0x02, 0x00, 0x20, 0x00, 0x03]),
      undefined,
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
    expect(ranges).toEqual([['holdingRegisters', [16, 34]]]);
  });

  it('skips FC 23 when data is too short', () => {
    runCheckAddress(
      () => false,
      1,
      0x17,
      Buffer.from([0x00, 0x10, 0x00, 0x02]),
      undefined,
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
  });

  it('allows custom FC without requestAddressRange', () => {
    runCheckAddress(
      () => false,
      1,
      0x64,
      Buffer.from([0x00]),
      { fc: 0x64 },
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
  });

  it('checks custom FC ranges across multiple tables', () => {
    const checked: [string, [number, number]][] = [];
    runCheckAddress(
      (_unit, table, range) => {
        checked.push([table, range]);
        return true;
      },
      1,
      0x64,
      Buffer.from([0x00]),
      {
        fc: 0x64,
        requestAddressRange: () => ({
          coils: [[0, 10]],
          holdingRegisters: [[20, 30]],
        }),
      },
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
    expect(checked).toEqual([
      ['coils', [0, 10]],
      ['holdingRegisters', [20, 30]],
    ]);
  });

  it('denies custom FC when any range is rejected', () => {
    runCheckAddress(
      (_unit, table) => (table === 'coils' ? false : true),
      1,
      0x64,
      Buffer.from([0x00]),
      {
        fc: 0x64,
        requestAddressRange: () => ({
          coils: [[0, 10]],
          holdingRegisters: [[20, 30]],
        }),
      },
      (err, code) => {
        expect(err).toBeInstanceOf(UnauthorizedAccessError);
        expect(err?.message).toContain('custom function code 0x64');
        expect(code).toBeUndefined();
      },
    );
  });

  it('denies custom FC with a numeric error code', () => {
    runCheckAddress(
      () => ErrorCode.ILLEGAL_DATA_ADDRESS,
      1,
      0x64,
      Buffer.from([0x00]),
      {
        fc: 0x64,
        requestAddressRange: () => ({
          holdingRegisters: [[20, 30]],
        }),
      },
      (err, code) => {
        expect(err).toBeInstanceOf(ModbusError);
        expect(code).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
      },
    );
  });

  it('handles async custom FC denials', async () => {
    let result: [UnauthorizedAccessError | ModbusError | null, number | undefined] | null = null;
    runCheckAddress(
      () => Promise.resolve(false),
      1,
      0x64,
      Buffer.from([0x00]),
      {
        fc: 0x64,
        requestAddressRange: () => ({
          holdingRegisters: [[20, 30]],
        }),
      },
      (err, code) => {
        result = [err, code];
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(result?.[0]).toBeInstanceOf(UnauthorizedAccessError);
    expect(result?.[1]).toBeUndefined();
  });

  it('resolves the coils table for FC 1', () => {
    const ranges: [string, [number, number]][] = [];
    runCheckAddress(
      (_unit, table, range) => {
        ranges.push([table, range]);
        return true;
      },
      1,
      0x01,
      Buffer.from([0x00, 0x10, 0x00, 0x0a]),
      undefined,
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
    expect(ranges).toEqual([['coils', [16, 25]]]);
  });

  it('resolves the discrete inputs table for FC 2', () => {
    const ranges: [string, [number, number]][] = [];
    runCheckAddress(
      (_unit, table, range) => {
        ranges.push([table, range]);
        return true;
      },
      1,
      0x02,
      Buffer.from([0x00, 0x10, 0x00, 0x0a]),
      undefined,
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
    expect(ranges).toEqual([['discreteInputs', [16, 25]]]);
  });

  it('resolves the input registers table for FC 4', () => {
    const ranges: [string, [number, number]][] = [];
    runCheckAddress(
      (_unit, table, range) => {
        ranges.push([table, range]);
        return true;
      },
      1,
      0x04,
      Buffer.from([0x00, 0x10, 0x00, 0x0a]),
      undefined,
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
    expect(ranges).toEqual([['inputRegisters', [16, 25]]]);
  });

  it('allows single-value writes when data is too short to derive an address', () => {
    runCheckAddress(
      () => false,
      1,
      0x06,
      Buffer.from([0x00]),
      undefined,
      (err, code) => {
        expect(err).toBeNull();
        expect(code).toBeUndefined();
      },
    );
  });

  it('allows when async checkAddress resolves to true', async () => {
    let result: [UnauthorizedAccessError | ModbusError | null, number | undefined] | null = null;
    runCheckAddress(
      () => Promise.resolve(true),
      1,
      0x03,
      Buffer.from([0x00, 0x01, 0x00, 0x0a]),
      undefined,
      (err, code) => {
        result = [err, code];
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(result).toEqual([null, undefined]);
  });

  it('denies with a numeric code when async checkAddress resolves to a number', async () => {
    let result: [UnauthorizedAccessError | ModbusError | null, number | undefined] | null = null;
    runCheckAddress(
      () => Promise.resolve(ErrorCode.ILLEGAL_DATA_ADDRESS),
      1,
      0x03,
      Buffer.from([0x00, 0x01, 0x00, 0x0a]),
      undefined,
      (err, code) => {
        result = [err, code];
      },
    );
    await new Promise((resolve) => setImmediate(resolve));
    expect(result?.[0]).toBeInstanceOf(ModbusError);
    expect(result?.[1]).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
  });
});
