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

import { connect } from 'node:tls';

import { afterEach, describe, expect, it } from 'vitest';

import { TlsServerPhysicalLayer } from './tls-server-physical-layer';
import { CA_CERT, CLIENT_CERT, CLIENT_KEY, SERVER_CERT, SERVER_KEY } from '../../../test/helpers/tls-certs';

describe('TlsServerPhysicalLayer whitelist', () => {
  let server: TlsServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('accepts a connection from a whitelisted exact IP', async () => {
    server = new TlsServerPhysicalLayer({ cert: SERVER_CERT, key: SERVER_KEY }, { whitelist: ['127.0.0.1'] });

    const connected = new Promise<void>((resolve) => server.once('connect', () => resolve()));

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const socket = connect({ port, host: '127.0.0.1', ca: CA_CERT, rejectUnauthorized: true }, () => {
      socket.end();
    });

    await connected;
  });

  it('rejects a connection from a non-whitelisted IP and emits connectionRejected', async () => {
    server = new TlsServerPhysicalLayer({ cert: SERVER_CERT, key: SERVER_KEY }, { whitelist: ['192.168.1.1'] });

    const rejected = new Promise<{ reason: string; address: string }>((resolve) => {
      server.once('connectionRejected', (event) => resolve(event));
    });

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const socket = connect({ port, host: '127.0.0.1', ca: CA_CERT, rejectUnauthorized: true });
    socket.on('error', () => {
      // Expected: the server destroys the socket before handshake completes.
    });

    const event = await rejected;
    expect(event.reason).toBe('whitelist');
    expect(event.address).toBe('127.0.0.1');
  });

  it('accepts a connection from a whitelisted CIDR', async () => {
    server = new TlsServerPhysicalLayer({ cert: SERVER_CERT, key: SERVER_KEY }, { whitelist: ['127.0.0.0/8'] });

    const connected = new Promise<void>((resolve) => server.once('connect', () => resolve()));

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const socket = connect({ port, host: '127.0.0.1', ca: CA_CERT, rejectUnauthorized: true }, () => {
      socket.end();
    });

    await connected;
  });

  it('accepts a connection from a whitelisted predicate', async () => {
    server = new TlsServerPhysicalLayer(
      { cert: SERVER_CERT, key: SERVER_KEY },
      {
        whitelist: [(address) => address === '127.0.0.1'],
      },
    );

    const connected = new Promise<void>((resolve) => server.once('connect', () => resolve()));

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const socket = connect({ port, host: '127.0.0.1', ca: CA_CERT, rejectUnauthorized: true }, () => {
      socket.end();
    });

    await connected;
  });
});

describe('TlsServerPhysicalLayer maxConnections', () => {
  let server: TlsServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects connections beyond maxConnections and emits connectionRejected', async () => {
    server = new TlsServerPhysicalLayer({ cert: SERVER_CERT, key: SERVER_KEY }, { maxConnections: 2 });

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const sockets: ReturnType<typeof connect>[] = [];

    // First connection is accepted.
    const first = new Promise<void>((resolve) => server.once('connect', () => resolve()));
    sockets.push(connect({ port, host: '127.0.0.1', ca: CA_CERT, rejectUnauthorized: true }));
    await first;

    // Second connection is accepted.
    const second = new Promise<void>((resolve) => server.once('connect', () => resolve()));
    sockets.push(connect({ port, host: '127.0.0.1', ca: CA_CERT, rejectUnauthorized: true }));
    await second;

    // Third connection exceeds the limit.
    const rejected = new Promise<{ reason: string; address: string }>((resolve) => {
      server.once('connectionRejected', (event) => resolve(event));
    });
    const third = connect({ port, host: '127.0.0.1', ca: CA_CERT, rejectUnauthorized: true });
    third.on('error', () => {
      // Expected: the server destroys the socket.
    });
    sockets.push(third);

    const event = await rejected;
    expect(event.reason).toBe('max_connections');
    expect(event.address).toBe('127.0.0.1');

    for (const socket of sockets) {
      socket.destroy();
    }
  });
});

describe('TlsServerPhysicalLayer maxConnectionsPerIp', () => {
  let server: TlsServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects connections beyond the per-IP limit and emits connectionRejected', async () => {
    server = new TlsServerPhysicalLayer({ cert: SERVER_CERT, key: SERVER_KEY }, { maxConnectionsPerIp: 2 });

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const sockets: ReturnType<typeof connect>[] = [];

    // First connection from 127.0.0.1 is accepted.
    const first = new Promise<void>((resolve) => server.once('connect', () => resolve()));
    sockets.push(connect({ port, host: '127.0.0.1', ca: CA_CERT, rejectUnauthorized: true }));
    await first;

    // Second connection from the same IP is accepted.
    const second = new Promise<void>((resolve) => server.once('connect', () => resolve()));
    sockets.push(connect({ port, host: '127.0.0.1', ca: CA_CERT, rejectUnauthorized: true }));
    await second;

    // Third connection from the same IP exceeds the per-IP limit.
    const rejected = new Promise<{ reason: string; address: string }>((resolve) => {
      server.once('connectionRejected', (event) => resolve(event));
    });
    const third = connect({ port, host: '127.0.0.1', ca: CA_CERT, rejectUnauthorized: true });
    third.on('error', () => {
      // Expected: the server destroys the socket.
    });
    sockets.push(third);

    const event = await rejected;
    expect(event.reason).toBe('max_connections_per_ip');
    expect(event.address).toBe('127.0.0.1');

    for (const socket of sockets) {
      socket.destroy();
    }
  });
});

describe('TlsServerPhysicalLayer lifecycle and errors', () => {
  let server: TlsServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('server getter returns tls.Server when listening', async () => {
    server = new TlsServerPhysicalLayer({ cert: SERVER_CERT, key: SERVER_KEY });

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));

    expect(server.server).not.toBeNull();
    expect(server.server).toBeDefined();
  });

  it('reports an error when the port is already in use', async () => {
    server = new TlsServerPhysicalLayer({ cert: SERVER_CERT, key: SERVER_KEY });

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const secondServer = new TlsServerPhysicalLayer({ cert: SERVER_CERT, key: SERVER_KEY });
    const error = await new Promise<Error | null>((resolve) => {
      secondServer.open({ port, host: '127.0.0.1' }, (err) => resolve(err));
    });

    expect(error).toBeInstanceOf(Error);

    await new Promise<void>((resolve) => secondServer.close(() => resolve()));
  });
});

describe('TlsServerPhysicalLayer client certificates', () => {
  let server: TlsServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('succeeds with client certificate authentication', async () => {
    server = new TlsServerPhysicalLayer({
      cert: SERVER_CERT,
      key: SERVER_KEY,
      requestCert: true,
      rejectUnauthorized: true,
      ca: CA_CERT,
    });

    const connected = new Promise<void>((resolve) => server.once('connect', () => resolve()));

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const socket = connect({
      port,
      host: '127.0.0.1',
      cert: CLIENT_CERT,
      key: CLIENT_KEY,
      ca: CA_CERT,
      rejectUnauthorized: true,
    });

    await connected;
    socket.end();
  });
});
