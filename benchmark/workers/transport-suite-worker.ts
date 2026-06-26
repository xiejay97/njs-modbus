/**
 * Transport throughput benchmark worker.
 *
 * Forked by `bench-transport-suite.ts`. Measures FC03 readHoldingRegisters for one
 * (mode, transport, library) cell using the adapter registry so each library
 * is exercised through the same adapter contract.
 */

import type { ModbusQueueStrategy } from '#njs-modbus';
import type { ClientHandle, LibraryAdapter } from '../adapters/types';
import type { MacroBenchmarkResult } from '../macro';

import { resolve } from '../adapters/registry';
import { runMacro } from '../macro';

type Mode = 'sequential' | 'multiconn';
type Transport = 'tcp' | 'rtu' | 'ascii';

const mode = process.env['TRANSPORT_BENCH_MODE'] as Mode;
const transport = process.env['TRANSPORT_BENCH_TRANSPORT'] as Transport;
const library = process.env['TRANSPORT_BENCH_LIBRARY'];
const durationMs = Number(process.env['TRANSPORT_BENCH_DURATION'] ?? '30000');
const connections = Number(process.env['TRANSPORT_BENCH_CONNECTIONS'] ?? '1');
const port = Number(process.env['TRANSPORT_BENCH_PORT'] ?? '0');
const masterPath = process.env['TRANSPORT_BENCH_MASTER_PATH'] ?? '';
const slavePath = process.env['TRANSPORT_BENCH_SLAVE_PATH'] ?? '';
const label = process.env['TRANSPORT_BENCH_LABEL'] ?? `${mode}/${transport}/${library}`;

const REQ_LEN = 50;
const BAUD = 115200;
const BYTE_TIME_US = 10_000_000 / BAUD;
const MIN_RTT_RTU_US = (8 + 105) * BYTE_TIME_US; // ~9.8ms
const MIN_RTT_ASCII_US = (1 + 2 * 8 + 1 + 1 + 2 * 105 + 2 + 1) * BYTE_TIME_US; // ~20.5ms

function minRttFor(t: Transport): number {
  if (t === 'rtu') {
    return MIN_RTT_RTU_US;
  }
  if (t === 'ascii') {
    return MIN_RTT_ASCII_US;
  }
  return 0;
}

async function enforceMinRtt(rttUs: number, minUs: number): Promise<void> {
  if (rttUs >= minUs || minUs === 0) {
    return;
  }
  const remainUs = minUs - rttUs;
  if (remainUs >= 4000) {
    await new Promise<void>((resolve) => setTimeout(resolve, remainUs / 1000));
    return;
  }
  await new Promise<void>((resolve) => {
    setImmediate(() => {
      const target = process.hrtime.bigint() + BigInt(Math.ceil(remainUs * 1000));
      while (process.hrtime.bigint() < target) {
        /* spin */
      }
      resolve();
    });
  });
}

function scaleResult(result: MacroBenchmarkResult, mode: Mode): void {
  if (mode === 'multiconn' && connections > 1) {
    result.opsPerSecond *= connections;
    result.iterations *= connections;
  }
}

async function createServer(adapter: LibraryAdapter): Promise<{ server: unknown; close: () => Promise<void> }> {
  if (transport === 'tcp') {
    const queueStrategy: ModbusQueueStrategy = mode === 'multiconn' ? 'concurrent' : 'fifo';
    const handle = await adapter.createTcpServer(port, { unitId: 1, queueStrategy });
    return { server: handle, close: () => handle.close() };
  }
  const handle = await adapter.createSerialServer(slavePath, transport.toUpperCase() as 'RTU' | 'ASCII', {
    unitId: 1,
  });
  return { server: handle, close: () => handle.close() };
}

async function createClients(adapter: LibraryAdapter): Promise<{ clients: ClientHandle[]; close: () => Promise<void> }> {
  const masterCount = mode === 'multiconn' ? connections : 1;
  const queueStrategy: ModbusQueueStrategy = mode === 'multiconn' ? 'concurrent' : 'fifo';
  const clients: ClientHandle[] = [];

  for (let i = 0; i < masterCount; i++) {
    if (transport === 'tcp') {
      clients.push(await adapter.createTcpClient(port, { queueStrategy, timeout: 1000 }));
    } else {
      clients.push(await adapter.createSerialClient(masterPath, transport.toUpperCase() as 'RTU' | 'ASCII', { timeout: 1000 }));
    }
  }

  return {
    clients,
    close: async () => {
      await Promise.all(clients.map((c) => c.close()));
    },
  };
}

async function run(): Promise<MacroBenchmarkResult> {
  if (!library) {
    throw new Error('TRANSPORT_BENCH_LIBRARY is required');
  }

  const adapter = await resolve(library);
  const { close: closeServer } = await createServer(adapter);
  const { clients, close: closeClients } = await createClients(adapter);

  try {
    let fn: () => Promise<unknown>;
    if (mode === 'sequential') {
      const client = clients[0];
      fn = () => adapter.readHoldingRegisters(client, 0, REQ_LEN);
    } else {
      const multiconnPromises: Promise<unknown>[] = new Array(clients.length);
      fn = () => {
        for (let i = 0; i < clients.length; i++) {
          multiconnPromises[i] = adapter.readHoldingRegisters(clients[i], 0, REQ_LEN);
        }
        return Promise.all(multiconnPromises);
      };
    }

    const minRtt = minRttFor(transport);
    const result = await runMacro({
      name: label,
      fn,
      durationMs,
      warmupIterations: transport === 'tcp' ? 100 : 50,
      afterEach: minRtt > 0 ? (latencyMs) => enforceMinRtt(latencyMs * 1000, minRtt) : undefined,
      onError: transport !== 'tcp' ? () => true : undefined,
    });

    scaleResult(result, mode);
    return result;
  } finally {
    await closeClients();
    await closeServer();
  }
}

(async () => {
  if (!process.send) {
    console.error('This worker must run inside a forked child process');
    process.exit(1);
  }
  try {
    const result = await run();
    process.send(result, () => process.exit(0));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    process.send({ error: message }, () => process.exit(1));
  }
})();
