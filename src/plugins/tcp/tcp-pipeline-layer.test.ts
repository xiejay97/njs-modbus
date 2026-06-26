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

import { createConnection } from 'node:net';

import { afterEach, describe, expect, it } from 'vitest';

import { TcpServerPhysicalLayer } from './tcp-server-physical-layer';

describe('TcpPipelineLayer idleTimeout', () => {
  let server: TcpServerPhysicalLayer;

  afterEach(async () => {
    if (server.state !== 'closed') {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it('destroys the pipeline after idleTimeout with no data', async () => {
    server = new TcpServerPhysicalLayer(undefined, { idleTimeout: 100 });

    const pipelinePromise = new Promise<AbstractPipelineLayer>((resolve) => {
      server.once('connect', (pipeline) => resolve(pipeline));
    });

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const client = createConnection({ port, host: '127.0.0.1' });
    const pipeline = await pipelinePromise;

    const start = Date.now();
    await new Promise<void>((resolve) => pipeline.once('close', () => resolve()));
    const elapsed = Date.now() - start;

    expect(elapsed).toBeGreaterThanOrEqual(90);
    client.destroy();
  });

  it('resets the idle timer on received data', async () => {
    server = new TcpServerPhysicalLayer(undefined, { idleTimeout: 100 });

    const pipelinePromise = new Promise<AbstractPipelineLayer>((resolve) => {
      server.once('connect', (pipeline) => resolve(pipeline));
    });

    await new Promise<void>((resolve) => server.open({ port: 0, host: '127.0.0.1' }, () => resolve()));
    const port = (server.server?.address() as { port: number } | null)?.port ?? 0;

    const client = createConnection({ port, host: '127.0.0.1' });
    const pipeline = await pipelinePromise;

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

    client.destroy();
  });
});
