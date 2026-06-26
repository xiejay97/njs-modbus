/**
 * Slave Audit Logging Example
 *
 * Demonstrates how to consume accessAudit, protocolException, and pipelineFault
 * events and forward them to a structured logger (or console).
 *
 * Run: npx tsx slave-audit-logging.ts
 */

import type { AbstractPipelineAdapter, AbstractPipelineAdapterEvents } from 'njs-modbus';

import { EventEmitter } from 'node:events';

import { ModbusSlave } from 'njs-modbus';

/**
 * Minimal in-memory pipeline adapter for the demo.
 * In production this would be a TCP, serial, or UDP pipeline.
 */
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
  checkUnit: (unit) => unit === 1,
});

slave.on('accessAudit', (event) => {
  console.log(JSON.stringify({ kind: 'accessAudit', ...event, data: event.data.toString('hex') }));
});

slave.on('protocolException', (event) => {
  console.log(JSON.stringify({ kind: 'protocolException', ...event, data: event.data.toString('hex') }));
});

slave.on('pipelineFault', (event) => {
  console.log(JSON.stringify({ kind: 'pipelineFault', ...event, data: event.data.toString('hex') }));
});

// Helper to build a minimal TCP frame: [tid 2][proto 2][len 2][unit 1][fc 1][payload...]
function tcpFrame(unit: number, fc: number, pdu: Buffer): Buffer {
  const length = 1 + 1 + pdu.length;
  const frame = Buffer.allocUnsafe(8 + pdu.length);
  frame.writeUInt16BE(1, 0); // transaction id
  frame.writeUInt16BE(0, 2); // protocol id
  frame.writeUInt16BE(length, 4);
  frame[6] = unit;
  frame[7] = fc;
  pdu.copy(frame, 8);
  return frame;
}

// Trigger unit_access_denied
adapter.emit('data', tcpFrame(2, 0x03, Buffer.from([0x00, 0x00, 0x00, 0x05])));

// Trigger function_not_implemented (unit 1 exists but has no FC3 handler)
slave.addUnit(1, {});
adapter.emit('data', tcpFrame(1, 0x03, Buffer.from([0x00, 0x00, 0x00, 0x05])));
