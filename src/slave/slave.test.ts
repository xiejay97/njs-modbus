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

import type { ModbusQueueStrategy } from '../types';

import { ErrorCode } from '../error-code';
import { ModbusSlave } from './slave';

import { pduDiagnosticsReturnQueryData, tcpFrame } from '#test/helpers/fixtures';
import { MockPipelineAdapter } from '#test/helpers/mock-pipeline-adapter';
import { flushPromises } from '#test/helpers/utils';

describe('ModbusSlave', () => {
  function createSlave(queueStrategy?: ModbusQueueStrategy) {
    const adapter = new MockPipelineAdapter();
    const slave = new ModbusSlave({
      queueStrategy,
      pipelineAdapter: adapter,
      protocol: { type: 'TCP' },
    });
    return { slave, adapter };
  }

  function createConcurrentSlave() {
    const adapter = new MockPipelineAdapter();
    const slave = new ModbusSlave({
      queueStrategy: 'concurrent',
      pipelineAdapter: adapter,
      protocol: { type: 'TCP' },
    });
    return { slave, adapter };
  }

  function pduReadBits(address: number, length: number): Buffer {
    return Buffer.from([(address >>> 8) & 0xff, address & 0xff, (length >>> 8) & 0xff, length & 0xff]);
  }

  function pduReadRegisters(address: number, length: number): Buffer {
    return pduReadBits(address, length);
  }

  function pduWriteSingleCoil(address: number, value: 0 | 1): Buffer {
    return Buffer.from([(address >>> 8) & 0xff, address & 0xff, value ? 0xff : 0x00, 0x00]);
  }

  function pduWriteSingleRegister(address: number, value: number): Buffer {
    return Buffer.from([(address >>> 8) & 0xff, address & 0xff, (value >>> 8) & 0xff, value & 0xff]);
  }

  function pduWriteMultipleCoils(address: number, bits: number[]): Buffer {
    const length = bits.length;
    const byteCount = (length + 7) >> 3;
    const pdu = Buffer.alloc(5 + byteCount);
    pdu[0] = (address >>> 8) & 0xff;
    pdu[1] = address & 0xff;
    pdu[2] = (length >>> 8) & 0xff;
    pdu[3] = length & 0xff;
    pdu[4] = byteCount;
    for (let i = 0; i < length; i++) {
      const byteIdx = 5 + (i >> 3);
      const bitIdx = i & 7;
      pdu[byteIdx] |= (bits[i] & 1) << bitIdx;
    }
    return pdu;
  }

  function pduWriteMultipleRegisters(address: number, values: number[]): Buffer {
    const pdu = Buffer.allocUnsafe(5 + values.length * 2);
    pdu[0] = (address >>> 8) & 0xff;
    pdu[1] = address & 0xff;
    pdu[2] = (values.length >>> 8) & 0xff;
    pdu[3] = values.length & 0xff;
    pdu[4] = values.length * 2;
    let off = 5;
    for (const v of values) {
      pdu[off++] = (v >>> 8) & 0xff;
      pdu[off++] = v & 0xff;
    }
    return pdu;
  }

  function pduMaskWriteRegister(address: number, andMask: number, orMask: number): Buffer {
    return Buffer.from([
      (address >>> 8) & 0xff,
      address & 0xff,
      (andMask >>> 8) & 0xff,
      andMask & 0xff,
      (orMask >>> 8) & 0xff,
      orMask & 0xff,
    ]);
  }

  function pduReadWriteMultipleRegisters(readAddress: number, readLength: number, writeAddress: number, writeValues: number[]): Buffer {
    const byteCount = writeValues.length * 2;
    const pdu = Buffer.allocUnsafe(9 + byteCount);
    pdu[0] = (readAddress >>> 8) & 0xff;
    pdu[1] = readAddress & 0xff;
    pdu[2] = (readLength >>> 8) & 0xff;
    pdu[3] = readLength & 0xff;
    pdu[4] = (writeAddress >>> 8) & 0xff;
    pdu[5] = writeAddress & 0xff;
    pdu[6] = (writeValues.length >>> 8) & 0xff;
    pdu[7] = writeValues.length & 0xff;
    pdu[8] = byteCount;
    let off = 9;
    for (const v of writeValues) {
      pdu[off++] = (v >>> 8) & 0xff;
      pdu[off++] = v & 0xff;
    }
    return pdu;
  }

  function pduReadDeviceIdentification(readDeviceIDCode: number, objectId: number): Buffer {
    return Buffer.from([0x0e, readDeviceIDCode, objectId]);
  }

  it('should respond to FC 1 read coils', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {
      readCoils: (_address, _length, callback) => callback(null, [1, 0, 1, 1, 0, 0, 1, 1, 1, 0]),
    });

    adapter.emitData(tcpFrame(1, 1, 0x01, pduReadBits(0, 10)));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    const response = adapter.written[0];
    expect(response.readUInt16BE(0)).toBe(1);
    expect(response[7]).toBe(0x01);
    expect(response[8]).toBe(2); // byte count
    expect(response.subarray(9)).toEqual(Buffer.from([0b11001101, 0b00000001]));
  });

  it('should respond to FC 2 read discrete inputs', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {
      readDiscreteInputs: (_address, _length, callback) => callback(null, [0, 1, 0, 1, 1, 1, 0, 0]),
    });

    adapter.emitData(tcpFrame(1, 1, 0x02, pduReadBits(0, 8)));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    const response = adapter.written[0];
    expect(response[7]).toBe(0x02);
    expect(response[8]).toBe(1);
    expect(response.subarray(9)).toEqual(Buffer.from([0b00111010]));
  });

  it('should respond to FC 3 read holding registers', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {
      readHoldingRegisters: (_address, _length, callback) => callback(null, [0x1234, 0x5678]),
    });

    adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 2)));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    const response = adapter.written[0];
    expect(response.readUInt16BE(0)).toBe(1); // same tid
    expect(response[7]).toBe(0x03); // fc
    expect(response.subarray(8)).toEqual(Buffer.from([0x04, 0x12, 0x34, 0x56, 0x78]));
  });

  it('should respond to FC 4 read input registers', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {
      readInputRegisters: (_address, _length, callback) => callback(null, [0x00aa, 0x00bb]),
    });

    adapter.emitData(tcpFrame(1, 1, 0x04, pduReadRegisters(0, 2)));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    const response = adapter.written[0];
    expect(response[7]).toBe(0x04);
    expect(response.subarray(8)).toEqual(Buffer.from([0x04, 0x00, 0xaa, 0x00, 0xbb]));
  });

  it('should respond to FC 5 write single coil', async () => {
    const { slave, adapter } = createSlave();
    let writtenValue = -1;
    slave.addUnit(1, {
      writeSingleCoil: (_address, value, callback) => {
        writtenValue = value;
        callback(null);
      },
    });

    const pdu = pduWriteSingleCoil(0x10, 1);
    adapter.emitData(tcpFrame(1, 1, 0x05, pdu));
    await flushPromises();

    expect(writtenValue).toBe(1);
    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0].subarray(8)).toEqual(pdu);
  });

  it('should echo a write single register request', async () => {
    const { slave, adapter } = createSlave();
    let writtenValue = 0;
    slave.addUnit(1, {
      writeSingleRegister: (_address, value, callback) => {
        writtenValue = value;
        callback(null);
      },
    });

    const pdu = pduWriteSingleRegister(10, 0xabcd);
    adapter.emitData(tcpFrame(1, 1, 0x06, pdu));
    await flushPromises();

    expect(writtenValue).toBe(0xabcd);
    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0].subarray(8)).toEqual(pdu);
  });

  it('should respond to FC 15 write multiple coils', async () => {
    const { slave, adapter } = createSlave();
    const received: number[] = [];
    slave.addUnit(1, {
      writeMultipleCoils: (_address, value, callback) => {
        received.push(...value);
        callback(null);
      },
    });

    const bits = [1, 0, 1, 1, 1, 0, 0, 1, 1, 0];
    const pdu = pduWriteMultipleCoils(0x20, bits);
    adapter.emitData(tcpFrame(1, 1, 0x0f, pdu));
    await flushPromises();

    expect(received).toEqual(bits);
    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0].subarray(8)).toEqual(pdu.subarray(0, 4));
  });

  it('should return ILLEGAL_FUNCTION for FC 15 when writeMultipleCoils is omitted', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {
      writeSingleCoil: (_address, _value, callback) => callback(null),
    });

    const pdu = pduWriteMultipleCoils(0x20, [1, 0, 1]);
    adapter.emitData(tcpFrame(1, 1, 0x0f, pdu));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0][7]).toBe(0x8f);
    expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
  });

  it('should respond to FC 16 write multiple registers', async () => {
    const { slave, adapter } = createSlave();
    const received: number[] = [];
    slave.addUnit(1, {
      writeMultipleRegisters: (_address, value, callback) => {
        received.push(...value);
        callback(null);
      },
    });

    const values = [0x1234, 0x5678];
    const pdu = pduWriteMultipleRegisters(0x30, values);
    adapter.emitData(tcpFrame(1, 1, 0x10, pdu));
    await flushPromises();

    expect(received).toEqual(values);
    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0].subarray(8)).toEqual(pdu.subarray(0, 4));
  });

  it('should return ILLEGAL_FUNCTION for FC 16 when writeMultipleRegisters is omitted', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {
      writeSingleRegister: (_address, _value, callback) => callback(null),
    });

    const pdu = pduWriteMultipleRegisters(0x30, [0x1111, 0x2222]);
    adapter.emitData(tcpFrame(1, 1, 0x10, pdu));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0][7]).toBe(0x90);
    expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
  });

  it('should respond to FC 17 report server ID', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {
      reportServerId: (callback) =>
        callback(null, {
          serverId: new Uint8Array([0x01, 0x02]),
          runIndicatorStatus: true,
          additionalData: Buffer.from([0xab]),
        }),
    });

    adapter.emitData(tcpFrame(1, 1, 0x11, Buffer.alloc(0)));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    const response = adapter.written[0].subarray(8);
    expect(response[0]).toBe(4); // byte count
    expect(response[1]).toBe(0x01);
    expect(response[2]).toBe(0x02);
    expect(response[3]).toBe(0xff);
    expect(response.subarray(4)).toEqual(Buffer.from([0xab]));
  });

  it('should return ILLEGAL_FUNCTION for FC 8/0 when handler is omitted', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {});

    adapter.emitData(tcpFrame(1, 1, 0x08, pduDiagnosticsReturnQueryData(0xabcd)));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0][7]).toBe(0x88);
    expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
  });

  it('should call handler and still echo original data for FC 8/0 when handler is provided', async () => {
    const { slave, adapter } = createSlave();
    let receivedData = -1;
    slave.addUnit(1, {
      diagnosticsReturnQueryData: (data, callback) => {
        receivedData = data;
        callback(null);
      },
    });

    const pdu = pduDiagnosticsReturnQueryData(0xabcd);
    adapter.emitData(tcpFrame(1, 1, 0x08, pdu));
    await flushPromises();

    expect(receivedData).toBe(0xabcd);
    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0][7]).toBe(0x08);
    expect(adapter.written[0].subarray(8)).toEqual(pdu);
  });

  it('should return handler error code for FC 8/0 when handler fails', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {
      diagnosticsReturnQueryData: (_data, callback) => callback(ErrorCode.SERVER_DEVICE_FAILURE),
    });

    adapter.emitData(tcpFrame(1, 1, 0x08, pduDiagnosticsReturnQueryData(0xabcd)));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0][7]).toBe(0x88);
    expect(adapter.written[0].subarray(8)).toEqual(Buffer.from([ErrorCode.SERVER_DEVICE_FAILURE]));
  });

  it('should return ILLEGAL_DATA_VALUE for FC 8 with wrong PDU length', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {});

    adapter.emitData(tcpFrame(1, 1, 0x08, Buffer.from([0x00, 0x00, 0xab]))); // 3 bytes
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0][7]).toBe(0x88);
    expect(adapter.written[0].subarray(8)).toEqual(Buffer.from([ErrorCode.ILLEGAL_DATA_VALUE]));
  });

  it('should return ILLEGAL_DATA_VALUE for FC 8 with unsupported sub-function', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {});

    adapter.emitData(tcpFrame(1, 1, 0x08, Buffer.from([0x00, 0x01, 0xab, 0xcd]))); // sub-function 0x0001
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0][7]).toBe(0x88);
    expect(adapter.written[0].subarray(8)).toEqual(Buffer.from([ErrorCode.ILLEGAL_DATA_VALUE]));
  });

  it('should respond to FC 22 mask write register', async () => {
    const { slave, adapter } = createSlave();
    let masked: { address: number; andMask: number; orMask: number } | null = null;
    slave.addUnit(1, {
      maskWriteRegister: (address, andMask, orMask, callback) => {
        masked = { address, andMask, orMask };
        callback(null);
      },
    });

    const pdu = pduMaskWriteRegister(0x40, 0xff00, 0x000f);
    adapter.emitData(tcpFrame(1, 1, 0x16, pdu));
    await flushPromises();

    expect(masked).toEqual({ address: 0x40, andMask: 0xff00, orMask: 0x000f });
    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0].subarray(8)).toEqual(pdu);
  });

  it('should return ILLEGAL_FUNCTION for FC 22 when maskWriteRegister is omitted', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {
      readHoldingRegisters: (_address, _length, callback) => callback(null, [0x1234]),
      writeSingleRegister: (_address, _value, callback) => callback(null),
    });

    adapter.emitData(tcpFrame(1, 1, 0x16, pduMaskWriteRegister(0x40, 0xff00, 0x000f)));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0][7]).toBe(0x96);
    expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
  });

  it('should respond to FC 23 read/write multiple registers', async () => {
    const { slave, adapter } = createSlave();
    const written: number[] = [];
    slave.addUnit(1, {
      readHoldingRegisters: (_address, _length, callback) => callback(null, [0x3333, 0x4444]),
      writeMultipleRegisters: (_address, value, callback) => {
        written.push(...value);
        callback(null);
      },
    });

    const pdu = pduReadWriteMultipleRegisters(0x50, 2, 0x60, [0x1111, 0x2222]);
    adapter.emitData(tcpFrame(1, 1, 0x17, pdu));
    await flushPromises();

    expect(written).toEqual([0x1111, 0x2222]);
    expect(adapter.written).toHaveLength(1);
    const response = adapter.written[0].subarray(8);
    expect(response[0]).toBe(4); // byte count
    expect(response.subarray(1)).toEqual(Buffer.from([0x33, 0x33, 0x44, 0x44]));
  });

  it('should respond to FC 43/14 read device identification', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {
      readDeviceIdentification: (callback) =>
        callback(null, {
          0x00: 'Vendor',
          0x01: 'Product',
          0x03: 'Extended',
        }),
    });

    adapter.emitData(tcpFrame(1, 1, 0x2b, pduReadDeviceIdentification(0x01, 0x00)));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    const response = adapter.written[0].subarray(8);
    expect(response[0]).toBe(0x0e);
    expect(response[1]).toBe(0x01);
    expect(response[2]).toBe(0x82); // regular conformity
    expect(response[3]).toBe(0x00);
    expect(response[5]).toBe(3); // object count (0,1,2) for basic stream
  });

  it('should return ILLEGAL_FUNCTION when a handler is missing', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {});

    adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0][7]).toBe(0x83);
    expect(adapter.written[0].subarray(8)).toEqual(Buffer.from([ErrorCode.ILLEGAL_FUNCTION]));
  });

  it('should support a custom function code handler', async () => {
    const { slave, adapter } = createSlave();
    slave.addUnit(1, {});
    slave.addCustomFunctionCode({ fc: 0x65 }, (_unit, _fc, _data, callback) => callback(null, () => Buffer.from([0x03, 0x04])));

    adapter.emitData(tcpFrame(1, 1, 0x65, Buffer.from([0x01, 0x02])));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0][7]).toBe(0x65);
    expect(adapter.written[0].subarray(8)).toEqual(Buffer.from([0x03, 0x04]));
  });

  it('should process requests concurrently when concurrent mode is enabled', async () => {
    const { slave, adapter } = createSlave('concurrent');
    slave.addUnit(1, {
      readHoldingRegisters: (_address, _length, callback) => callback(null, [0x1234]),
    });

    adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
    adapter.emitData(tcpFrame(2, 1, 0x03, pduReadRegisters(1, 1)));
    await flushPromises();

    expect(adapter.written).toHaveLength(2);
  });

  describe('addUnit validation', () => {
    it('should reject unit 0', () => {
      const { slave } = createSlave();
      expect(() => slave.addUnit(0, {})).toThrow('Unit must be an integer in 1..247, got 0');
    });

    it('should reject unit 248', () => {
      const { slave } = createSlave();
      expect(() => slave.addUnit(248, {})).toThrow('Unit must be an integer in 1..247, got 248');
    });

    it('should reject non-integer unit', () => {
      const { slave } = createSlave();
      expect(() => slave.addUnit(1.5, {})).toThrow('Unit must be an integer in 1..247, got 1.5');
    });

    it('should accept unit 1', () => {
      const { slave } = createSlave();
      expect(() => slave.addUnit(1, {})).not.toThrow();
    });

    it('should accept unit 247', () => {
      const { slave } = createSlave();
      expect(() => slave.addUnit(247, {})).not.toThrow();
    });
  });

  describe('queueStrategy', () => {
    it('should default queueStrategy to drop-stale', () => {
      const { slave } = createSlave();
      expect(slave.queueStrategy).toBe('drop-stale');
    });

    it('should return ILLEGAL_FUNCTION for unknown function codes', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x7f, Buffer.from([0x01])));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0xff);
      expect(adapter.written[0].subarray(8)).toEqual(Buffer.from([ErrorCode.ILLEGAL_FUNCTION]));
    });

    it('should drop stale queued frames with drop-stale strategy', async () => {
      const { slave, adapter } = createSlave('drop-stale');
      slave.addUnit(1, {
        readHoldingRegisters: (_address, _length, callback) => {
          setTimeout(() => callback(null, [0x1234]), 20);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      adapter.emitData(tcpFrame(2, 1, 0x03, pduReadRegisters(1, 1)));
      adapter.emitData(tcpFrame(3, 1, 0x03, pduReadRegisters(2, 1)));

      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(adapter.written).toHaveLength(2);
      expect(adapter.written[0].readUInt16BE(0)).toBe(1);
      expect(adapter.written[1].readUInt16BE(0)).toBe(3);
    });

    it('should deduplicate queued frames with the same address', async () => {
      const { slave, adapter } = createSlave('deduplicate');
      slave.addUnit(1, {
        readHoldingRegisters: (_address, _length, callback) => {
          setTimeout(() => callback(null, [0x1234]), 20);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      adapter.emitData(tcpFrame(2, 1, 0x03, pduReadRegisters(0, 1)));
      adapter.emitData(tcpFrame(3, 1, 0x03, pduReadRegisters(1, 1)));
      adapter.emitData(tcpFrame(4, 1, 0x03, pduReadRegisters(0, 1)));

      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(adapter.written).toHaveLength(3);
      expect(adapter.written[0].readUInt16BE(0)).toBe(1);
      expect(adapter.written[1].readUInt16BE(0)).toBe(3);
      expect(adapter.written[2].readUInt16BE(0)).toBe(4);
    });

    it('should deduplicate FC 23 frames using full data body', async () => {
      const { slave, adapter } = createSlave('deduplicate');
      slave.addUnit(1, {
        readHoldingRegisters: (_address, _length, callback) => {
          setTimeout(() => callback(null, [0x3333]), 10);
        },
        writeMultipleRegisters: (_address, _value, callback) => {
          setTimeout(() => callback(null), 10);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x17, pduReadWriteMultipleRegisters(0x10, 1, 0x20, [0x1111])));
      await flushPromises();

      // Same read, different write -> NOT duplicate
      adapter.emitData(tcpFrame(2, 1, 0x17, pduReadWriteMultipleRegisters(0x10, 1, 0x21, [0x2222])));
      // Different read, same write -> NOT duplicate
      adapter.emitData(tcpFrame(3, 1, 0x17, pduReadWriteMultipleRegisters(0x11, 1, 0x20, [0x1111])));
      // Identical to frame 2 -> duplicate, drops frame 2
      adapter.emitData(tcpFrame(4, 1, 0x17, pduReadWriteMultipleRegisters(0x10, 1, 0x21, [0x2222])));

      await new Promise((resolve) => setTimeout(resolve, 100));

      expect(adapter.written).toHaveLength(3);
      expect(adapter.written[0].readUInt16BE(0)).toBe(1);
      expect(adapter.written[1].readUInt16BE(0)).toBe(3);
      expect(adapter.written[2].readUInt16BE(0)).toBe(4);
    });

    it('should process frames concurrently with queueStrategy concurrent', async () => {
      const { slave, adapter } = createSlave('concurrent');
      slave.addUnit(1, {
        readHoldingRegisters: (_address, _length, callback) => callback(null, [0x1234]),
      });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      adapter.emitData(tcpFrame(2, 1, 0x03, pduReadRegisters(1, 1)));
      await flushPromises();

      expect(adapter.written).toHaveLength(2);
    });
  });

  it('should serialize overlapping FC 23 writes with interval locks', async () => {
    const { slave, adapter } = createSlave();
    let activeWrites = 0;
    let maxActiveWrites = 0;
    slave.addUnit(1, {
      readHoldingRegisters: (_address, _length, callback) => callback(null, [0x0000]),
      writeMultipleRegisters: (_address, _value, callback) => {
        activeWrites++;
        maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
        setTimeout(() => {
          activeWrites--;
          callback(null);
        }, 20);
      },
    });

    const pdu1 = pduReadWriteMultipleRegisters(0, 1, 0, [0x1111]);
    const pdu2 = pduReadWriteMultipleRegisters(1, 1, 1, [0x2222]);
    adapter.emitData(tcpFrame(1, 1, 0x17, pdu1));
    adapter.emitData(tcpFrame(2, 1, 0x17, pdu2));
    await flushPromises();
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(maxActiveWrites).toBe(1); // overlapping addresses serialized
    expect(adapter.written).toHaveLength(2);
  });

  it('should add and remove units and custom function codes', () => {
    const { slave } = createSlave();

    slave.addUnit(2, {});
    slave.removeUnit(2);

    slave.addCustomFunctionCode({ fc: 0x65 }, (_unit, _fc, _data, callback) => callback(null, () => Buffer.alloc(0)));
    slave.removeCustomFunctionCode(0x65);
  });

  it('should be idempotent when destroy is called twice', () => {
    const { slave } = createSlave();

    slave.destroy();
    expect(() => slave.destroy()).not.toThrow();
  });

  it('should dispatch broadcast writes to all registered units', async () => {
    const { slave, adapter } = createSlave();
    const calls: number[] = [];

    slave.addUnit(1, {
      writeSingleRegister: (_address, _value, callback) => {
        calls.push(1);
        callback(null);
      },
    });
    slave.addUnit(2, {
      writeSingleRegister: (_address, _value, callback) => {
        calls.push(2);
        callback(null);
      },
    });

    adapter.emitData(tcpFrame(1, 0, 0x06, pduWriteSingleRegister(0x10, 0x1234)));
    await flushPromises();

    expect(calls.sort()).toEqual([1, 2]);
    expect(adapter.written).toHaveLength(0);
  });

  it('should emit a frameError event for malformed frames', async () => {
    const { slave, adapter } = createSlave();
    const frameErrors: unknown[] = [];
    slave.on('frameError', (event) => frameErrors.push(event));

    adapter.emitData(Buffer.from([0x00, 0x01, 0xab, 0xcd, 0x00, 0x04, 0x01, 0x03, 0x00, 0x00]));
    await flushPromises();

    expect(frameErrors).toHaveLength(1);
  });

  it('should emit a pipelineFault event when the response write fails', async () => {
    const { slave, adapter } = createSlave();
    const faults: unknown[] = [];
    slave.on('pipelineFault', (event) => faults.push(event));

    // Override the adapter write to simulate a transport failure.
    adapter.write = (_data, cb) => {
      cb?.(new Error('write failed'));
    };

    slave.addUnit(1, {
      readHoldingRegisters: (_address, _length, callback) => callback(null, [0x1234]),
    });

    adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
    await flushPromises();

    expect(faults.length).toBeGreaterThanOrEqual(1);
  });

  it('should deny a unit via checkUnit authorizer', async () => {
    const { slave, adapter } = createSlave();
    const audits: unknown[] = [];
    slave.on('accessAudit', (event) => audits.push(event));
    slave.setAccessAuthorizer({ checkUnit: () => false });
    slave.addUnit(1, {
      readHoldingRegisters: (_address, _length, callback) => callback(null, [0x1234]),
    });

    adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
    await flushPromises();

    expect(adapter.written).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect((audits[0] as { type: string }).type).toBe('unit_access_denied');
  });

  it('should deny an address via checkAddress authorizer', async () => {
    const { slave, adapter } = createSlave();
    const audits: unknown[] = [];
    slave.on('accessAudit', (event) => audits.push(event));
    slave.setAccessAuthorizer({ checkAddress: () => false });
    slave.addUnit(1, {
      readHoldingRegisters: (_address, _length, callback) => callback(null, [0x1234]),
    });

    adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
    await flushPromises();

    expect(adapter.written).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect((audits[0] as { type: string }).type).toBe('address_access_denied');
  });

  it('should deny a runtime result via checkRuntime authorizer', async () => {
    const { slave, adapter } = createSlave();
    slave.setAccessAuthorizer({ checkRuntime: () => ErrorCode.SERVER_DEVICE_BUSY });
    slave.addUnit(1, {
      readHoldingRegisters: (_address, _length, callback) => callback(null, [0x1234]),
    });

    adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
    await flushPromises();

    expect(adapter.written).toHaveLength(1);
    expect(adapter.written[0][7]).toBe(0x83);
    expect(adapter.written[0][8]).toBe(ErrorCode.SERVER_DEVICE_BUSY);
  });

  it('should handle async checkRuntime denials', async () => {
    const { slave, adapter } = createSlave();
    const audits: unknown[] = [];
    slave.on('accessAudit', (event) => audits.push(event));
    slave.setAccessAuthorizer({ checkRuntime: () => Promise.resolve(false) });
    slave.addUnit(1, {
      readHoldingRegisters: (_address, _length, callback) => callback(null, [0x1234]),
    });

    adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
    await flushPromises();

    expect(adapter.written).toHaveLength(0);
    expect(audits).toHaveLength(1);
    expect((audits[0] as { type: string }).type).toBe('runtime_access_denied');
  });

  describe('handler missing protocol exceptions', () => {
    it('should emit protocolException when FC 1 handler is missing', async () => {
      const { slave, adapter } = createSlave();
      const exceptions: unknown[] = [];
      slave.on('protocolException', (event) => exceptions.push(event));

      slave.addUnit(1, {});
      adapter.emitData(tcpFrame(1, 1, 0x01, pduReadBits(0, 1)));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x81);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
      expect(exceptions).toHaveLength(1);
      expect((exceptions[0] as { type: string }).type).toBe('function_not_implemented');
    });

    it('should emit protocolException when FC 23 write handler is missing', async () => {
      const { slave, adapter } = createSlave();
      const exceptions: unknown[] = [];
      slave.on('protocolException', (event) => exceptions.push(event));

      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [1]) });
      adapter.emitData(tcpFrame(1, 1, 0x17, pduReadWriteMultipleRegisters(0, 1, 0, [1])));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x97);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
      expect(exceptions).toHaveLength(1);
      expect((exceptions[0] as { type: string }).type).toBe('function_not_implemented');
    });
  });

  describe('FC handler validation errors', () => {
    it('should return ILLEGAL_DATA_VALUE for FC 1 with invalid PDU length', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readCoils: (_a, _l, cb) => cb(null, [1]) });

      adapter.emitData(tcpFrame(1, 1, 0x01, Buffer.from([0x00, 0x00])));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x81);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 1 with invalid quantity', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readCoils: (_a, _l, cb) => cb(null, [1]) });

      adapter.emitData(tcpFrame(1, 1, 0x01, pduReadBits(0, 0)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x81);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_FUNCTION for FC 1 when handler is missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x01, pduReadBits(0, 1)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x81);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 2 with invalid PDU length', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readDiscreteInputs: (_a, _l, cb) => cb(null, [1]) });

      adapter.emitData(tcpFrame(1, 1, 0x02, Buffer.from([0x00, 0x00])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x82);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_FUNCTION for FC 2 when handler is missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x02, pduReadBits(0, 1)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x82);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 3 with invalid quantity', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [1]) });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 0)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x83);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_FUNCTION for FC 3 when handler is missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x83);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 4 with invalid PDU length', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readInputRegisters: (_a, _l, cb) => cb(null, [1]) });

      adapter.emitData(tcpFrame(1, 1, 0x04, Buffer.from([0x00, 0x00])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x84);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_FUNCTION for FC 4 when handler is missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x04, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x84);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 5 with invalid PDU length', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { writeSingleCoil: (_a, _v, cb) => cb(null) });

      adapter.emitData(tcpFrame(1, 1, 0x05, Buffer.from([0x00, 0x00])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x85);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 5 with invalid coil value', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { writeSingleCoil: (_a, _v, cb) => cb(null) });

      adapter.emitData(tcpFrame(1, 1, 0x05, Buffer.from([0x00, 0x10, 0x12, 0x34])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x85);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_FUNCTION for FC 5 when handler is missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x05, pduWriteSingleCoil(0x10, 1)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x85);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 6 with invalid PDU length', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { writeSingleRegister: (_a, _v, cb) => cb(null) });

      adapter.emitData(tcpFrame(1, 1, 0x06, Buffer.from([0x00, 0x10])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x86);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_FUNCTION for FC 6 when handler is missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x06, pduWriteSingleRegister(0x10, 0x1234)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x86);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 15 with invalid PDU length', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { writeMultipleCoils: (_a, _v, cb) => cb(null) });

      adapter.emitData(tcpFrame(1, 1, 0x0f, Buffer.from([0x00, 0x10, 0x00, 0x01, 0x00])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x8f);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 15 with mismatched length and byte count', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { writeMultipleCoils: (_a, _v, cb) => cb(null) });

      adapter.emitData(tcpFrame(1, 1, 0x0f, Buffer.from([0x00, 0x10, 0x00, 0x09, 0x01, 0xff])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x8f);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_FUNCTION for FC 15 when writeMultipleCoils is missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x0f, pduWriteMultipleCoils(0x10, [1, 0, 1])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x8f);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 16 with invalid PDU length', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { writeMultipleRegisters: (_a, _v, cb) => cb(null) });

      adapter.emitData(tcpFrame(1, 1, 0x10, Buffer.from([0x00, 0x10, 0x00, 0x01, 0x01])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x90);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 16 with mismatched length and byte count', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { writeMultipleRegisters: (_a, _v, cb) => cb(null) });

      adapter.emitData(tcpFrame(1, 1, 0x10, Buffer.from([0x00, 0x10, 0x00, 0x02, 0x01, 0x12, 0x34])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x90);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_FUNCTION for FC 16 when writeMultipleRegisters is missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x10, pduWriteMultipleRegisters(0x10, [0x1234])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x90);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 17 with a non-empty PDU', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { reportServerId: (cb) => cb(null, { serverId: new Uint8Array([1]), runIndicatorStatus: true }) });

      adapter.emitData(tcpFrame(1, 1, 0x11, Buffer.from([0x01])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x91);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_FUNCTION for FC 17 when handler is missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x11, Buffer.alloc(0)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x91);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 22 with invalid PDU length', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { maskWriteRegister: (_a, _m1, _m2, cb) => cb(null) });

      adapter.emitData(tcpFrame(1, 1, 0x16, Buffer.from([0x00, 0x10, 0xff, 0x00])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x96);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_FUNCTION for FC 22 when maskWriteRegister is missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x16, pduMaskWriteRegister(0x10, 0xff00, 0x000f)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x96);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 23 with invalid PDU length', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => cb(null, [0x0000]),
        writeMultipleRegisters: (_a, _v, cb) => cb(null),
      });

      adapter.emitData(tcpFrame(1, 1, 0x17, Buffer.from([0x00, 0x10, 0x00, 0x01, 0x00, 0x20, 0x00, 0x01, 0x01])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x97);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 23 with mismatched write length and byte count', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => cb(null, [0x0000]),
        writeMultipleRegisters: (_a, _v, cb) => cb(null),
      });

      const pdu = pduReadWriteMultipleRegisters(0x10, 1, 0x20, [0x1234]);
      pdu[8] = 0x01; // corrupt byte count
      adapter.emitData(tcpFrame(1, 1, 0x17, pdu));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x97);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_FUNCTION for FC 23 when handlers are missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x17, pduReadWriteMultipleRegisters(0x10, 1, 0x20, [0x1234])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x97);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 43/14 with invalid PDU length', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readDeviceIdentification: (cb) => cb(null, { 0x00: 'V' }) });

      adapter.emitData(tcpFrame(1, 1, 0x2b, Buffer.from([0x14, 0x01])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0xab);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 43/14 with invalid MEI type', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readDeviceIdentification: (cb) => cb(null, { 0x00: 'V' }) });

      adapter.emitData(tcpFrame(1, 1, 0x2b, Buffer.from([0x00, 0x01, 0x00])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0xab);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 43/14 with invalid read device ID code', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readDeviceIdentification: (cb) => cb(null, { 0x00: 'V' }) });

      adapter.emitData(tcpFrame(1, 1, 0x2b, pduReadDeviceIdentification(0x05, 0x00)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0xab);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_FUNCTION for FC 43/14 when handler is missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x2b, pduReadDeviceIdentification(0x01, 0x00)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0xab);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });
  });

  describe('access authorizer slave paths', () => {
    it('should return an exception when checkUnit returns a numeric code', async () => {
      const { slave, adapter } = createSlave();
      slave.setAccessAuthorizer({ checkUnit: () => ErrorCode.ILLEGAL_FUNCTION });
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]) });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x83);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should handle async checkUnit resolving to false', async () => {
      const { slave, adapter } = createSlave();
      const audits: unknown[] = [];
      slave.on('accessAudit', (event) => audits.push(event));
      slave.setAccessAuthorizer({ checkUnit: () => Promise.resolve(false) });
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]) });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(adapter.written).toHaveLength(0);
      expect(audits).toHaveLength(1);
      expect((audits[0] as { type: string }).type).toBe('unit_access_denied');
    });

    it('should handle async checkUnit resolving to a numeric code', async () => {
      const { slave, adapter } = createSlave();
      slave.setAccessAuthorizer({ checkUnit: () => Promise.resolve(ErrorCode.ILLEGAL_FUNCTION) });
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]) });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x83);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return an exception when checkAddress returns a numeric code', async () => {
      const { slave, adapter } = createSlave();
      slave.setAccessAuthorizer({ checkAddress: () => ErrorCode.ILLEGAL_DATA_ADDRESS });
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]) });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x83);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
    });

    it('should handle async checkAddress resolving to false', async () => {
      const { slave, adapter } = createSlave();
      const audits: unknown[] = [];
      slave.on('accessAudit', (event) => audits.push(event));
      slave.setAccessAuthorizer({ checkAddress: () => Promise.resolve(false) });
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]) });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(adapter.written).toHaveLength(0);
      expect(audits).toHaveLength(1);
      expect((audits[0] as { type: string }).type).toBe('address_access_denied');
    });

    it('should handle async checkAddress resolving to a numeric code', async () => {
      const { slave, adapter } = createSlave();
      slave.setAccessAuthorizer({ checkAddress: () => Promise.resolve(ErrorCode.ILLEGAL_DATA_ADDRESS) });
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]) });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x83);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
    });

    it('should allow requests when checkRuntime returns true', async () => {
      const { slave, adapter } = createSlave();
      slave.setAccessAuthorizer({ checkRuntime: () => true });
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]) });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x03);
    });

    it('should allow requests when checkRuntime returns a resolving promise', async () => {
      const { slave, adapter } = createSlave();
      slave.setAccessAuthorizer({ checkRuntime: () => Promise.resolve(true) });
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]) });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x03);
    });
  });

  describe('additional FC edge cases', () => {
    it('should return SERVER_DEVICE_FAILURE for FC 17 when serverId exceeds 250 bytes', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        reportServerId: (cb) =>
          cb(null, {
            serverId: new Uint8Array(251).fill(0x01),
            runIndicatorStatus: true,
          }),
      });

      adapter.emitData(tcpFrame(1, 1, 0x11, Buffer.alloc(0)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x91);
      expect(adapter.written[0][8]).toBe(ErrorCode.SERVER_DEVICE_FAILURE);
    });

    it('should fall back to unit ID when FC 17 serverId is null', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        reportServerId: (cb) => cb(null, { serverId: undefined as unknown as Uint8Array, runIndicatorStatus: true }),
      });

      adapter.emitData(tcpFrame(1, 1, 0x11, Buffer.alloc(0)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x11);
      expect(adapter.written[0][9]).toBe(1);
    });

    it('should return ILLEGAL_FUNCTION for FC 22 when maskWriteRegister is omitted', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]),
        writeSingleRegister: (_a, _v, cb) => cb(null),
      });

      adapter.emitData(tcpFrame(1, 1, 0x16, pduMaskWriteRegister(0x10, 0xff00, 0x000f)));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x96);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_FUNCTION for FC 23 when writeMultipleRegisters is omitted', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => cb(null, [0x3333]),
        writeSingleRegister: (_a, _v, cb) => cb(null),
      });

      adapter.emitData(tcpFrame(1, 1, 0x17, pduReadWriteMultipleRegisters(0x50, 1, 0x60, [0x1111, 0x2222])));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x97);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_FUNCTION);
    });

    it('should return ILLEGAL_DATA_ADDRESS for FC 43/14 specific access with invalid object ID', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readDeviceIdentification: (cb) => cb(null, { 0x00: 'V' }) });

      adapter.emitData(tcpFrame(1, 1, 0x2b, pduReadDeviceIdentification(0x04, 0x07)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0xab);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
    });

    it('should return ILLEGAL_DATA_ADDRESS for FC 43/14 specific access when object is missing', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readDeviceIdentification: (cb) => cb(null, { 0x00: 'V' }) });

      adapter.emitData(tcpFrame(1, 1, 0x2b, pduReadDeviceIdentification(0x04, 0x05)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0xab);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
    });

    it('should return SERVER_DEVICE_FAILURE for FC 43/14 with an out-of-range object ID', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readDeviceIdentification: (cb) => cb(null, { 0x10: 'V' }) });

      adapter.emitData(tcpFrame(1, 1, 0x2b, pduReadDeviceIdentification(0x01, 0x00)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0xab);
      expect(adapter.written[0][8]).toBe(ErrorCode.SERVER_DEVICE_FAILURE);
    });

    it('should return SERVER_DEVICE_FAILURE for FC 43/14 with an oversized object value', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readDeviceIdentification: (cb) => cb(null, { 0x00: 'V'.repeat(300) }) });

      adapter.emitData(tcpFrame(1, 1, 0x2b, pduReadDeviceIdentification(0x01, 0x00)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0xab);
      expect(adapter.written[0][8]).toBe(ErrorCode.SERVER_DEVICE_FAILURE);
    });
  });

  describe('pipeline faults and broadcasts', () => {
    it('should emit a pipelineFault when unit access denied response fails to write', async () => {
      const { slave, adapter } = createSlave();
      const faults: unknown[] = [];
      slave.on('pipelineFault', (event) => faults.push(event));
      slave.setAccessAuthorizer({ checkUnit: () => ErrorCode.ILLEGAL_FUNCTION });
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]) });

      adapter.write = (_data, cb) => cb?.(new Error('write failed'));
      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(faults.length).toBeGreaterThanOrEqual(1);
    });

    it('should emit a pipelineFault when address access denied response fails to write', async () => {
      const { slave, adapter } = createSlave();
      const faults: unknown[] = [];
      slave.on('pipelineFault', (event) => faults.push(event));
      slave.setAccessAuthorizer({ checkAddress: () => ErrorCode.ILLEGAL_DATA_ADDRESS });
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]) });

      adapter.write = (_data, cb) => cb?.(new Error('write failed'));
      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(faults.length).toBeGreaterThanOrEqual(1);
    });

    it('should not respond to broadcast read requests', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]) });

      adapter.emitData(tcpFrame(1, 0, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(adapter.written).toHaveLength(0);
    });

    it('should dispatch broadcast writes to all registered units', async () => {
      const { slave, adapter } = createSlave();
      const calls: number[] = [];

      slave.addUnit(1, {
        writeSingleRegister: (_a, _v, cb) => {
          calls.push(1);
          cb(null);
        },
      });
      slave.addUnit(2, {
        writeSingleRegister: (_a, _v, cb) => {
          calls.push(2);
          cb(null);
        },
      });

      adapter.emitData(tcpFrame(1, 0, 0x06, pduWriteSingleRegister(0x10, 0x1234)));
      await flushPromises();

      expect(calls.sort()).toEqual([1, 2]);
      expect(adapter.written).toHaveLength(0);
    });

    it('should handle a broadcast when no units are registered', async () => {
      const { adapter } = createSlave();

      adapter.emitData(tcpFrame(1, 0, 0x06, pduWriteSingleRegister(0x10, 0x1234)));
      await flushPromises();

      expect(adapter.written).toHaveLength(0);
    });
  });

  describe('queue strategies', () => {
    it('should process frames in FIFO order', async () => {
      const { slave, adapter } = createSlave('fifo');
      const order: number[] = [];
      slave.addUnit(1, {
        readHoldingRegisters: (a, _l, cb) => {
          order.push(a);
          cb(null, [0x1234]);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      adapter.emitData(tcpFrame(2, 1, 0x03, pduReadRegisters(1, 1)));
      await flushPromises();

      expect(order).toEqual([0, 1]);
      expect(adapter.written).toHaveLength(2);
    });

    it('should deduplicate identical read frames', async () => {
      const { slave, adapter } = createSlave('deduplicate');
      let count = 0;
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => {
          count++;
          setTimeout(() => cb(null, [0x1234]), 10);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      adapter.emitData(tcpFrame(2, 1, 0x03, pduReadRegisters(0, 1)));
      adapter.emitData(tcpFrame(3, 1, 0x03, pduReadRegisters(0, 1)));
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(count).toBe(2);
      expect(adapter.written).toHaveLength(2);
    });

    it('should drop stale frames with drop-stale strategy', async () => {
      const { slave, adapter } = createSlave('drop-stale');
      let count = 0;
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => {
          count++;
          setTimeout(() => cb(null, [0x1234]), 10);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x03, pduReadRegisters(0, 1)));
      adapter.emitData(tcpFrame(2, 1, 0x03, pduReadRegisters(1, 1)));
      adapter.emitData(tcpFrame(3, 1, 0x03, pduReadRegisters(2, 1)));
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(count).toBe(2);
      expect(adapter.written).toHaveLength(2);
      expect(adapter.written[0].readUInt16BE(0)).toBe(1);
      expect(adapter.written[1].readUInt16BE(0)).toBe(3);
    });
  });

  describe('custom function codes', () => {
    it('should support a custom function code handler and return its response', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});
      slave.addCustomFunctionCode({ fc: 0x65 }, (_unit, _fc, data, callback) => {
        callback(null, () => Buffer.concat([data, data]));
      });

      adapter.emitData(tcpFrame(1, 1, 0x65, Buffer.from([0x01, 0x02])));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x65);
      expect(adapter.written[0].subarray(8)).toEqual(Buffer.from([0x01, 0x02, 0x01, 0x02]));
    });

    it('should return an exception for a custom FC that reports an error code', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {});
      slave.addCustomFunctionCode({ fc: 0x65 }, (_unit, _fc, _data, callback) => {
        callback(ErrorCode.SERVER_DEVICE_BUSY, undefined);
      });

      adapter.emitData(tcpFrame(1, 1, 0x65, Buffer.from([0x01])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0xe5);
      expect(adapter.written[0][8]).toBe(ErrorCode.SERVER_DEVICE_BUSY);
    });
  });

  describe('destroyed property', () => {
    it('should return false for a new slave', () => {
      const { slave } = createSlave();
      expect(slave.destroyed).toBe(false);
    });

    it('should return true after destroy', () => {
      const { slave } = createSlave();
      slave.destroy();
      expect(slave.destroyed).toBe(true);
    });
  });

  describe('unregistered unit', () => {
    it('should return GATEWAY_PATH_UNAVAILABLE for an unregistered unit', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [0x1234]) });

      adapter.emitData(tcpFrame(1, 2, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(adapter.written).toHaveLength(1);
      expect(adapter.written[0][7]).toBe(0x83);
      expect(adapter.written[0][8]).toBe(ErrorCode.GATEWAY_PATH_UNAVAILABLE);
    });

    it('should emit protocolException for an unregistered unit', async () => {
      const { slave, adapter } = createSlave();
      const exceptions: unknown[] = [];
      slave.on('protocolException', (event) => exceptions.push(event));

      adapter.emitData(tcpFrame(1, 2, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(exceptions).toHaveLength(1);
      expect((exceptions[0] as { type: string }).type).toBe('gateway_path_unavailable');
    });

    it('should emit pipelineFault when unregistered unit response fails to write', async () => {
      const { slave, adapter } = createSlave();
      const faults: unknown[] = [];
      slave.on('pipelineFault', (event) => faults.push(event));
      adapter.write = (_data, cb) => cb?.(new Error('write failed'));

      adapter.emitData(tcpFrame(1, 2, 0x03, pduReadRegisters(0, 1)));
      await flushPromises();

      expect(faults.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('pipeline fault on illegal function response', () => {
    it('should emit pipelineFault when illegal function response write fails', async () => {
      const { slave, adapter } = createSlave();
      const faults: unknown[] = [];
      slave.on('pipelineFault', (event) => faults.push(event));
      adapter.write = (_data, cb) => cb?.(new Error('write failed'));
      slave.addUnit(1, {});

      adapter.emitData(tcpFrame(1, 1, 0x7f, Buffer.from([0x01])));
      await flushPromises();

      expect(faults.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('concurrent mode write range locking', () => {
    it('should serialize overlapping FC 6 writes', async () => {
      const { slave, adapter } = createConcurrentSlave();
      let activeWrites = 0;
      let maxActiveWrites = 0;
      slave.addUnit(1, {
        writeSingleRegister: (_a, _v, cb) => {
          activeWrites++;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          setTimeout(() => {
            activeWrites--;
            cb(null);
          }, 20);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x06, pduWriteSingleRegister(0x10, 0x1111)));
      adapter.emitData(tcpFrame(2, 1, 0x06, pduWriteSingleRegister(0x10, 0x2222)));
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(maxActiveWrites).toBe(1);
      expect(adapter.written).toHaveLength(2);
    });

    it('should serialize overlapping FC 16 writes', async () => {
      const { slave, adapter } = createConcurrentSlave();
      let activeWrites = 0;
      let maxActiveWrites = 0;
      slave.addUnit(1, {
        writeMultipleRegisters: (_a, _v, cb) => {
          activeWrites++;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          setTimeout(() => {
            activeWrites--;
            cb(null);
          }, 20);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x10, pduWriteMultipleRegisters(0x10, [0x1111])));
      adapter.emitData(tcpFrame(2, 1, 0x10, pduWriteMultipleRegisters(0x10, [0x2222])));
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(maxActiveWrites).toBe(1);
      expect(adapter.written).toHaveLength(2);
    });

    it('should allow non-overlapping FC 16 writes concurrently', async () => {
      const { slave, adapter } = createConcurrentSlave();
      let activeWrites = 0;
      let maxActiveWrites = 0;
      slave.addUnit(1, {
        writeMultipleRegisters: (_a, _v, cb) => {
          activeWrites++;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          setTimeout(() => {
            activeWrites--;
            cb(null);
          }, 20);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x10, pduWriteMultipleRegisters(0x10, [0x1111])));
      adapter.emitData(tcpFrame(2, 1, 0x10, pduWriteMultipleRegisters(0x20, [0x2222])));
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(maxActiveWrites).toBe(2);
      expect(adapter.written).toHaveLength(2);
    });

    it('should serialize overlapping FC 5 writes', async () => {
      const { slave, adapter } = createConcurrentSlave();
      let activeWrites = 0;
      let maxActiveWrites = 0;
      slave.addUnit(1, {
        writeSingleCoil: (_a, _v, cb) => {
          activeWrites++;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          setTimeout(() => {
            activeWrites--;
            cb(null);
          }, 20);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x05, pduWriteSingleCoil(0x10, 1)));
      adapter.emitData(tcpFrame(2, 1, 0x05, pduWriteSingleCoil(0x10, 0)));
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(maxActiveWrites).toBe(1);
      expect(adapter.written).toHaveLength(2);
    });

    it('should serialize overlapping FC 15 writes', async () => {
      const { slave, adapter } = createConcurrentSlave();
      let activeWrites = 0;
      let maxActiveWrites = 0;
      slave.addUnit(1, {
        writeMultipleCoils: (_a, _v, cb) => {
          activeWrites++;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          setTimeout(() => {
            activeWrites--;
            cb(null);
          }, 20);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x0f, pduWriteMultipleCoils(0x10, [1, 0, 1])));
      adapter.emitData(tcpFrame(2, 1, 0x0f, pduWriteMultipleCoils(0x11, [1, 1])));
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(maxActiveWrites).toBe(1);
      expect(adapter.written).toHaveLength(2);
    });

    it('should serialize overlapping FC 22 writes', async () => {
      const { slave, adapter } = createConcurrentSlave();
      let activeWrites = 0;
      let maxActiveWrites = 0;
      slave.addUnit(1, {
        maskWriteRegister: (_a, _m1, _m2, cb) => {
          activeWrites++;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          setTimeout(() => {
            activeWrites--;
            cb(null);
          }, 20);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x16, pduMaskWriteRegister(0x10, 0xff00, 0x000f)));
      adapter.emitData(tcpFrame(2, 1, 0x16, pduMaskWriteRegister(0x10, 0x00ff, 0x00f0)));
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(maxActiveWrites).toBe(1);
      expect(adapter.written).toHaveLength(2);
    });

    it('should serialize overlapping FC 23 writes', async () => {
      const { slave, adapter } = createConcurrentSlave();
      let activeWrites = 0;
      let maxActiveWrites = 0;
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => cb(null, [0x0000]),
        writeMultipleRegisters: (_a, _v, cb) => {
          activeWrites++;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          setTimeout(() => {
            activeWrites--;
            cb(null);
          }, 20);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x17, pduReadWriteMultipleRegisters(0, 1, 0, [0x1111])));
      adapter.emitData(tcpFrame(2, 1, 0x17, pduReadWriteMultipleRegisters(0, 1, 0, [0x2222])));
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(maxActiveWrites).toBe(1);
      expect(adapter.written).toHaveLength(2);
    });

    it('should serialize custom FC writes with requestAddressRange', async () => {
      const { slave, adapter } = createConcurrentSlave();
      let activeWrites = 0;
      let maxActiveWrites = 0;
      slave.addUnit(1, {});
      slave.addCustomFunctionCode(
        {
          fc: 0x65,
          requestAddressRange: (_unit, _fc, data) => ({
            holdingRegisters: [[data[0], data[0] + data[1] - 1]],
          }),
        },
        (_unit, _fc, _data, callback) => {
          activeWrites++;
          maxActiveWrites = Math.max(maxActiveWrites, activeWrites);
          setTimeout(() => {
            activeWrites--;
            callback(null, () => Buffer.from([0x00]));
          }, 20);
        },
      );

      adapter.emitData(tcpFrame(1, 1, 0x65, Buffer.from([0x00, 0x10, 0x00, 0x02])));
      adapter.emitData(tcpFrame(2, 1, 0x65, Buffer.from([0x00, 0x05, 0x00, 0x02])));
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 60));

      expect(maxActiveWrites).toBe(1);
      expect(adapter.written).toHaveLength(2);
    });

    it('should flush pending writes after an in-flight write completes', async () => {
      const { slave, adapter } = createConcurrentSlave();
      const order: number[] = [];
      slave.addUnit(1, {
        writeSingleRegister: (a, _v, cb) => {
          setTimeout(() => {
            order.push(a);
            cb(null);
          }, 20);
        },
      });

      adapter.emitData(tcpFrame(1, 1, 0x06, pduWriteSingleRegister(0x10, 0x1111)));
      adapter.emitData(tcpFrame(2, 1, 0x06, pduWriteSingleRegister(0x10, 0x2222)));
      adapter.emitData(tcpFrame(3, 1, 0x06, pduWriteSingleRegister(0x10, 0x3333)));
      await flushPromises();
      await new Promise((resolve) => setTimeout(resolve, 80));

      expect(order).toEqual([0x10, 0x10, 0x10]);
      expect(adapter.written).toHaveLength(3);
    });
  });

  describe('FC validation gaps', () => {
    it('should return ILLEGAL_DATA_VALUE for FC 2 with quantity 0', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readDiscreteInputs: (_a, _l, cb) => cb(null, [1]) });

      adapter.emitData(tcpFrame(1, 1, 0x02, pduReadBits(0, 0)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x82);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 2 with quantity > 2000', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readDiscreteInputs: (_a, _l, cb) => cb(null, [1]) });

      adapter.emitData(tcpFrame(1, 1, 0x02, pduReadBits(0, 2001)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x82);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 3 with invalid PDU length', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readHoldingRegisters: (_a, _l, cb) => cb(null, [1]) });

      adapter.emitData(tcpFrame(1, 1, 0x03, Buffer.from([0x00, 0x00])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x83);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 4 with quantity 0', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readInputRegisters: (_a, _l, cb) => cb(null, [1]) });

      adapter.emitData(tcpFrame(1, 1, 0x04, pduReadRegisters(0, 0)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x84);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 4 with quantity > 125', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readInputRegisters: (_a, _l, cb) => cb(null, [1]) });

      adapter.emitData(tcpFrame(1, 1, 0x04, pduReadRegisters(0, 126)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x84);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 23 with read quantity 0', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => cb(null, [0x0000]),
        writeMultipleRegisters: (_a, _v, cb) => cb(null),
      });

      adapter.emitData(tcpFrame(1, 1, 0x17, pduReadWriteMultipleRegisters(0x10, 0, 0x20, [0x1111])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x97);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 23 with read quantity > 125', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => cb(null, [0x0000]),
        writeMultipleRegisters: (_a, _v, cb) => cb(null),
      });

      adapter.emitData(tcpFrame(1, 1, 0x17, pduReadWriteMultipleRegisters(0x10, 126, 0x20, [0x1111])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x97);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return ILLEGAL_DATA_VALUE for FC 23 with write quantity 0', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => cb(null, [0x0000]),
        writeMultipleRegisters: (_a, _v, cb) => cb(null),
      });

      const pdu = Buffer.allocUnsafe(9);
      pdu[0] = 0x00;
      pdu[1] = 0x10;
      pdu[2] = 0x00;
      pdu[3] = 0x01;
      pdu[4] = 0x00;
      pdu[5] = 0x20;
      pdu[6] = 0x00;
      pdu[7] = 0x00;
      pdu[8] = 0x00;
      adapter.emitData(tcpFrame(1, 1, 0x17, pdu));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x97);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });
  });

  describe('coil and discrete input tail-byte branches', () => {
    it.each([{ length: 11 }, { length: 12 }, { length: 13 }, { length: 14 }, { length: 15 }])(
      'should pack FC 1 response with $length coils',
      async ({ length }) => {
        const { slave, adapter } = createSlave();
        const coils = Array.from({ length }, (_, i) => (i % 2) as 0 | 1);
        slave.addUnit(1, { readCoils: (_a, _l, cb) => cb(null, coils) });

        adapter.emitData(tcpFrame(1, 1, 0x01, pduReadBits(0, length)));
        await flushPromises();

        expect(adapter.written[0][7]).toBe(0x01);
        expect(adapter.written[0][8]).toBe((length + 7) >> 3);
      },
    );

    it.each([{ length: 11 }, { length: 12 }, { length: 13 }, { length: 14 }, { length: 15 }])(
      'should pack FC 2 response with $length discrete inputs',
      async ({ length }) => {
        const { slave, adapter } = createSlave();
        const inputs = Array.from({ length }, (_, i) => (i % 2) as 0 | 1);
        slave.addUnit(1, { readDiscreteInputs: (_a, _l, cb) => cb(null, inputs) });

        adapter.emitData(tcpFrame(1, 1, 0x02, pduReadBits(0, length)));
        await flushPromises();

        expect(adapter.written[0][7]).toBe(0x02);
        expect(adapter.written[0][8]).toBe((length + 7) >> 3);
      },
    );

    it.each([{ length: 11 }, { length: 12 }, { length: 13 }, { length: 14 }, { length: 15 }])(
      'should unpack FC 15 request with $length coils',
      async ({ length }) => {
        const { slave, adapter } = createSlave();
        const received: number[] = [];
        slave.addUnit(1, {
          writeMultipleCoils: (_a, value, cb) => {
            received.push(...value);
            cb(null);
          },
        });

        const bits = Array.from({ length }, (_, i) => (i % 2) as 0 | 1);
        adapter.emitData(tcpFrame(1, 1, 0x0f, pduWriteMultipleCoils(0x20, bits)));
        await flushPromises();

        expect(received).toEqual(bits);
        expect(adapter.written[0][7]).toBe(0x0f);
      },
    );
  });

  describe('FC edge branches', () => {
    it('should default runIndicatorStatus to true when undefined for FC 17', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        reportServerId: (cb) => cb(null, { serverId: new Uint8Array([0x01]), runIndicatorStatus: undefined as unknown as boolean }),
      });

      adapter.emitData(tcpFrame(1, 1, 0x11, Buffer.alloc(0)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x11);
      expect(adapter.written[0][10]).toBe(0xff);
    });

    it('should return error when readHoldingRegisters fails in FC 23', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => cb(ErrorCode.ILLEGAL_DATA_ADDRESS, undefined),
        writeMultipleRegisters: (_a, _v, cb) => cb(null),
      });

      adapter.emitData(tcpFrame(1, 1, 0x17, pduReadWriteMultipleRegisters(0x10, 1, 0x20, [0x1111])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x97);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_ADDRESS);
    });

    it('should return error when writeMultipleRegisters fails in FC 23', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => cb(null, [0x0000]),
        writeMultipleRegisters: (_a, _v, cb) => cb(ErrorCode.ILLEGAL_DATA_VALUE),
      });

      adapter.emitData(tcpFrame(1, 1, 0x17, pduReadWriteMultipleRegisters(0x10, 1, 0x20, [0x1111])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x97);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should return error when writeMultipleRegisters fails in FC 23', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        readHoldingRegisters: (_a, _l, cb) => cb(null, [0x0000]),
        writeMultipleRegisters: (_a, _v, cb) => cb(ErrorCode.ILLEGAL_DATA_VALUE),
      });

      adapter.emitData(tcpFrame(1, 1, 0x17, pduReadWriteMultipleRegisters(0x10, 1, 0x20, [0x1111, 0x2222])));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x97);
      expect(adapter.written[0][8]).toBe(ErrorCode.ILLEGAL_DATA_VALUE);
    });

    it('should handle FC 43 basic stream read device ID code', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, { readDeviceIdentification: (cb) => cb(null, { 0x00: 'Vendor' }) });

      adapter.emitData(tcpFrame(1, 1, 0x2b, pduReadDeviceIdentification(0x01, 0x00)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x2b);
      expect(adapter.written[0][10]).toBe(0x81); // basic conformity
    });

    it('should handle FC 43 extended stream read device ID code', async () => {
      const { slave, adapter } = createSlave();
      slave.addUnit(1, {
        readDeviceIdentification: (cb) =>
          cb(null, {
            0x00: 'Vendor',
            0x80: 'Extended',
          }),
      });

      adapter.emitData(tcpFrame(1, 1, 0x2b, pduReadDeviceIdentification(0x03, 0x00)));
      await flushPromises();

      expect(adapter.written[0][7]).toBe(0x2b);
      expect(adapter.written[0][10]).toBe(0x83); // extended conformity
    });
  });
});
