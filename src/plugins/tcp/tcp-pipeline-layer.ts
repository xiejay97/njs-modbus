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

import type { AbstractPhysicalLayer } from '../abstract-physical-layer';
import type { Socket } from 'node:net';

import { AbstractPipelineLayer } from '../abstract-pipeline-layer';
import { PipelineLayerState } from '../vars';

/**
 * TCP pipeline layer backed by a `node:net` `Socket`.
 *
 * Forwards `data` events from the socket and emits `tx` after a successful
 * `socket.write`. An optional `idleTimeout` destroys the pipeline after the
 * specified milliseconds with no received data.
 */
export class TcpPipelineLayer extends AbstractPipelineLayer {
  private _state: PipelineLayerState = PipelineLayerState.CONNECTED;
  private _physicalLayer: AbstractPhysicalLayer;
  private _socket: Socket;
  private _idleTid: NodeJS.Timeout | null = null;

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
   * @param socket Connected `Socket` instance.
   * @param idleTimeout Optional inactivity timeout (unit: ms). `0` disables the
   *   timer.
   */
  constructor(physicalLayer: AbstractPhysicalLayer, socket: Socket, idleTimeout?: number) {
    super();

    this._physicalLayer = physicalLayer;
    this._socket = socket;

    const onData = (chunk: Buffer) => {
      if (this.state !== PipelineLayerState.CONNECTED) {
        return;
      }
      this.emit('rx', chunk);
      this.emit('data', chunk);
    };
    socket.on('data', onData);
    this._cleanupFns.add(() => socket.off('data', onData));

    const onSocketError = (err: Error) => {
      this.physicalLayer.emit('error', err);
    };
    socket.on('error', onSocketError);
    this._cleanupFns.add(() => socket.off('error', onSocketError));

    if (idleTimeout && idleTimeout > 0) {
      const resetIdle = () => {
        if (this._idleTid !== null) {
          clearTimeout(this._idleTid);
        }
        this._idleTid = setTimeout(() => {
          this.destroy();
        }, idleTimeout);
      };
      resetIdle();
      socket.on('data', resetIdle);
      this._cleanupFns.add(() => {
        socket.off('data', resetIdle);
        if (this._idleTid !== null) {
          clearTimeout(this._idleTid);
          this._idleTid = null;
        }
      });
    }

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
   * Write a frame to the TCP socket.
   *
   * @param data Encoded frame bytes (unit: byte).
   * @param cb Optional callback invoked once the write completes.
   * @returns `void`.
   */
  override write(data: Buffer, cb?: (err: Error | null) => void): void {
    if (this.state === PipelineLayerState.CONNECTED) {
      this._socket.write(data, (err) => {
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
   * Destroy the underlying socket and tear down the pipeline.
   *
   * @param cb Optional callback invoked once the layer is destroyed.
   * @returns `void`.
   */
  override destroy(cb?: (err: Error | null) => void): void {
    if (this._state === PipelineLayerState.DESTROYED) {
      cb?.(null);
      return;
    }
    if (this._state === PipelineLayerState.DESTROYING) {
      this._pendingDestroyCbs.push(cb);
      return;
    }

    this._state = PipelineLayerState.DESTROYING;
    this._pendingDestroyCbs = [cb];

    if (this._idleTid !== null) {
      clearTimeout(this._idleTid);
      this._idleTid = null;
    }

    this._socket.destroy();
  }
}
