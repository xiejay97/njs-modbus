/**
 * Best-practice Modbus TCP slave / server.
 *
 * Demonstrates:
 * - Per-connection {@link ModbusSlave} instances with deterministic cleanup.
 * - Address-range access control shared with the master.
 * - Event auditing for framing errors, protocol exceptions, and access denials.
 * - A multi-unit in-memory model covering coils, discrete inputs, input
 *   registers, and holding registers.
 * - Graceful shutdown on SIGINT.
 *
 * Run: pnpm --filter njs-modbus-best-practice server
 *      (or from this directory: npx tsx slave.ts)
 */

import { ModbusSlave, TcpServerPhysicalLayer } from 'njs-modbus';

import { sharedAuthorizer } from './src/authorizer';
import { DEFAULT_HOLDING_REGISTERS, DEFAULT_INPUT_REGISTERS, SLAVE_QUEUE_STRATEGY, TCP_ENDPOINT, UNITS } from './src/config';
import { createProcessUnit, createSensorUnit } from './src/models';

const physical = new TcpServerPhysicalLayer();
const processUnit = createProcessUnit(DEFAULT_HOLDING_REGISTERS);
const sensorUnit = createSensorUnit(DEFAULT_INPUT_REGISTERS);

physical.on('connect', (pipeline) => {
  const socket = (pipeline as typeof pipeline & { socket: { remoteAddress?: string; remotePort?: number } }).socket;
  const clientInfo = `${socket.remoteAddress ?? 'unknown'}:${socket.remotePort ?? 0}`;
  console.log(`[slave] client connected from ${clientInfo}`);

  const slave = new ModbusSlave({
    pipelineAdapter: pipeline,
    protocol: { type: 'TCP' },
    queueStrategy: SLAVE_QUEUE_STRATEGY,
    // Write-range locking is only relevant for 'concurrent' slaves; keeping it
    // at the default is harmless and makes the policy explicit.
    enableWriteRangeLock: true,
  });

  // Best practice: install the same policy on the slave so the model is never
  // invoked for out-of-range or unknown-unit requests.
  slave.setAccessAuthorizer(sharedAuthorizer);

  // Register two logical units on the same TCP connection.
  slave.addUnit(UNITS.PROCESS, processUnit);
  slave.addUnit(UNITS.SENSOR, sensorUnit);

  // Audit every request rejected by the authorizer.
  slave.on('accessAudit', (event) => {
    console.warn(`[slave] access denied: ${event.type} unit=${event.unit} fc=${event.fc} tx=${event.transaction ?? 'n/a'}`);
  });

  // Log protocol-level exceptions so operators can spot malformed requests.
  slave.on('protocolException', (event) => {
    console.warn(`[slave] protocol exception: ${event.type} unit=${event.unit} fc=${event.fc} - ${event.message}`);
  });

  // Framing errors usually indicate a noisy line or non-Modbus traffic.
  slave.on('frameError', (event) => {
    console.error(`[slave] frame error: ${event.type} - ${event.message}`);
  });

  // A pipeline fault means we produced a response but could not write it.
  slave.on('pipelineFault', (event) => {
    console.error(`[slave] pipeline fault: ${event.type} unit=${event.unit} fc=${event.fc} - ${event.error.message}`);
  });

  // Clean up the slave instance when the TCP connection closes so event
  // listeners and queues are released immediately.
  pipeline.once('close', () => {
    console.log(`[slave] client disconnected ${clientInfo}`);
    slave.destroy();
  });
});

physical.on('error', (err) => {
  console.error('[slave] physical layer error:', err.message);
});

physical.open({ host: TCP_ENDPOINT.host, port: TCP_ENDPOINT.port }, (err) => {
  if (err) {
    console.error('[slave] failed to listen:', err.message);
    process.exit(1);
  }
  console.log(`[slave] listening on ${TCP_ENDPOINT.host}:${TCP_ENDPOINT.port}`);
});

// Graceful shutdown: close the server, which also destroys active pipelines.
process.on('SIGINT', () => {
  console.log('\n[slave] shutting down...');
  physical.close(() => process.exit(0));
});
