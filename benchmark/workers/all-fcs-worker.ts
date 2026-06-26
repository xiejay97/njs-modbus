/**
 * All-function-code end-to-end benchmark worker.
 *
 * Runs a single (FC, library) pair in a worker thread on a dedicated TCP port.
 * Each library sets up its own loopback server + client and invokes the
 * function code matching `workerData.fc` in a tight sequential loop.
 */

import type { AbstractPipelineLayer } from '#njs-modbus';
import type { MacroBenchmarkResult } from '../macro';

import net from 'node:net';
import v8 from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';

import jsmodbus from 'jsmodbus';
import ModbusSerial from 'modbus-serial';

import { withCleanupTimeout, withTimeout } from '../engine/timeout';
import { runMacro } from '../macro';

import { ModbusMaster, ModbusSlave, TcpClientPhysicalLayer, TcpServerPhysicalLayer } from '#njs-modbus';

const CONNECT_TIMEOUT_MS = 10000;
const CLEANUP_TIMEOUT_MS = 10000;

type Library = 'njs-modbus' | 'modbus-serial' | 'jsmodbus';

interface WorkerInput {
  fc: string;
  library: Library;
  port: number;
  durationMs: number;
  maxPayload?: boolean;
}

// Expose global.gc() inside this worker thread so runMacro can force GC before
// measurement. Worker threads do not inherit --expose-gc from execArgv.
v8.setFlagsFromString('--expose_gc');

const { fc, library, port, durationMs, maxPayload = false } = workerData as WorkerInput;

const QTY_COILS = maxPayload ? 2000 : 100;
const QTY_REGS = maxPayload ? 125 : 50;
const QTY_WRITE_COILS = maxPayload ? 1968 : 100;
const QTY_WRITE_REGS = maxPayload ? 123 : 50;
const QTY_RW_WRITE = maxPayload ? 121 : 25;

const coilArray = new Uint8Array(QTY_WRITE_COILS);
for (let i = 0; i < QTY_WRITE_COILS; i++) {
  coilArray[i] = i % 2;
}
const regArray: number[] = Array.from({ length: QTY_WRITE_REGS }, (_, i) => i & 0xffff);
const rwArray: number[] = Array.from({ length: QTY_RW_WRITE }, (_, i) => i & 0xffff);

const COIL_COUNT = 65536;
const REG_COUNT = 65536;

const coilStore = new Uint8Array(COIL_COUNT);
const inputStore = new Uint8Array(COIL_COUNT);
const holdingStore = new Uint16Array(REG_COUNT);
const inputRegStore = new Uint16Array(REG_COUNT);

for (let i = 0; i < COIL_COUNT; i++) {
  coilStore[i] = i & 1;
  inputStore[i] = (i + 1) & 1;
}
for (let i = 0; i < REG_COUNT; i++) {
  holdingStore[i] = i & 0xffff;
  inputRegStore[i] = (i * 2) & 0xffff;
}

// ---------------------------------------------------------------------------
// njs-modbus
// ---------------------------------------------------------------------------

const NJS_EMPTY_BUF = Buffer.alloc(0);
const NJS_SERVER_ID = {
  serverId: new Uint8Array([0x42]),
  runIndicatorStatus: true,
  additionalData: NJS_EMPTY_BUF,
};
const NJS_DEVICE_ID: Record<number, string> = {
  0x00: 'njs-modbus',
  0x01: 'benchmark',
  0x02: '0.0.0',
};
const NJS_FC23_READ = { address: 0, length: QTY_REGS };
const NJS_FC23_WRITE = { address: 0, value: rwArray };

function waitForPipeline(
  physicalLayer: TcpServerPhysicalLayer | TcpClientPhysicalLayer,
  open: (cb: (err: Error | null) => void) => void,
): Promise<AbstractPipelineLayer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onConnect = (pipeline: AbstractPipelineLayer) => {
      if (settled) {
        return;
      }
      settled = true;
      physicalLayer.off('error', onError);
      resolve(pipeline);
    };
    const onError = (err: Error) => {
      if (settled) {
        return;
      }
      settled = true;
      physicalLayer.off('connect', onConnect);
      reject(err);
    };
    physicalLayer.once('connect', onConnect);
    physicalLayer.once('error', onError);
    open((err) => {
      if (err) {
        onError(err);
      }
    });
  });
}

function openTcpServer(physicalLayer: TcpServerPhysicalLayer): Promise<void> {
  return new Promise((resolve, reject) => {
    physicalLayer.open({ port, host: '127.0.0.1' }, (err) => {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
}

function createNjsModbusSlave(physicalLayer: TcpServerPhysicalLayer): Promise<ModbusSlave<'TCP'>> {
  return new Promise((resolve, reject) => {
    const onConnect = (pipeline: AbstractPipelineLayer) => {
      physicalLayer.off('error', onError);
      const slave = new ModbusSlave({
        pipelineAdapter: pipeline,
        protocol: { type: 'TCP' },
        queueStrategy: 'fifo',
      });

      slave.addUnit(1, {
        readCoils: (address: number, length: number, callback) => {
          callback(null, coilStore.subarray(address, address + length) as ArrayLike<0 | 1>);
        },
        readDiscreteInputs: (address: number, length: number, callback) => {
          callback(null, inputStore.subarray(address, address + length) as ArrayLike<0 | 1>);
        },
        readHoldingRegisters: (address: number, length: number, callback) => {
          callback(null, holdingStore.subarray(address, address + length));
        },
        readInputRegisters: (address: number, length: number, callback) => {
          callback(null, inputRegStore.subarray(address, address + length));
        },
        writeSingleCoil: (address: number, value: number, callback) => {
          coilStore[address] = value;
          callback(null);
        },
        writeMultipleCoils: (address: number, value: (0 | 1)[], callback) => {
          for (let i = 0; i < value.length; i++) {
            coilStore[address + i] = value[i] ?? 0;
          }
          callback(null);
        },
        writeSingleRegister: (address: number, value: number, callback) => {
          holdingStore[address] = value;
          callback(null);
        },
        writeMultipleRegisters: (address: number, value: number[], callback) => {
          holdingStore.set(value, address);
          callback(null);
        },
        maskWriteRegister: (address: number, andMask: number, orMask: number, callback) => {
          holdingStore[address] = (holdingStore[address] & andMask) | (orMask & ~andMask);
          callback(null);
        },
        reportServerId: (callback) => {
          callback(null, NJS_SERVER_ID);
        },
        diagnosticsReturnQueryData: (_data, callback) => {
          callback(null);
        },
        readDeviceIdentification: (callback) => {
          callback(null, NJS_DEVICE_ID);
        },
      });

      resolve(slave);
    };
    const onError = (err: Error) => {
      physicalLayer.off('connect', onConnect);
      reject(err);
    };
    physicalLayer.once('connect', onConnect);
    physicalLayer.once('error', onError);
  });
}

function createNjsModbusMaster(): Promise<{ master: ModbusMaster<'TCP'>; physicalLayer: TcpClientPhysicalLayer }> {
  const physicalLayer = new TcpClientPhysicalLayer();

  return waitForPipeline(physicalLayer, (cb) => physicalLayer.open({ port, host: '127.0.0.1' }, cb)).then((pipeline) => {
    const master = new ModbusMaster({
      pipelineAdapter: pipeline,
      protocol: { type: 'TCP' },
      queueStrategy: 'fifo',
      timeout: 1000,
    });
    return { master, physicalLayer };
  });
}

async function setupNjsModbus(): Promise<{
  slave: ModbusSlave<'TCP'>;
  master: ModbusMaster<'TCP'>;
  slavePhysical: TcpServerPhysicalLayer;
  masterPhysical: TcpClientPhysicalLayer;
}> {
  const slavePhysical = new TcpServerPhysicalLayer();
  await openTcpServer(slavePhysical);

  const slavePromise = createNjsModbusSlave(slavePhysical);
  const masterPromise = createNjsModbusMaster();

  const [slave, { master, physicalLayer: masterPhysical }] = await Promise.all([slavePromise, masterPromise]);

  return { slave, master, slavePhysical, masterPhysical };
}

const njsOps: Record<string, (m: ModbusMaster<'TCP'>) => Promise<unknown>> = {
  fc01_read_coils: (m) => m.readCoils(1, 0, QTY_COILS),
  fc02_read_discrete_inputs: (m) => m.readDiscreteInputs(1, 0, QTY_COILS),
  fc03_read_holding_registers: (m) => m.readHoldingRegisters(1, 0, QTY_REGS),
  fc04_read_input_registers: (m) => m.readInputRegisters(1, 0, QTY_REGS),
  fc05_write_single_coil: (m) => m.writeSingleCoil(1, 0, 1),
  fc06_write_single_register: (m) => m.writeSingleRegister(1, 0, 0x1234),
  fc08_00_diagnostics_return_query_data: (m) => m.diagnosticsReturnQueryData(1, 0xabcd),
  fc15_write_multiple_coils: (m) => m.writeMultipleCoils(1, 0, coilArray as ArrayLike<0 | 1>),
  fc16_write_multiple_registers: (m) => m.writeMultipleRegisters(1, 0, regArray),
  fc17_report_server_id: (m) => m.reportServerId(1),
  fc22_mask_write_register: (m) => m.maskWriteRegister(1, 0, 0xf0f0, 0x0a0a),
  fc23_read_write_multiple_registers: (m) => m.readAndWriteMultipleRegisters(1, NJS_FC23_READ, NJS_FC23_WRITE),
  fc43_read_device_identification: (m) => m.readDeviceIdentification(1, 0x01, 0x00),
};

async function runNjsModbus(fcName: string): Promise<MacroBenchmarkResult> {
  const op = njsOps[fcName];
  if (!op) {
    throw new Error(`njs-modbus has no op for ${fcName}`);
  }

  const { slave, master, slavePhysical, masterPhysical } = await setupNjsModbus();

  try {
    return await runMacro({
      name: library,
      fn: () => op(master),
      durationMs,
      warmupIterations: 200,
    });
  } finally {
    await withCleanupTimeout(
      new Promise<void>((resolve) => {
        master.destroy();
        masterPhysical.close(() => resolve());
      }),
      CLEANUP_TIMEOUT_MS,
      'all-fcs njs-modbus client close',
    );
    await withCleanupTimeout(
      new Promise<void>((resolve) => {
        slave.destroy();
        slavePhysical.close(() => resolve());
      }),
      CLEANUP_TIMEOUT_MS,
      'all-fcs njs-modbus server close',
    );
  }
}

// ---------------------------------------------------------------------------
// modbus-serial
// ---------------------------------------------------------------------------

const MS_DEVICE_ID: Record<number, string> = {
  0x00: 'njs-modbus',
  0x01: 'benchmark',
  0x02: '0.0.0',
};
const MS_SERVER_ID_BUF = Buffer.from([0x42, 0xff]);

function callbackToPromise<T>(fn: (cb: (err: unknown, data: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    fn((err, data) => (err ? reject(err) : resolve(data)));
  });
}

function buildModbusSerialVector(): Record<string, unknown> {
  return {
    getCoil: (addr: number) => coilStore[addr] === 1,
    getDiscreteInput: (addr: number) => inputStore[addr] === 1,
    getHoldingRegister: (addr: number) => holdingStore[addr],
    getMultipleHoldingRegisters: (addr: number, length: number) => holdingStore.subarray(addr, addr + length),
    getInputRegister: (addr: number) => inputRegStore[addr],
    getMultipleInputRegisters: (addr: number, length: number) => inputRegStore.subarray(addr, addr + length),
    setCoil: (addr: number, value: boolean) => {
      coilStore[addr] = value ? 1 : 0;
    },
    setRegister: (addr: number, value: number) => {
      holdingStore[addr] = value;
    },
    setCoilArray: (addr: number, values: boolean[]) => {
      for (let i = 0; i < values.length; i++) {
        coilStore[addr + i] = values[i] ? 1 : 0;
      }
    },
    setRegisterArray: (addr: number, values: number[]) => {
      holdingStore.set(values, addr);
    },
    readDeviceIdentification: () => MS_DEVICE_ID,
    reportServerID: () => MS_SERVER_ID_BUF,
  };
}

async function runModbusSerial(fcName: string): Promise<MacroBenchmarkResult> {
  const vector = buildModbusSerialVector();
  interface ServerLike {
    on: (event: string, handler: () => void) => void;
    close: (cb?: () => void) => void;
  }
  const server = new (ModbusSerial as unknown as { ServerTCP: new (...args: unknown[]) => ServerLike }).ServerTCP(vector, {
    port,
    host: '127.0.0.1',
    unitID: 1,
  }) as ServerLike;
  await withTimeout(
    new Promise<void>((resolve) => server.on('initialized', resolve)),
    CONNECT_TIMEOUT_MS,
    'all-fcs modbus-serial server initialized',
  );

  const client = new ModbusSerial();
  client.setID(1);
  await withTimeout(client.connectTCP('127.0.0.1', { port }), CONNECT_TIMEOUT_MS, 'all-fcs modbus-serial client connect');
  client.setTimeout(1000);

  const ops: Record<string, () => Promise<unknown>> = {
    fc01_read_coils: () => client.readCoils(0, QTY_COILS),
    fc02_read_discrete_inputs: () => client.readDiscreteInputs(0, QTY_COILS),
    fc03_read_holding_registers: () => client.readHoldingRegisters(0, QTY_REGS),
    fc04_read_input_registers: () => client.readInputRegisters(0, QTY_REGS),
    fc05_write_single_coil: () => client.writeCoil(0, true),
    fc06_write_single_register: () => client.writeRegister(0, 0x1234),
    fc15_write_multiple_coils: () => client.writeCoils(0, coilArray as unknown as boolean[]),
    fc16_write_multiple_registers: () => client.writeRegisters(0, regArray),
    fc17_report_server_id: () => (client as unknown as { reportServerID: () => Promise<unknown> }).reportServerID(),
    fc22_mask_write_register: () => client.maskWriteRegister(0, 0xf0f0, 0x0a0a),
    fc23_read_write_multiple_registers: () => callbackToPromise((cb) => client.writeFC23(1, 0, QTY_REGS, 0, QTY_RW_WRITE, rwArray, cb)),
    fc43_read_device_identification: () => client.readDeviceIdentification(0x01, 0x00),
  };

  const op = ops[fcName];
  if (!op) {
    throw new Error(`modbus-serial has no op for ${fcName}`);
  }

  try {
    return await runMacro({
      name: library,
      fn: op,
      durationMs,
      warmupIterations: 200,
    });
  } finally {
    await withCleanupTimeout(
      new Promise<void>((resolve) => client.close(() => resolve())),
      CLEANUP_TIMEOUT_MS,
      'all-fcs modbus-serial client close',
    );
    await withCleanupTimeout(
      new Promise<void>((resolve) => server.close(() => resolve())),
      CLEANUP_TIMEOUT_MS,
      'all-fcs modbus-serial server close',
    );
  }
}

// ---------------------------------------------------------------------------
// jsmodbus
// ---------------------------------------------------------------------------

async function runJsmodbus(fcName: string): Promise<MacroBenchmarkResult> {
  const holding = Buffer.alloc(REG_COUNT * 2);
  const input = Buffer.alloc(REG_COUNT * 2);
  for (let i = 0; i < REG_COUNT; i++) {
    holding.writeUInt16BE(holdingStore[i], i * 2);
    input.writeUInt16BE(inputRegStore[i], i * 2);
  }
  const coils = Buffer.alloc(COIL_COUNT / 8);
  const discrete = Buffer.alloc(COIL_COUNT / 8);
  for (let i = 0; i < COIL_COUNT; i++) {
    if (coilStore[i]) {
      coils[i >> 3] |= 1 << (i & 7);
    }
    if (inputStore[i]) {
      discrete[i >> 3] |= 1 << (i & 7);
    }
  }

  const netServer = new net.Server();

  const modbusServer = new jsmodbus.server.TCP(netServer, { holding, input, coils, discrete });
  void modbusServer;
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      netServer.once('error', reject);
      netServer.listen(port, '127.0.0.1', () => {
        netServer.off('error', reject);
        resolve();
      });
    }),
    CONNECT_TIMEOUT_MS,
    'all-fcs jsmodbus server listen',
  );

  const socket = new net.Socket();
  const client = new jsmodbus.client.TCP(socket, 1, 5000);
  await withTimeout(
    new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.connect({ port, host: '127.0.0.1' }, () => {
        socket.off('error', reject);
        resolve();
      });
    }),
    CONNECT_TIMEOUT_MS,
    'all-fcs jsmodbus client connect',
  );

  const coilArrayBuf = Buffer.from(coilArray) as unknown as boolean[];

  const ops: Record<string, () => Promise<unknown>> = {
    fc01_read_coils: () => client.readCoils(0, QTY_COILS),
    fc02_read_discrete_inputs: () => client.readDiscreteInputs(0, QTY_COILS),
    fc03_read_holding_registers: () => client.readHoldingRegisters(0, QTY_REGS),
    fc04_read_input_registers: () => client.readInputRegisters(0, QTY_REGS),
    fc05_write_single_coil: () => client.writeSingleCoil(0, 1),
    fc06_write_single_register: () => client.writeSingleRegister(0, 0x1234),
    fc15_write_multiple_coils: () => client.writeMultipleCoils(0, coilArrayBuf),
    fc16_write_multiple_registers: () => client.writeMultipleRegisters(0, regArray),
  };

  const op = ops[fcName];
  if (!op) {
    throw new Error(`jsmodbus does not support ${fcName}`);
  }

  try {
    return await runMacro({
      name: library,
      fn: op,
      durationMs,
      warmupIterations: 200,
    });
  } finally {
    socket.destroy();
    await withCleanupTimeout(
      new Promise<void>((resolve) => netServer.close(() => resolve())),
      CLEANUP_TIMEOUT_MS,
      'all-fcs jsmodbus server close',
    );
  }
}

// ---------------------------------------------------------------------------
// Dispatch
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const runners: Record<Library, (fc: string) => Promise<MacroBenchmarkResult>> = {
    'njs-modbus': runNjsModbus,
    'modbus-serial': runModbusSerial,
    jsmodbus: runJsmodbus,
  };

  const runner = runners[library];
  if (!runner) {
    throw new Error(`Unknown library: ${library}`);
  }

  const port = parentPort;
  if (!port) {
    throw new Error('This worker must run inside a worker thread');
  }

  const result = await runner(fc);
  port.postMessage(result);
}

main().catch((err) => {
  const port = parentPort;
  if (port) {
    port.postMessage({ error: String(err?.stack ?? err) });
  } else {
    console.error(err);
    process.exit(1);
  }
});
