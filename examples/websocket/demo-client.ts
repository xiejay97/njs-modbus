import { ModbusMaster } from 'njs-modbus';

import { WebSocketClientPhysicalLayer } from './websocket-client-layer.js';

/**
 * WebSocket Modbus Client Demo
 *
 * Connects to ws://localhost:8080 and performs a sequence of Modbus requests.
 *
 * Run: npx tsx demo-client.ts
 * (Make sure demo-server.ts is running first)
 */

const layer = new WebSocketClientPhysicalLayer();

layer.on('open', () => {
  console.log('✅ WebSocket client connected');
});

layer.on('close', () => {
  console.log('🔌 Connection closed');
  process.exit(0);
});

layer.on('error', (err: Error) => {
  console.error('❌ Client error:', err.message);
});

layer.once('connect', (pipeline) => {
  const master = new ModbusMaster({
    pipelineAdapter: pipeline,
    protocol: { type: 'TCP' },
    timeout: 5000,
  });

  master.on('frameError', (event) => {
    console.error('❌ Frame error:', event.message);
  });

  run(master).catch((err) => {
    console.error('Demo failed:', err.message);
    master.destroy();
    layer.close();
    process.exit(1);
  });
});

async function run(master: ModbusMaster<'TCP'>): Promise<void> {
  console.log('\n📡 Sending requests...\n');

  // --- FC03: Read Holding Registers (Unit 1) ---
  try {
    const res1 = await master.readHoldingRegisters(1, 0, 10);
    console.log('FC03 readHoldingRegisters (Unit 1, addr=0, len=10):');
    console.log('  values:', res1.data);
    console.log('  raw buffer:', res1.buffer.toString('hex'));
  } catch (e) {
    console.error('FC03 failed:', (e as Error).message);
  }

  // --- FC06: Write Single Register (Unit 1) ---
  try {
    await master.writeSingleRegister(1, 5, 12345);
    console.log('\nFC06 writeSingleRegister (Unit 1, addr=5, value=12345): OK');
  } catch (e) {
    console.error('FC06 failed:', (e as Error).message);
  }

  // --- FC16: Write Multiple Registers (Unit 1) ---
  try {
    await master.writeMultipleRegisters(1, 10, [100, 200, 300, 400, 500]);
    console.log('\nFC16 writeMultipleRegisters (Unit 1, addr=10, values=[100,200,300,400,500]): OK');
  } catch (e) {
    console.error('FC16 failed:', (e as Error).message);
  }

  // --- FC04: Read Input Registers (Unit 2) ---
  try {
    const res2 = await master.readInputRegisters(2, 0, 5);
    console.log('\nFC04 readInputRegisters (Unit 2, addr=0, len=5):');
    console.log('  values:', res2.data);
  } catch (e) {
    console.error('FC04 failed:', (e as Error).message);
  }

  // --- FC01: Read Coils (Unit 1 – not implemented, should return exception) ---
  try {
    await master.readCoils(1, 0, 8);
    console.log('\nFC01 readCoils: unexpected success');
  } catch (e) {
    console.log('\nFC01 readCoils (Unit 1) expected exception:', (e as Error).message);
  }

  console.log('\n✅ All requests completed. Closing...');
  master.destroy();
  layer.close();
}

layer.open('ws://localhost:8080', (err) => {
  if (err) {
    console.error('Failed to open WebSocket:', err.message);
    process.exit(1);
  }
});
