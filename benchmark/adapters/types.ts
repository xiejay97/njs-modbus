import type { ModbusQueueStrategy } from '#njs-modbus';

/**
 * Library adapter contracts.
 *
 * Decouples the benchmark core from concrete Modbus library implementations.
 * Every supported library provides an adapter factory registered in
 * `registry.ts`. The core engine only manipulates opaque `ServerHandle` /
 * `ClientHandle` objects and calls adapter operations on them.
 */

/** Supported Modbus transports. */
export type Protocol = 'TCP' | 'RTU' | 'ASCII';

/** Benchmark execution modes. */
export type BenchMode = 'sequential' | 'multiconn';

/** Opaque server handle — implementations attach library-specific state. */
export interface ServerHandle {
  /** Release server resources. */
  close: () => Promise<void>;
}

/** Opaque client handle — implementations attach library-specific state. */
export interface ClientHandle {
  /** Release client resources. */
  close: () => Promise<void>;
}

/** Minimal decoded frame shape returned by codec adapters. */
export interface CodecFrame {
  unit: number;
  fc: number;
  data: Buffer;
  transaction?: number;
}

/** Optional codec micro-benchmark capability for a library adapter. */
export interface CodecAdapter {
  encodeTcpRequest: (unit: number, fc: number, data: Buffer) => Buffer;
  encodeTcpResponse: (unit: number, fc: number, data: Buffer) => Buffer;
  decodeTcpRequest: (buffer: Buffer) => CodecFrame | null;
  decodeTcpResponse: (buffer: Buffer) => CodecFrame | null;

  encodeRtuRequest: (unit: number, fc: number, data: Buffer) => Buffer;
  encodeRtuResponse: (unit: number, fc: number, data: Buffer) => Buffer;
  decodeRtuRequest: (buffer: Buffer) => CodecFrame | null;
  decodeRtuResponse: (buffer: Buffer) => CodecFrame | null;

  encodeAsciiRequest: (unit: number, fc: number, data: Buffer) => Buffer;
  encodeAsciiResponse: (unit: number, fc: number, data: Buffer) => Buffer;
  decodeAsciiRequest: (buffer: Buffer) => CodecFrame | null;
  decodeAsciiResponse: (buffer: Buffer) => CodecFrame | null;
}

/** Options for creating a server. */
export interface CreateServerOptions {
  /** Server unit ID. Defaults to library-specific value. */
  unitId?: number;
  /** ADU queue strategy (njs-modbus only). */
  queueStrategy?: ModbusQueueStrategy;
}

/** Options for creating a client. */
export interface CreateClientOptions {
  /** ADU queue strategy (njs-modbus only). */
  queueStrategy?: ModbusQueueStrategy;
  /** Request timeout in milliseconds. */
  timeout?: number;
}

/** Capability mask advertised by an adapter. */
export interface AdapterCapability {
  /** Transport protocols this adapter can speak. */
  protocols: Protocol[];
  /**
   * Benchmark modes supported per protocol.
   * Missing protocol means "only sequential".
   */
  modes?: Partial<Record<Protocol, BenchMode[]>>;
}

/**
 * Minimal surface needed by transport and chaos benchmarks.
 *
 * Implementations own all library-specific lifecycle and state; the core
 * engine only sees opaque `ServerHandle` / `ClientHandle` objects.
 */
export interface LibraryAdapter {
  readonly name: string;
  readonly capability: AdapterCapability;

  createTcpServer: (port: number, options?: CreateServerOptions) => Promise<ServerHandle>;
  createTcpClient: (port: number, options?: CreateClientOptions) => Promise<ClientHandle>;

  createSerialServer: (path: string, protocol: 'RTU' | 'ASCII', options?: CreateServerOptions) => Promise<ServerHandle>;
  createSerialClient: (path: string, protocol: 'RTU' | 'ASCII', options?: CreateClientOptions) => Promise<ClientHandle>;

  readHoldingRegisters: (client: ClientHandle, address: number, quantity: number) => Promise<unknown>;

  /** Optional codec micro-benchmark capability. */
  codec?: CodecAdapter;
}
