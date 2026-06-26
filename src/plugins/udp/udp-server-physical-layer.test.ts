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

import type { AbstractPipelineLayer } from '../abstract-pipeline-layer';

import { createSocket } from 'node:dgram';

import { afterEach, describe, expect, it } from 'vitest';

import { UdpServerPhysicalLayer } from './udp-server-physical-layer';

describe('UdpServerPhysicalLayer whitelist', () => {
  let server: UdpServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('accepts a datagram from a whitelisted exact IP', async () => {
    server = new UdpServerPhysicalLayer(undefined, { whitelist: ['127.0.0.1'] });

    const connected = new Promise<void>((resolve) => server.once('connect', () => resolve()));

    await new Promise<void>((resolve) => server.open({ port: 0, address: '127.0.0.1' }, () => resolve()));
    const port = (server.socket?.address() as { port: number } | null)?.port ?? 0;

    const client = createSocket('udp4');
    client.send(Buffer.from('hello'), port, '127.0.0.1', () => {
      client.close();
    });

    await connected;
  });

  it('rejects a datagram from a non-whitelisted IP and emits connectionRejected', async () => {
    server = new UdpServerPhysicalLayer(undefined, { whitelist: ['192.168.1.1'] });

    const rejected = new Promise<{ reason: string; address: string; port?: number }>((resolve) => {
      server.once('connectionRejected', (event) => resolve(event));
    });

    await new Promise<void>((resolve) => server.open({ port: 0, address: '127.0.0.1' }, () => resolve()));
    const port = (server.socket?.address() as { port: number } | null)?.port ?? 0;

    const client = createSocket('udp4');
    client.send(Buffer.from('hello'), port, '127.0.0.1', () => {
      client.close();
    });

    const event = await rejected;
    expect(event.reason).toBe('whitelist');
    expect(event.address).toBe('127.0.0.1');
    expect(event.port).toEqual(expect.any(Number));
  });

  it('accepts a datagram from a whitelisted CIDR', async () => {
    server = new UdpServerPhysicalLayer(undefined, { whitelist: ['127.0.0.0/8'] });

    const connected = new Promise<void>((resolve) => server.once('connect', () => resolve()));

    await new Promise<void>((resolve) => server.open({ port: 0, address: '127.0.0.1' }, () => resolve()));
    const port = (server.socket?.address() as { port: number } | null)?.port ?? 0;

    const client = createSocket('udp4');
    client.send(Buffer.from('hello'), port, '127.0.0.1', () => {
      client.close();
    });

    await connected;
  });

  it('accepts a datagram from a whitelisted predicate', async () => {
    server = new UdpServerPhysicalLayer(undefined, {
      whitelist: [(address) => address === '127.0.0.1'],
    });

    const connected = new Promise<void>((resolve) => server.once('connect', () => resolve()));

    await new Promise<void>((resolve) => server.open({ port: 0, address: '127.0.0.1' }, () => resolve()));
    const port = (server.socket?.address() as { port: number } | null)?.port ?? 0;

    const client = createSocket('udp4');
    client.send(Buffer.from('hello'), port, '127.0.0.1', () => {
      client.close();
    });

    await connected;
  });
});

describe('UdpServerPhysicalLayer maxConnections', () => {
  let server: UdpServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects datagrams from new peers beyond maxConnections and emits connectionRejected', async () => {
    server = new UdpServerPhysicalLayer(undefined, { maxConnections: 2 });

    await new Promise<void>((resolve) => server.open({ port: 0, address: '127.0.0.1' }, () => resolve()));
    const port = (server.socket?.address() as { port: number } | null)?.port ?? 0;

    // First peer is accepted.
    const first = new Promise<void>((resolve) => server.once('connect', () => resolve()));
    const client1 = createSocket('udp4');
    client1.send(Buffer.from('hello'), port, '127.0.0.1', () => {
      client1.close();
    });
    await first;

    // Second peer is accepted.
    const second = new Promise<void>((resolve) => server.once('connect', () => resolve()));
    const client2 = createSocket('udp4');
    client2.send(Buffer.from('hello'), port, '127.0.0.1', () => {
      client2.close();
    });
    await second;

    // Third peer exceeds the limit.
    const rejected = new Promise<{ reason: string; address: string; port?: number }>((resolve) => {
      server.once('connectionRejected', (event) => resolve(event));
    });
    const client3 = createSocket('udp4');
    client3.send(Buffer.from('hello'), port, '127.0.0.1', () => {
      client3.close();
    });

    const event = await rejected;
    expect(event.reason).toBe('max_connections');
    expect(event.address).toBe('127.0.0.1');
    expect(event.port).toEqual(expect.any(Number));
  });
});

describe('UdpServerPhysicalLayer maxConnectionsPerIp', () => {
  let server: UdpServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('rejects peers beyond the per-IP limit and emits connectionRejected', async () => {
    server = new UdpServerPhysicalLayer(undefined, { maxConnectionsPerIp: 2 });

    await new Promise<void>((resolve) => server.open({ port: 0, address: '127.0.0.1' }, () => resolve()));
    const port = (server.socket?.address() as { port: number } | null)?.port ?? 0;

    // First peer from 127.0.0.1 is accepted.
    const first = new Promise<void>((resolve) => server.once('connect', () => resolve()));
    const client1 = createSocket('udp4');
    client1.send(Buffer.from('hello'), port, '127.0.0.1', () => {
      client1.close();
    });
    await first;

    // Second peer from the same IP is accepted.
    const second = new Promise<void>((resolve) => server.once('connect', () => resolve()));
    const client2 = createSocket('udp4');
    client2.send(Buffer.from('hello'), port, '127.0.0.1', () => {
      client2.close();
    });
    await second;

    // Third peer from the same IP exceeds the per-IP limit.
    const rejected = new Promise<{ reason: string; address: string; port?: number }>((resolve) => {
      server.once('connectionRejected', (event) => resolve(event));
    });
    const client3 = createSocket('udp4');
    client3.send(Buffer.from('hello'), port, '127.0.0.1', () => {
      client3.close();
    });

    const event = await rejected;
    expect(event.reason).toBe('max_connections_per_ip');
    expect(event.address).toBe('127.0.0.1');
    expect(event.port).toEqual(expect.any(Number));
  });
});

describe('UdpServerPhysicalLayer idleTimeout', () => {
  let server: UdpServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('destroys a peer pipeline after idleTimeout with no traffic', async () => {
    server = new UdpServerPhysicalLayer(undefined, { idleTimeout: 100 });

    const pipelinePromise = new Promise<AbstractPipelineLayer>((resolve) => {
      server.once('connect', (pipeline) => resolve(pipeline));
    });

    await new Promise<void>((resolve) => server.open({ port: 0, address: '127.0.0.1' }, () => resolve()));
    const port = (server.socket?.address() as { port: number } | null)?.port ?? 0;

    const client = createSocket('udp4');
    client.send(Buffer.from('hello'), port, '127.0.0.1', () => {
      client.close();
    });

    const pipeline = await pipelinePromise;

    const start = Date.now();
    await new Promise<void>((resolve) => pipeline.once('close', () => resolve()));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(90);
  });

  it('resets the peer idle timer on received datagrams', async () => {
    server = new UdpServerPhysicalLayer(undefined, { idleTimeout: 100 });

    const pipelinePromise = new Promise<AbstractPipelineLayer>((resolve) => {
      server.once('connect', (pipeline) => resolve(pipeline));
    });

    await new Promise<void>((resolve) => server.open({ port: 0, address: '127.0.0.1' }, () => resolve()));
    const port = (server.socket?.address() as { port: number } | null)?.port ?? 0;

    const client = createSocket('udp4');
    client.send(Buffer.from('hello'), port, '127.0.0.1');

    const pipeline = await pipelinePromise;

    let closed = false;
    pipeline.once('close', () => {
      closed = true;
    });

    // Keep sending datagrams to reset the idle timer.
    const interval = setInterval(() => {
      client.send(Buffer.from('ping'), port, '127.0.0.1');
    }, 50);

    await new Promise<void>((resolve) => setTimeout(resolve, 250));
    expect(closed).toBe(false);

    clearInterval(interval);
    await new Promise<void>((resolve) => pipeline.once('close', () => resolve()));
    expect(closed).toBe(true);

    client.close();
  });
});
