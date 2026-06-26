/**
 * jsmodbus adapter.
 *
 * Implements the benchmark adapter contract on top of the `jsmodbus` package.
 */

import type { ClientHandle, CreateClientOptions, CreateServerOptions, LibraryAdapter, ServerHandle } from './types';

import net from 'node:net';

import jsmodbus from 'jsmodbus';

import { withCleanupTimeout, withTimeout } from '../engine/timeout';

const DEFAULT_TIMEOUT = 1000;
const CONNECT_TIMEOUT_MS = 10000;
const CLEANUP_TIMEOUT_MS = 10000;
const BAUD_RATE = 115200;

const CAPABILITY = {
  protocols: ['TCP', 'RTU'] as const,
  modes: {
    TCP: ['sequential', 'multiconn'] as const,
    RTU: ['sequential'] as const,
  },
};

class JsmodbusServerHandle implements ServerHandle {
  constructor(
    private readonly server: net.Server,
    private readonly sockets: Set<net.Socket>,
  ) {}

  async close(): Promise<void> {
    await withCleanupTimeout(
      new Promise<void>((resolve) => this.server.close(() => resolve())),
      CLEANUP_TIMEOUT_MS,
      'jsmodbus TCP server close',
      () => {
        for (const socket of this.sockets) {
          try {
            socket.destroy();
          } catch {
            /* ignore */
          }
        }
      },
    );
  }
}

class JsmodbusClientHandle implements ClientHandle {
  constructor(
    public readonly client: any,
    private readonly socket: net.Socket,
  ) {}

  async close(): Promise<void> {
    this.socket.destroy();
  }
}

class JsmodbusSerialServerHandle implements ServerHandle {
  constructor(private readonly port: any) {}

  async close(): Promise<void> {
    await withCleanupTimeout(
      new Promise<void>((resolve) => this.port.close(() => resolve())),
      CLEANUP_TIMEOUT_MS,
      'jsmodbus serial server close',
    );
  }
}

class JsmodbusSerialClientHandle implements ClientHandle {
  constructor(
    public readonly client: any,
    private readonly port: any,
  ) {}

  async close(): Promise<void> {
    await withCleanupTimeout(
      new Promise<void>((resolve) => this.port.close(() => resolve())),
      CLEANUP_TIMEOUT_MS,
      'jsmodbus serial client close',
    );
  }
}

function createHoldingBuffer(): Buffer {
  const holding = Buffer.alloc(1024);
  for (let i = 0; i < 125; i++) {
    holding.writeUInt16BE(i, i * 2);
  }
  return holding;
}

export class JsmodbusAdapter implements LibraryAdapter {
  readonly name = 'jsmodbus';
  readonly capability = {
    protocols: [...CAPABILITY.protocols],
    modes: {
      TCP: [...CAPABILITY.modes.TCP],
      RTU: [...CAPABILITY.modes.RTU],
    },
  };

  async createTcpServer(port: number, _options?: CreateServerOptions): Promise<ServerHandle> {
    const holding = createHoldingBuffer();
    const sockets = new Set<net.Socket>();
    const netServer = new net.Server((socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    const server = new jsmodbus.server.TCP(netServer, { holding });
    void server;
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        netServer.once('error', reject);
        netServer.listen(port, '127.0.0.1', () => {
          netServer.off('error', reject);
          resolve();
        });
      }),
      CONNECT_TIMEOUT_MS,
      'jsmodbus TCP server listen',
    );
    return new JsmodbusServerHandle(netServer, sockets);
  }

  async createTcpClient(port: number, _options?: CreateClientOptions): Promise<ClientHandle> {
    const socket = new net.Socket();
    const client = new jsmodbus.client.TCP(socket, 1, DEFAULT_TIMEOUT);
    await withTimeout(
      new Promise<void>((resolve, reject) => {
        socket.once('error', reject);
        socket.connect({ port, host: '127.0.0.1' }, () => {
          socket.off('error', reject);
          resolve();
        });
      }),
      CONNECT_TIMEOUT_MS,
      'jsmodbus TCP client connect',
    );
    return new JsmodbusClientHandle(client, socket);
  }

  async createSerialServer(path: string, protocol: 'RTU' | 'ASCII', _options?: CreateServerOptions): Promise<ServerHandle> {
    const { SerialPort } = await import('serialport');
    const holding = createHoldingBuffer();
    const slavePort = new SerialPort({ path, baudRate: BAUD_RATE, autoOpen: false });
    await withTimeout(
      new Promise<void>((resolve, reject) => slavePort.open((err: Error | null) => (err ? reject(err) : resolve()))),
      CONNECT_TIMEOUT_MS,
      `jsmodbus ${protocol} server open`,
    );

    if (protocol === 'ASCII') {
      const ServerClass = (jsmodbus.server as any).ASCII;
      if (!ServerClass) {
        throw new Error('jsmodbus does not support ASCII server');
      }
      const server = new ServerClass(slavePort, { holding });
      void server;
    } else {
      const server = new jsmodbus.server.RTU(slavePort, { holding });
      void server;
    }

    return new JsmodbusSerialServerHandle(slavePort);
  }

  async createSerialClient(path: string, protocol: 'RTU' | 'ASCII', _options?: CreateClientOptions): Promise<ClientHandle> {
    const { SerialPort } = await import('serialport');
    const masterPort = new SerialPort({ path, baudRate: BAUD_RATE, autoOpen: false });
    await withTimeout(
      new Promise<void>((resolve, reject) => masterPort.open((err: Error | null) => (err ? reject(err) : resolve()))),
      CONNECT_TIMEOUT_MS,
      `jsmodbus ${protocol} client open`,
    );

    // jsmodbus serial client is RTU-only; match legacy transport-suite behaviour.
    void protocol;
    const client = new jsmodbus.client.RTU(masterPort, 1, DEFAULT_TIMEOUT);
    return new JsmodbusSerialClientHandle(client, masterPort);
  }

  async readHoldingRegisters(client: ClientHandle, address: number, quantity: number): Promise<unknown> {
    const c = client as JsmodbusClientHandle | JsmodbusSerialClientHandle;
    return c.client.readHoldingRegisters(address, quantity);
  }
}

export function createJsmodbusAdapter(): LibraryAdapter {
  return new JsmodbusAdapter();
}
