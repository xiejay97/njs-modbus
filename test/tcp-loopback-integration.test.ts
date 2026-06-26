import type { AbstractPipelineLayer } from 'njs-modbus';

import { ModbusMaster, ModbusSlave, TcpClientPhysicalLayer, TcpServerPhysicalLayer } from 'njs-modbus';

import { flushPromises } from '#test/helpers/utils';

describe('TCP loopback integration', () => {
  it('reads holding registers from a real TCP slave', async () => {
    const serverPhysical = new TcpServerPhysicalLayer();
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

    const clientPhysical = new TcpClientPhysicalLayer();
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

  it('writes a single coil through a real TCP connection', async () => {
    const serverPhysical = new TcpServerPhysicalLayer();
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

    const clientPhysical = new TcpClientPhysicalLayer();
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
    const serverPhysical = new TcpServerPhysicalLayer(undefined, {
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

    const clientPhysical = new TcpClientPhysicalLayer();
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
