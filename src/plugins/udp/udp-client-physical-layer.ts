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

import type { Socket, SocketOptions } from 'node:dgram';

import { createSocket } from 'node:dgram';

import { AbstractPhysicalLayer } from '../abstract-physical-layer';
import { AbstractPipelineLayer } from '../abstract-pipeline-layer';
import { PhysicalLayerState, PipelineLayerState } from '../vars';

/**
 * UDP client pipeline layer backed by a connected `node:dgram` `Socket`.
 *
 * Emits `data` for incoming datagrams and `tx` after a successful `send`.
 */
export class UdpClientPipelineLayer extends AbstractPipelineLayer {
  private _state: PipelineLayerState = PipelineLayerState.CONNECTED;
  private _physicalLayer: UdpClientPhysicalLayer;
  private _socket: Socket;

  private _pendingDestroyCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _cleanupFns = new Set<() => void>();

  /** Current lifecycle state of this pipeline. */
  get state(): PipelineLayerState {
    return this._state;
  }

  /** Parent physical layer that created this pipeline. */
  get physicalLayer(): AbstractPhysicalLayer {
    return this._physicalLayer;
  }

  /** Underlying `Socket` instance. */
  get socket(): Socket {
    return this._socket;
  }

  /**
   * @param physicalLayer Parent physical layer.
   * @param socket Connected UDP `Socket` instance.
   */
  constructor(physicalLayer: UdpClientPhysicalLayer, socket: Socket) {
    super();

    this._physicalLayer = physicalLayer;
    this._socket = socket;

    const onMessage = (msg: Buffer) => {
      if (this.state !== PipelineLayerState.CONNECTED) {
        return;
      }
      this.emit('rx', msg);
      this.emit('data', msg);
    };
    socket.on('message', onMessage);
    this._cleanupFns.add(() => socket.off('message', onMessage));

    const onSocketError = (err: Error) => {
      this.physicalLayer.emit('error', err);
    };
    socket.on('error', onSocketError);
    this._cleanupFns.add(() => socket.off('error', onSocketError));

    const cleanupClose = () => socket.off('close', onClose);
    const onClose = () => {
      this._cleanupFns.delete(cleanupClose);

      this._state = PipelineLayerState.DESTROYED;
      for (const fn of this._cleanupFns) {
        fn();
      }
      this._cleanupFns.clear();

      for (const fn of this._pendingDestroyCbs) {
        if (fn) {
          fn(null);
        }
      }
      this._pendingDestroyCbs.length = 0;
      this.emit('close');
    };
    socket.once('close', onClose);
    this._cleanupFns.add(cleanupClose);
  }

  /**
   * Send a frame through the connected UDP socket.
   *
   * @param data Encoded frame bytes (unit: byte).
   * @param cb Optional callback invoked once the datagram is sent.
   * @returns `void`.
   */
  override write(data: Buffer, cb?: (err: Error | null) => void): void {
    if (this.state === PipelineLayerState.CONNECTED) {
      this._socket.send(data, (err) => {
        if (err) {
          cb?.(err);
        } else {
          cb?.(null);
          this.emit('tx', data);
        }
      });
    } else {
      cb?.(new Error('Pipeline is not connected'));
    }
  }

  /**
   * Close the UDP socket and tear down the pipeline.
   *
   * @param cb Optional callback invoked once the socket is closed.
   * @returns `void`.
   */
  override destroy(cb?: (err: Error | null) => void): void {
    if (this.state === PipelineLayerState.DESTROYED) {
      cb?.(null);
      return;
    }
    if (this.state === PipelineLayerState.DESTROYING) {
      this._pendingDestroyCbs.push(cb);
      return;
    }

    this._state = PipelineLayerState.DESTROYING;
    this._pendingDestroyCbs = [cb];

    this._socket.close();
  }
}

/**
 * UDP client physical layer.
 *
 * Binds a local UDP socket, connects it to a remote endpoint, and emits a
 * {@link UdpClientPipelineLayer} on `connect`.
 */
export class UdpClientPhysicalLayer extends AbstractPhysicalLayer {
  private _state: PhysicalLayerState = PhysicalLayerState.CLOSED;
  private _pipelines = new Set<AbstractPipelineLayer>();

  private _socket: Socket | null = null;
  private _socketOpts: SocketOptions;

  private _pendingOpenCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _pendingCloseCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _cleanupFns = new Set<() => void>();

  /** Current lifecycle state of this physical layer. */
  get state(): PhysicalLayerState {
    return this._state;
  }

  /** Underlying `Socket` instance when open, otherwise `null`. */
  get socket(): Socket | null {
    return this._socket;
  }

  /**
   * @param options Optional `SocketOptions`. Defaults to `udp4`.
   */
  constructor(options?: Partial<SocketOptions>) {
    super();

    this._socketOpts = { ...options, type: options?.type ?? 'udp4' };
  }

  /**
   * Open a connected UDP socket to a remote Modbus endpoint.
   *
   * @param remote Remote endpoint (`address` and `port`). Port defaults to `502`
   *   (unit: port number).
   * @param cb Optional callback invoked once the socket is bound and connected.
   * @returns `void`.
   */
  override open(remote: { port?: number; address?: string }, cb?: (err: Error | null) => void): void {
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

    const socket = createSocket(this._socketOpts);
    this._socket = socket;

    const onListening = () => {
      socket.off('error', onError);

      socket.connect(remote?.port ?? 502, remote?.address);

      this._state = PhysicalLayerState.OPEN;
      for (const fn of this._pendingOpenCbs) {
        if (fn) {
          fn(null);
        }
      }
      this._pendingOpenCbs.length = 0;
      this.emit('open');

      const pipeline = new UdpClientPipelineLayer(this, socket);
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
      socket.off('listening', onListening);

      this._state = PhysicalLayerState.CLOSED;
      this._socket = null;
      for (const fn of this._pendingOpenCbs) {
        if (fn) {
          fn(err);
        }
      }
      this._pendingOpenCbs.length = 0;
    };

    socket.once('listening', onListening);
    socket.once('error', onError);

    socket.bind();
  }

  /**
   * Close the UDP socket and destroy any associated pipelines.
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
