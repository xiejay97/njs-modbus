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
import type { TcpConnectionSecurityOptions } from '../connection-security-options';
import type { ListenOptions, Server, ServerOpts } from 'node:net';

import { createServer } from 'node:net';

import { canonicalizeIp } from '../../utils/canonicalize-ip';
import { createIpMatchers } from '../../utils/ip-whitelist';
import { AbstractPhysicalLayer } from '../abstract-physical-layer';
import { PhysicalLayerState } from '../vars';
import { TcpPipelineLayer } from './tcp-pipeline-layer';

/**
 * TCP server physical layer.
 *
 * Listens on a local port and emits a {@link TcpPipelineLayer} for every
 * incoming connection.
 */
export class TcpServerPhysicalLayer extends AbstractPhysicalLayer {
  private _state: PhysicalLayerState = PhysicalLayerState.CLOSED;
  private _pipelines = new Set<AbstractPipelineLayer>();

  private _server: Server | null = null;
  private _serverOpts?: ServerOpts;
  private _whitelist: ((address: string) => boolean) | null = null;
  private _maxConnections: number = 0;
  private _maxConnectionsPerIp: number = 0;
  private _idleTimeout: number = 0;

  private _pipelinesByIp = new Map<string, Set<AbstractPipelineLayer>>();

  private _pendingOpenCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _pendingCloseCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _cleanupFns = new Set<() => void>();

  /** Current lifecycle state of this physical layer. */
  get state(): PhysicalLayerState {
    return this._state;
  }

  /** Underlying `Server` instance when listening, otherwise `null`. */
  get server(): Server | null {
    return this._server;
  }

  /**
   * @param options Optional `Server` constructor options.
   * @param security Optional security and resource-limit options.
   */
  constructor(options?: ServerOpts, security?: TcpConnectionSecurityOptions) {
    super();

    this._serverOpts = options;
    if (security) {
      if (security.whitelist) {
        this._whitelist = createIpMatchers(security.whitelist);
      }
      if (security.maxConnections) {
        this._maxConnections = security.maxConnections;
      }
      if (security.maxConnectionsPerIp) {
        this._maxConnectionsPerIp = security.maxConnectionsPerIp;
      }
      if (security.idleTimeout) {
        this._idleTimeout = security.idleTimeout;
      }
    }
  }

  /**
   * Start listening for incoming Modbus TCP connections.
   *
   * @param options Listen options. Port defaults to `502` (unit: port number).
   * @param cb Optional callback invoked once the server is listening.
   * @returns `void`.
   */
  override open(options: ListenOptions, cb?: (err: Error | null) => void): void {
    if (this.state === PhysicalLayerState.OPEN) {
      cb?.(null);
      return;
    }
    if (this.state === PhysicalLayerState.OPENING) {
      this._pendingOpenCbs.push(cb);
      return;
    }
    if (this.state === PhysicalLayerState.CLOSING) {
      cb?.(new Error('Port is closing'));
      return;
    }

    this._state = PhysicalLayerState.OPENING;
    this._pendingOpenCbs = [cb];

    const server = createServer(this._serverOpts, (socket) => {
      socket.setNoDelay(true);

      const address = canonicalizeIp(socket.remoteAddress);
      if (this._whitelist && !this._whitelist(address)) {
        this.emit('connectionRejected', { reason: 'whitelist' as const, address });
        socket.destroy();
        return;
      }
      if (this._maxConnections > 0 && this._pipelines.size >= this._maxConnections) {
        this.emit('connectionRejected', { reason: 'max_connections' as const, address });
        socket.destroy();
        return;
      }
      if (this._maxConnectionsPerIp > 0 && (this._pipelinesByIp.get(address)?.size ?? 0) >= this._maxConnectionsPerIp) {
        this.emit('connectionRejected', { reason: 'max_connections_per_ip' as const, address });
        socket.destroy();
        return;
      }

      const pipeline = new TcpPipelineLayer(this, socket, this._idleTimeout);
      this._pipelines.add(pipeline);

      let pipelinesForIp = this._pipelinesByIp.get(address);
      if (!pipelinesForIp) {
        pipelinesForIp = new Set<AbstractPipelineLayer>();
        this._pipelinesByIp.set(address, pipelinesForIp);
      }
      pipelinesForIp.add(pipeline);

      const cleanupClose = () => pipeline.off('close', onClose);
      const onClose = () => {
        this._cleanupFns.delete(cleanupClose);

        this._pipelines.delete(pipeline);
        const set = this._pipelinesByIp.get(address);
        if (set) {
          set.delete(pipeline);
          if (set.size === 0) {
            this._pipelinesByIp.delete(address);
          }
        }
      };
      pipeline.once('close', onClose);
      this._cleanupFns.add(cleanupClose);

      this.emit('connect', pipeline);
    });
    this._server = server;

    const onConnect = () => {
      server.off('error', onError);

      this._state = PhysicalLayerState.OPEN;
      for (const fn of this._pendingOpenCbs) {
        if (fn) {
          fn(null);
        }
      }
      this._pendingOpenCbs.length = 0;
      this.emit('open');

      {
        const onError = (err: Error) => {
          this.emit('error', err);
        };
        server.on('error', onError);
        this._cleanupFns.add(() => server.off('error', onError));

        const cleanupClose = () => server.off('close', onClose);
        const onClose = () => {
          this._cleanupFns.delete(cleanupClose);
          this._state = PhysicalLayerState.CLOSED;
          this._server = null;
          for (const fn of this._cleanupFns) {
            fn();
          }
          this._cleanupFns.clear();
          for (const fn of this._pendingCloseCbs) {
            if (fn) {
              fn(null);
            }
          }
          this._pendingCloseCbs.length = 0;
          this.emit('close');
        };
        server.once('close', onClose);
        this._cleanupFns.add(cleanupClose);
      }
    };

    const onError = (err: Error) => {
      server.off('listening', onConnect);
      this._state = PhysicalLayerState.CLOSED;
      this._server = null;
      for (const fn of this._pendingOpenCbs) {
        if (fn) {
          fn(err);
        }
      }
      this._pendingOpenCbs.length = 0;
    };

    server.once('listening', onConnect);
    server.once('error', onError);

    server.listen({ ...options, port: options?.port ?? 502 });
  }

  /**
   * Close the server and destroy any active connection pipelines.
   *
   * @param cb Optional callback invoked once the server is closed.
   * @returns `void`.
   */
  override close(cb?: (err: Error | null) => void): void {
    if (this.state === PhysicalLayerState.CLOSED) {
      cb?.(null);
      return;
    }
    if (this.state === PhysicalLayerState.CLOSING) {
      this._pendingCloseCbs.push(cb);
      return;
    }
    if (this.state === PhysicalLayerState.OPENING) {
      cb?.(new Error('Port is opening'));
      return;
    }

    this._state = PhysicalLayerState.CLOSING;
    this._pendingCloseCbs = [cb];

    this.server!.close();
    for (const pipeline of [...this._pipelines]) {
      pipeline.destroy();
    }
  }
}
