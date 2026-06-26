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

import type { UdpConnectionSecurityOptions } from '../connection-security-options';
import type { BindOptions, RemoteInfo, Socket, SocketOptions } from 'node:dgram';

import { createSocket } from 'node:dgram';

import { canonicalizeIp } from '../../utils/canonicalize-ip';
import { createIpMatchers } from '../../utils/ip-whitelist';
import { AbstractPhysicalLayer } from '../abstract-physical-layer';
import { AbstractPipelineLayer } from '../abstract-pipeline-layer';
import { PhysicalLayerState, PipelineLayerState } from '../vars';

/**
 * UDP server-side pipeline layer representing one remote peer.
 *
 * Created by {@link UdpServerPhysicalLayer} for each unique remote address;
 * destroyed automatically after `idleTimeout` ms with no traffic.
 */
export class UdpServerPipelineLayer extends AbstractPipelineLayer {
  private _state: PipelineLayerState = PipelineLayerState.CONNECTED;
  private _physicalLayer: UdpServerPhysicalLayer;
  private _socket: Socket;
  private _remote: RemoteInfo;
  private _idleTid: NodeJS.Timeout | null = null;

  private _cleanupFns = new Set<() => void>();

  /** Current lifecycle state of this pipeline. */
  get state(): PipelineLayerState {
    return this._state;
  }

  /** Parent physical layer that created this pipeline. */
  get physicalLayer(): AbstractPhysicalLayer {
    return this._physicalLayer;
  }

  /** Underlying shared UDP `Socket` instance. */
  get socket(): Socket {
    return this._socket;
  }

  /** Remote peer address information. */
  get remote(): RemoteInfo {
    return this._remote;
  }

  /**
   * @param physicalLayer Parent physical layer.
   * @param socket Shared UDP `Socket` instance.
   * @param remote Remote peer information.
   * @param idleTimeout Inactivity timeout (unit: ms); `0` disables the timer.
   * @param messageEventDelegation Hook for subscribing to datagrams scoped to this peer.
   */
  constructor(
    physicalLayer: UdpServerPhysicalLayer,
    socket: Socket,
    remote: RemoteInfo,
    idleTimeout: number,
    messageEventDelegation: {
      add: (listener: (msg: Buffer, rinfo: RemoteInfo) => void) => void;
      remove: (listener: (...args: any[]) => void) => void;
    },
  ) {
    super();

    this._physicalLayer = physicalLayer;
    this._socket = socket;
    this._remote = remote;

    const onMessage = (msg: Buffer) => {
      if (this.state !== PipelineLayerState.CONNECTED) {
        return;
      }

      if (this._idleTid !== null) {
        clearTimeout(this._idleTid);
        this._idleTid = null;
        if (idleTimeout > 0) {
          this._idleTid = setTimeout(() => {
            this.destroy();
          }, idleTimeout);
        }
      }

      this.emit('rx', msg);
      this.emit('data', msg);
    };
    messageEventDelegation.add(onMessage);
    this._cleanupFns.add(() => messageEventDelegation.remove(onMessage));

    if (idleTimeout > 0) {
      this._idleTid = setTimeout(() => {
        this.destroy();
      }, idleTimeout);
    }
  }

  /**
   * Send a frame to the remote peer.
   *
   * @param data Encoded frame bytes (unit: byte).
   * @param cb Optional callback invoked once the datagram is sent.
   * @returns `void`.
   */
  override write(data: Buffer, cb?: (err: Error | null) => void): void {
    if (this.state === PipelineLayerState.CONNECTED) {
      this._socket.send(data, this._remote.port, this._remote.address, (err) => {
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
   * Tear down this peer pipeline and stop the idle timer.
   *
   * @param cb Optional callback invoked once the pipeline is destroyed.
   * @returns `void`.
   */
  override destroy(cb?: (err: Error | null) => void): void {
    if (this.state === PipelineLayerState.DESTROYED) {
      cb?.(null);
      return;
    }

    this._state = PipelineLayerState.DESTROYED;

    for (const fn of this._cleanupFns) {
      fn();
    }
    this._cleanupFns.clear();
    if (this._idleTid !== null) {
      clearTimeout(this._idleTid);
      this._idleTid = null;
    }

    cb?.(null);
    this.emit('close');
  }
}

/**
 * UDP server physical layer.
 *
 * Binds a UDP socket, creates a {@link UdpServerPipelineLayer} for every
 * unique remote peer, and emits it through the `connect` event.
 */
export class UdpServerPhysicalLayer extends AbstractPhysicalLayer {
  private _state: PhysicalLayerState = PhysicalLayerState.CLOSED;
  private _pipelines = new Map<string, { pipeline: UdpServerPipelineLayer; listeners: Set<(...args: any[]) => void> }>();

  private _socket: Socket | null = null;
  private _socketOpts: SocketOptions;
  private _whitelist: ((address: string) => boolean) | null = null;
  private _maxConnections: number = 0;
  private _maxConnectionsPerIp: number = 0;
  private _idleTimeout: number = 0;

  private _pipelinesByIp = new Map<string, Set<string>>();

  private _pendingOpenCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _pendingCloseCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _cleanupFns = new Set<() => void>();

  /** Current lifecycle state of this physical layer. */
  get state(): PhysicalLayerState {
    return this._state;
  }

  /** Underlying `Socket` instance when bound, otherwise `null`. */
  get socket(): Socket | null {
    return this._socket;
  }

  /**
   * @param options Optional `SocketOptions`. Defaults to `udp4`.
   * @param security Optional security and resource-limit options.
   */
  constructor(options?: SocketOptions, security?: UdpConnectionSecurityOptions) {
    super();

    this._socketOpts = { ...options, type: options?.type ?? 'udp4' };
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
   * Bind the UDP socket and start accepting datagrams from remote peers.
   *
   * @param options Bind options. Port defaults to `502` (unit: port number).
   * @param cb Optional callback invoked once the socket is bound.
   * @returns `void`.
   */
  override open(options: BindOptions, cb?: (err: Error | null) => void): void {
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

    const socket = createSocket(this._socketOpts, (msg, rinfo) => {
      const address = canonicalizeIp(rinfo.address);
      if (this._whitelist && !this._whitelist(address)) {
        this.emit('connectionRejected', {
          reason: 'whitelist' as const,
          address,
          port: rinfo.port,
        });
        return;
      }

      const id = `${rinfo.address}:${rinfo.port}`;
      let pipelineEntry = this._pipelines.get(id);
      if (!pipelineEntry) {
        if (this._maxConnections > 0 && this._pipelines.size >= this._maxConnections) {
          this.emit('connectionRejected', {
            reason: 'max_connections' as const,
            address,
            port: rinfo.port,
          });
          return;
        }

        if (this._maxConnectionsPerIp > 0 && (this._pipelinesByIp.get(address)?.size ?? 0) >= this._maxConnectionsPerIp) {
          this.emit('connectionRejected', {
            reason: 'max_connections_per_ip' as const,
            address,
            port: rinfo.port,
          });
          return;
        }

        const listeners = new Set<(...args: any[]) => void>();
        const pipeline = new UdpServerPipelineLayer(this, socket, rinfo, this._idleTimeout, {
          add: (listener) => {
            listeners.add(listener);
          },
          remove: (listener) => {
            listeners.delete(listener);
          },
        });
        pipelineEntry = { pipeline, listeners };
        this._pipelines.set(id, pipelineEntry);

        let peerIdsForIp = this._pipelinesByIp.get(address);
        if (!peerIdsForIp) {
          peerIdsForIp = new Set<string>();
          this._pipelinesByIp.set(address, peerIdsForIp);
        }
        peerIdsForIp.add(id);

        const cleanupClose = () => pipeline.off('close', onClose);
        const onClose = () => {
          this._cleanupFns.delete(cleanupClose);
          this._pipelines.delete(id);
          const set = this._pipelinesByIp.get(address);
          if (set) {
            set.delete(id);
            if (set.size === 0) {
              this._pipelinesByIp.delete(address);
            }
          }
        };
        pipeline.once('close', onClose);
        this._cleanupFns.add(cleanupClose);

        this.emit('connect', pipeline);
      }
      for (const fn of pipelineEntry.listeners) {
        fn(msg, rinfo);
      }
    });
    this._socket = socket;

    const onListening = () => {
      socket.off('error', onError);

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
        socket.on('error', onError);
        this._cleanupFns.add(() => socket.off('error', onError));

        const cleanupClose = () => socket.off('close', onClose);
        const onClose = () => {
          this._cleanupFns.delete(cleanupClose);
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
        socket.once('close', onClose);
        this._cleanupFns.add(cleanupClose);
      }
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

    socket.bind({ ...options, port: options?.port ?? 502 });
  }

  /**
   * Close the UDP socket and destroy all peer pipelines.
   *
   * @param cb Optional callback invoked once the socket is closed.
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

    this.socket!.close();
    for (const pipeline of [...this._pipelines]) {
      pipeline[1].pipeline.destroy();
    }
  }
}
