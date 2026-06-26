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

import type { FrameErrorEvent } from '../layers/protocol';
import type { ModbusQueueStrategy } from '../types';

import { ErrorCode, ModbusError } from '../error-code';
import { ModbusMaster } from './master';

import { pduDiagnosticsReturnQueryData, tcpFrame } from '#test/helpers/fixtures';
import { MockPipelineAdapter } from '#test/helpers/mock-pipeline-adapter';
import { flushPromises } from '#test/helpers/utils';

describe('ModbusMaster', () => {
  function createMaster(timeout = 100, queueStrategy?: ModbusQueueStrategy) {
    const adapter = new MockPipelineAdapter();
    const master = new ModbusMaster({
      timeout,
      queueStrategy,
      pipelineAdapter: adapter,
      protocol: { type: 'TCP' },
    });
    return { master, adapter };
  }

  function pduReadRegistersResponse(values: number[]): Buffer {
    const byteCount = values.length * 2;
    const pdu = Buffer.allocUnsafe(1 + byteCount);
    pdu[0] = byteCount;
    let off = 1;
    for (const v of values) {
      pdu[off++] = (v >>> 8) & 0xff;
      pdu[off++] = v & 0xff;
    }
    return pdu;
  }

  function pduReadBitsResponse(bits: number[]): Buffer {
    const length = bits.length;
    const byteCount = (length + 7) >> 3;
    const pdu = Buffer.alloc(1 + byteCount);
    pdu[0] = byteCount;
    for (let i = 0; i < length; i++) {
      const byteIdx = 1 + (i >> 3);
      const bitIdx = i & 7;
      pdu[byteIdx] |= (bits[i] & 1) << bitIdx;
    }
    return pdu;
  }

  function pduWriteMultipleCoilsResponse(address: number, length: number): Buffer {
    return Buffer.from([(address >>> 8) & 0xff, address & 0xff, (length >>> 8) & 0xff, length & 0xff]);
  }

  function pduWriteMultipleRegistersResponse(address: number, length: number): Buffer {
    return pduWriteMultipleCoilsResponse(address, length);
  }

  function pduReportServerIdResponse(serverId: number[], runIndicator = true, additionalData?: Buffer): Buffer {
    const sidLen = serverId.length;
    const extraLen = additionalData?.length ?? 0;
    const byteCount = sidLen + 1 + extraLen;
    const pdu = Buffer.allocUnsafe(1 + byteCount);
    pdu[0] = byteCount;
    let off = 1;
    for (const b of serverId) {
      pdu[off++] = b & 0xff;
    }
    pdu[off++] = runIndicator ? 0xff : 0x00;
    if (additionalData) {
      additionalData.copy(pdu, off);
    }
    return pdu;
  }

  function pduMaskWriteRegisterResponse(address: number, andMask: number, orMask: number): Buffer {
    return Buffer.from([
      (address >>> 8) & 0xff,
      address & 0xff,
      (andMask >>> 8) & 0xff,
      andMask & 0xff,
      (orMask >>> 8) & 0xff,
      orMask & 0xff,
    ]);
  }

  function pduReadWriteMultipleRegistersResponse(values: number[]): Buffer {
    return pduReadRegistersResponse(values);
  }

  function pduReadDeviceIdentificationResponse(
    readDeviceIDCode: number,
    objects: { id: number; value: string }[],
    moreFollows = false,
    nextObjectId = 0x00,
  ): Buffer {
    const body: number[] = [0x0e, readDeviceIDCode, 0x81, moreFollows ? 0xff : 0x00, nextObjectId, objects.length];
    for (const obj of objects) {
      const bytes = Buffer.from(obj.value);
      body.push(obj.id, bytes.length);
      for (const b of bytes) {
        body.push(b);
      }
    }
    return Buffer.from(body);
  }

  it('should encode and send a read holding registers request', async () => {
    const { master, adapter } = createMaster();

    const responsePromise = master.readHoldingRegisters(1, 0, 2);
    const written = adapter.written[0];
    expect(written).toBeDefined();
    expect(written[6]).toBe(1); // unit
    expect(written[7]).toBe(0x03); // fc

    const tid = written.readUInt16BE(0);
    const pdu = pduReadRegistersResponse([0x1234, 0x5678]);
    adapter.emitData(tcpFrame(tid, 1, 0x03, pdu));

    const result = await responsePromise;
    expect(result).toBeDefined();
    expect(result!.data).toEqual([0x1234, 0x5678]);
  });

  it('should use the configured initial TCP transaction id', async () => {
    const adapter = new MockPipelineAdapter();
    const master = new ModbusMaster({
      timeout: 100,
      pipelineAdapter: adapter,
      protocol: { type: 'TCP', opts: { transactionId: 0x1234 } },
    });

    expect(master.transactionId).toBe(0x1234);

    const promise = master.readHoldingRegisters(1, 0, 1);
    const written = adapter.written[0];
    expect(written.readUInt16BE(0)).toBe(0x1234);

    adapter.emitData(tcpFrame(0x1234, 1, 0x03, pduReadRegistersResponse([0x1234])));

    await promise;
    expect(master.transactionId).toBe(0x1235);
  });

  it('should default the TCP transaction id counter to 1', async () => {
    const { master, adapter } = createMaster();

    expect(master.transactionId).toBe(1);

    const promise = master.readHoldingRegisters(1, 0, 1);
    expect(adapter.written[0].readUInt16BE(0)).toBe(1);

    adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegistersResponse([0x1234])));
    await promise;

    expect(master.transactionId).toBe(2);
  });

  it('should read discrete inputs (FC 2)', async () => {
    const { master, adapter } = createMaster();

    const promise = master.readDiscreteInputs(1, 0x10, 10);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);
    adapter.emitData(tcpFrame(tid, 1, 0x02, pduReadBitsResponse([1, 0, 1, 1, 0, 0, 1, 1, 1, 0])));

    const result = await promise;
    expect(result!.data).toEqual([1, 0, 1, 1, 0, 0, 1, 1, 1, 0]);
  });

  it('should read coils (FC 1)', async () => {
    const { master, adapter } = createMaster();

    const promise = master.readCoils(1, 0, 9);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);
    adapter.emitData(tcpFrame(tid, 1, 0x01, pduReadBitsResponse([1, 1, 0, 0, 1, 1, 0, 1, 1])));

    const result = await promise;
    expect(result!.data).toEqual([1, 1, 0, 0, 1, 1, 0, 1, 1]);
  });

  it('should read input registers (FC 4)', async () => {
    const { master, adapter } = createMaster();

    const promise = master.readInputRegisters(1, 0x20, 2);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);
    adapter.emitData(tcpFrame(tid, 1, 0x04, pduReadRegistersResponse([0x00aa, 0x00bb])));

    const result = await promise;
    expect(result!.data).toEqual([0x00aa, 0x00bb]);
  });

  it('should write a single coil (FC 5)', async () => {
    const { master, adapter } = createMaster();

    const promise = master.writeSingleCoil(1, 0x05, 1);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);
    adapter.emitData(tcpFrame(tid, 1, 0x05, Buffer.from([0x00, 0x05, 0xff, 0x00])));

    const result = await promise;
    expect(result!.data).toBe(1);
  });

  it('should write a single register (FC 6)', async () => {
    const { master, adapter } = createMaster();

    const promise = master.writeSingleRegister(1, 0x10, 0xabcd);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);
    adapter.emitData(tcpFrame(tid, 1, 0x06, Buffer.from([0x00, 0x10, 0xab, 0xcd])));

    const result = await promise;
    expect(result!.data).toBe(0xabcd);
  });

  it('should write multiple coils (FC 15)', async () => {
    const { master, adapter } = createMaster();

    const value: (0 | 1)[] = [1, 0, 1, 1, 1, 0, 0, 1, 1, 0];
    const promise = master.writeMultipleCoils(1, 0x20, value);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);
    adapter.emitData(tcpFrame(tid, 1, 0x0f, pduWriteMultipleCoilsResponse(0x20, 10)));

    const result = await promise;
    expect(result!.data).toEqual(value);
  });

  it('should write multiple registers (FC 16)', async () => {
    const { master, adapter } = createMaster();

    const value = [0x1234, 0x5678, 0x9abc];
    const promise = master.writeMultipleRegisters(1, 0x30, value);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);
    adapter.emitData(tcpFrame(tid, 1, 0x10, pduWriteMultipleRegistersResponse(0x30, 3)));

    const result = await promise;
    expect(result!.data).toEqual(value);
  });

  it('should report server ID (FC 17)', async () => {
    const { master, adapter } = createMaster();

    const promise = master.reportServerId(1, 3);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);
    adapter.emitData(tcpFrame(tid, 1, 0x11, pduReportServerIdResponse([0x01, 0x02, 0x03], true, Buffer.from([0xab]))));

    const result = await promise;
    expect(result!.data).toEqual({
      serverId: Buffer.from([0x01, 0x02, 0x03]),
      runIndicatorStatus: true,
      additionalData: Buffer.from([0xab]),
    });
  });

  it('should mask write a register (FC 22)', async () => {
    const { master, adapter } = createMaster();

    const promise = master.maskWriteRegister(1, 0x40, 0xff00, 0x000f);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);
    adapter.emitData(tcpFrame(tid, 1, 0x16, pduMaskWriteRegisterResponse(0x40, 0xff00, 0x000f)));

    const result = await promise;
    expect(result!.data).toEqual({ andMask: 0xff00, orMask: 0x000f });
  });

  it('should read and write multiple registers (FC 23)', async () => {
    const { master, adapter } = createMaster();

    const promise = master.readAndWriteMultipleRegisters(1, { address: 0x50, length: 2 }, { address: 0x60, value: [0x1111, 0x2222] });
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);
    adapter.emitData(tcpFrame(tid, 1, 0x17, pduReadWriteMultipleRegistersResponse([0x3333, 0x4444])));

    const result = await promise;
    expect(result!.data).toEqual([0x3333, 0x4444]);
  });

  it('should read device identification (FC 43/14)', async () => {
    const { master, adapter } = createMaster();

    const promise = master.readDeviceIdentification(1, 0x01, 0x00);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);
    const pdu = pduReadDeviceIdentificationResponse(0x01, [
      { id: 0x00, value: 'Vendor' },
      { id: 0x01, value: 'Product' },
    ]);
    adapter.emitData(tcpFrame(tid, 1, 0x2b, pdu));

    const result = await promise;
    expect(result!.data).toMatchObject({
      readDeviceIDCode: 0x01,
      conformityLevel: 0x81,
      moreFollows: false,
      nextObjectId: 0x00,
      objects: [
        { id: 0x00, value: 'Vendor' },
        { id: 0x01, value: 'Product' },
      ],
    });
  });

  it('should send diagnostics return query data (FC 8/0)', async () => {
    const { master, adapter } = createMaster();

    const promise = master.diagnosticsReturnQueryData(1, 0xabcd);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);

    expect(written[6]).toBe(1); // unit
    expect(written[7]).toBe(0x08); // fc
    expect(written.subarray(8, 12)).toEqual(Buffer.from([0x00, 0x00, 0xab, 0xcd]));

    adapter.emitData(tcpFrame(tid, 1, 0x08, pduDiagnosticsReturnQueryData(0xabcd)));

    const result = await promise;
    expect(result!.data).toBe(0xabcd);
  });

  it('should reject diagnostics return query data when echo data mismatches', async () => {
    const { master, adapter } = createMaster();

    const promise = master.diagnosticsReturnQueryData(1, 0xabcd);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);

    adapter.emitData(tcpFrame(tid, 1, 0x08, pduDiagnosticsReturnQueryData(0x1234)));

    await expect(promise).rejects.toThrow('Response echo does not match request');
  });

  it('should expose handleFC8_0 alias', () => {
    const { master } = createMaster();
    expect(master.handleFC8_0).toBe(master.diagnosticsReturnQueryData);
  });

  it('should resolve undefined for a broadcast diagnostics return query data request', async () => {
    const { master, adapter } = createMaster();

    const responsePromise = master.diagnosticsReturnQueryData(0, 0x1234);
    expect(adapter.written[0][6]).toBe(0); // unit 0

    const result = await responsePromise;
    expect(result).toBeUndefined();
  });

  it('should reject with a ModbusError on an exception response', async () => {
    const { master, adapter } = createMaster();

    const responsePromise = master.readHoldingRegisters(1, 0, 1);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);

    adapter.emitData(tcpFrame(tid, 1, 0x83, Buffer.from([ErrorCode.ILLEGAL_DATA_ADDRESS])));

    await expect(responsePromise).rejects.toBeInstanceOf(ModbusError);
    await expect(responsePromise).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_DATA_ADDRESS });
  });

  it('should reject with a timeout when no response arrives', async () => {
    const { master } = createMaster(20);

    await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toThrow('Request timed out');
  });

  it('should resolve undefined for a broadcast request', async () => {
    const { master, adapter } = createMaster();

    const responsePromise = master.writeSingleRegister(0, 10, 0xabcd);
    expect(adapter.written[0][6]).toBe(0); // unit 0

    const result = await responsePromise;
    expect(result).toBeUndefined();
  });

  it('should serialize multiple FIFO requests', async () => {
    const { master, adapter } = createMaster(100, 'fifo');

    const p1 = master.readHoldingRegisters(1, 0, 1);
    const p2 = master.readHoldingRegisters(1, 1, 1);

    expect(adapter.written).toHaveLength(1);
    const tid1 = adapter.written[0].readUInt16BE(0);
    adapter.emitData(tcpFrame(tid1, 1, 0x03, pduReadRegistersResponse([0x1111])));

    await p1;
    expect(adapter.written).toHaveLength(2);
    const tid2 = adapter.written[1].readUInt16BE(0);
    adapter.emitData(tcpFrame(tid2, 1, 0x03, pduReadRegistersResponse([0x2222])));

    const r2 = await p2;
    expect(r2!.data).toEqual([0x2222]);
  });

  describe('queueStrategy', () => {
    it('should default queueStrategy to drop-stale', () => {
      const { master } = createMaster();
      expect(master.queueStrategy).toBe('drop-stale');
    });

    it('should reject unknown function codes immediately', async () => {
      const { master } = createMaster();

      await expect(master.sendCustomFC(1, 0x7f, [0x01])).rejects.toThrow('Unsupported function code 0x7f');
    });

    it('should drop stale queued requests with drop-stale strategy', async () => {
      const { master, adapter } = createMaster(500, 'drop-stale');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      expect(adapter.written).toHaveLength(1);
      const tid1 = adapter.written[0].readUInt16BE(0);

      const p2 = master.readHoldingRegisters(1, 1, 1);
      const p3 = master.readHoldingRegisters(1, 2, 1);

      adapter.emitData(tcpFrame(tid1, 1, 0x03, pduReadRegistersResponse([0x1111])));
      await p1;

      await expect(p2).rejects.toThrow('Request dropped by drop-stale strategy');

      expect(adapter.written).toHaveLength(2);
      const tid3 = adapter.written[1].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid3, 1, 0x03, pduReadRegistersResponse([0x3333])));
      const r3 = await p3;
      expect(r3!.data).toEqual([0x3333]);
    });

    it('should deduplicate queued requests with the same address', async () => {
      const { master, adapter } = createMaster(500, 'deduplicate');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      expect(adapter.written).toHaveLength(1);
      const tid1 = adapter.written[0].readUInt16BE(0);

      const p2 = master.readHoldingRegisters(1, 0, 1);
      const p3 = master.readHoldingRegisters(1, 1, 1);
      const p4 = master.readHoldingRegisters(1, 0, 1);

      adapter.emitData(tcpFrame(tid1, 1, 0x03, pduReadRegistersResponse([0x1111])));
      await p1;

      await expect(p2).rejects.toThrow('Request dropped by deduplicate strategy');

      expect(adapter.written).toHaveLength(2);
      const tid3 = adapter.written[1].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid3, 1, 0x03, pduReadRegistersResponse([0x3333])));
      await p3;

      expect(adapter.written).toHaveLength(3);
      const tid4 = adapter.written[2].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid4, 1, 0x03, pduReadRegistersResponse([0x4444])));
      const r4 = await p4;
      expect(r4!.data).toEqual([0x4444]);
    });

    it('should include quantity in read deduplication key', async () => {
      const { master, adapter } = createMaster(500, 'deduplicate');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      expect(adapter.written).toHaveLength(1);
      const tid1 = adapter.written[0].readUInt16BE(0);

      const p2 = master.readHoldingRegisters(1, 0, 1);
      const p3 = master.readHoldingRegisters(1, 0, 2);

      adapter.emitData(tcpFrame(tid1, 1, 0x03, pduReadRegistersResponse([0x1111])));
      await p1;

      expect(adapter.written).toHaveLength(2);
      const tid2 = adapter.written[1].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid2, 1, 0x03, pduReadRegistersResponse([0x2222])));
      await p2;

      expect(adapter.written).toHaveLength(3);
      const tid3 = adapter.written[2].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid3, 1, 0x03, pduReadRegistersResponse([0x3333, 0x4444])));
      const r3 = await p3;
      expect(r3!.data).toEqual([0x3333, 0x4444]);
    });

    it('should deduplicate FC 23 requests using full data body', async () => {
      const { master, adapter } = createMaster(500, 'deduplicate');

      const p1 = master.readAndWriteMultipleRegisters(1, { address: 0x10, length: 1 }, { address: 0x20, value: [0x1111] });
      expect(adapter.written).toHaveLength(1);
      const tid1 = adapter.written[0].readUInt16BE(0);

      // Same read address, different write address -> NOT duplicate
      const p2 = master.readAndWriteMultipleRegisters(1, { address: 0x10, length: 1 }, { address: 0x21, value: [0x2222] });
      // Different read address, same write address -> NOT duplicate
      const p3 = master.readAndWriteMultipleRegisters(1, { address: 0x11, length: 1 }, { address: 0x20, value: [0x1111] });
      // Identical to p2 -> duplicate, replaces p2
      const p4 = master.readAndWriteMultipleRegisters(1, { address: 0x10, length: 1 }, { address: 0x21, value: [0x2222] });

      adapter.emitData(tcpFrame(tid1, 1, 0x17, pduReadWriteMultipleRegistersResponse([0x1111])));
      await p1;

      await expect(p2).rejects.toThrow('Request dropped by deduplicate strategy');

      expect(adapter.written).toHaveLength(2);
      const tid3 = adapter.written[1].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid3, 1, 0x17, pduReadWriteMultipleRegistersResponse([0x3333])));
      await p3;

      expect(adapter.written).toHaveLength(3);
      const tid4 = adapter.written[2].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid4, 1, 0x17, pduReadWriteMultipleRegistersResponse([0x4444])));
      const r4 = await p4;
      expect(r4!.data).toEqual([0x4444]);
    });

    it('should deduplicate custom FC requests using fingerprint plugin', async () => {
      const { master, adapter } = createMaster(500, 'deduplicate');

      master.addCustomFunctionCode({
        fc: 0x65,
        requestFingerprint: (_unit, _fc, data) => data[0],
      });

      const p1 = master.sendCustomFC(1, 0x65, Buffer.from([0x01, 0x02]));
      expect(adapter.written).toHaveLength(1);
      const tid1 = adapter.written[0].readUInt16BE(0);

      const p2 = master.sendCustomFC(1, 0x65, Buffer.from([0x01, 0x03]));
      const p3 = master.sendCustomFC(1, 0x65, Buffer.from([0x02, 0x03]));
      const p4 = master.sendCustomFC(1, 0x65, Buffer.from([0x01, 0x04]));

      adapter.emitData(tcpFrame(tid1, 1, 0x65, Buffer.from([0xaa])));
      await p1;

      await expect(p2).rejects.toThrow('Request dropped by deduplicate strategy');

      expect(adapter.written).toHaveLength(2);
      const tid3 = adapter.written[1].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid3, 1, 0x65, Buffer.from([0xbb])));
      await p3;

      expect(adapter.written).toHaveLength(3);
      const tid4 = adapter.written[2].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid4, 1, 0x65, Buffer.from([0xcc])));
      const r4 = await p4;
      expect(r4).toEqual(Buffer.from([0xcc]));
    });

    it('should deduplicate custom FC requests using full data when no fingerprint plugin', async () => {
      const { master, adapter } = createMaster(500, 'deduplicate');

      master.addCustomFunctionCode({ fc: 0x65 });

      const p1 = master.sendCustomFC(1, 0x65, Buffer.from([0x01, 0x02]));
      expect(adapter.written).toHaveLength(1);
      const tid1 = adapter.written[0].readUInt16BE(0);

      const p2 = master.sendCustomFC(1, 0x65, Buffer.from([0x01, 0x03]));
      const p3 = master.sendCustomFC(1, 0x65, Buffer.from([0x01, 0x03]));

      adapter.emitData(tcpFrame(tid1, 1, 0x65, Buffer.from([0xaa])));
      await p1;

      await expect(p2).rejects.toThrow('Request dropped by deduplicate strategy');

      expect(adapter.written).toHaveLength(2);
      const tid3 = adapter.written[1].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid3, 1, 0x65, Buffer.from([0xbb])));
      const r3 = await p3;
      expect(r3).toEqual(Buffer.from([0xbb]));
    });

    it('should process requests concurrently with queueStrategy concurrent', async () => {
      const { master, adapter } = createMaster(500, 'concurrent');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      const p2 = master.readHoldingRegisters(1, 1, 1);

      expect(adapter.written).toHaveLength(2);

      const tid1 = adapter.written[0].readUInt16BE(0);
      const tid2 = adapter.written[1].readUInt16BE(0);

      adapter.emitData(tcpFrame(tid2, 1, 0x03, pduReadRegistersResponse([0x2222])));
      adapter.emitData(tcpFrame(tid1, 1, 0x03, pduReadRegistersResponse([0x1111])));

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1!.data).toEqual([0x1111]);
      expect(r2!.data).toEqual([0x2222]);
    });

    it('should reject pending queued requests when destroyed with drop-stale', async () => {
      const { master } = createMaster(500, 'drop-stale');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      const p2 = master.readHoldingRegisters(1, 1, 1);

      master.destroy();

      await expect(p1).rejects.toThrow('Master has been destroyed');
      await expect(p2).rejects.toThrow('Master has been destroyed');
    });
  });

  it('should allow a custom function code to be sent and parsed', async () => {
    const { master, adapter } = createMaster();

    master.addCustomFunctionCode({ fc: 0x65 });

    const responsePromise = master.sendCustomFC(1, 0x65, [0x00_01, 0x00_02]);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);

    adapter.emitData(tcpFrame(tid, 1, 0x65, Buffer.from([0x03, 0x04])));

    const result = await responsePromise;
    expect(result).toEqual(Buffer.from([0x03, 0x04]));
  });

  it('should remove a custom function code from the protocol layer', async () => {
    const { master } = createMaster();

    master.addCustomFunctionCode({ fc: 0x65 });
    master.removeCustomFunctionCode(0x65);
  });

  describe('concurrent mode', () => {
    it('should send multiple requests without waiting for each response', async () => {
      const { master, adapter } = createMaster(500, 'concurrent');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      const p2 = master.readHoldingRegisters(1, 1, 1);

      expect(adapter.written).toHaveLength(2);

      const tid1 = adapter.written[0].readUInt16BE(0);
      const tid2 = adapter.written[1].readUInt16BE(0);
      expect(tid1).not.toBe(tid2);

      adapter.emitData(tcpFrame(tid2, 1, 0x03, pduReadRegistersResponse([0x2222])));
      adapter.emitData(tcpFrame(tid1, 1, 0x03, pduReadRegistersResponse([0x1111])));

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1!.data).toEqual([0x1111]);
      expect(r2!.data).toEqual([0x2222]);
    });
  });

  it('should reject pending queued requests when destroyed', async () => {
    const { master } = createMaster();

    // Queue two requests; the first is in flight, the second is queued.
    const p1 = master.readHoldingRegisters(1, 0, 1);
    const p2 = master.readHoldingRegisters(1, 1, 1);

    // Destroy before any response arrives.
    master.destroy();

    await expect(p1).rejects.toThrow('Master has been destroyed');
    await expect(p2).rejects.toThrow('Master has been destroyed');
  });

  it('should be idempotent when destroy is called twice', () => {
    const { master } = createMaster();

    master.destroy();
    expect(() => master.destroy()).not.toThrow();
  });

  it('should reject in-flight exchanges when destroyed', async () => {
    const { master, adapter } = createMaster(500);

    const p = master.readHoldingRegisters(1, 0, 1);

    // Wait until the request has been written and is awaiting a response.
    await flushPromises();
    expect(adapter.written).toHaveLength(1);

    master.destroy();

    await expect(p).rejects.toThrow('Master has been destroyed');
  });

  it('should deny requests with a synchronous checkUnit authorizer', async () => {
    const { master } = createMaster();

    master.setAccessAuthorizer({ checkUnit: () => false });

    await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toBeInstanceOf(Error);
  });

  it('should deny requests with a numeric checkUnit authorizer', async () => {
    const { master } = createMaster();

    master.setAccessAuthorizer({ checkUnit: () => ErrorCode.ILLEGAL_FUNCTION });

    await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_FUNCTION });
  });

  it('should deny requests with an async checkUnit authorizer', async () => {
    const { master } = createMaster();

    master.setAccessAuthorizer({ checkUnit: () => Promise.resolve(false) });

    await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toBeInstanceOf(Error);
  });

  it('should deny requests with a synchronous checkAddress authorizer', async () => {
    const { master } = createMaster();

    master.setAccessAuthorizer({ checkAddress: () => false });

    await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toBeInstanceOf(Error);
  });

  it('should allow requests after deleting the access authorizer', async () => {
    const { master, adapter } = createMaster();

    master.setAccessAuthorizer({ checkUnit: () => false });
    master.deleteAccessAuthorizer();

    const promise = master.readHoldingRegisters(1, 0, 1);
    const written = adapter.written[0];
    const tid = written.readUInt16BE(0);
    adapter.emitData(tcpFrame(tid, 1, 0x03, pduReadRegistersResponse([0x1234])));

    const result = await promise;
    expect(result.data).toEqual([0x1234]);
  });

  // ============================================================================
  // Response validation error paths
  // ============================================================================

  describe('response validation errors', () => {
    it('should reject on unit mismatch', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readHoldingRegisters(1, 0, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Response has wrong unit
      adapter.emitData(tcpFrame(tid, 2, 0x03, pduReadRegistersResponse([0x1234])));

      await expect(promise).rejects.toThrow('Response unit or function code mismatch');
    });

    it('should reject on function code mismatch', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readHoldingRegisters(1, 0, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Response has wrong FC
      adapter.emitData(tcpFrame(tid, 1, 0x04, pduReadRegistersResponse([0x1234])));

      await expect(promise).rejects.toThrow('Response unit or function code mismatch');
    });

    it('should reject on short byte-count response (FC 1)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readCoils(1, 0, 8);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // byteCount says 1 but data is empty (shorter than 1 + 1 = 2)
      adapter.emitData(tcpFrame(tid, 1, 0x01, Buffer.from([0x01])));

      await expect(promise).rejects.toThrow('Response shorter than expected');
    });

    it('should reject on length mismatch for FC 1', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readCoils(1, 0, 8);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // byteCount says 1 but data has 2 extra bytes (length mismatch)
      adapter.emitData(tcpFrame(tid, 1, 0x01, Buffer.from([0x01, 0xff, 0x00])));

      await expect(promise).rejects.toThrow('Response length mismatch');
    });

    it('should reject on byte-count mismatch for FC 1', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readCoils(1, 0, 8);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // byteCount field says 2 but we expect 1 byte for 8 coils
      adapter.emitData(tcpFrame(tid, 1, 0x01, Buffer.from([0x02, 0xff])));

      await expect(promise).rejects.toThrow('Response byte count mismatch');
    });

    it('should reject on short byte-count response (FC 3)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readHoldingRegisters(1, 0, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // byteCount says 2 but only 1 byte of data
      adapter.emitData(tcpFrame(tid, 1, 0x03, Buffer.from([0x02, 0x12])));

      await expect(promise).rejects.toThrow('Response shorter than expected');
    });

    it('should reject on length mismatch for FC 3', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readHoldingRegisters(1, 0, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // byteCount says 2 but data has 3 bytes
      adapter.emitData(tcpFrame(tid, 1, 0x03, Buffer.from([0x02, 0x12, 0x34, 0x56])));

      await expect(promise).rejects.toThrow('Response length mismatch');
    });

    it('should reject on byte-count mismatch for FC 3', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readHoldingRegisters(1, 0, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // byteCount field says 4 but we expect 2 for 1 register
      adapter.emitData(tcpFrame(tid, 1, 0x03, Buffer.from([0x04, 0x12, 0x34])));

      await expect(promise).rejects.toThrow('Response byte count mismatch');
    });

    it('should reject on short byte-count response (FC 23)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readAndWriteMultipleRegisters(1, { address: 0, length: 1 }, { address: 0, value: [0x1111] });
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // byteCount says 2 but only 1 byte of data
      adapter.emitData(tcpFrame(tid, 1, 0x17, Buffer.from([0x02, 0x12])));

      await expect(promise).rejects.toThrow('Response shorter than expected');
    });

    it('should reject on length mismatch for FC 23', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readAndWriteMultipleRegisters(1, { address: 0, length: 1 }, { address: 0, value: [0x1111] });
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // byteCount says 2 but data has 4 bytes
      adapter.emitData(tcpFrame(tid, 1, 0x17, Buffer.from([0x02, 0x12, 0x34, 0x56, 0x78])));

      await expect(promise).rejects.toThrow('Response length mismatch');
    });

    it('should reject on byte-count mismatch for FC 23', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readAndWriteMultipleRegisters(1, { address: 0, length: 1 }, { address: 0, value: [0x1111] });
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // byteCount field says 4 but data length is 2
      adapter.emitData(tcpFrame(tid, 1, 0x17, Buffer.from([0x04, 0x12, 0x34])));

      await expect(promise).rejects.toThrow('Response byte count mismatch');
    });

    it('should reject on short echo response (FC 5)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.writeSingleCoil(1, 0x05, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo is only 2 bytes, expected 4
      adapter.emitData(tcpFrame(tid, 1, 0x05, Buffer.from([0x00, 0x05])));

      await expect(promise).rejects.toThrow('Response echo shorter than expected');
    });

    it('should reject on echo length mismatch (FC 5)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.writeSingleCoil(1, 0x05, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo is 6 bytes, expected 4
      adapter.emitData(tcpFrame(tid, 1, 0x05, Buffer.from([0x00, 0x05, 0xff, 0x00, 0x00, 0x00])));

      await expect(promise).rejects.toThrow('Response echo length mismatch');
    });

    it('should reject on echo mismatch (FC 5)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.writeSingleCoil(1, 0x05, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo has wrong address
      adapter.emitData(tcpFrame(tid, 1, 0x05, Buffer.from([0x00, 0x06, 0xff, 0x00])));

      await expect(promise).rejects.toThrow('Response echo does not match request');
    });

    it('should reject on short echo response (FC 6)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.writeSingleRegister(1, 0x10, 0xabcd);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo is only 2 bytes, expected 4
      adapter.emitData(tcpFrame(tid, 1, 0x06, Buffer.from([0x00, 0x10])));

      await expect(promise).rejects.toThrow('Response echo shorter than expected');
    });

    it('should reject on echo length mismatch (FC 6)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.writeSingleRegister(1, 0x10, 0xabcd);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo is 6 bytes, expected 4
      adapter.emitData(tcpFrame(tid, 1, 0x06, Buffer.from([0x00, 0x10, 0xab, 0xcd, 0x00, 0x00])));

      await expect(promise).rejects.toThrow('Response echo length mismatch');
    });

    it('should reject on echo mismatch (FC 6)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.writeSingleRegister(1, 0x10, 0xabcd);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo has wrong value
      adapter.emitData(tcpFrame(tid, 1, 0x06, Buffer.from([0x00, 0x10, 0xab, 0xce])));

      await expect(promise).rejects.toThrow('Response echo does not match request');
    });

    it('should reject on short echo response (FC 15)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.writeMultipleCoils(1, 0x20, [1, 0, 1]);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo is only 2 bytes, expected 4
      adapter.emitData(tcpFrame(tid, 1, 0x0f, Buffer.from([0x00, 0x20])));

      await expect(promise).rejects.toThrow('Response echo shorter than expected');
    });

    it('should reject on echo length mismatch (FC 15)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.writeMultipleCoils(1, 0x20, [1, 0, 1]);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo is 6 bytes, expected 4
      adapter.emitData(tcpFrame(tid, 1, 0x0f, Buffer.from([0x00, 0x20, 0x00, 0x03, 0x00, 0x00])));

      await expect(promise).rejects.toThrow('Response echo length mismatch');
    });

    it('should reject on echo mismatch (FC 15)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.writeMultipleCoils(1, 0x20, [1, 0, 1]);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo has wrong address
      adapter.emitData(tcpFrame(tid, 1, 0x0f, Buffer.from([0x00, 0x21, 0x00, 0x03])));

      await expect(promise).rejects.toThrow('Response echo does not match request');
    });

    it('should reject on short echo response (FC 16)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.writeMultipleRegisters(1, 0x30, [0x1234]);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo is only 2 bytes, expected 4
      adapter.emitData(tcpFrame(tid, 1, 0x10, Buffer.from([0x00, 0x30])));

      await expect(promise).rejects.toThrow('Response echo shorter than expected');
    });

    it('should reject on echo length mismatch (FC 16)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.writeMultipleRegisters(1, 0x30, [0x1234]);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo is 6 bytes, expected 4
      adapter.emitData(tcpFrame(tid, 1, 0x10, Buffer.from([0x00, 0x30, 0x00, 0x01, 0x00, 0x00])));

      await expect(promise).rejects.toThrow('Response echo length mismatch');
    });

    it('should reject on echo mismatch (FC 16)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.writeMultipleRegisters(1, 0x30, [0x1234]);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo has wrong quantity
      adapter.emitData(tcpFrame(tid, 1, 0x10, Buffer.from([0x00, 0x30, 0x00, 0x02])));

      await expect(promise).rejects.toThrow('Response echo does not match request');
    });

    it('should reject on short echo response (FC 22)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.maskWriteRegister(1, 0x40, 0xff00, 0x000f);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo is only 4 bytes, expected 6
      adapter.emitData(tcpFrame(tid, 1, 0x16, Buffer.from([0x00, 0x40, 0xff, 0x00])));

      await expect(promise).rejects.toThrow('Response echo shorter than expected');
    });

    it('should reject on echo length mismatch (FC 22)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.maskWriteRegister(1, 0x40, 0xff00, 0x000f);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo is 8 bytes, expected 6
      adapter.emitData(tcpFrame(tid, 1, 0x16, Buffer.from([0x00, 0x40, 0xff, 0x00, 0x00, 0x0f, 0x00, 0x00])));

      await expect(promise).rejects.toThrow('Response echo length mismatch');
    });

    it('should reject on echo mismatch (FC 22)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.maskWriteRegister(1, 0x40, 0xff00, 0x000f);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      // Echo has wrong andMask
      adapter.emitData(tcpFrame(tid, 1, 0x16, Buffer.from([0x00, 0x40, 0xff, 0x01, 0x00, 0x0f])));

      await expect(promise).rejects.toThrow('Response echo does not match request');
    });
  });

  // ============================================================================
  // Access authorizer checkRuntime denial paths
  // ============================================================================

  describe('access authorizer checkRuntime', () => {
    it('should deny request when checkRuntime returns false synchronously', async () => {
      const { master } = createMaster();

      master.setAccessAuthorizer({ checkRuntime: () => false });

      await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toThrow('Request intercepted by access authorizer');
    });

    it('should deny request when checkRuntime returns a numeric ErrorCode synchronously', async () => {
      const { master } = createMaster();

      master.setAccessAuthorizer({ checkRuntime: () => ErrorCode.ILLEGAL_DATA_ADDRESS });

      await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toBeInstanceOf(ModbusError);
      await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_DATA_ADDRESS });
    });

    it('should deny request when checkRuntime returns Promise resolving false', async () => {
      const { master } = createMaster();

      master.setAccessAuthorizer({ checkRuntime: () => Promise.resolve(false) });

      await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toThrow('Request intercepted by access authorizer');
    });

    it('should deny request when checkRuntime returns Promise resolving a numeric ErrorCode', async () => {
      const { master } = createMaster();

      master.setAccessAuthorizer({ checkRuntime: () => Promise.resolve(ErrorCode.SERVER_DEVICE_FAILURE) });

      await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toBeInstanceOf(ModbusError);
      await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toMatchObject({ code: ErrorCode.SERVER_DEVICE_FAILURE });
    });

    it('should allow request when checkRuntime returns true synchronously', async () => {
      const { master, adapter } = createMaster();

      master.setAccessAuthorizer({ checkRuntime: () => true });

      const promise = master.readHoldingRegisters(1, 0, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      adapter.emitData(tcpFrame(tid, 1, 0x03, pduReadRegistersResponse([0x1234])));

      const result = await promise;
      expect(result!.data).toEqual([0x1234]);
    });

    it('should allow request when checkRuntime returns Promise resolving true', async () => {
      const { master, adapter } = createMaster();

      master.setAccessAuthorizer({ checkRuntime: () => Promise.resolve(true) });

      const promise = master.readHoldingRegisters(1, 0, 1);

      // Need to wait for the async checkRuntime to resolve before the write happens
      await flushPromises();

      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      adapter.emitData(tcpFrame(tid, 1, 0x03, pduReadRegistersResponse([0x1234])));

      const result = await promise;
      expect(result!.data).toEqual([0x1234]);
    });

    it('should reject when checkRuntime Promise rejects', async () => {
      const { master } = createMaster();

      master.setAccessAuthorizer({ checkRuntime: () => Promise.reject(new Error('Auth service down')) });

      await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toThrow('Auth service down');
    });
  });

  // ============================================================================
  // Queue strategy edge cases
  // ============================================================================

  describe('queue strategy edge cases', () => {
    it('should handle multiple concurrent requests with out-of-order responses', async () => {
      const { master, adapter } = createMaster(500, 'concurrent');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      const p2 = master.readHoldingRegisters(1, 1, 1);
      const p3 = master.readHoldingRegisters(1, 2, 1);

      expect(adapter.written).toHaveLength(3);

      const tid1 = adapter.written[0].readUInt16BE(0);
      const tid2 = adapter.written[1].readUInt16BE(0);
      const tid3 = adapter.written[2].readUInt16BE(0);

      // Respond out of order: 3, 1, 2
      adapter.emitData(tcpFrame(tid3, 1, 0x03, pduReadRegistersResponse([0x3333])));
      adapter.emitData(tcpFrame(tid1, 1, 0x03, pduReadRegistersResponse([0x1111])));
      adapter.emitData(tcpFrame(tid2, 1, 0x03, pduReadRegistersResponse([0x2222])));

      const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
      expect(r1!.data).toEqual([0x1111]);
      expect(r2!.data).toEqual([0x2222]);
      expect(r3!.data).toEqual([0x3333]);
    });

    it('should handle FIFO mode with sequential processing', async () => {
      const { master, adapter } = createMaster(500, 'fifo');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      const p2 = master.readHoldingRegisters(1, 1, 1);
      const p3 = master.readHoldingRegisters(1, 2, 1);

      // Only first request should be sent
      expect(adapter.written).toHaveLength(1);
      const tid1 = adapter.written[0].readUInt16BE(0);

      adapter.emitData(tcpFrame(tid1, 1, 0x03, pduReadRegistersResponse([0x1111])));
      await p1;

      // Second request should now be sent
      expect(adapter.written).toHaveLength(2);
      const tid2 = adapter.written[1].readUInt16BE(0);

      adapter.emitData(tcpFrame(tid2, 1, 0x03, pduReadRegistersResponse([0x2222])));
      await p2;

      // Third request should now be sent
      expect(adapter.written).toHaveLength(3);
      const tid3 = adapter.written[2].readUInt16BE(0);

      adapter.emitData(tcpFrame(tid3, 1, 0x03, pduReadRegistersResponse([0x3333])));
      const r3 = await p3;
      expect(r3!.data).toEqual([0x3333]);
    });

    it('should handle FIFO mode with error in middle request', async () => {
      const { master, adapter } = createMaster(500, 'fifo');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      const p2 = master.readHoldingRegisters(1, 1, 1);
      const p3 = master.readHoldingRegisters(1, 2, 1);

      expect(adapter.written).toHaveLength(1);
      const tid1 = adapter.written[0].readUInt16BE(0);

      adapter.emitData(tcpFrame(tid1, 1, 0x03, pduReadRegistersResponse([0x1111])));
      await p1;

      expect(adapter.written).toHaveLength(2);
      const tid2 = adapter.written[1].readUInt16BE(0);

      // Send exception for p2
      adapter.emitData(tcpFrame(tid2, 1, 0x83, Buffer.from([ErrorCode.ILLEGAL_DATA_ADDRESS])));
      await expect(p2).rejects.toBeInstanceOf(ModbusError);

      expect(adapter.written).toHaveLength(3);
      const tid3 = adapter.written[2].readUInt16BE(0);

      adapter.emitData(tcpFrame(tid3, 1, 0x03, pduReadRegistersResponse([0x3333])));
      const r3 = await p3;
      expect(r3!.data).toEqual([0x3333]);
    });

    it('should handle drop-stale with custom function codes', async () => {
      const { master, adapter } = createMaster(500, 'drop-stale');

      master.addCustomFunctionCode({ fc: 0x65 });

      const p1 = master.sendCustomFC(1, 0x65, Buffer.from([0x01]));
      expect(adapter.written).toHaveLength(1);
      const tid1 = adapter.written[0].readUInt16BE(0);

      const p2 = master.sendCustomFC(1, 0x65, Buffer.from([0x02]));
      const p3 = master.sendCustomFC(1, 0x65, Buffer.from([0x03]));

      adapter.emitData(tcpFrame(tid1, 1, 0x65, Buffer.from([0xaa])));
      await p1;

      await expect(p2).rejects.toThrow('Request dropped by drop-stale strategy');

      expect(adapter.written).toHaveLength(2);
      const tid3 = adapter.written[1].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid3, 1, 0x65, Buffer.from([0xcc])));
      const r3 = await p3;
      expect(r3).toEqual(Buffer.from([0xcc]));
    });

    it('should handle deduplicate with custom function codes', async () => {
      const { master, adapter } = createMaster(500, 'deduplicate');

      master.addCustomFunctionCode({ fc: 0x65 });

      const p1 = master.sendCustomFC(1, 0x65, Buffer.from([0x01, 0x02]));
      expect(adapter.written).toHaveLength(1);
      const tid1 = adapter.written[0].readUInt16BE(0);

      const p2 = master.sendCustomFC(1, 0x65, Buffer.from([0x01, 0x02]));
      const p3 = master.sendCustomFC(1, 0x65, Buffer.from([0x03, 0x04]));
      // p4 has same fingerprint as p2 (which is in queue), so p2 gets deduplicated
      const p4 = master.sendCustomFC(1, 0x65, Buffer.from([0x01, 0x02]));

      adapter.emitData(tcpFrame(tid1, 1, 0x65, Buffer.from([0xaa])));
      await p1;

      // p2 was deduplicated by p4 (same fingerprint in queue)
      await expect(p2).rejects.toThrow('Request dropped by deduplicate strategy');

      expect(adapter.written).toHaveLength(2);
      const tid3 = adapter.written[1].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid3, 1, 0x65, Buffer.from([0xbb])));
      await p3;

      expect(adapter.written).toHaveLength(3);
      const tid4 = adapter.written[2].readUInt16BE(0);
      adapter.emitData(tcpFrame(tid4, 1, 0x65, Buffer.from([0xcc])));
      const r4 = await p4;
      expect(r4).toEqual(Buffer.from([0xcc]));
    });

    it('should handle broadcast in drop-stale mode', async () => {
      const { master, adapter } = createMaster(500, 'drop-stale');

      const p1 = master.writeSingleRegister(0, 10, 0xabcd);
      const p2 = master.writeSingleRegister(0, 11, 0xef01);

      // Both broadcasts are sent immediately (no queuing for broadcast)
      expect(adapter.written).toHaveLength(2);
      expect(adapter.written[0][6]).toBe(0);
      expect(adapter.written[1][6]).toBe(0);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();
    });

    it('should handle broadcast in concurrent mode', async () => {
      const { master, adapter } = createMaster(500, 'concurrent');

      const p1 = master.writeSingleRegister(0, 10, 0xabcd);
      const p2 = master.writeSingleRegister(0, 11, 0xef01);

      expect(adapter.written).toHaveLength(2);
      expect(adapter.written[0][6]).toBe(0);
      expect(adapter.written[1][6]).toBe(0);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();
    });

    it('should handle broadcast in FIFO mode', async () => {
      const { master, adapter } = createMaster(500, 'fifo');

      const p1 = master.writeSingleRegister(0, 10, 0xabcd);
      const p2 = master.writeSingleRegister(0, 11, 0xef01);

      // Both broadcasts are sent immediately (no queuing for broadcast)
      expect(adapter.written).toHaveLength(2);
      expect(adapter.written[0][6]).toBe(0);
      expect(adapter.written[1][6]).toBe(0);

      const [r1, r2] = await Promise.all([p1, p2]);
      expect(r1).toBeUndefined();
      expect(r2).toBeUndefined();
    });
  });

  // ============================================================================
  // Pipeline write failures
  // ============================================================================

  describe('pipeline write failures', () => {
    it('should reject the request when adapter.write callback receives an error', async () => {
      const adapter = new MockPipelineAdapter();
      // Override write to simulate a failure
      adapter.write = function (data: Buffer, cb?: (err: Error | null) => void): void {
        this.written.push(Buffer.from(data));
        cb?.(new Error('Pipeline write failed'));
      };

      const master = new ModbusMaster({
        timeout: 100,
        pipelineAdapter: adapter,
        protocol: { type: 'TCP' },
      });

      await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toThrow('Pipeline write failed');
    });

    it('should reject broadcast when adapter.write callback receives an error', async () => {
      const adapter = new MockPipelineAdapter();
      adapter.write = function (data: Buffer, cb?: (err: Error | null) => void): void {
        this.written.push(Buffer.from(data));
        cb?.(new Error('Broadcast write failed'));
      };

      const master = new ModbusMaster({
        timeout: 100,
        pipelineAdapter: adapter,
        protocol: { type: 'TCP' },
      });

      await expect(master.writeSingleRegister(0, 10, 0xabcd)).rejects.toThrow('Broadcast write failed');
    });
  });

  // ============================================================================
  // Timeout / destroy race conditions
  // ============================================================================

  describe('timeout and destroy race conditions', () => {
    it('should reject in-flight request with destroyed when destroyed while waiting for response', async () => {
      const { master, adapter } = createMaster(500);

      const p = master.readHoldingRegisters(1, 0, 1);

      await flushPromises();
      expect(adapter.written).toHaveLength(1);

      master.destroy();

      await expect(p).rejects.toThrow('Master has been destroyed');
    });

    it('should be safe to call destroy multiple times', async () => {
      const { master } = createMaster();

      master.destroy();
      expect(() => master.destroy()).not.toThrow();
      expect(() => master.destroy()).not.toThrow();
    });

    it('should reject queued requests when destroyed before any are sent', async () => {
      const { master } = createMaster(500, 'fifo');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      const p2 = master.readHoldingRegisters(1, 1, 1);
      const p3 = master.readHoldingRegisters(1, 2, 1);

      // Destroy immediately before any responses
      master.destroy();

      await expect(p1).rejects.toThrow('Master has been destroyed');
      await expect(p2).rejects.toThrow('Master has been destroyed');
      await expect(p3).rejects.toThrow('Master has been destroyed');
    });

    it('should reject new requests after destroy', async () => {
      const { master } = createMaster();

      master.destroy();

      await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toThrow('Master has been destroyed');
    });

    it('should handle destroy during concurrent requests', async () => {
      const { master, adapter } = createMaster(500, 'concurrent');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      const p2 = master.readHoldingRegisters(1, 1, 1);
      const p3 = master.readHoldingRegisters(1, 2, 1);

      await flushPromises();
      expect(adapter.written).toHaveLength(3);

      master.destroy();

      await expect(p1).rejects.toThrow('Master has been destroyed');
      await expect(p2).rejects.toThrow('Master has been destroyed');
      await expect(p3).rejects.toThrow('Master has been destroyed');
    });
  });

  // ============================================================================
  // Custom function code edge cases
  // ============================================================================

  describe('custom function code edge cases', () => {
    it('should send custom FC with number[] payload encoding big-endian', async () => {
      const { master, adapter } = createMaster();

      master.addCustomFunctionCode({ fc: 0x65 });

      // Pass number[] payload — each number encoded as big-endian 16-bit
      const responsePromise = master.sendCustomFC(1, 0x65, [0x0102, 0x0304]);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // Verify the payload was encoded big-endian
      // TCP frame: bytes 0-1=tid, 2-3=protocol, 4-5=length, 6=unit, 7=fc, 8+=data
      expect(written[7]).toBe(0x65); // FC
      expect(written[8]).toBe(0x01); // first value hi
      expect(written[9]).toBe(0x02); // first value lo
      expect(written[10]).toBe(0x03); // second value hi
      expect(written[11]).toBe(0x04); // second value lo

      adapter.emitData(tcpFrame(tid, 1, 0x65, Buffer.from([0xab, 0xcd])));

      const result = await responsePromise;
      expect(result).toEqual(Buffer.from([0xab, 0xcd]));
    });

    it('should reject custom FC on exception response', async () => {
      const { master, adapter } = createMaster();

      master.addCustomFunctionCode({ fc: 0x65 });

      const promise = master.sendCustomFC(1, 0x65, Buffer.from([0x01]));
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      adapter.emitData(tcpFrame(tid, 1, 0xe5, Buffer.from([ErrorCode.ILLEGAL_FUNCTION])));

      await expect(promise).rejects.toBeInstanceOf(ModbusError);
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_FUNCTION });
    });

    it('should reject custom FC on unit mismatch in response', async () => {
      const { master, adapter } = createMaster();

      master.addCustomFunctionCode({ fc: 0x65 });

      const promise = master.sendCustomFC(1, 0x65, Buffer.from([0x01]));
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // Response with wrong unit (not exception, so detectException returns null)
      adapter.emitData(tcpFrame(tid, 2, 0x65, Buffer.from([0xaa])));

      await expect(promise).rejects.toThrow('Response unit or function code mismatch');
    });

    it('should reject custom FC on function code mismatch in response', async () => {
      const { master, adapter } = createMaster();

      master.addCustomFunctionCode({ fc: 0x65 });

      const promise = master.sendCustomFC(1, 0x65, Buffer.from([0x01]));
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // Response with wrong FC (not exception, so detectException returns null)
      adapter.emitData(tcpFrame(tid, 1, 0x66, Buffer.from([0xaa])));

      await expect(promise).rejects.toThrow('Response unit or function code mismatch');
    });

    it('should remove all custom function codes', async () => {
      const { master } = createMaster();

      master.addCustomFunctionCode({ fc: 0x65 });
      master.addCustomFunctionCode({ fc: 0x66 });

      master.removeAllCustomFunctionCodes();

      await expect(master.sendCustomFC(1, 0x65, Buffer.from([0x01]))).rejects.toThrow('Unsupported function code 0x65');
      await expect(master.sendCustomFC(1, 0x66, Buffer.from([0x01]))).rejects.toThrow('Unsupported function code 0x66');
    });

    it('should handle custom FC with Buffer payload', async () => {
      const { master, adapter } = createMaster();

      master.addCustomFunctionCode({ fc: 0x65 });

      const promise = master.sendCustomFC(1, 0x65, Buffer.from([0x01, 0x02, 0x03]));
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // TCP frame: bytes 0-1=tid, 2-3=protocol, 4-5=length, 6=unit, 7=fc, 8+=data
      expect(written[7]).toBe(0x65); // FC
      expect(written[8]).toBe(0x01);
      expect(written[9]).toBe(0x02);
      expect(written[10]).toBe(0x03);

      adapter.emitData(tcpFrame(tid, 1, 0x65, Buffer.from([0x04, 0x05])));

      const result = await promise;
      expect(result).toEqual(Buffer.from([0x04, 0x05]));
    });

    it('should handle custom FC broadcast (unit 0)', async () => {
      const { master, adapter } = createMaster();

      master.addCustomFunctionCode({ fc: 0x65 });

      const promise = master.sendCustomFC(0, 0x65, Buffer.from([0x01]));
      expect(adapter.written[0][6]).toBe(0); // unit 0

      const result = await promise;
      expect(result).toBeUndefined();
    });
  });

  // ============================================================================
  // Malformed exception response
  // ============================================================================

  describe('malformed exception response', () => {
    it('should reject with generic error on malformed exception response (no data)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readHoldingRegisters(1, 0, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // Exception response with empty data (no exception code)
      adapter.emitData(tcpFrame(tid, 1, 0x83, Buffer.alloc(0)));

      await expect(promise).rejects.toThrow('Malformed Modbus exception response');
    });

    it('should reject with generic error on exception response with wrong unit', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readHoldingRegisters(1, 0, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // Exception response with wrong unit — falls through to validateResponse
      adapter.emitData(tcpFrame(tid, 2, 0x83, Buffer.from([ErrorCode.ILLEGAL_DATA_ADDRESS])));

      await expect(promise).rejects.toThrow('Response unit or function code mismatch');
    });

    it('should reject with generic error on exception response with wrong FC', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readHoldingRegisters(1, 0, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // Exception response with wrong FC — falls through to validateResponse
      adapter.emitData(tcpFrame(tid, 1, 0x84, Buffer.from([ErrorCode.ILLEGAL_DATA_ADDRESS])));

      await expect(promise).rejects.toThrow('Response unit or function code mismatch');
    });
  });

  // ============================================================================
  // Report Server ID validation errors
  // ============================================================================

  describe('report server ID validation errors', () => {
    it('should reject on report server ID response too short', async () => {
      const { master, adapter } = createMaster();

      const promise = master.reportServerId(1, 3);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // byteCount=2, but serverIdLength=3 means we need at least 2+3=5 bytes
      adapter.emitData(tcpFrame(tid, 1, 0x11, Buffer.from([0x02, 0x01, 0x02])));

      await expect(promise).rejects.toThrow('Report server ID response too short');
    });

    it('should reject on report server ID length mismatch', async () => {
      const { master, adapter } = createMaster();

      const promise = master.reportServerId(1, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // byteCount says 3 but data has 4 bytes
      adapter.emitData(tcpFrame(tid, 1, 0x11, Buffer.from([0x03, 0x01, 0x02, 0xff, 0xab])));

      await expect(promise).rejects.toThrow('Report server ID length mismatch');
    });
  });

  // ============================================================================
  // Read device identification validation errors
  // ============================================================================

  describe('read device identification validation errors', () => {
    it('should reject on read device identification response too short', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readDeviceIdentification(1, 0x01, 0x00);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // Less than 6 bytes
      adapter.emitData(tcpFrame(tid, 1, 0x2b, Buffer.from([0x0e, 0x01, 0x81])));

      await expect(promise).rejects.toThrow('Read device identification response too short');
    });

    it('should reject on invalid read device identification response (wrong MEI)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readDeviceIdentification(1, 0x01, 0x00);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // MEI byte is wrong (0x0f instead of 0x0e)
      adapter.emitData(tcpFrame(tid, 1, 0x2b, Buffer.from([0x0f, 0x01, 0x81, 0x00, 0x00, 0x00])));

      await expect(promise).rejects.toThrow('Invalid read device identification response');
    });

    it('should reject on invalid read device identification response (wrong readDeviceIDCode)', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readDeviceIdentification(1, 0x01, 0x00);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // readDeviceIDCode is wrong (0x02 instead of 0x01)
      adapter.emitData(tcpFrame(tid, 1, 0x2b, Buffer.from([0x0e, 0x02, 0x81, 0x00, 0x00, 0x00])));

      await expect(promise).rejects.toThrow('Invalid read device identification response');
    });

    it('should reject on device identification object count mismatch', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readDeviceIdentification(1, 0x01, 0x00);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // Says 1 object but has 0 objects
      adapter.emitData(tcpFrame(tid, 1, 0x2b, Buffer.from([0x0e, 0x01, 0x81, 0x00, 0x00, 0x01])));

      await expect(promise).rejects.toThrow('Device identification object count mismatch');
    });

    it('should reject on device identification length mismatch', async () => {
      const { master, adapter } = createMaster();

      const promise = master.readDeviceIdentification(1, 0x01, 0x00);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);

      // 1 object with id=0, len=6, but 6 bytes of value + 1 extra trailing byte
      // This makes object count match (1) but total length mismatch
      adapter.emitData(
        tcpFrame(tid, 1, 0x2b, Buffer.from([0x0e, 0x01, 0x81, 0x00, 0x00, 0x01, 0x00, 0x06, 0x56, 0x65, 0x6e, 0x64, 0x6f, 0x72, 0x00])),
      );

      await expect(promise).rejects.toThrow('Device identification length mismatch');
    });
  });

  // ============================================================================
  // Access authorizer with checkAddress numeric return
  // ============================================================================

  describe('access authorizer numeric checkAddress', () => {
    it('should deny requests with a numeric checkAddress authorizer', async () => {
      const { master } = createMaster();

      master.setAccessAuthorizer({ checkAddress: () => ErrorCode.ILLEGAL_DATA_VALUE });

      await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toBeInstanceOf(ModbusError);
      await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_DATA_VALUE });
    });

    it('should deny requests with an async checkAddress authorizer', async () => {
      const { master } = createMaster();

      master.setAccessAuthorizer({ checkAddress: () => Promise.resolve(false) });

      await expect(master.readHoldingRegisters(1, 0, 1)).rejects.toBeInstanceOf(Error);
    });
  });

  // ============================================================================
  // Additional concurrent mode tests
  // ============================================================================

  describe('concurrent mode additional tests', () => {
    it('should handle concurrent mode with many requests', async () => {
      const { master, adapter } = createMaster(500, 'concurrent');

      const promises = [];
      for (let i = 0; i < 5; i++) {
        promises.push(master.readHoldingRegisters(1, i, 1));
      }

      expect(adapter.written).toHaveLength(5);

      // Respond in reverse order
      for (let i = 4; i >= 0; i--) {
        const tid = adapter.written[i].readUInt16BE(0);
        adapter.emitData(tcpFrame(tid, 1, 0x03, pduReadRegistersResponse([0x1000 + i])));
      }

      const results = await Promise.all(promises);
      for (let i = 0; i < 5; i++) {
        expect(results[i]!.data).toEqual([0x1000 + i]);
      }
    });

    it('should handle concurrent mode with mixed success and exception', async () => {
      const { master, adapter } = createMaster(500, 'concurrent');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      const p2 = master.readHoldingRegisters(1, 1, 1);
      const p3 = master.readHoldingRegisters(1, 2, 1);

      expect(adapter.written).toHaveLength(3);

      const tid1 = adapter.written[0].readUInt16BE(0);
      const tid2 = adapter.written[1].readUInt16BE(0);
      const tid3 = adapter.written[2].readUInt16BE(0);

      adapter.emitData(tcpFrame(tid1, 1, 0x03, pduReadRegistersResponse([0x1111])));
      adapter.emitData(tcpFrame(tid2, 1, 0x83, Buffer.from([ErrorCode.ILLEGAL_DATA_ADDRESS])));
      adapter.emitData(tcpFrame(tid3, 1, 0x03, pduReadRegistersResponse([0x3333])));

      const [r1, r3] = await Promise.all([p1, p3]);
      expect(r1!.data).toEqual([0x1111]);
      expect(r3!.data).toEqual([0x3333]);

      await expect(p2).rejects.toBeInstanceOf(ModbusError);
      await expect(p2).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_DATA_ADDRESS });
    });
  });

  // ============================================================================
  // Destroyed property
  // ============================================================================

  describe('destroyed property', () => {
    it('should return false for a new master', () => {
      const { master } = createMaster();
      expect(master.destroyed).toBe(false);
    });

    it('should return true after destroy', () => {
      const { master } = createMaster();
      master.destroy();
      expect(master.destroyed).toBe(true);
    });
  });

  describe('frameError event', () => {
    it('should emit frameError when the protocol layer reports a frame error', async () => {
      const { master } = createMaster();
      const frameErrors: { message: string }[] = [];
      master.on('frameError', (event) => frameErrors.push(event));

      const protocolLayer = (master as unknown as { _protocolLayer: { onFrameError?: (event: FrameErrorEvent) => void } })._protocolLayer;
      protocolLayer.onFrameError?.({ message: 'test frame error' } as FrameErrorEvent);
      await flushPromises();

      expect(frameErrors).toHaveLength(1);
      expect(frameErrors[0]!.message).toBe('test frame error');
    });
  });

  describe('broadcast race conditions', () => {
    it('should handle broadcast write callback arriving after timeout', async () => {
      const { master, adapter } = createMaster(10);
      let writeCb: ((err: Error | null) => void) | undefined;
      adapter.write = function (data: Buffer, cb?: (err: Error | null) => void): void {
        this.written.push(Buffer.from(data));
        writeCb = cb;
      };

      const promise = master.writeSingleRegister(0, 10, 0xabcd);
      await flushPromises();
      expect(adapter.written).toHaveLength(1);

      await expect(promise).rejects.toThrow('Request timed out');

      writeCb?.(null);
      await flushPromises();
    });

    it('should handle non-broadcast response arriving before write callback', async () => {
      const { master, adapter } = createMaster(100);
      let writeCb: ((err: Error | null) => void) | undefined;
      adapter.write = function (data: Buffer, cb?: (err: Error | null) => void): void {
        this.written.push(Buffer.from(data));
        writeCb = cb;
      };

      const promise = master.readHoldingRegisters(1, 0, 1);
      await flushPromises();
      expect(adapter.written).toHaveLength(1);
      const tid = adapter.written[0].readUInt16BE(0);

      adapter.emitData(tcpFrame(tid, 1, 0x03, pduReadRegistersResponse([0x1234])));
      const result = await promise;
      expect(result!.data).toEqual([0x1234]);

      writeCb?.(null);
      await flushPromises();
    });

    it('should handle non-broadcast write error before response arrives', async () => {
      const { master, adapter } = createMaster(100);
      adapter.write = function (_data: Buffer, cb?: (err: Error | null) => void): void {
        cb?.(new Error('write failed'));
      };

      const promise = master.readHoldingRegisters(1, 0, 1);
      await expect(promise).rejects.toThrow('write failed');
    });
  });

  describe('coil read tail-byte branches', () => {
    it.each([
      { length: 11, expected: [1, 0, 1, 1, 1, 0, 0, 1, 1, 0, 1] },
      { length: 12, expected: [1, 0, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0] },
      { length: 13, expected: [1, 0, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1] },
      { length: 14, expected: [1, 0, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1] },
      { length: 15, expected: [1, 0, 1, 1, 1, 0, 0, 1, 1, 0, 1, 0, 1, 1, 0] },
    ])('should read $length coils covering tail-byte remainder', async ({ length, expected }) => {
      const { master, adapter } = createMaster();
      const promise = master.readCoils(1, 0, length);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      adapter.emitData(tcpFrame(tid, 1, 0x01, pduReadBitsResponse(expected)));
      const result = await promise;
      expect(result!.data).toEqual(expected);
    });
  });

  describe('FC callback branches', () => {
    it('should resolve undefined for broadcast readInputRegisters', async () => {
      const { master, adapter } = createMaster();
      const result = await master.readInputRegisters(0, 0, 1);
      expect(adapter.written[0][6]).toBe(0);
      expect(result).toBeUndefined();
    });

    it('should reject readInputRegisters on exception response', async () => {
      const { master, adapter } = createMaster();
      const promise = master.readInputRegisters(1, 0, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      adapter.emitData(tcpFrame(tid, 1, 0x84, Buffer.from([ErrorCode.ILLEGAL_DATA_ADDRESS])));
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_DATA_ADDRESS });
    });

    it('should reject readInputRegisters when checkUnit denies', async () => {
      const { master } = createMaster();
      master.setAccessAuthorizer({ checkUnit: () => false });
      await expect(master.readInputRegisters(1, 0, 1)).rejects.toBeInstanceOf(Error);
    });

    it('should resolve undefined for broadcast writeSingleCoil', async () => {
      const { master, adapter } = createMaster();
      const result = await master.writeSingleCoil(0, 0x10, 1);
      expect(adapter.written[0][6]).toBe(0);
      expect(result).toBeUndefined();
    });

    it('should reject writeSingleCoil on exception response', async () => {
      const { master, adapter } = createMaster();
      const promise = master.writeSingleCoil(1, 0x10, 1);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      adapter.emitData(tcpFrame(tid, 1, 0x85, Buffer.from([ErrorCode.ILLEGAL_DATA_ADDRESS])));
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_DATA_ADDRESS });
    });

    it('should reject writeSingleCoil when checkUnit denies', async () => {
      const { master } = createMaster();
      master.setAccessAuthorizer({ checkUnit: () => false });
      await expect(master.writeSingleCoil(1, 0x10, 1)).rejects.toBeInstanceOf(Error);
    });

    it('should resolve undefined for broadcast writeSingleRegister', async () => {
      const { master, adapter } = createMaster();
      const result = await master.writeSingleRegister(0, 0x10, 0xabcd);
      expect(adapter.written[0][6]).toBe(0);
      expect(result).toBeUndefined();
    });

    it('should reject writeSingleRegister on exception response', async () => {
      const { master, adapter } = createMaster();
      const promise = master.writeSingleRegister(1, 0x10, 0xabcd);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      adapter.emitData(tcpFrame(tid, 1, 0x86, Buffer.from([ErrorCode.ILLEGAL_DATA_ADDRESS])));
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_DATA_ADDRESS });
    });

    it('should reject writeSingleRegister when checkUnit denies', async () => {
      const { master } = createMaster();
      master.setAccessAuthorizer({ checkUnit: () => false });
      await expect(master.writeSingleRegister(1, 0x10, 0xabcd)).rejects.toBeInstanceOf(Error);
    });

    it('should resolve undefined for broadcast writeMultipleCoils', async () => {
      const { master, adapter } = createMaster();
      const result = await master.writeMultipleCoils(0, 0x20, [1, 0, 1]);
      expect(adapter.written[0][6]).toBe(0);
      expect(result).toBeUndefined();
    });

    it('should reject writeMultipleCoils on exception response', async () => {
      const { master, adapter } = createMaster();
      const promise = master.writeMultipleCoils(1, 0x20, [1, 0, 1]);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      adapter.emitData(tcpFrame(tid, 1, 0x8f, Buffer.from([ErrorCode.ILLEGAL_DATA_ADDRESS])));
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_DATA_ADDRESS });
    });

    it('should reject writeMultipleCoils when checkUnit denies', async () => {
      const { master } = createMaster();
      master.setAccessAuthorizer({ checkUnit: () => false });
      await expect(master.writeMultipleCoils(1, 0x20, [1, 0, 1])).rejects.toBeInstanceOf(Error);
    });

    it('should resolve undefined for broadcast maskWriteRegister', async () => {
      const { master, adapter } = createMaster();
      const result = await master.maskWriteRegister(0, 0x40, 0xff00, 0x000f);
      expect(adapter.written[0][6]).toBe(0);
      expect(result).toBeUndefined();
    });

    it('should reject maskWriteRegister on exception response', async () => {
      const { master, adapter } = createMaster();
      const promise = master.maskWriteRegister(1, 0x40, 0xff00, 0x000f);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      adapter.emitData(tcpFrame(tid, 1, 0x96, Buffer.from([ErrorCode.ILLEGAL_DATA_ADDRESS])));
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_DATA_ADDRESS });
    });

    it('should reject maskWriteRegister when checkUnit denies', async () => {
      const { master } = createMaster();
      master.setAccessAuthorizer({ checkUnit: () => false });
      await expect(master.maskWriteRegister(1, 0x40, 0xff00, 0x000f)).rejects.toBeInstanceOf(Error);
    });

    it('should resolve undefined for broadcast readAndWriteMultipleRegisters', async () => {
      const { master, adapter } = createMaster();
      const result = await master.readAndWriteMultipleRegisters(0, { address: 0x50, length: 1 }, { address: 0x60, value: [0x1111] });
      expect(adapter.written[0][6]).toBe(0);
      expect(result).toBeUndefined();
    });

    it('should reject readAndWriteMultipleRegisters on exception response', async () => {
      const { master, adapter } = createMaster();
      const promise = master.readAndWriteMultipleRegisters(1, { address: 0x50, length: 1 }, { address: 0x60, value: [0x1111] });
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      adapter.emitData(tcpFrame(tid, 1, 0x97, Buffer.from([ErrorCode.ILLEGAL_DATA_ADDRESS])));
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_DATA_ADDRESS });
    });

    it('should reject readAndWriteMultipleRegisters when checkUnit denies', async () => {
      const { master } = createMaster();
      master.setAccessAuthorizer({ checkUnit: () => false });
      await expect(
        master.readAndWriteMultipleRegisters(1, { address: 0x50, length: 1 }, { address: 0x60, value: [0x1111] }),
      ).rejects.toBeInstanceOf(Error);
    });

    it('should resolve undefined for broadcast readDeviceIdentification', async () => {
      const { master, adapter } = createMaster();
      const result = await master.readDeviceIdentification(0, 0x01, 0x00);
      expect(adapter.written[0][6]).toBe(0);
      expect(result).toBeUndefined();
    });

    it('should reject readDeviceIdentification on exception response', async () => {
      const { master, adapter } = createMaster();
      const promise = master.readDeviceIdentification(1, 0x01, 0x00);
      const written = adapter.written[0];
      const tid = written.readUInt16BE(0);
      adapter.emitData(tcpFrame(tid, 1, 0xab, Buffer.from([ErrorCode.ILLEGAL_DATA_ADDRESS])));
      await expect(promise).rejects.toMatchObject({ code: ErrorCode.ILLEGAL_DATA_ADDRESS });
    });

    it('should reject readDeviceIdentification when checkUnit denies', async () => {
      const { master } = createMaster();
      master.setAccessAuthorizer({ checkUnit: () => false });
      await expect(master.readDeviceIdentification(1, 0x01, 0x00)).rejects.toBeInstanceOf(Error);
    });
  });

  describe('destroy in-flight pending exchanges', () => {
    it('should reject all concurrent in-flight requests when destroyed', async () => {
      const { master, adapter } = createMaster(500, 'concurrent');

      const p1 = master.readHoldingRegisters(1, 0, 1);
      const p2 = master.readHoldingRegisters(1, 1, 1);
      const p3 = master.readHoldingRegisters(1, 2, 1);

      await flushPromises();
      expect(adapter.written).toHaveLength(3);

      master.destroy();

      await expect(p1).rejects.toThrow('Master has been destroyed');
      await expect(p2).rejects.toThrow('Master has been destroyed');
      await expect(p3).rejects.toThrow('Master has been destroyed');
    });
  });
});
