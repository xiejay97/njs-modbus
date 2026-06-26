/**
 * @note These tests use real `node:tls` sockets and the embedded test
 * certificates from `test/helpers/tls-certs.ts`.
 */

import type { AbstractPipelineLayer } from 'njs-modbus';

import { ModbusMaster, ModbusSlave, TlsClientPhysicalLayer, TlsServerPhysicalLayer } from 'njs-modbus';
import { describe, expect, it } from 'vitest';

import { CA_CERT, CLIENT_CERT, CLIENT_KEY, SERVER_CERT, SERVER_KEY, WRONG_CA_CERT } from './helpers/tls-certs';
import { flushPromises } from './helpers/utils';

const SERVER_TLS_OPTIONS = { cert: SERVER_CERT, key: SERVER_KEY };
const CLIENT_TLS_OPTIONS = { ca: CA_CERT, rejectUnauthorized: true };

describe('TLS loopback integration', () => {
  it('reads holding registers from a real TLS slave', async () => {
    const serverPhysical = new TlsServerPhysicalLayer(SERVER_TLS_OPTIONS);
    const slavePromise = new Promise<ModbusSlave<'TCP'>>((resolve) => {
      serverPhysical.once('connect', (pipeline: AbstractPipelineLayer) => {
        const slave = new ModbusSlave({
          pipelineAdapter: pipeline,
          protocol: { type: 'TCP' },
        });
        slave.addUnit(1, {
          readHoldingRegisters: (_address, _length, callback) => callback(null, [0x1234, 0x5678]),
        });
        resolve(slave);
      });
    });

    await new Promise<void>((resolve) => serverPhysical.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (serverPhysical.server?.address() as { port: number } | null)?.port ?? 0;

    const clientPhysical = new TlsClientPhysicalLayer(CLIENT_TLS_OPTIONS);
    const masterPromise = new Promise<ModbusMaster<'TCP'>>((resolve) => {
      clientPhysical.once('connect', (pipeline: AbstractPipelineLayer) => {
        const master = new ModbusMaster({
          pipelineAdapter: pipeline,
          protocol: { type: 'TCP' },
          timeout: 500,
        });
        resolve(master);
      });
    });

    await new Promise<void>((resolve) => clientPhysical.open({ port, host: '127.0.0.1' }, () => resolve()));

    const [master, slave] = await Promise.all([masterPromise, slavePromise]);
    await flushPromises();

    const response = await master.readHoldingRegisters(1, 0, 2);
    expect(response.data).toEqual([0x1234, 0x5678]);

    master.destroy();
    slave.destroy();

    await new Promise<void>((resolve) => clientPhysical.close(() => resolve()));
    await new Promise<void>((resolve) => serverPhysical.close(() => resolve()));
  });

  it('writes a single coil through a real TLS connection', async () => {
    const serverPhysical = new TlsServerPhysicalLayer(SERVER_TLS_OPTIONS);
    const slavePromise = new Promise<ModbusSlave<'TCP'>>((resolve) => {
      serverPhysical.once('connect', (pipeline: AbstractPipelineLayer) => {
        const slave = new ModbusSlave({
          pipelineAdapter: pipeline,
          protocol: { type: 'TCP' },
        });
        slave.addUnit(1, {
          writeSingleCoil: (_address, _value, callback) => callback(null),
        });
        resolve(slave);
      });
    });

    await new Promise<void>((resolve) => serverPhysical.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (serverPhysical.server?.address() as { port: number } | null)?.port ?? 0;

    const clientPhysical = new TlsClientPhysicalLayer(CLIENT_TLS_OPTIONS);
    const masterPromise = new Promise<ModbusMaster<'TCP'>>((resolve) => {
      clientPhysical.once('connect', (pipeline: AbstractPipelineLayer) => {
        const master = new ModbusMaster({
          pipelineAdapter: pipeline,
          protocol: { type: 'TCP' },
          timeout: 500,
        });
        resolve(master);
      });
    });

    await new Promise<void>((resolve) => clientPhysical.open({ port, host: '127.0.0.1' }, () => resolve()));

    const [master, slave] = await Promise.all([masterPromise, slavePromise]);
    await flushPromises();

    const response = await master.writeSingleCoil(1, 0x10, 1);
    expect(response.data).toBe(1);

    master.destroy();
    slave.destroy();

    await new Promise<void>((resolve) => clientPhysical.close(() => resolve()));
    await new Promise<void>((resolve) => serverPhysical.close(() => resolve()));
  });

  it('reads holding registers through a server with security options enabled', async () => {
    const serverPhysical = new TlsServerPhysicalLayer(SERVER_TLS_OPTIONS, {
      whitelist: ['127.0.0.1'],
      maxConnections: 2,
      maxConnectionsPerIp: 2,
      idleTimeout: 1000,
    });
    const slavePromise = new Promise<ModbusSlave<'TCP'>>((resolve) => {
      serverPhysical.once('connect', (pipeline: AbstractPipelineLayer) => {
        const slave = new ModbusSlave({
          pipelineAdapter: pipeline,
          protocol: { type: 'TCP' },
        });
        slave.addUnit(1, {
          readHoldingRegisters: (_address, _length, callback) => callback(null, [0x1234, 0x5678]),
        });
        resolve(slave);
      });
    });

    await new Promise<void>((resolve) => serverPhysical.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (serverPhysical.server?.address() as { port: number } | null)?.port ?? 0;

    const clientPhysical = new TlsClientPhysicalLayer(CLIENT_TLS_OPTIONS);
    const masterPromise = new Promise<ModbusMaster<'TCP'>>((resolve) => {
      clientPhysical.once('connect', (pipeline: AbstractPipelineLayer) => {
        const master = new ModbusMaster({
          pipelineAdapter: pipeline,
          protocol: { type: 'TCP' },
          timeout: 500,
        });
        resolve(master);
      });
    });

    await new Promise<void>((resolve) => clientPhysical.open({ port, host: '127.0.0.1' }, () => resolve()));

    const [master, slave] = await Promise.all([masterPromise, slavePromise]);
    await flushPromises();

    const response = await master.readHoldingRegisters(1, 0, 2);
    expect(response.data).toEqual([0x1234, 0x5678]);

    master.destroy();
    slave.destroy();

    await new Promise<void>((resolve) => clientPhysical.close(() => resolve()));
    await new Promise<void>((resolve) => serverPhysical.close(() => resolve()));
  });

  it('fails to connect with wrong CA certificate', async () => {
    const serverPhysical = new TlsServerPhysicalLayer(SERVER_TLS_OPTIONS);

    await new Promise<void>((resolve) => serverPhysical.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (serverPhysical.server?.address() as { port: number } | null)?.port ?? 0;

    const clientPhysical = new TlsClientPhysicalLayer({ ca: WRONG_CA_CERT, rejectUnauthorized: true });
    const err = await new Promise<Error | null>((resolve) => {
      clientPhysical.open({ port, host: '127.0.0.1' }, (e) => resolve(e));
    });

    expect(err).toBeInstanceOf(Error);

    await new Promise<void>((resolve) => serverPhysical.close(() => resolve()));
  });

  it('succeeds with client certificate authentication', async () => {
    const serverPhysical = new TlsServerPhysicalLayer({
      cert: SERVER_CERT,
      key: SERVER_KEY,
      requestCert: true,
      rejectUnauthorized: true,
      ca: CA_CERT,
    });
    const slavePromise = new Promise<ModbusSlave<'TCP'>>((resolve) => {
      serverPhysical.once('connect', (pipeline: AbstractPipelineLayer) => {
        const slave = new ModbusSlave({
          pipelineAdapter: pipeline,
          protocol: { type: 'TCP' },
        });
        slave.addUnit(1, {
          readHoldingRegisters: (_address, _length, callback) => callback(null, [0x1234, 0x5678]),
        });
        resolve(slave);
      });
    });

    await new Promise<void>((resolve) => serverPhysical.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (serverPhysical.server?.address() as { port: number } | null)?.port ?? 0;

    const clientPhysical = new TlsClientPhysicalLayer({
      cert: CLIENT_CERT,
      key: CLIENT_KEY,
      ca: CA_CERT,
      rejectUnauthorized: true,
    });
    const masterPromise = new Promise<ModbusMaster<'TCP'>>((resolve) => {
      clientPhysical.once('connect', (pipeline: AbstractPipelineLayer) => {
        const master = new ModbusMaster({
          pipelineAdapter: pipeline,
          protocol: { type: 'TCP' },
          timeout: 500,
        });
        resolve(master);
      });
    });

    await new Promise<void>((resolve) => clientPhysical.open({ port, host: '127.0.0.1' }, () => resolve()));

    const [master, slave] = await Promise.all([masterPromise, slavePromise]);
    await flushPromises();

    const response = await master.readHoldingRegisters(1, 0, 2);
    expect(response.data).toEqual([0x1234, 0x5678]);

    master.destroy();
    slave.destroy();

    await new Promise<void>((resolve) => clientPhysical.close(() => resolve()));
    await new Promise<void>((resolve) => serverPhysical.close(() => resolve()));
  });
});
