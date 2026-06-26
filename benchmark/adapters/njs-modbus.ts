/**
 * njs-modbus adapter.
 *
 * Implements the benchmark adapter contract on top of the local `njs-modbus`
 * package. In production benchmark runs it resolves to the built `dist/index.mjs`
 * via the `njs-modbus` subpath import declared in `benchmark/package.json`.
 */

import type { AbstractPhysicalLayer, AbstractPipelineLayer, ApplicationDataUnit } from '#njs-modbus';
import type {
  ClientHandle,
  CodecAdapter,
  CodecFrame,
  CreateClientOptions,
  CreateServerOptions,
  LibraryAdapter,
  ServerHandle,
} from './types';

import { withCleanupTimeout, withTimeout } from '../engine/timeout';

import {
  AsciiProtocolLayer,
  ModbusMaster,
  ModbusSlave,
  RtuProtocolLayer,
  SerialPhysicalLayer,
  TcpClientPhysicalLayer,
  TcpProtocolLayer,
  TcpServerPhysicalLayer,
} from '#njs-modbus';

const DEFAULT_TIMEOUT = 1000;
const CONNECT_TIMEOUT_MS = 10000;
const CLEANUP_TIMEOUT_MS = 10000;
const BAUD_RATE = 115200;

const CAPABILITY = {
  protocols: ['TCP', 'RTU', 'ASCII'] as const,
  modes: {
    TCP: ['sequential', 'multiconn'] as const,
    RTU: ['sequential'] as const,
    ASCII: ['sequential'] as const,
  },
};

class NjsServerHandle implements ServerHandle {
  constructor(
    private readonly slaves: ModbusSlave<'TCP' | 'RTU' | 'ASCII'>[],
    private readonly physicalLayer: AbstractPhysicalLayer,
  ) {}

  async close(): Promise<void> {
    await withCleanupTimeout(
      new Promise<void>((resolve) => {
        for (const slave of this.slaves) {
          slave.destroy();
        }
        this.physicalLayer.close(() => resolve());
      }),
      CLEANUP_TIMEOUT_MS,
      'njs-modbus server close',
    );
  }
}

class NjsClientHandle implements ClientHandle {
  constructor(
    public readonly master: ModbusMaster<'TCP' | 'RTU' | 'ASCII'>,
    private readonly physicalLayer: AbstractPhysicalLayer,
  ) {}

  async close(): Promise<void> {
    await withCleanupTimeout(
      new Promise<void>((resolve) => {
        this.master.destroy();
        this.physicalLayer.close(() => resolve());
      }),
      CLEANUP_TIMEOUT_MS,
      'njs-modbus client close',
    );
  }
}

function createHoldingStore(): Uint16Array {
  const registers = new Uint16Array(65536);
  for (let i = 0; i < 125; i++) {
    registers[i] = i;
  }
  return registers;
}

type FramedApplicationDataUnit = ApplicationDataUnit & { buffer: Buffer };

function toCodecFrame(frame: FramedApplicationDataUnit | null): CodecFrame | null {
  if (!frame) {
    return null;
  }
  return {
    unit: frame.unit,
    fc: frame.fc,
    data: frame.data,
    transaction: frame.transaction,
  };
}

function createTcpDecode(role: 'MASTER' | 'SLAVE'): (buffer: Buffer) => FramedApplicationDataUnit | null {
  const layer = new TcpProtocolLayer(role);
  let last: FramedApplicationDataUnit | null = null;
  layer.onFrame = (frame) => {
    last = frame;
  };
  return (buffer) => {
    last = null;
    layer.decode(buffer);
    return last;
  };
}

function createRtuDecode(role: 'MASTER' | 'SLAVE'): (buffer: Buffer) => FramedApplicationDataUnit | null {
  const layer = new RtuProtocolLayer(role);
  let last: FramedApplicationDataUnit | null = null;
  layer.onFrame = (frame) => {
    last = frame;
  };
  return (buffer) => {
    last = null;
    layer.decode(buffer);
    return last;
  };
}

function createAsciiDecode(role: 'MASTER' | 'SLAVE'): (buffer: Buffer) => FramedApplicationDataUnit | null {
  const layer = new AsciiProtocolLayer(role);
  let last: FramedApplicationDataUnit | null = null;
  layer.onFrame = (frame) => {
    last = frame;
  };
  return (buffer) => {
    last = null;
    layer.decode(buffer);
    return last;
  };
}

function createNjsCodecAdapter(): CodecAdapter {
  // Encode-side layers. Role only affects the decode state machine; the encode
  // method itself is independent of role.
  const tcpReqEncode = new TcpProtocolLayer('MASTER');
  const tcpResEncode = new TcpProtocolLayer('SLAVE');
  const rtuReqEncode = new RtuProtocolLayer('MASTER');
  const rtuResEncode = new RtuProtocolLayer('SLAVE');
  const asciiReqEncode = new AsciiProtocolLayer('MASTER');
  const asciiResEncode = new AsciiProtocolLayer('SLAVE');

  // Decode-side layers use the opposite role so frame-length prediction matches
  // the direction (request vs response).
  const tcpReqDecode = createTcpDecode('SLAVE');
  const tcpResDecode = createTcpDecode('MASTER');
  const rtuReqDecode = createRtuDecode('SLAVE');
  const rtuResDecode = createRtuDecode('MASTER');
  const asciiReqDecode = createAsciiDecode('SLAVE');
  const asciiResDecode = createAsciiDecode('MASTER');

  return {
    encodeTcpRequest: (unit, fc, data) => tcpReqEncode.encode(unit, fc, data, 1),
    encodeTcpResponse: (unit, fc, data) => tcpResEncode.encode(unit, fc, data, 1),
    decodeTcpRequest: (buffer) => toCodecFrame(tcpReqDecode(buffer)),
    decodeTcpResponse: (buffer) => toCodecFrame(tcpResDecode(buffer)),
    encodeRtuRequest: (unit, fc, data) => rtuReqEncode.encode(unit, fc, data),
    encodeRtuResponse: (unit, fc, data) => rtuResEncode.encode(unit, fc, data),
    decodeRtuRequest: (buffer) => toCodecFrame(rtuReqDecode(buffer)),
    decodeRtuResponse: (buffer) => toCodecFrame(rtuResDecode(buffer)),
    encodeAsciiRequest: (unit, fc, data) => asciiReqEncode.encode(unit, fc, data),
    encodeAsciiResponse: (unit, fc, data) => asciiResEncode.encode(unit, fc, data),
    decodeAsciiRequest: (buffer) => toCodecFrame(asciiReqDecode(buffer)),
    decodeAsciiResponse: (buffer) => toCodecFrame(asciiResDecode(buffer)),
  };
}

function waitForPipeline(
  physicalLayer: AbstractPhysicalLayer,
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

export class NjsModbusAdapter implements LibraryAdapter {
  readonly name = 'njs-modbus';
  readonly capability = {
    protocols: [...CAPABILITY.protocols],
    modes: {
      TCP: [...CAPABILITY.modes.TCP],
      RTU: [...CAPABILITY.modes.RTU],
      ASCII: [...CAPABILITY.modes.ASCII],
    },
  };

  private _codec?: CodecAdapter;

  get codec(): CodecAdapter {
    if (!this._codec) {
      this._codec = createNjsCodecAdapter();
    }
    return this._codec;
  }

  async createTcpServer(port: number, options?: CreateServerOptions): Promise<ServerHandle> {
    const registers = createHoldingStore();
    const physicalLayer = new TcpServerPhysicalLayer();

    await withTimeout(
      new Promise<void>((resolve, reject) => {
        physicalLayer.open({ port, host: '127.0.0.1' }, (err) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      }),
      CONNECT_TIMEOUT_MS,
      'njs-modbus TCP server listen',
    );

    const queueStrategy = options?.queueStrategy ?? 'fifo';
    const unitId = options?.unitId ?? 1;
    const slaves: ModbusSlave<'TCP'>[] = [];

    const addSlave = (pipeline: AbstractPipelineLayer) => {
      const slave = new ModbusSlave({
        pipelineAdapter: pipeline,
        protocol: { type: 'TCP' },
        queueStrategy,
      });
      slave.addUnit(unitId, {
        readHoldingRegisters: (address: number, length: number, callback) => {
          callback(null, Array.from(registers.subarray(address, address + length)));
        },
      });
      slaves.push(slave);
    };

    physicalLayer.on('connect', addSlave);

    return new NjsServerHandle(slaves, physicalLayer);
  }

  async createTcpClient(port: number, options?: CreateClientOptions): Promise<ClientHandle> {
    const physicalLayer = new TcpClientPhysicalLayer();

    const pipeline = await withTimeout(
      waitForPipeline(physicalLayer, (cb) => physicalLayer.open({ port, host: '127.0.0.1' }, cb)),
      CONNECT_TIMEOUT_MS,
      'njs-modbus TCP client connect',
    );

    const master = new ModbusMaster({
      pipelineAdapter: pipeline,
      protocol: { type: 'TCP' },
      queueStrategy: options?.queueStrategy ?? 'fifo',
      timeout: options?.timeout ?? DEFAULT_TIMEOUT,
    });

    return new NjsClientHandle(master, physicalLayer);
  }

  async createSerialServer(path: string, protocol: 'RTU' | 'ASCII', options?: CreateServerOptions): Promise<ServerHandle> {
    const registers = createHoldingStore();
    const physicalLayer = new SerialPhysicalLayer({ path, baudRate: BAUD_RATE });

    const pipeline = await withTimeout(
      waitForPipeline(physicalLayer, (cb) => physicalLayer.open(cb)),
      CONNECT_TIMEOUT_MS,
      `njs-modbus ${protocol} server open`,
    );

    const slave = new ModbusSlave({
      pipelineAdapter: pipeline,
      protocol: protocol === 'RTU' ? { type: 'RTU', opts: { intervalBetweenFrames: 0 } } : { type: 'ASCII' },
      queueStrategy: options?.queueStrategy ?? 'fifo',
    });

    slave.addUnit(options?.unitId ?? 1, {
      readHoldingRegisters: (address: number, length: number, callback) => {
        callback(null, Array.from(registers.subarray(address, address + length)));
      },
    });

    return new NjsServerHandle([slave], physicalLayer);
  }

  async createSerialClient(path: string, protocol: 'RTU' | 'ASCII', options?: CreateClientOptions): Promise<ClientHandle> {
    const physicalLayer = new SerialPhysicalLayer({ path, baudRate: BAUD_RATE });

    const pipeline = await withTimeout(
      waitForPipeline(physicalLayer, (cb) => physicalLayer.open(cb)),
      CONNECT_TIMEOUT_MS,
      `njs-modbus ${protocol} client open`,
    );

    const master = new ModbusMaster({
      pipelineAdapter: pipeline,
      protocol: { type: protocol },
      queueStrategy: options?.queueStrategy ?? 'fifo',
      timeout: options?.timeout ?? DEFAULT_TIMEOUT,
    });

    return new NjsClientHandle(master, physicalLayer);
  }

  async readHoldingRegisters(client: ClientHandle, address: number, quantity: number): Promise<unknown> {
    const c = client as NjsClientHandle;
    return c.master.readHoldingRegisters(1, address, quantity);
  }
}

export function createNjsModbusAdapter(): LibraryAdapter {
  return new NjsModbusAdapter();
}
