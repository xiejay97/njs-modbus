import { ModbusSlave } from 'njs-modbus';

import { WebSocketServerPhysicalLayer } from './websocket-server-layer.js';

/**
 * WebSocket Modbus Server Demo
 *
 * Starts a WebSocket server on port 8080 and exposes a Modbus slave with:
 * - Unit 1: 100 holding registers (address 0..99), initial value = address
 * - Unit 2: 50 input registers (address 0..49), initial value = address * 2
 *
 * Run: npx tsx demo-server.ts
 */

const layer = new WebSocketServerPhysicalLayer({ port: 8080 });

layer.on('open', () => {
  console.log('✅ WebSocket Modbus Server listening on ws://localhost:8080');
});

layer.on('close', () => {
  console.log('🔌 Server closed');
  process.exit(0);
});

layer.on('error', (err) => {
  console.error('❌ Server error:', err.message);
});

layer.on('connect', (pipeline) => {
  console.log('🔗 Client connected');

  const slave = new ModbusSlave({
    pipelineAdapter: pipeline,
    protocol: { type: 'TCP' },
    queueStrategy: 'concurrent',
  });

  // Unit 1 – Holding registers
  slave.addUnit(1, {
    readHoldingRegisters: (address: number, length: number, callback) => {
      const values: number[] = [];
      for (let i = 0; i < length; i++) {
        values.push(address + i);
      }
      console.log(`  [Unit 1] readHoldingRegisters addr=${address} len=${length} → [${values.join(', ')}]`);
      callback(null, values);
    },
    writeSingleRegister: (address: number, value: number, callback) => {
      console.log(`  [Unit 1] writeSingleRegister addr=${address} value=${value}`);
      callback(null);
    },
    writeMultipleRegisters: (address: number, values: number[], callback) => {
      console.log(`  [Unit 1] writeMultipleRegisters addr=${address} values=[${values.join(', ')}]`);
      callback(null);
    },
  });

  // Unit 2 – Input registers (read-only)
  slave.addUnit(2, {
    readInputRegisters: (address: number, length: number, callback) => {
      const values: number[] = [];
      for (let i = 0; i < length; i++) {
        values.push((address + i) * 2);
      }
      console.log(`  [Unit 2] readInputRegisters addr=${address} len=${length} → [${values.join(', ')}]`);
      callback(null, values);
    },
  });

  pipeline.once('close', () => {
    console.log('🔌 Client disconnected');
    slave.destroy();
  });
});

layer.open(undefined, (err) => {
  if (err) {
    console.error('Failed to open server:', err.message);
    process.exit(1);
  }
});

// Graceful shutdown on Ctrl+C
process.on('SIGINT', () => {
  console.log('\n⏳ Shutting down...');
  layer.close();
});
