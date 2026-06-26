/**
 * Best-practice Modbus TCP master / client.
 *
 * Demonstrates:
 * - Connection lifecycle management with exponential-backoff reconnect.
 * - Local access control that rejects illegal requests before they enter the queue.
 * - Concurrent pipelining (safe on Modbus TCP thanks to MBAP transaction ids).
 * - Per-request timeouts and structured error handling.
 * - Sequential scans mixed with concurrent writes.
 * - Graceful shutdown on SIGINT.
 *
 * Run: pnpm --filter njs-modbus-best-practice client
 *      (or from this directory: npx tsx master.ts)
 */

import { ErrorCode, ModbusError, ModbusMaster, TcpClientPhysicalLayer } from 'njs-modbus';

import { sharedAuthorizer } from './src/authorizer';
import { ADDRESS_RANGES, MASTER_QUEUE_STRATEGY, MASTER_TIMEOUT_MS, TCP_ENDPOINT, UNITS } from './src/config';

const physical = new TcpClientPhysicalLayer();

let master: ModbusMaster<'TCP'> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let shutdownRequested = false;

/**
 * Open the TCP connection, create a master, and run the demo sequence.
 *
 * If the connection drops, schedule a reconnect unless shutdown is in progress.
 */
function start(): void {
  if (shutdownRequested) {
    return;
  }

  physical.open({ host: TCP_ENDPOINT.host, port: TCP_ENDPOINT.port }, (err) => {
    if (err) {
      console.error('[master] connection failed:', err.message);
      scheduleReconnect();
      return;
    }
    console.log(`[master] connected to ${TCP_ENDPOINT.host}:${TCP_ENDPOINT.port}`);
  });
}

physical.on('connect', (pipeline) => {
  master = new ModbusMaster({
    pipelineAdapter: pipeline,
    protocol: { type: 'TCP' },
    queueStrategy: MASTER_QUEUE_STRATEGY,
    timeout: MASTER_TIMEOUT_MS,
  });

  // Best practice: mirror the slave-side authorizer on the master so illegal
  // requests fail fast and never consume queue slots or wire bandwidth.
  master.setAccessAuthorizer(sharedAuthorizer);

  // Log framing errors without crashing the demo.
  master.on('frameError', (event) => {
    console.error('[master] frame error:', event.type, '-', event.message);
  });

  // Run the demo workload. In a real application this would be triggered by
  // external scheduling (e.g. setInterval, message bus, or HTTP request).
  runDemo(master).catch((err) => {
    console.error('[master] demo workload failed:', (err as Error).message);
    stop();
  });

  // If the pipeline closes, destroy the master and reconnect.
  pipeline.once('close', () => {
    console.log('[master] connection closed');
    master?.destroy();
    master = null;
    scheduleReconnect();
  });
});

physical.on('error', (err) => {
  console.error('[master] physical layer error:', err.message);
});

/**
 * Reconnect with a simple exponential backoff capped at 5 seconds.
 */
function scheduleReconnect(): void {
  if (shutdownRequested || reconnectTimer) {
    return;
  }
  const delay = Math.min(1000 * 2 ** (Math.random() * 3), 5000);
  console.log(`[master] reconnecting in ${Math.round(delay)}ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    start();
  }, delay);
}

/**
 * Run a representative workload against the slave.
 */
async function runDemo(masterInstance: ModbusMaster<'TCP'>): Promise<void> {
  console.log('\n[master] starting demo workload');

  // 1. Read initial holding registers from the process unit.
  const holding = await masterInstance.readHoldingRegisters(UNITS.PROCESS, 0, 10);
  console.log('[master] FC03 holding registers 0..9:', holding.data);

  // 2. Read sensor input registers concurrently with the previous-style read.
  const sensor = await masterInstance.readInputRegisters(UNITS.SENSOR, 0, 5);
  console.log('[master] FC04 input registers 0..4:', sensor.data);

  // 3. Write a setpoint and a coil in parallel (safe because MBAP tids match
  // responses to requests even when dispatched concurrently).
  const [writeReg, writeCoil] = await Promise.all([
    masterInstance.writeSingleRegister(UNITS.PROCESS, 5, 12345),
    masterInstance.writeSingleCoil(UNITS.PROCESS, 0, 1),
  ]);
  console.log('[master] FC06 wrote register 5 =', writeReg.data);
  console.log('[master] FC05 wrote coil 0 =', writeCoil.data);

  // 4. Batch write multiple registers.
  await masterInstance.writeMultipleRegisters(UNITS.PROCESS, 10, [100, 200, 300, 400, 500]);
  console.log('[master] FC16 wrote registers 10..14');

  // 5. Verify the writes by reading the affected range.
  const afterWrite = await masterInstance.readHoldingRegisters(UNITS.PROCESS, 0, 15);
  console.log('[master] FC03 holding registers 0..14 after writes:', afterWrite.data);

  // 6. Demonstrate local access control: this request is rejected by the
  // master-side authorizer before it is encoded or sent.
  try {
    const outOfRange = ADDRESS_RANGES.holdingRegisters.end + 1;
    await masterInstance.readHoldingRegisters(UNITS.PROCESS, outOfRange, 1);
    console.log('[master] unexpectedly passed out-of-range read');
  } catch (e) {
    if (e instanceof ModbusError && e.code === ErrorCode.ILLEGAL_DATA_ADDRESS) {
      console.log('[master] out-of-range read rejected locally with ILLEGAL_DATA_ADDRESS');
    } else {
      console.log('[master] out-of-range read rejected:', (e as Error).message);
    }
  }

  // 7. Demonstrate handling a slave-side exception by reading an unmapped unit.
  try {
    await masterInstance.readHoldingRegisters(99, 0, 1);
    console.log('[master] unexpectedly read from unmapped unit 99');
  } catch (e) {
    console.log('[master] unit 99 rejected:', (e as Error).message);
  }

  console.log('\n[master] demo workload completed successfully');

  // In a long-running application you would keep the connection open. For the
  // demo we close cleanly after the sequence finishes.
  stop();
}

/**
 * Stop the master, cancel pending reconnects, and exit.
 */
function stop(): void {
  if (shutdownRequested) {
    return;
  }
  shutdownRequested = true;

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  master?.destroy();
  master = null;

  physical.close(() => {
    console.log('[master] stopped');
    process.exit(0);
  });
}

// Graceful shutdown on Ctrl+C.
process.on('SIGINT', () => {
  console.log('\n[master] stopping...');
  stop();
});

start();
