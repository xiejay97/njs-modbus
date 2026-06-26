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

import { createServer } from 'node:tls';

import { afterEach, describe, expect, it } from 'vitest';

import { TlsClientPhysicalLayer } from './tls-client-physical-layer';
import { TlsPipelineLayer } from './tls-pipeline-layer';
import { CA_CERT, CLIENT_CERT, CLIENT_KEY, SERVER_CERT, SERVER_KEY, WRONG_CA_CERT } from '../../../test/helpers/tls-certs';

describe('TlsClientPhysicalLayer', () => {
  let server: ReturnType<typeof createServer> | null = null;

  afterEach(async () => {
    const srv = server;
    if (srv) {
      await new Promise<void>((resolve) => srv.close(() => resolve()));
      server = null;
    }
  });

  async function startServer(options?: Parameters<typeof createServer>[0]): Promise<number> {
    const srv = createServer(options ?? { cert: SERVER_CERT, key: SERVER_KEY });
    server = srv;

    await new Promise<void>((resolve) => srv.listen({ port: 0, host: '127.0.0.1' }, () => resolve()));
    return (srv.address() as { port: number }).port;
  }

  it('connects to a TLS server with valid certificates', async () => {
    const port = await startServer();

    const client = new TlsClientPhysicalLayer({ ca: CA_CERT, rejectUnauthorized: true });

    const pipelinePromise = new Promise<TlsPipelineLayer>((resolve) => {
      client.once('connect', (pipeline) => resolve(pipeline as TlsPipelineLayer));
    });

    const err = await new Promise<Error | null>((resolve) => client.open({ port, host: '127.0.0.1' }, (e) => resolve(e)));

    expect(err).toBeNull();
    const pipeline = await pipelinePromise;
    expect(pipeline).toBeInstanceOf(TlsPipelineLayer);
    expect(client.state).toBe('open');

    client.close();
  });

  it('emits error and fails open when certificate is invalid', async () => {
    const port = await startServer();

    const client = new TlsClientPhysicalLayer({ ca: WRONG_CA_CERT, rejectUnauthorized: true });

    const openErr = await new Promise<Error | null>((resolve) => {
      client.open({ port, host: '127.0.0.1' }, (e) => resolve(e));
    });

    expect(openErr).toBeInstanceOf(Error);
    expect(client.state).toBe('closed');
  });

  it('connects with client certificate authentication', async () => {
    const port = await startServer({
      cert: SERVER_CERT,
      key: SERVER_KEY,
      requestCert: true,
      rejectUnauthorized: true,
      ca: CA_CERT,
    });

    const client = new TlsClientPhysicalLayer({
      cert: CLIENT_CERT,
      key: CLIENT_KEY,
      ca: CA_CERT,
      rejectUnauthorized: true,
    });

    const pipelinePromise = new Promise<TlsPipelineLayer>((resolve) => {
      client.once('connect', (pipeline) => resolve(pipeline as TlsPipelineLayer));
    });

    const err = await new Promise<Error | null>((resolve) => client.open({ port, host: '127.0.0.1' }, (e) => resolve(e)));

    expect(err).toBeNull();
    const pipeline = await pipelinePromise;
    expect(pipeline.socket.authorized).toBe(true);

    client.close();
  });

  it('rejects open when port is closing', async () => {
    const port = await startServer();

    const client = new TlsClientPhysicalLayer({ ca: CA_CERT, rejectUnauthorized: true });

    await new Promise<void>((resolve) => client.open({ port, host: '127.0.0.1' }, () => resolve()));
    expect(client.state).toBe('open');

    client.close();
    expect(client.state).toBe('closing');

    const reopenErr = await new Promise<Error | null>((resolve) => {
      client.open({ port, host: '127.0.0.1' }, (e) => resolve(e));
    });

    expect(reopenErr).toEqual(expect.objectContaining({ message: 'Port is closing' }));

    await new Promise<void>((resolve) => client.once('close', () => resolve()));
  });

  it('socket getter returns TLSSocket when connected', async () => {
    const port = await startServer();

    const client = new TlsClientPhysicalLayer({ ca: CA_CERT, rejectUnauthorized: true });

    const pipelinePromise = new Promise<TlsPipelineLayer>((resolve) => {
      client.once('connect', (pipeline) => resolve(pipeline as TlsPipelineLayer));
    });

    await new Promise<void>((resolve) => client.open({ port, host: '127.0.0.1' }, () => resolve()));
    const pipeline = await pipelinePromise;

    expect(client.socket).toBe(pipeline.socket);
    expect(client.socket).not.toBeNull();

    client.close();
  });

  it('close transitions through CLOSING and emits close', async () => {
    const port = await startServer();

    const client = new TlsClientPhysicalLayer({ ca: CA_CERT, rejectUnauthorized: true });

    await new Promise<void>((resolve) => client.open({ port, host: '127.0.0.1' }, () => resolve()));
    expect(client.state).toBe('open');

    const closePromise = new Promise<void>((resolve) => client.once('close', () => resolve()));
    client.close();
    await closePromise;

    expect(client.state).toBe('closed');
  });
});
