/**
 * modbus-serial adapter.
 *
 * Implements the benchmark adapter contract on top of the `modbus-serial`
 * package.
 */

import type { ClientHandle, CreateClientOptions, CreateServerOptions, LibraryAdapter, ServerHandle } from './types';

import ModbusSerial from 'modbus-serial';

import { withCleanupTimeout, withTimeout } from '../engine/timeout';

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

class ModbusSerialServerHandle implements ServerHandle {
  constructor(private readonly server: any) {}

  async close(): Promise<void> {
    await withCleanupTimeout(
      new Promise<void>((resolve) => this.server.close(() => resolve())),
      CLEANUP_TIMEOUT_MS,
      'modbus-serial server close',
    );
  }
}

class ModbusSerialClientHandle implements ClientHandle {
  constructor(public readonly client: any) {}

  async close(): Promise<void> {
    await withCleanupTimeout(
      new Promise<void>((resolve) => this.client.close(() => resolve())),
      CLEANUP_TIMEOUT_MS,
      'modbus-serial client close',
    );
  }
}

function createHoldingStore(): Uint16Array {
  const holding = new Uint16Array(65536);
  for (let i = 0; i < 65536; i++) {
    holding[i] = i & 0xffff;
  }
  return holding;
}

export class ModbusSerialAdapter implements LibraryAdapter {
  readonly name = 'modbus-serial';
  readonly capability = {
    protocols: [...CAPABILITY.protocols],
    modes: {
      TCP: [...CAPABILITY.modes.TCP],
      RTU: [...CAPABILITY.modes.RTU],
      ASCII: [...CAPABILITY.modes.ASCII],
    },
  };

  async createTcpServer(port: number, options?: CreateServerOptions): Promise<ServerHandle> {
    const holding = createHoldingStore();
    const vector = {
      getMultipleHoldingRegisters: (addr: number, length: number) => holding.subarray(addr, addr + length),
    };
    const server = new (ModbusSerial as any).ServerTCP(vector, {
      port,
      host: '127.0.0.1',
      unitID: options?.unitId ?? 1,
    });
    void server;
    // ServerTCP has no 'initialized' event; blind wait matches legacy harness.
    await new Promise<void>((resolve) => setTimeout(resolve, 50));
    return new ModbusSerialServerHandle(server);
  }

  async createTcpClient(port: number, options?: CreateClientOptions): Promise<ClientHandle> {
    const client = new ModbusSerial();
    client.setID(1);
    client.setTimeout(options?.timeout ?? DEFAULT_TIMEOUT);
    await withTimeout(client.connectTCP('127.0.0.1', { port }), CONNECT_TIMEOUT_MS, 'modbus-serial TCP client connect');
    return new ModbusSerialClientHandle(client);
  }

  async createSerialServer(path: string, protocol: 'RTU' | 'ASCII', _options?: CreateServerOptions): Promise<ServerHandle> {
    const holding = createHoldingStore();
    const vector = {
      getMultipleHoldingRegisters: (addr: number, length: number) => holding.subarray(addr, addr + length),
    };
    const Ctor = ModbusSerial as any;

    if (protocol === 'ASCII') {
      const ServerSerial = Ctor.ServerSerial;
      if (!ServerSerial) {
        throw new Error('modbus-serial does not support serial server');
      }
      const server = new ServerSerial(vector, { path, baudRate: BAUD_RATE });
      await withTimeout(
        new Promise<void>((resolve) => server.once('initialized', resolve)),
        CONNECT_TIMEOUT_MS,
        `modbus-serial ${protocol} server initialized`,
      );
      return new ModbusSerialServerHandle(server);
    }

    const server = new Ctor.ServerSerial(vector, { path, baudRate: BAUD_RATE });
    await withTimeout(
      new Promise<void>((resolve) => server.once('initialized', resolve)),
      CONNECT_TIMEOUT_MS,
      `modbus-serial ${protocol} server initialized`,
    );
    return new ModbusSerialServerHandle(server);
  }

  async createSerialClient(path: string, protocol: 'RTU' | 'ASCII', options?: CreateClientOptions): Promise<ClientHandle> {
    const client = new ModbusSerial();
    if (protocol === 'ASCII') {
      await withTimeout(client.connectAsciiSerial(path, { baudRate: BAUD_RATE }), CONNECT_TIMEOUT_MS, 'modbus-serial ASCII client open');
    } else {
      await withTimeout(client.connectRTU(path, { baudRate: BAUD_RATE }), CONNECT_TIMEOUT_MS, 'modbus-serial RTU client open');
    }
    client.setID(1);
    client.setTimeout(options?.timeout ?? DEFAULT_TIMEOUT);
    return new ModbusSerialClientHandle(client);
  }

  async readHoldingRegisters(client: ClientHandle, address: number, quantity: number): Promise<unknown> {
    const c = client as ModbusSerialClientHandle;
    return new Promise((resolve, reject) => {
      c.client.readHoldingRegisters(address, quantity, (err: any, data: any) => {
        if (err) {
          reject(err);
        } else {
          resolve(data);
        }
      });
    });
  }
}

export function createModbusSerialAdapter(): LibraryAdapter {
  return new ModbusSerialAdapter();
}
