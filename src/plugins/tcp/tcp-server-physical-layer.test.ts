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

import { createConnection } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { TcpServerPhysicalLayer } from './tcp-server-physical-layer';

describe('TcpServerPhysicalLayer whitelist', () => {
  let server: TcpServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('accepts a connection from a whitelisted exact IP', async () => {
    server = new TcpServerPhysicalLayer(undefined, { whitelist: ['127.0.0.1'] });

    const connected = new Promise<void>((resolve) => server.once('connect', () => resolve()));

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.end();
    });

    await connected;
  });

  it('rejects a connection from a non-whitelisted IP and emits connectionRejected', async () => {
    server = new TcpServerPhysicalLayer(undefined, { whitelist: ['192.168.1.1'] });

    const rejected = new Promise<{ reason: string; address: string }>((resolve) => {
      server.once('connectionRejected', (event) => resolve(event));
    });

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const socket = createConnection({ port, host: '127.0.0.1' });
    socket.on('error', () => {
      // Expected: the server destroys the socket before handshake completes.
    });

    const event = await rejected;
    expect(event.reason).toBe('whitelist');
    expect(event.address).toBe('127.0.0.1');
  });

  it('accepts a connection from a whitelisted CIDR', async () => {
    server = new TcpServerPhysicalLayer(undefined, { whitelist: ['127.0.0.0/8'] });

    const connected = new Promise<void>((resolve) => server.once('connect', () => resolve()));

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.end();
    });

    await connected;
  });

  it('accepts a connection from a whitelisted predicate', async () => {
    server = new TcpServerPhysicalLayer(undefined, {
      whitelist: [(address) => address === '127.0.0.1'],
    });

    const connected = new Promise<void>((resolve) => server.once('connect', () => resolve()));

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const socket = createConnection({ port, host: '127.0.0.1' }, () => {
      socket.end();
    });

    await connected;
  });
});

describe('TcpServerPhysicalLayer maxConnections', () => {
  let server: TcpServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects connections beyond maxConnections and emits connectionRejected', async () => {
    server = new TcpServerPhysicalLayer(undefined, { maxConnections: 2 });

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const sockets: ReturnType<typeof createConnection>[] = [];

    // First connection is accepted.
    const first = new Promise<void>((resolve) => server.once('connect', () => resolve()));
    sockets.push(createConnection({ port, host: '127.0.0.1' }));
    await first;

    // Second connection is accepted.
    const second = new Promise<void>((resolve) => server.once('connect', () => resolve()));
    sockets.push(createConnection({ port, host: '127.0.0.1' }));
    await second;

    // Third connection exceeds the limit.
    const rejected = new Promise<{ reason: string; address: string }>((resolve) => {
      server.once('connectionRejected', (event) => resolve(event));
    });
    const third = createConnection({ port, host: '127.0.0.1' });
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

describe('TcpServerPhysicalLayer maxConnectionsPerIp', () => {
  let server: TcpServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects connections beyond the per-IP limit and emits connectionRejected', async () => {
    server = new TcpServerPhysicalLayer(undefined, { maxConnectionsPerIp: 2 });

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const sockets: ReturnType<typeof createConnection>[] = [];

    // First connection from 127.0.0.1 is accepted.
    const first = new Promise<void>((resolve) => server.once('connect', () => resolve()));
    sockets.push(createConnection({ port, host: '127.0.0.1' }));
    await first;

    // Second connection from the same IP is accepted.
    const second = new Promise<void>((resolve) => server.once('connect', () => resolve()));
    sockets.push(createConnection({ port, host: '127.0.0.1' }));
    await second;

    // Third connection from the same IP exceeds the per-IP limit.
    const rejected = new Promise<{ reason: string; address: string }>((resolve) => {
      server.once('connectionRejected', (event) => resolve(event));
    });
    const third = createConnection({ port, host: '127.0.0.1' });
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
