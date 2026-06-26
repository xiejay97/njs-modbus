/**
 * Custom Function Code with Address-Range Authorization
 *
 * Demonstrates how to declare `requestAddressRange` for a custom function code
 * so that `AccessAuthorizer.checkAddress` can authorize it.
 *
 * Run: npx tsx custom-fc-authorization.ts
 */

import type { AbstractPipelineAdapter, AbstractPipelineAdapterEvents } from 'njs-modbus';

import { EventEmitter } from 'node:events';

import { ModbusSlave } from 'njs-modbus';

class DemoAdapter extends EventEmitter<AbstractPipelineAdapterEvents> implements AbstractPipelineAdapter {
  write(_data: Buffer, cb?: (err: Error | null) => void): void {
    cb?.(null);
  }
}

const adapter = new DemoAdapter();

const slave = new ModbusSlave({
  pipelineAdapter: adapter,
  protocol: { type: 'TCP' },
});

slave.setAccessAuthorizer({
  checkAddress: (_unit, table, [start, end]) => {
    if (table !== 'holdingRegisters') {
      return false;
    }
    return start >= 0 && end < 50;
  },
});

// A unit model is required before the slave will dispatch any request (including
// custom function codes) to the handler registered below.
slave.addUnit(1, {});

slave.addCustomFunctionCode(
  {
    fc: 0x65,
    requestAddressRange: (_unit, _fc, data) => {
      // First two bytes of the PDU are the start address; length = data.length - 2 bytes.
      const start = (data[0] << 8) | data[1];
      const length = data.length - 2;
      return { holdingRegisters: [[start, start + length - 1]] };
    },
  },
  (_unit, _fc, data, callback) => {
    console.log('Custom FC handler called for', data.length, 'bytes');
    callback(null, () => Buffer.concat([data, data]));
  },
);

slave.on('accessAudit', (event) => {
  console.log('Denied:', event.type, event.message);
});

slave.on('protocolException', (event) => {
  console.log('Exception:', event.type, event.message);
});

function tcpFrame(unit: number, fc: number, pdu: Buffer): Buffer {
  const length = 1 + 1 + pdu.length;
  const frame = Buffer.allocUnsafe(8 + pdu.length);
  frame.writeUInt16BE(1, 0);
  frame.writeUInt16BE(0, 2);
  frame.writeUInt16BE(length, 4);
  frame[6] = unit;
  frame[7] = fc;
  pdu.copy(frame, 8);
  return frame;
}

// Authorized: addresses 0..4
adapter.emit('data', tcpFrame(1, 0x65, Buffer.from([0x00, 0x00, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03])));

// Denied: addresses 60..63 are outside 0..49
adapter.emit('data', tcpFrame(1, 0x65, Buffer.from([0x00, 0x3c, 0x00, 0x01, 0x00, 0x02, 0x00, 0x03])));
