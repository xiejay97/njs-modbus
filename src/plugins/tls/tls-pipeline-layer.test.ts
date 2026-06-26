/*
 * Copyright (c) 2026 xiejay97
 *
 * Licensed under the Business Source License 1.1 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * Change Date: 2029-06-24
 *
 * On the date above, in accordance with the Change Date, the Licensed Work
 * will be made available under the Apache License, Version 2.0.
 *
 * You may obtain a copy of the License at
 *     https://mariadb.com/bsl11/
 */

/**
 * @note These tests use real `node:tls` sockets and the embedded test
 * certificates from `test/helpers/tls-certs.ts`.
 */

import type { ConnectionOptions, TLSSocket } from 'node:tls';

import { createServer, connect } from 'node:tls';

import { afterEach, describe, expect, it } from 'vitest';

import { CA_CERT, SERVER_CERT, SERVER_KEY } from '../../../test/helpers/tls-certs';
import { AbstractPhysicalLayer } from '../abstract-physical-layer';
import { PhysicalLayerState } from '../vars';
import { TlsPipelineLayer } from './tls-pipeline-layer';

class TestPhysicalLayer extends AbstractPhysicalLayer {
  private _state: PhysicalLayerState = PhysicalLayerState.CLOSED;

  get state(): PhysicalLayerState {
    return this._state;
  }

  override open(): void {
    this._state = PhysicalLayerState.OPEN;
  }

  override close(cb?: (err: Error | null) => void): void {
    this._state = PhysicalLayerState.CLOSED;
    cb?.(null);
  }
}

describe('TlsPipelineLayer', () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    const srv = server;
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      server = null;
    }
  });

  async function createConnectedSocketPair(
    serverTlsOptions?: Parameters<typeof createServer>[0],
    clientTlsOptions?: Omit<ConnectionOptions, 'port' | 'host'>,
  ): Promise<{ serverSocket: TLSSocket; client: TLSSocket; destroy: () => void }> {
    const srv = createServer(serverTlsOptions ?? { cert: SERVER_CERT, key: SERVER_KEY });
    server = srv;

    const serverSocketPromise = new Promise<TLSSocket>((resolve) => {
      srv.on('secureConnection', (socket) => resolve(socket));
    });

    await new Promise<void>((resolve) => srv.listen({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (srv.address() as { port: number }).port;

    const client = connect({
      ...clientTlsOptions,
      port,
      host: '127.0.0.1',
      ca: clientTlsOptions?.ca ?? CA_CERT,
    });

    const serverSocket = await serverSocketPromise;

    return {
      serverSocket,
      client,
      destroy: () => {
        client.destroy();
        serverSocket.destroy();
      },
    };
  }

  it('forwards data from TLSSocket to rx and data events', async () => {
    const { serverSocket, client, destroy } = await createConnectedSocketPair();

    const physicalLayer = new TestPhysicalLayer();
    const pipeline = new TlsPipelineLayer(physicalLayer, serverSocket);

    const rxPromise = new Promise<Buffer>((resolve) => pipeline.once('rx', (chunk) => resolve(chunk)));
    const dataPromise = new Promise<Buffer>((resolve) => pipeline.once('data', (chunk) => resolve(chunk)));

    client.write(Buffer.from([0x01, 0x02, 0x03]));

    const [rxChunk, dataChunk] = await Promise.all([rxPromise, dataPromise]);
    expect(rxChunk).toEqual(Buffer.from([0x01, 0x02, 0x03]));
    expect(dataChunk).toEqual(Buffer.from([0x01, 0x02, 0x03]));

    pipeline.destroy();
    destroy();
  });

  it('write emits tx on success', async () => {
    const { serverSocket, client, destroy } = await createConnectedSocketPair();

    const physicalLayer = new TestPhysicalLayer();
    const pipeline = new TlsPipelineLayer(physicalLayer, serverSocket);

    const txPromise = new Promise<Buffer>((resolve) => pipeline.once('tx', (chunk) => resolve(chunk)));
    const clientDataPromise = new Promise<Buffer>((resolve) => {
      client.once('data', (chunk) => resolve(chunk));
    });

    const data = Buffer.from([0x0a, 0x0b, 0x0c]);
    pipeline.write(data);

    const [txChunk, clientChunk] = await Promise.all([txPromise, clientDataPromise]);
    expect(txChunk).toEqual(data);
    expect(clientChunk).toEqual(data);

    pipeline.destroy();
    destroy();
  });

  it('write calls cb with error when not connected', async () => {
    const { serverSocket, destroy } = await createConnectedSocketPair();

    const physicalLayer = new TestPhysicalLayer();
    const pipeline = new TlsPipelineLayer(physicalLayer, serverSocket);

    await new Promise<void>((resolve) => pipeline.destroy(() => resolve()));

    const err = await new Promise<Error | null>((resolve) => pipeline.write(Buffer.from([0x01]), (e) => resolve(e)));
    expect(err).toEqual(expect.objectContaining({ message: 'Pipeline is not connected' }));

    destroy();
  });

  it('destroy transitions to DESTROYED and emits close', async () => {
    const { serverSocket, destroy } = await createConnectedSocketPair();

    const physicalLayer = new TestPhysicalLayer();
    const pipeline = new TlsPipelineLayer(physicalLayer, serverSocket);

    const closePromise = new Promise<void>((resolve) => pipeline.once('close', () => resolve()));

    pipeline.destroy();
    await closePromise;

    expect(pipeline.state).toBe('destroyed');

    destroy();
  });

  it('destroys the pipeline after idleTimeout with no data', async () => {
    const { serverSocket, client, destroy } = await createConnectedSocketPair();

    const physicalLayer = new TestPhysicalLayer();
    const pipeline = new TlsPipelineLayer(physicalLayer, serverSocket, 100);

    const start = Date.now();
    await new Promise<void>((resolve) => pipeline.once('close', () => resolve()));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(90);

    client.destroy();
    destroy();
  });

  it('resets the idle timer on received data', async () => {
    const { serverSocket, client, destroy } = await createConnectedSocketPair();

    const physicalLayer = new TestPhysicalLayer();
    const pipeline = new TlsPipelineLayer(physicalLayer, serverSocket, 100);

    let closed = false;
    pipeline.once('close', () => {
      closed = true;
    });

    // Keep sending data to reset the idle timer.
    const interval = setInterval(() => {
      client.write(Buffer.from('ping'));
    }, 50);

    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(closed).toBe(false);

    clearInterval(interval);
    await new Promise<void>((resolve) => pipeline.once('close', () => resolve()));
    expect(closed).toBe(true);

    destroy();
  });
});
