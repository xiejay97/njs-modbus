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

import { SerialPort } from 'serialport';

import { AbstractPhysicalLayer } from '../abstract-physical-layer';
import { AbstractPipelineLayer } from '../abstract-pipeline-layer';
import { PhysicalLayerState, PipelineLayerState } from '../vars';

/**
 * Construction-time configuration for {@link SerialPhysicalLayer}.
 *
 * Forwarded almost verbatim to `node-serialport`; the per-field doc strings
 * mirror the upstream `OpenOptions` semantics so users do not have to cross-
 * reference two manuals. The path / baudRate pair is the only required
 * tuple — every other field has a hardware-safe default.
 */
export interface SerialPhysicalLayerOptions {
  /** The system path of the serial port you want to open. For example, `/dev/tty.XXX` on Mac/Linux, or `COM1` on Windows */
  path: string;
  /**
   * The baud rate of the port to be opened. This should match one of the commonly available baud rates, such as 110, 300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, or 115200. Custom rates are supported best effort per platform. The device connected to the serial port is not guaranteed to support the requested baud rate, even if the port itself supports that baud rate.
   */
  baudRate: number;
  /** Must be one of these: 5, 6, 7, or 8. Defaults to 8 */
  dataBits?: 5 | 6 | 7 | 8;
  /** Prevent other processes from opening the port. Windows does not currently support `false`. Defaults to true */
  lock?: boolean;
  /** Must be 1, 1.5 or 2. Defaults to 1 */
  stopBits?: 1 | 1.5 | 2;
  /** Device parity. Defaults to none */
  parity?: 'none' | 'even' | 'odd' | 'mark' | 'space';
  /** Flow control Setting. Defaults to false */
  rtscts?: boolean;
  /** Flow control Setting. Defaults to false */
  xon?: boolean;
  /** Flow control Setting. Defaults to false */
  xoff?: boolean;
  /** Flow control Setting. Defaults to false */
  xany?: boolean;
  /** drop DTR on close. Defaults to true */
  hupcl?: boolean;
  /** The size of the read and write buffers. Defaults to 64k */
  highWaterMark?: number;
  /** Emit 'end' on port close. Defaults to false */
  endOnClose?: boolean;
  /** see `man termios`. Defaults to 1 (Darwin/Linux only) */
  vmin?: number;
  /** see `man termios`. Defaults to 0 (Darwin/Linux only) */
  vtime?: number;
  /** RTS mode. Defaults to handshake (Windows only) */
  rtsMode?: 'handshake' | 'enable' | 'toggle';
}

/**
 * Serial pipeline layer backed by a `node-serialport` `SerialPort`.
 *
 * Buffers writes so that only one `SerialPort.write`+`drain` cycle is in
 * flight at a time, matching the half-duplex expectations of Modbus RTU/ASCII.
 */
export class SerialPipelineLayer extends AbstractPipelineLayer {
  private _state: PipelineLayerState = PipelineLayerState.CONNECTED;
  private _physicalLayer: SerialPhysicalLayer;
  private _serialport: SerialPort;

  private _isDraining = false;
  private _writeDataQueue: Buffer[] = [];
  private _writeCbQueue: (((err: Error | null) => void) | undefined)[] = [];

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

  /** Underlying `SerialPort` instance. */
  get serialport(): SerialPort {
    return this._serialport;
  }

  /**
   * @param physicalLayer Parent physical layer.
   * @param serialport Opened `SerialPort` instance.
   */
  constructor(physicalLayer: SerialPhysicalLayer, serialport: SerialPort) {
    super();

    this._physicalLayer = physicalLayer;
    this._serialport = serialport;

    const onData = (chunk: Buffer) => {
      if (this.state !== PipelineLayerState.CONNECTED) {
        return;
      }
      this.emit('rx', chunk);
      this.emit('data', chunk);
    };
    serialport.on('data', onData);
    this._cleanupFns.add(() => serialport.off('data', onData));

    const onSerialError = (err: Error) => {
      this.physicalLayer.emit('error', err);
    };
    serialport.on('error', onSerialError);
    this._cleanupFns.add(() => serialport.off('error', onSerialError));

    const cleanupClose = () => serialport.off('close', onClose);
    const onClose = () => {
      this._cleanupFns.delete(cleanupClose);

      this._state = PipelineLayerState.DESTROYED;
      for (const fn of this._cleanupFns) {
        fn();
      }
      this._cleanupFns.clear();

      this._flushQueueWithError(new Error('Pipeline is not connected'));

      for (const fn of this._pendingDestroyCbs) {
        if (fn) {
          fn(null);
        }
      }
      this._pendingDestroyCbs.length = 0;
      this.emit('close');
    };
    serialport.once('close', onClose);
    this._cleanupFns.add(cleanupClose);
  }

  /**
   * Write a frame to the serial port.
   *
   * Writes are serialized so that each frame is fully drained before the next
   * one starts.
   *
   * @param data Encoded frame bytes (unit: byte).
   * @param cb Optional callback invoked once the write (and drain) completes.
   * @returns `void`.
   */
  override write(data: Buffer, cb?: (err: Error | null) => void): void {
    if (this.state === PipelineLayerState.CONNECTED) {
      if (this._isDraining) {
        this._writeDataQueue.push(data);
        this._writeCbQueue.push(cb);
        return;
      }

      this._executeWrite(data, cb);
    } else {
      cb?.(new Error('Pipeline is not connected'));
    }
  }

  private _executeWrite(data: Buffer, cb?: (err: Error | null) => void): void {
    this._isDraining = true;
    this._serialport.write(data, (err) => {
      if (err) {
        this._isDraining = false;
        cb?.(err);

        this._flushQueueWithError(err);
        return;
      }

      cb?.(null);

      this._serialport.drain((drainErr) => {
        if (drainErr) {
          this._isDraining = false;

          this._flushQueueWithError(drainErr);
          return;
        }

        this.emit('tx', data);

        this._isDraining = false;
        this._next();
      });
    });
  }

  private _next(): void {
    if (this._writeDataQueue.length === 0) {
      return;
    }

    const data = this._writeDataQueue.shift()!;
    const cb = this._writeCbQueue.shift()!;
    this._executeWrite(data, cb);
  }

  private _flushQueueWithError(err: Error): void {
    this._isDraining = false;
    for (const cb of this._writeCbQueue) {
      cb?.(err);
    }
    this._writeDataQueue.length = 0;
    this._writeCbQueue.length = 0;
  }

  /**
   * Close the underlying serial port and tear down the pipeline.
   *
   * @param cb Optional callback invoked once the port is closed.
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

    this._serialport.close((err: Error | null) => {
      if (err) {
        for (const fn of this._pendingDestroyCbs) {
          if (fn) {
            fn(null);
          }
        }
        this._pendingDestroyCbs.length = 0;
      }
    });
  }
}

/**
 * Serial physical layer that opens a `node-serialport` port and emits a
 * single {@link SerialPipelineLayer} on `connect`.
 */
export class SerialPhysicalLayer extends AbstractPhysicalLayer {
  private _state: PhysicalLayerState = PhysicalLayerState.CLOSED;
  private _pipelines = new Set<AbstractPipelineLayer>();

  private _serialport: SerialPort | null = null;
  private _serialportOpts: SerialPhysicalLayerOptions;
  private _path: string;
  private _baudRate: number;

  private _pendingOpenCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _pendingCloseCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _cleanupFns = new Set<() => void>();

  /** Current lifecycle state of this physical layer. */
  get state(): PhysicalLayerState {
    return this._state;
  }

  /** Underlying `SerialPort` instance when open, otherwise `null`. */
  get serialport(): SerialPort | null {
    return this._serialport;
  }

  /** System path of the serial port (e.g., `/dev/ttyUSB0`). */
  get path(): string {
    return this._path;
  }

  /** Configured baud rate. */
  get baudRate(): number {
    return this._baudRate;
  }

  /**
   * @param options Serial port open options.
   */
  constructor(options: SerialPhysicalLayerOptions) {
    super();

    this._serialportOpts = options;
    this._path = options.path;
    this._baudRate = options.baudRate;
  }

  /**
   * Open the serial port.
   *
   * @param cb Optional callback invoked once the port is open.
   * @returns `void`.
   */
  override open(cb?: (err: Error | null) => void): void {
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

    const serialport = new SerialPort({ ...this._serialportOpts, autoOpen: false });
    this._serialport = serialport;

    serialport.open((err: Error | null) => {
      if (err) {
        this._state = PhysicalLayerState.CLOSED;
        this._serialport = null;
        for (const fn of this._pendingOpenCbs) {
          if (fn) {
            fn(err);
          }
        }
        this._pendingOpenCbs.length = 0;
      } else {
        this._state = PhysicalLayerState.OPEN;
        for (const fn of this._pendingOpenCbs) {
          if (fn) {
            fn(null);
          }
        }
        this._pendingOpenCbs.length = 0;
        this.emit('open');

        const pipeline = new SerialPipelineLayer(this, serialport);
        this._pipelines.add(pipeline);

        const cleanupClose = () => pipeline.off('close', onClose);
        const onClose = () => {
          this._cleanupFns.delete(cleanupClose);

          this._pipelines.delete(pipeline);

          this._state = PhysicalLayerState.CLOSED;
          this._serialport = null;
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
      }
    });
  }

  /**
   * Close the serial port and destroy any associated pipelines.
   *
   * @param cb Optional callback invoked once the port is closed.
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

    for (const pipeline of this._pipelines) {
      pipeline.destroy((err) => {
        if (err) {
          for (const fn of this._pendingCloseCbs) {
            if (fn) {
              fn(err);
            }
          }
          this._pendingCloseCbs.length = 0;
        }
      });
    }
  }
}
