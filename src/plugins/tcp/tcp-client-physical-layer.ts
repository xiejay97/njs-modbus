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
import type { SocketConstructorOpts, SocketConnectOpts } from 'node:net';

import { Socket } from 'node:net';

import { AbstractPhysicalLayer } from '../abstract-physical-layer';
import { PhysicalLayerState } from '../vars';
import { TcpPipelineLayer } from './tcp-pipeline-layer';

/**
 * TCP client physical layer.
 *
 * Opens a `node:net` socket to a remote host and emits a {@link TcpPipelineLayer}
 * on `connect`.
 */
export class TcpClientPhysicalLayer extends AbstractPhysicalLayer {
  private _state: PhysicalLayerState = PhysicalLayerState.CLOSED;
  private _pipelines = new Set<AbstractPipelineLayer>();

  private _socket: Socket | null = null;
  private _socketOpts?: SocketConstructorOpts;

  private _pendingOpenCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _pendingCloseCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _cleanupFns = new Set<() => void>();

  /** Current lifecycle state of this physical layer. */
  get state(): PhysicalLayerState {
    return this._state;
  }

  /** Underlying `Socket` instance when connected, otherwise `null`. */
  get socket(): Socket | null {
    return this._socket;
  }

  /**
   * @param options Optional `Socket` constructor options.
   */
  constructor(options?: SocketConstructorOpts) {
    super();

    this._socketOpts = options;
  }

  /**
   * Connect to a remote Modbus TCP endpoint.
   *
   * @param options Connection target (`host` and `port`). Port defaults to `502`
   *   (unit: port number).
   * @param cb Optional callback invoked once the socket connects.
   * @returns `void`.
   */
  override open(options: SocketConnectOpts, cb?: (err: Error | null) => void): void {
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

    const socket = new Socket(this._socketOpts);
    socket.setNoDelay(true);
    this._socket = socket;

    const onConnect = () => {
      socket.off('error', onError);

      this._state = PhysicalLayerState.OPEN;
      for (const fn of this._pendingOpenCbs) {
        if (fn) {
          fn(null);
        }
      }
      this._pendingOpenCbs.length = 0;
      this.emit('open');

      const pipeline = new TcpPipelineLayer(this, socket);
      this._pipelines.add(pipeline);

      const cleanupClose = () => pipeline.off('close', onClose);
      const onClose = () => {
        this._cleanupFns.delete(cleanupClose);

        this._pipelines.delete(pipeline);

        this._state = PhysicalLayerState.CLOSED;
        this._socket = null;
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
      pipeline.once('close', onClose);
      this._cleanupFns.add(cleanupClose);

      this.emit('connect', pipeline);
    };

    const onError = (err: Error) => {
      socket.off('connect', onConnect);

      this._state = PhysicalLayerState.CLOSED;
      this._socket = null;
      for (const fn of this._pendingOpenCbs) {
        if (fn) {
          fn(err);
        }
      }
      this._pendingOpenCbs.length = 0;
    };

    socket.once('connect', onConnect);
    socket.once('error', onError);

    socket.connect(options ?? { port: 502 });
  }

  /**
   * Close the socket and destroy any associated pipelines.
   *
   * @param cb Optional callback invoked once the layer is closed.
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

    for (const pipeline of [...this._pipelines]) {
      pipeline.destroy();
    }
  }
}
