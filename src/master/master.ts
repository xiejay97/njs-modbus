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

import type { ErrorCode } from '../error-code';
import type { AbstractPipelineAdapter } from '../layers/abstract-pipeline-adapter';
import type { AbstractProtocolLayer, AsciiProtocolLayerOptions, FrameErrorEvent, RtuProtocolLayerOptions } from '../layers/protocol';
import type { AccessAuthorizer, CustomFunctionCode, DeviceIdentification, ModbusFrame, ModbusQueueStrategy, ServerId } from '../types';

import { getErrorByCode } from '../error-code';
import { CompactEventEmitter, generateRequestFingerprint, runCheckAddress, runCheckUnit, TimerHeap } from '../utils';
import {
  COIL_OFF,
  COIL_ON,
  DIAGNOSTICS_RETURN_QUERY_DATA,
  EMPTY_BUFFER,
  EXCEPTION_OFFSET,
  FunctionCode,
  MEI_READ_DEVICE_ID,
  UnauthorizedAccessError,
} from '../vars';
import { FIFO_KEY, MasterSession } from './master-session';
import { RtuProtocolLayer, TcpProtocolLayer, AsciiProtocolLayer } from '../layers/protocol';

/**
 * Events emitted by {@link ModbusMaster}.
 */
export interface ModbusMasterEvents {
  /** A frame failed validation; see {@link FrameErrorEvent}. */
  frameError: [event: FrameErrorEvent];
}

/**
 * Construction-time configuration for {@link ModbusMaster}.
 *
 * The `protocol` discriminator selects the application-layer codec (RTU / TCP /
 * ASCII); each protocol accepts an optional `opts` bag (RTU/ASCII framing
 * options, or `{ transactionId }` for TCP to seed the 16-bit MBAP transaction
 * counter); `queueStrategy` and `timeout` tune the request scheduler; and an
 * optional `customFunctionCodes` array can be seeded at construction time so the
 * master recognises non-standard function codes immediately.
 *
 * @template P Transport protocol literal — `'TCP'`, `'RTU'`, or `'ASCII'`.
 */
export interface ModbusMasterOptions<P extends 'TCP' | 'RTU' | 'ASCII'> {
  pipelineAdapter: AbstractPipelineAdapter;
  protocol: P extends 'TCP'
    ? { type: 'TCP'; opts?: { transactionId?: number } }
    : P extends 'RTU'
      ? { type: 'RTU'; opts?: RtuProtocolLayerOptions }
      : { type: 'ASCII'; opts?: AsciiProtocolLayerOptions };
  /**
   * Modbus ADU queue processing strategy.
   * Controls pruning, deduplication, and scheduling behavior when new requests arrive.
   * - 'fifo': strict first-in-first-out, execute in queued order.
   * - 'drop-stale' (default): last-arrived overwrites; new requests clear all stale unexecuted items in the queue.
   * - 'deduplicate': smart deduplication based on ADU fingerprint.
   * - 'concurrent': concurrent async dispatch (⚠️ Modbus TCP or multi-link Master only, use with caution on RTU bus).
   */
  queueStrategy?: P extends 'TCP' ? ModbusQueueStrategy : Exclude<ModbusQueueStrategy, 'concurrent'>;
  /** Per-request timeout in ms. Default 1000. */
  timeout?: number;
}

/**
 * Resolved response from a Modbus slave / server.
 *
 * `transaction` is only present for Modbus TCP (MBAP transaction id); it is
 * omitted for RTU and ASCII transports. `buffer` is the raw on-wire ADU that
 * produced this response — useful for audit logs or replay debugging.
 *
 * @template T Type of the decoded payload (`Uint8Array` for bit reads,
 *   `Uint16Array` for register reads, `number` for single-value writes, etc.).
 */
export interface ModbusResponse<T> {
  transaction?: number;
  unit: number;
  fc: number;
  data: T;
  buffer: Buffer;
}

interface PendingEntry {
  settled: boolean;
  callback: ((error: Error | null, frame?: ModbusFrame) => void) | null;
  sessionKey: string | number | null;
}

/**
 * Detect a Modbus exception response (V1.1b3 §7).
 *
 * When the server cannot fulfill a request, it replies with `fc | 0x80` and a
 * single-byte exception code. This helper surfaces that as a typed
 * {@link ModbusError} so callers can branch on `err.code` instead of seeing a
 * generic "Malformed Modbus exception response". Returns `null` when the frame is a normal response.
 *
 * @param frame Parsed inbound frame including the raw wire buffer.
 * @param unit Unit / slave address that was sent in the request.
 * @param fc Function code that was sent in the request.
 * @returns The typed exception error, or `null` for a normal response.
 */
function detectException(frame: ModbusFrame, unit: number, fc: number): Error | null {
  if (frame.unit !== unit || frame.fc !== (fc | EXCEPTION_OFFSET)) {
    return null;
  }
  if (frame.data.length < 1) {
    return new Error('Malformed Modbus exception response');
  }
  return getErrorByCode(frame.data[0] as ErrorCode);
}

/**
 * Assert the frame's `(unit, fc)` tuple matches what we sent. Used as the
 * baseline validation step on every public FC handler before further
 * payload-shape checks.
 *
 * @throws `Error('Response unit or function code mismatch')` when either field is wrong.
 */
function validateResponse(frame: ModbusFrame, unit: number, fc: number): void {
  if (frame.unit !== unit || frame.fc !== fc) {
    throw new Error('Response unit or function code mismatch');
  }
}

/**
 * Validate a "byte-count + payload" style response (FC 1/2/3/4/23):
 * `frame.data[0]` must equal `byteCount`, and the total length must equal
 * exactly `1 + byteCount` (no trailing slop, no truncation).
 *
 * @throws `Error('Response shorter than expected')` when shorter than expected,
 *   `Error('Response length mismatch')` on a length mismatch, and
 *   `Error('Response byte count mismatch')` when the byte-count field disagrees
 *   with the actual payload length.
 */
function validateByteCountResponse(frame: ModbusFrame, unit: number, fc: number, byteCount: number): void {
  validateResponse(frame, unit, fc);
  if (frame.data.length < 1 + byteCount) {
    throw new Error('Response shorter than expected');
  }
  if (frame.data.length !== 1 + byteCount) {
    throw new Error('Response length mismatch');
  }
  if (frame.data[0] !== byteCount) {
    throw new Error('Response byte count mismatch');
  }
}

/**
 * Validate an "echo" style response (FC 5/6/15/16/22): the slave must
 * mirror back the address-and-value bytes we sent verbatim.
 *
 * @throws `Error('Response echo shorter than expected')` when the echo is short,
 *   `Error('Response echo length mismatch')` when the echo length differs, and
 *   `Error('Response echo does not match request')` when the echo bytes do not
 *   match.
 */
function validateEchoResponse(frame: ModbusFrame, unit: number, fc: number, expected: Buffer): void {
  validateResponse(frame, unit, fc);
  if (frame.data.length < expected.length) {
    throw new Error('Response echo shorter than expected');
  }
  if (frame.data.length !== expected.length) {
    throw new Error('Response echo length mismatch');
  }
  if (!frame.data.equals(expected)) {
    throw new Error('Response echo does not match request');
  }
}

/**
 * Modbus master / client orchestrator.
 *
 * One instance owns:
 * 1. A single {@link AbstractProtocolLayer} (RTU / TCP / ASCII codec) created
 *    at construction time.
 * 2. A single {@link AbstractPipelineAdapter} supplied at construction time.
 * 3. A request queue with the chosen {@link ModbusQueueStrategy}.
 * 4. A `MasterSession` that matches inbound frames to in-flight
 *    requests by transaction id (TCP) or strict FIFO (RTU/ASCII).
 * 5. A global lazy-deletion `TimerHeap` that arms one native
 *    `setTimeout` per pending exchange under load.
 *
 * The instance emits decoded frames and framing errors on the protocol
 * layer's event surface so external observers can log or audit the wire
 * traffic without touching the internal queue machinery.
 *
 * Lifecycle notes:
 * - A protocol layer is created once in the constructor and lives as long as
 *   the master instance.
 * - The pipeline layer is supplied at construction time and exists for the
 *   lifetime of the master instance.
 *
 * @template P Transport protocol literal — `'TCP'`, `'RTU'`, or `'ASCII'`.
 */
export class ModbusMaster<P extends 'TCP' | 'RTU' | 'ASCII'> extends CompactEventEmitter<ModbusMasterEvents> {
  /** Resolved queue strategy — see {@link ModbusQueueStrategy}. */
  public readonly queueStrategy: ModbusQueueStrategy;
  /** Default per-request timeout in milliseconds. */
  public readonly timeout: number;

  /**
   * The next 16-bit TCP transaction identifier that will be stamped into an
   * outbound MBAP header. For RTU and ASCII transports the counter is unused
   * and remains at its initial value.
   */
  public get transactionId(): number {
    return this._transactionId;
  }

  /** `true` after {@link destroy} has been called. */
  public get destroyed(): boolean {
    return this._destroyed;
  }

  private _destroyed = false;
  private _masterSession = new MasterSession();
  private _protocolLayer: AbstractProtocolLayer;
  private _pipelineAdapter: AbstractPipelineAdapter;
  private _accessAuthorizer?: AccessAuthorizer;
  // Parallel arrays for FIFO queue — avoids creating a queue-entry object per request.
  private _queueUnits: number[] = [];
  private _queueFcs: number[] = [];
  private _queueDatas: Buffer[] = [];
  private _queueTimeouts: number[] = [];
  private _queueBroadcasts: boolean[] = [];
  private _queueCallbacks: ((error: Error | null, frame?: ModbusFrame) => void)[] = [];
  private _queueFingerprints: (number | null)[] = [];
  private _queueHead = 0;
  private _queueLen = 0;
  private _draining = false;
  private _transactionId = 1;
  private _cleanupSession = new Set<() => void>();
  private _nextExchangeId = 1;
  // Global timer heap with lazy deletion — one native setTimeout for all requests.
  private _pendingExchanges = new Map<number, PendingEntry>();
  private _timerHeap = new TimerHeap((id: number) => {
    const pending = this._pendingExchanges.get(id);
    if (!pending) {
      return;
    } // lazy deletion: already handled
    pending.settled = true;
    this._pendingExchanges.delete(id);
    if (pending.sessionKey !== null) {
      this._masterSession.stop(pending.sessionKey);
    }
    const cb = pending.callback;
    if (cb) {
      pending.callback = null;
      cb(new Error('Request timed out'));
    }
  });

  /**
   * @param options Construction options; `protocol` is mandatory,
   *   `queueStrategy` defaults to `'drop-stale'`, and `timeout`
   *   defaults to 1000 ms. An optional `customFunctionCodes` array can be
   *   supplied to pre-register non-standard function codes.
   * @returns A new {@link ModbusMaster} instance.
   * @throws `Error('Concurrent mode requires a Modbus TCP protocol layer')`
   *   when `queueStrategy: 'concurrent'` is paired with a non-TCP protocol —
   *   RTU/ASCII have no transaction id, so concurrent dispatch would have
   *   no way to match responses back to requests.
   */
  constructor(options: ModbusMasterOptions<P>) {
    super();

    this.queueStrategy = options.queueStrategy ?? 'drop-stale';
    this.timeout = options.timeout ?? 1000;
    const protocol = options.protocol;
    const protocolLayer: AbstractProtocolLayer =
      protocol.type === 'TCP'
        ? new TcpProtocolLayer('MASTER')
        : protocol.type === 'RTU'
          ? new RtuProtocolLayer('MASTER', protocol.opts)
          : new AsciiProtocolLayer('MASTER', protocol.opts);
    this._protocolLayer = protocolLayer;

    if (protocol.type === 'TCP' && protocol.opts && protocol.opts.transactionId) {
      this._transactionId = protocol.opts.transactionId;
    }
    const pipelineAdapter = options.pipelineAdapter;
    this._pipelineAdapter = pipelineAdapter;

    const cleanupFrame = () => (protocolLayer.onFrame = undefined);
    const onFrame = (frame: ModbusFrame) => {
      this._masterSession.handleFrame(frame);
    };
    protocolLayer.onFrame = onFrame;
    this._cleanupSession.add(cleanupFrame);

    const cleanupFrameError = () => (protocolLayer.onFrameError = undefined);
    const onFrameError = (event: FrameErrorEvent) => {
      this._masterSession.handleError(new Error(event.message));
      this.emit('frameError', event);
    };
    protocolLayer.onFrameError = onFrameError;
    this._cleanupSession.add(cleanupFrameError);

    const onData = (data: Buffer) => {
      this._protocolLayer.decode(data);
    };
    pipelineAdapter.on('data', onData);
    this._cleanupSession.add(() => pipelineAdapter.off('data', onData));

    this.writeFC1 = this.readCoils;
    this.writeFC2 = this.readDiscreteInputs;
    this.writeFC3 = this.readHoldingRegisters;
    this.writeFC4 = this.readInputRegisters;
    this.writeFC5 = this.writeSingleCoil;
    this.writeFC6 = this.writeSingleRegister;
    this.handleFC8_0 = this.diagnosticsReturnQueryData;
    this.writeFC15 = this.writeMultipleCoils;
    this.writeFC16 = this.writeMultipleRegisters;
    this.handleFC17 = this.reportServerId;
    this.handleFC22 = this.maskWriteRegister;
    this.handleFC23 = this.readAndWriteMultipleRegisters;
    this.handleFC43_14 = this.readDeviceIdentification;
  }

  /**
   * Queue-aware request entry point.
   *
   * Behaviour by {@link queueStrategy}:
   * - **`'concurrent'`** (TCP only): bypass the queue entirely and dispatch
   *   immediately via `_exchange`.
   * - **`'fifo'`**: append to the queue; drained one-at-a-time.
   * - **`'drop-stale'`** (default): reject every pending request with
   *   `Error('Request dropped by drop-stale strategy')`, then enqueue the
   *   new one — keeps only the latest intent.
   * - **`'deduplicate'`**: scan the pending queue and reject every request
   *   whose ADU fingerprint matches the new one, then enqueue.
   *
   * Authorization gates are evaluated in the order
   * function-code support → `checkUnit` → `checkAddress` before any queue
   * insertion or wire I/O, so rejected requests fail fast and never enter
   * the queue.
   *
   * @param unit Unit / slave address byte (0..247).
   * @param fc Modbus function code byte (0..255).
   * @param data PDU payload bytes (length 0..253).
   * @param timeout Per-request timeout override in milliseconds.
   * @param broadcast `true` when `unit === 0` (no response awaited).
   * @param callback Callback invoked with `(err, frame)` on completion.
   * @returns `void`.
   * @throws Via `callback`: `Error('Master has been destroyed')` when the master
   *   instance has already been destroyed; `Error('Unsupported function code 0x..')`
   *   when the FC is neither a standard nor registered custom code;
   *   `Error('Request denied by access authorizer')` / {@link UnauthorizedAccessError}
   *   when `checkUnit` or `checkAddress` rejects the request; typed {@link ModbusError}
   *   when either gate returns a numeric {@link ErrorCode}.
   */
  private _send(
    unit: number,
    fc: number,
    data: Buffer,
    timeout: number,
    broadcast: boolean,
    callback: (error: Error | null, frame?: ModbusFrame) => void,
  ): void {
    if (this._destroyed) {
      callback(new Error('Master has been destroyed'));
      return;
    }

    runCheckUnit(this._accessAuthorizer ? this._accessAuthorizer.checkUnit : undefined, unit, (unitErr, unitErrCode) => {
      if (unitErr) {
        callback(unitErr);
        return;
      }

      const customFC = this._protocolLayer.customFunctionCodes[fc];
      const fingerprint = generateRequestFingerprint(unit, fc, data, customFC);
      if (fingerprint === null) {
        callback(new Error(`Unsupported function code 0x${fc.toString(16).padStart(2, '0')}`));
        return;
      }

      runCheckAddress(
        this._accessAuthorizer ? this._accessAuthorizer.checkAddress : undefined,
        unit,
        fc,
        data,
        customFC,
        (addrErr, addrErrCode) => {
          if (addrErr) {
            callback(addrErr);
            return;
          }

          if (this.queueStrategy === 'concurrent') {
            this._exchange(unit, fc, data, timeout, broadcast, callback);
            return;
          }

          if (this._queueLen > 0) {
            if (this.queueStrategy === 'drop-stale') {
              const rejectErr = new Error('Request dropped by drop-stale strategy');
              const end = this._queueHead + this._queueLen;
              for (let i = this._queueHead; i < end; i++) {
                this._queueCallbacks[i](rejectErr);
              }
              this._queueUnits.length = 0;
              this._queueFcs.length = 0;
              this._queueDatas.length = 0;
              this._queueTimeouts.length = 0;
              this._queueBroadcasts.length = 0;
              this._queueCallbacks.length = 0;
              this._queueFingerprints.length = 0;
              this._queueHead = 0;
              this._queueLen = 0;
            } else if (this.queueStrategy === 'deduplicate') {
              const newKey = fingerprint;
              const rejectErr = new Error('Request dropped by deduplicate strategy');
              const end = this._queueHead + this._queueLen;
              let writeIdx = this._queueHead;
              for (let i = this._queueHead; i < end; i++) {
                const qUnit = this._queueUnits[i];
                const qFc = this._queueFcs[i];
                const qData = this._queueDatas[i];
                const qKey = this._queueFingerprints[i];
                if (qKey !== null && qKey === newKey) {
                  this._queueCallbacks[i](rejectErr);
                } else {
                  if (writeIdx !== i) {
                    this._queueUnits[writeIdx] = qUnit;
                    this._queueFcs[writeIdx] = qFc;
                    this._queueDatas[writeIdx] = qData;
                    this._queueTimeouts[writeIdx] = this._queueTimeouts[i];
                    this._queueBroadcasts[writeIdx] = this._queueBroadcasts[i];
                    this._queueCallbacks[writeIdx] = this._queueCallbacks[i];
                    this._queueFingerprints[writeIdx] = qKey;
                  }
                  writeIdx++;
                }
              }
              // Truncate arrays to remove cleared slots so the next push stays contiguous.
              this._queueUnits.length = writeIdx;
              this._queueFcs.length = writeIdx;
              this._queueDatas.length = writeIdx;
              this._queueTimeouts.length = writeIdx;
              this._queueBroadcasts.length = writeIdx;
              this._queueCallbacks.length = writeIdx;
              this._queueFingerprints.length = writeIdx;
              this._queueLen = writeIdx - this._queueHead;
              if (this._queueLen === 0) {
                this._queueHead = 0;
              }
            }
          }

          this._queueUnits.push(unit);
          this._queueFcs.push(fc);
          this._queueDatas.push(data);
          this._queueTimeouts.push(timeout);
          this._queueBroadcasts.push(broadcast);
          this._queueCallbacks.push(callback);
          this._queueFingerprints.push(fingerprint);
          this._queueLen++;
          this._drain();
        },
      );
    });
  }

  /**
   * Kick off the queue-drain loop if not already running. Idempotent — a
   * second concurrent call returns without re-entering, so the loop stays
   * single-threaded for the FIFO / drop-stale / deduplicate strategies.
   */
  private _drain(): void {
    if (this._draining) {
      return;
    }
    this._draining = true;
    this._processNext();
  }

  /**
   * Pop the head request off the parallel-array queue, dispatch it via
   * `_exchange`, and chain the next pop onto the request's callback.
   *
   * Uses a head-index dequeue (O(1) per pop) instead of `Array.shift()`
   * (O(N) reindex × 6 parallel arrays). The arrays are shrunk back to
   * length 0 once the queue empties so the backing storage is reused
   * across drain cycles instead of growing unboundedly.
   *
   * The drain loop is guarded against synchronous callbacks from
   * `_exchange` (early error paths such as a detached pipeline or
   * access-authorizer rejection): synchronous completion iterates via the
   * `while` loop, asynchronous completion resumes through the callback.
   * This prevents unbounded stack growth when many consecutive requests
   * fail before entering the transport.
   */
  private _processNext(): void {
    if (this._queueLen === 0) {
      this._draining = false;
      return;
    }

    const next = () => {
      while (this._queueLen > 0) {
        // Head-index dequeue: O(1) instead of 6×O(N) shift().
        const h = this._queueHead;
        const unit = this._queueUnits[h];
        const fc = this._queueFcs[h];
        const data = this._queueDatas[h];
        const timeout = this._queueTimeouts[h];
        const broadcast = this._queueBroadcasts[h];
        const callback = this._queueCallbacks[h];
        // Drop references so the GC can reclaim data buffers and callback
        // closures while the rest of the queue is still draining. Primitives
        // (unit/fc/timeout/broadcast) need no clearing.
        this._queueDatas[h] = undefined as any;
        this._queueCallbacks[h] = undefined as any;
        this._queueFingerprints[h] = null;
        this._queueHead = h + 1;
        this._queueLen--;
        if (this._queueLen === 0) {
          // Queue drained: reset head and shrink arrays back to length 0 so the
          // backing storage is reused without growing unboundedly.
          this._queueUnits.length = 0;
          this._queueFcs.length = 0;
          this._queueDatas.length = 0;
          this._queueTimeouts.length = 0;
          this._queueBroadcasts.length = 0;
          this._queueCallbacks.length = 0;
          this._queueFingerprints.length = 0;
          this._queueHead = 0;
        }

        let completed = false;
        let returned = false;
        this._exchange(unit, fc, data, timeout, broadcast, (err, frame) => {
          callback(err, frame);
          if (returned) {
            next();
          } else {
            completed = true;
          }
        });
        returned = true;
        if (completed) {
          continue;
        }
        return;
      }
      this._draining = false;
    };

    next();
  }

  /**
   * Single request/response exchange — the lowest level of the master's
   * write path. Owns the lazy-deletion timer architecture:
   *
   * 1. Allocate an `exchangeId` and register a {@link PendingEntry} so
   *    every async checkpoint can detect cancellation in O(1).
   * 2. Arm the timeout via `TimerHeap`: one shared native
   *    `setTimeout` for ≥3 in-flight requests; per-request timers below
   *    that. On expiry, the heap callback flips `settled = true` and
   *    fires `Error('Request timed out')`.
   * 3. For non-broadcast TCP frames, allocate the next free transaction
   *    id (skipping ids already in the session map), encode the ADU, and
   *    register a `MasterSession` waiter keyed on the tid **before**
   *    `pipeline.write()` is called. Registering the waiter first prevents
   *    responses that arrive before the write callback runs (loopback,
   *    mock transports, or very fast slaves) from being discarded.
   * 4. For non-broadcast RTU/ASCII frames, the session waiter is keyed on
   *    the `FIFO_KEY` constant — only one in-flight request can match at
   *    a time, which is enforced by the upstream queue.
   * 5. For broadcasts (`unit === 0`), no response is expected — the
   *    callback fires as soon as the write resolves (success) or the
   *    timeout elapses.
   *
   * Stale frames (response arrived after `settled = true`) and stale
   * timer fires (response arrived first) are silently discarded — the
   * `settled` flag is the single source of truth.
   *
   * @param unit Unit / slave address byte (0..247).
   * @param fc Modbus function code byte (0..255).
   * @param data PDU payload bytes (length 0..253).
   * @param timeout Per-request timeout override in milliseconds.
   * @param broadcast `true` when `unit === 0` (no response awaited).
   * @param callback Callback invoked with `(err, frame)` on completion.
   * @returns `void`.
   * @throws Via `callback`: `Error('Request denied by access authorizer')` /
   *   {@link UnauthorizedAccessError} when the configured
   *   {@link AccessAuthorizer.checkRuntime} callback rejects the request;
   *   typed {@link ModbusError} when `checkRuntime` returns a numeric
   *   {@link ErrorCode}; the error reported by
   *   {@link AbstractPipelineAdapter.write} when the transport rejects the
   *   outbound bytes; `Error('Request timed out')` when the heap deadline
   *   elapses; typed {@link ModbusError} when the slave returns an exception
   *   response.
   */
  private _exchange(
    unit: number,
    fc: number,
    data: Buffer,
    timeout: number,
    broadcast: boolean,
    callback: (error: Error | null, frame?: ModbusFrame) => void,
  ): void {
    if (!this._accessAuthorizer || !this._accessAuthorizer.checkRuntime) {
      this._runExchange(unit, fc, data, timeout, broadcast, callback);
      return;
    }

    const auth = this._accessAuthorizer.checkRuntime(unit, fc, data);
    if (auth === true) {
      return this._runExchange(unit, fc, data, timeout, broadcast, callback);
    }
    if (auth === false) {
      const dataPreview = data.length > 20 ? `${data.subarray(0, 20).toString('hex')}...` : data.toString('hex');
      return callback(
        new UnauthorizedAccessError(
          `Request intercepted by access authorizer: unit=${unit}, fc=0x${fc.toString(16).padStart(2, '0')}, data=${dataPreview}`,
        ),
      );
    }
    if (typeof auth === 'number') {
      return callback(getErrorByCode(auth));
    }

    auth.then((res) => {
      if (res === false) {
        const dataPreview = data.length > 20 ? `${data.subarray(0, 20).toString('hex')}...` : data.toString('hex');
        return callback(
          new UnauthorizedAccessError(
            `Request intercepted by access authorizer: unit=${unit}, fc=0x${fc.toString(16).padStart(2, '0')}, data=${dataPreview}`,
          ),
        );
      }
      if (typeof res === 'number') {
        return callback(getErrorByCode(res));
      }
      this._runExchange(unit, fc, data, timeout, broadcast, callback);
    }, callback);
  }

  /**
   * Execute the wire write for a single exchange.
   *
   * This is the synchronous continuation of `_exchange` after access
   * control has approved the request. It encodes the frame, registers the
   * session waiter, arms the timer, and writes to the pipeline adapter.
   *
   * @param unit Unit / slave address byte (0..247).
   * @param fc Modbus function code byte (0..255).
   * @param data PDU payload bytes (length 0..253).
   * @param timeout Per-request timeout override in milliseconds.
   * @param broadcast `true` when `unit === 0` (no response awaited).
   * @param callback Callback invoked with `(err, frame)` on completion.
   * @returns `void`.
   */
  private _runExchange(
    unit: number,
    fc: number,
    data: Buffer,
    timeout: number,
    broadcast: boolean,
    callback: (error: Error | null, frame?: ModbusFrame) => void,
  ): void {
    // FIFO mode: clear stale buffer state before this request.
    // Concurrent mode: must not flush — other in-flight requests share the buffer.
    if (this.queueStrategy !== 'concurrent') {
      this._protocolLayer.flush();
    }

    // Lazy-deletion timer architecture:
    // 1. Assign an exchangeId and register in _pendingExchanges.
    // 2. Push deadline into the global TimerHeap (one native setTimeout under
    //    load; a fast direct-timer path is used when only 1-2 exchanges are
    //    pending).
    // 3. When the response arrives, delete from Map — the heap entry is left
    //    behind and silently discarded when it surfaces at the top (lazy deletion).
    const exchangeId = this._nextExchangeId++;
    const pending: PendingEntry = { settled: false, callback, sessionKey: null };
    this._pendingExchanges.set(exchangeId, pending);

    let tid: number | undefined;
    if (this._protocolLayer.PROTOCOL === 'TCP') {
      do {
        tid = this._transactionId;
        this._transactionId = (this._transactionId + 1) & 0xffff || 1;
      } while (this._masterSession.has(tid));
    }

    if (broadcast) {
      // Broadcast: no response expected. Skip the session entirely.
      this._timerHeap.add(exchangeId, timeout);
      this._pipelineAdapter.write(this._protocolLayer.encode(unit, fc, data, tid), (writeErr) => {
        if (pending.settled) {
          return;
        }
        const cb = pending.callback;
        if (!cb) {
          return;
        }
        pending.settled = true;
        pending.callback = null;
        this._pendingExchanges.delete(exchangeId);
        if (writeErr) {
          cb(writeErr);
        } else {
          cb(null);
        }
      });
      return;
    }

    const key: string | number = tid ?? FIFO_KEY;
    const payload = this._protocolLayer.encode(unit, fc, data, tid);

    pending.sessionKey = key;
    this._timerHeap.add(exchangeId, timeout);

    // Register the session waiter BEFORE handing the bytes to the pipeline.
    // Responses can arrive before the write callback runs on loopback / mock
    // transports or in concurrent TCP mode; registering first guarantees the
    // frame is matched instead of dropped.
    this._masterSession.start(key, (err, frame) => {
      if (pending.settled) {
        return;
      }
      const cb = pending.callback;
      if (cb) {
        pending.settled = true;
        pending.callback = null;
        this._pendingExchanges.delete(exchangeId);
        cb(err, frame);
      }
    });

    this._pipelineAdapter.write(payload, (writeErr?: Error | null) => {
      if (pending.settled) {
        return;
      }
      if (writeErr) {
        const cb = pending.callback;
        if (cb) {
          pending.settled = true;
          pending.callback = null;
          this._pendingExchanges.delete(exchangeId);
          this._masterSession.stop(key);
          cb(writeErr);
        }
      }
    });
  }

  /**
   * Shared implementation for FC 1 (Read Coils) and FC 2 (Read Discrete Inputs).
   *
   * The two FCs share an identical request body (`address` + `length`,
   * each big-endian 16-bit) and an identical response shape (a byte-count
   * prefix followed by `(length + 7) >> 3` packed bits, LSB-first inside
   * each byte per V1.1b3 §6.1). This helper unpacks the bit-packed payload
   * into a `number[]` of 0/1 values via an inlined per-byte 8-way
   * shift-and-mask.
   *
   * @param unit Unit / slave address byte (0..247).
   * @param fc Function code byte — `FunctionCode.READ_COILS` or
   *   `FunctionCode.READ_DISCRETE_INPUTS`.
   * @param address Zero-based starting address (0..0xFFFF).
   * @param length Number of discretes to read (1..2000).
   * @param timeout Per-request timeout override in milliseconds.
   * @returns Promise resolving to `{ unit, fc, data, buffer }` where `data`
   *   is a length-`length` `(0 | 1)[]`, or `void` for broadcast.
   *
   * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
   */
  private writeFC1Or2(unit: number, fc: number, address: number, length: number, timeout: number) {
    const byteCount = (length + 7) >> 3;

    const bufferTx = Buffer.allocUnsafe(4);
    bufferTx[0] = (address >>> 8) & 0xff;
    bufferTx[1] = address & 0xff;
    bufferTx[2] = (length >>> 8) & 0xff;
    bufferTx[3] = length & 0xff;

    return new Promise<ModbusResponse<(0 | 1)[]> | void>((resolve, reject) => {
      this._send(unit, fc, bufferTx, timeout, unit === 0, (err, frame) => {
        if (err) {
          reject(err);
          return;
        }
        if (!frame) {
          resolve(undefined);
          return;
        }
        const exception = detectException(frame, unit, fc);
        if (exception) {
          reject(exception);
          return;
        }
        try {
          validateByteCountResponse(frame, unit, fc, byteCount);
          const data = new Array<0 | 1>(length);
          let byteIdx = 1;
          let outIdx = 0;
          const fullBytes = length >> 3;
          for (let b = 0; b < fullBytes; b++) {
            const byte = frame.data[byteIdx++];
            data[outIdx++] = (byte & 0x01) as 0 | 1;
            data[outIdx++] = ((byte >>> 1) & 0x01) as 0 | 1;
            data[outIdx++] = ((byte >>> 2) & 0x01) as 0 | 1;
            data[outIdx++] = ((byte >>> 3) & 0x01) as 0 | 1;
            data[outIdx++] = ((byte >>> 4) & 0x01) as 0 | 1;
            data[outIdx++] = ((byte >>> 5) & 0x01) as 0 | 1;
            data[outIdx++] = ((byte >>> 6) & 0x01) as 0 | 1;
            data[outIdx++] = ((byte >>> 7) & 0x01) as 0 | 1;
          }
          const rem = length & 7;
          if (rem) {
            const byte = frame.data[byteIdx];
            data[outIdx++] = (byte & 0x01) as 0 | 1;
            if (rem > 1) {
              data[outIdx++] = ((byte >>> 1) & 0x01) as 0 | 1;
            }
            if (rem > 2) {
              data[outIdx++] = ((byte >>> 2) & 0x01) as 0 | 1;
            }
            if (rem > 3) {
              data[outIdx++] = ((byte >>> 3) & 0x01) as 0 | 1;
            }
            if (rem > 4) {
              data[outIdx++] = ((byte >>> 4) & 0x01) as 0 | 1;
            }
            if (rem > 5) {
              data[outIdx++] = ((byte >>> 5) & 0x01) as 0 | 1;
            }
            if (rem > 6) {
              data[outIdx++] = ((byte >>> 6) & 0x01) as 0 | 1;
            }
          }
          (frame as { data: unknown }).data = data;
          resolve(frame as unknown as ModbusResponse<(0 | 1)[]>);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Alias for {@link readCoils} — kept for users that prefer the FC-numeric naming. */
  public writeFC1: this['readCoils'];
  /**
   * FC 1 — Read Coils (V1.1b3 §6.1). Reads `length` discrete coil values
   * starting at `address`.
   *
   * @param unit Unit / slave address. Pass `0` for broadcast (no response
   *   awaited; resolves with `void`).
   * @param address Zero-based coil starting address (0..0xFFFF).
   * @param length Number of coils to read (1..2000 per spec).
   * @param timeout Per-request timeout override in milliseconds; defaults
   *   to {@link timeout}.
   * @returns Promise resolving to `{ unit, fc, data, buffer }` where `data`
   *   is a length-`length` `(0 | 1)[]` of 0/1 values.
   * @throws `Error('Request timed out')` when no response arrives within `timeout`;
   *   typed {@link ModbusError} when the slave returns an exception response.
   */
  public readCoils(unit: 0, address: number, length: number, timeout?: number): Promise<void>;
  public readCoils(unit: number, address: number, length: number, timeout?: number): Promise<ModbusResponse<(0 | 1)[]>>;
  public readCoils(unit: number, address: number, length: number, timeout = this.timeout): Promise<ModbusResponse<(0 | 1)[]> | void> {
    return this.writeFC1Or2(unit, FunctionCode.READ_COILS, address, length, timeout);
  }

  /** Alias for {@link readDiscreteInputs}. */
  public writeFC2: this['readDiscreteInputs'];
  /**
   * FC 2 — Read Discrete Inputs (V1.1b3 §6.2). Identical request/response
   * shape to FC 1, against the read-only discrete-input table.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param address Zero-based discrete-input starting address (0..0xFFFF).
   * @param length Number of inputs to read (1..2000).
   * @param timeout Per-request timeout override (ms).
   * @returns Promise resolving to a `(0 | 1)[]` of 0/1 values, or `void` for broadcast.
   * @throws Same as {@link readCoils}.
   */
  public readDiscreteInputs(unit: 0, address: number, length: number, timeout?: number): Promise<void>;
  public readDiscreteInputs(unit: number, address: number, length: number, timeout?: number): Promise<ModbusResponse<(0 | 1)[]>>;
  public readDiscreteInputs(
    unit: number,
    address: number,
    length: number,
    timeout = this.timeout,
  ): Promise<ModbusResponse<(0 | 1)[]> | void> {
    return this.writeFC1Or2(unit, FunctionCode.READ_DISCRETE_INPUTS, address, length, timeout);
  }

  /**
   * Shared implementation for FC 3 (Read Holding Registers) and FC 4 (Read
   * Input Registers).
   *
   * Both FCs share an identical request body (`address` + `length`, each
   * big-endian 16-bit) and an identical response shape (byte-count prefix
   * followed by `length` big-endian 16-bit values). The response loop uses
   * inline `(buf[i] << 8) | buf[i+1]` reads instead of `readUInt16BE` —
   * at FC 3's max length of 125 that saves 250 bounds-check pairs per
   * response — per CLAUDE.md "Hot Paths: Strictly Inline".
   *
   * @param unit Unit / slave address byte (0..247).
   * @param fc Function code byte — `FunctionCode.READ_HOLDING_REGISTERS` or
   *   `FunctionCode.READ_INPUT_REGISTERS`.
   * @param address Zero-based starting address (0..0xFFFF).
   * @param length Number of registers to read (1..125).
   * @param timeout Per-request timeout override in milliseconds.
   * @returns Promise resolving to `{ unit, fc, data, buffer }` where `data`
   *   is a length-`length` `number[]` of 16-bit register values, or `void`
   *   for broadcast.
   *
   * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
   */
  private writeFC3Or4(unit: number, fc: number, address: number, length: number, timeout: number) {
    const byteCount = length * 2;

    const bufferTx = Buffer.allocUnsafe(4);
    // Inline big-endian writes — see writeFC1Or2 for the rationale.
    bufferTx[0] = (address >>> 8) & 0xff;
    bufferTx[1] = address & 0xff;
    bufferTx[2] = (length >>> 8) & 0xff;
    bufferTx[3] = length & 0xff;

    return new Promise<ModbusResponse<number[]> | void>((resolve, reject) => {
      this._send(unit, fc, bufferTx, timeout, unit === 0, (err, frame) => {
        if (err) {
          reject(err);
          return;
        }
        if (!frame) {
          resolve(undefined);
          return;
        }
        const exception = detectException(frame, unit, fc);
        if (exception) {
          reject(exception);
          return;
        }
        try {
          validateByteCountResponse(frame, unit, fc, byteCount);
          const data = new Array<number>(length);
          let off = 1;
          for (let i = 0; i < length; i++) {
            data[i] = (frame.data[off] << 8) | frame.data[off + 1];
            off += 2;
          }
          (frame as { data: unknown }).data = data;
          resolve(frame as unknown as ModbusResponse<number[]>);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Alias for {@link readHoldingRegisters}. */
  public writeFC3: this['readHoldingRegisters'];
  /**
   * FC 3 — Read Holding Registers (V1.1b3 §6.3). Reads `length` holding
   * registers starting at `address`.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param address Zero-based register starting address (0..0xFFFF).
   * @param length Number of registers to read (1..125 per spec).
   * @param timeout Per-request timeout override (ms).
   * @returns Promise resolving to a length-`length` `number[]` of 16-bit
   *   register values.
   * @throws Same as {@link readCoils}.
   */
  public readHoldingRegisters(unit: 0, address: number, length: number, timeout?: number): Promise<void>;
  public readHoldingRegisters(unit: number, address: number, length: number, timeout?: number): Promise<ModbusResponse<number[]>>;
  public readHoldingRegisters(
    unit: number,
    address: number,
    length: number,
    timeout = this.timeout,
  ): Promise<ModbusResponse<number[]> | void> {
    return this.writeFC3Or4(unit, FunctionCode.READ_HOLDING_REGISTERS, address, length, timeout);
  }

  /** Alias for {@link readInputRegisters}. */
  public writeFC4: this['readInputRegisters'];
  /**
   * FC 4 — Read Input Registers (V1.1b3 §6.4). Identical request/response
   * shape to FC 3, against the read-only input-register table.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param address Zero-based register starting address (0..0xFFFF).
   * @param length Number of registers to read (1..125).
   * @param timeout Per-request timeout override (ms).
   * @returns Promise resolving to a `number[]` of 16-bit register values.
   * @throws Same as {@link readCoils}.
   */
  public readInputRegisters(unit: 0, address: number, length: number, timeout?: number): Promise<void>;
  public readInputRegisters(unit: number, address: number, length: number, timeout?: number): Promise<ModbusResponse<number[]>>;
  public readInputRegisters(
    unit: number,
    address: number,
    length: number,
    timeout = this.timeout,
  ): Promise<ModbusResponse<number[]> | void> {
    return this.writeFC3Or4(unit, FunctionCode.READ_INPUT_REGISTERS, address, length, timeout);
  }

  /** Alias for {@link writeSingleCoil}. */
  public writeFC5: this['writeSingleCoil'];
  /**
   * FC 5 — Write Single Coil (V1.1b3 §6.5). Sets a single coil to ON / OFF.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param address Zero-based coil address (0..0xFFFF).
   * @param value Coil state — pass `0` for OFF (`0x0000` on the wire) and any
   *   non-zero value for ON (`0xFF00`).
   * @param timeout Per-request timeout override (ms).
   * @returns Promise resolving to `{ data: value, ... }` echoed from the slave.
   * @throws Same as {@link readCoils}.
   */
  public writeSingleCoil(unit: 0, address: number, value: number, timeout?: number): Promise<void>;
  public writeSingleCoil(unit: number, address: number, value: number, timeout?: number): Promise<ModbusResponse<number>>;
  public writeSingleCoil(unit: number, address: number, value: number, timeout = this.timeout): Promise<ModbusResponse<number> | void> {
    const fc = FunctionCode.WRITE_SINGLE_COIL;

    const bufferTx = Buffer.allocUnsafe(4);
    const coilValue = value === 0 ? COIL_OFF : COIL_ON;
    // Inline big-endian writes — see writeFC1Or2 for the rationale.
    bufferTx[0] = (address >>> 8) & 0xff;
    bufferTx[1] = address & 0xff;
    bufferTx[2] = (coilValue >>> 8) & 0xff;
    bufferTx[3] = coilValue & 0xff;

    return new Promise<ModbusResponse<number> | void>((resolve, reject) => {
      this._send(unit, fc, bufferTx, timeout, unit === 0, (err, frame) => {
        if (err) {
          reject(err);
          return;
        }
        if (!frame) {
          resolve(undefined);
          return;
        }
        const exception = detectException(frame, unit, fc);
        if (exception) {
          reject(exception);
          return;
        }
        try {
          validateEchoResponse(frame, unit, fc, bufferTx);
          (frame as { data: unknown }).data = value;
          resolve(frame as unknown as ModbusResponse<number>);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Alias for {@link writeSingleRegister}. */
  public writeFC6: this['writeSingleRegister'];
  /**
   * FC 6 — Write Single Register (V1.1b3 §6.6). Writes one 16-bit value
   * into the holding-register table.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param address Zero-based register address (0..0xFFFF).
   * @param value Big-endian 16-bit value to write (0..0xFFFF).
   * @param timeout Per-request timeout override (ms).
   * @returns Promise resolving to `{ data: value, ... }` echoed from the slave.
   * @throws Same as {@link readCoils}.
   */
  public writeSingleRegister(unit: 0, address: number, value: number, timeout?: number): Promise<void>;
  public writeSingleRegister(unit: number, address: number, value: number, timeout?: number): Promise<ModbusResponse<number>>;
  public writeSingleRegister(unit: number, address: number, value: number, timeout = this.timeout): Promise<ModbusResponse<number> | void> {
    const fc = FunctionCode.WRITE_SINGLE_REGISTER;

    const bufferTx = Buffer.allocUnsafe(4);
    // Inline big-endian writes — see writeFC1Or2 for the rationale.
    bufferTx[0] = (address >>> 8) & 0xff;
    bufferTx[1] = address & 0xff;
    bufferTx[2] = (value >>> 8) & 0xff;
    bufferTx[3] = value & 0xff;

    return new Promise<ModbusResponse<number> | void>((resolve, reject) => {
      this._send(unit, fc, bufferTx, timeout, unit === 0, (err, frame) => {
        if (err) {
          reject(err);
          return;
        }
        if (!frame) {
          resolve(undefined);
          return;
        }
        const exception = detectException(frame, unit, fc);
        if (exception) {
          reject(exception);
          return;
        }
        try {
          validateEchoResponse(frame, unit, fc, bufferTx);
          (frame as { data: unknown }).data = value;
          resolve(frame as unknown as ModbusResponse<number>);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Alias for {@link diagnosticsReturnQueryData}. */
  public handleFC8_0: this['diagnosticsReturnQueryData'];
  /**
   * FC 8 / Sub-function 0x0000 — Diagnostics: Return Query Data (V1.1b3 §6.8).
   * Sends a 2-byte sub-function code (`0x0000`) and a 2-byte data value; the
   * slave echoes both back verbatim. Used for loopback / communication testing.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param data 16-bit diagnostic data value (0..0xFFFF) sent big-endian.
   * @param timeout Per-request timeout override in milliseconds.
   * @returns Promise resolving to `{ data: number, ... }` where `data` is the
   *   echoed 16-bit value.
   * @throws Same as {@link readCoils}; `Error('Response echo does not match request')`
   *   when the echoed data does not match the request.
   */
  public diagnosticsReturnQueryData(unit: 0, data: number, timeout?: number): Promise<void>;
  public diagnosticsReturnQueryData(unit: number, data: number, timeout?: number): Promise<ModbusResponse<number>>;
  public diagnosticsReturnQueryData(unit: number, data: number, timeout = this.timeout): Promise<ModbusResponse<number> | void> {
    const fc = FunctionCode.DIAGNOSTICS;

    const bufferTx = Buffer.allocUnsafe(4);
    // Inline big-endian writes.
    bufferTx[0] = (DIAGNOSTICS_RETURN_QUERY_DATA >>> 8) & 0xff;
    bufferTx[1] = DIAGNOSTICS_RETURN_QUERY_DATA & 0xff;
    bufferTx[2] = (data >>> 8) & 0xff;
    bufferTx[3] = data & 0xff;

    return new Promise<ModbusResponse<number> | void>((resolve, reject) => {
      this._send(unit, fc, bufferTx, timeout, unit === 0, (err, frame) => {
        if (err) {
          reject(err);
          return;
        }
        if (!frame) {
          resolve(undefined);
          return;
        }
        const exception = detectException(frame, unit, fc);
        if (exception) {
          reject(exception);
          return;
        }
        try {
          validateEchoResponse(frame, unit, fc, bufferTx);
          (frame as { data: unknown }).data = data;
          resolve(frame as unknown as ModbusResponse<number>);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Alias for {@link writeMultipleCoils}. */
  public writeFC15: this['writeMultipleCoils'];
  /**
   * FC 15 — Write Multiple Coils (V1.1b3 §6.11). Writes a contiguous block
   * of coil values starting at `address`.
   *
   * Coil values are bit-packed LSB-first into the request body — the
   * inline 8-way pack in this method's body matches the 8-way unpack in
   * `writeFC1Or2` for symmetry.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param address Zero-based coil starting address (0..0xFFFF).
   * @param value Coil values to write — `ArrayLike<0 | 1>` where element `i`
   *   is `0` (OFF) or `1` (ON). Length must be 1..1968 per spec.
   * @param timeout Per-request timeout override (ms).
   * @returns Promise resolving to `{ data: value, ... }` (the original input
   *   value, not the wire echo, for caller convenience).
   * @throws Same as {@link readCoils}.
   */
  public writeMultipleCoils(unit: 0, address: number, value: ArrayLike<0 | 1>, timeout?: number): Promise<void>;
  public writeMultipleCoils<T extends ArrayLike<0 | 1> = ArrayLike<0 | 1>>(
    unit: number,
    address: number,
    value: T,
    timeout?: number,
  ): Promise<ModbusResponse<T>>;
  public writeMultipleCoils<T extends ArrayLike<0 | 1> = ArrayLike<0 | 1>>(
    unit: number,
    address: number,
    value: T,
    timeout = this.timeout,
  ): Promise<ModbusResponse<T> | void> {
    const fc = FunctionCode.WRITE_MULTIPLE_COILS;
    const len = value.length;
    const byteCount = (len + 7) >> 3;

    const bufferTx = Buffer.allocUnsafe(5 + byteCount);
    // Inline big-endian writes — see writeFC1Or2 for the rationale.
    bufferTx[0] = (address >>> 8) & 0xff;
    bufferTx[1] = address & 0xff;
    bufferTx[2] = (len >>> 8) & 0xff;
    bufferTx[3] = len & 0xff;
    bufferTx[4] = byteCount;
    let out = 5;
    const fullBytes = len >> 3;
    for (let b = 0; b < fullBytes; b++) {
      const base = b << 3;
      bufferTx[out++] =
        (value[base] & 1) |
        ((value[base + 1] & 1) << 1) |
        ((value[base + 2] & 1) << 2) |
        ((value[base + 3] & 1) << 3) |
        ((value[base + 4] & 1) << 4) |
        ((value[base + 5] & 1) << 5) |
        ((value[base + 6] & 1) << 6) |
        ((value[base + 7] & 1) << 7);
    }
    const rem = len & 7;
    if (rem) {
      const base = fullBytes << 3;
      let acc = value[base] & 1;
      if (rem > 1) {
        acc |= (value[base + 1] & 1) << 1;
      }
      if (rem > 2) {
        acc |= (value[base + 2] & 1) << 2;
      }
      if (rem > 3) {
        acc |= (value[base + 3] & 1) << 3;
      }
      if (rem > 4) {
        acc |= (value[base + 4] & 1) << 4;
      }
      if (rem > 5) {
        acc |= (value[base + 5] & 1) << 5;
      }
      if (rem > 6) {
        acc |= (value[base + 6] & 1) << 6;
      }
      bufferTx[out] = acc;
    }

    return new Promise<ModbusResponse<T> | void>((resolve, reject) => {
      this._send(unit, fc, bufferTx, timeout, unit === 0, (err, frame) => {
        if (err) {
          reject(err);
          return;
        }
        if (!frame) {
          resolve(undefined);
          return;
        }
        const exception = detectException(frame, unit, fc);
        if (exception) {
          reject(exception);
          return;
        }
        try {
          validateEchoResponse(frame, unit, fc, bufferTx.subarray(0, 4));
          (frame as { data: unknown }).data = value;
          resolve(frame as unknown as ModbusResponse<T>);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Alias for {@link writeMultipleRegisters}. */
  public writeFC16: this['writeMultipleRegisters'];
  /**
   * FC 16 — Write Multiple Registers (V1.1b3 §6.12). Writes a contiguous
   * block of 16-bit holding-register values starting at `address`.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param address Zero-based register starting address (0..0xFFFF).
   * @param value Register values to write as an `ArrayLike<number>` (each
   *   element is a 16-bit word, 0..0xFFFF). Length must be 1..123 per spec.
   * @param timeout Per-request timeout override (ms).
   * @returns Promise resolving to `{ data: value, ... }` (the original input
   *   value; the wire echo is just the address+quantity tuple).
   * @throws Same as {@link readCoils}.
   */
  public writeMultipleRegisters(unit: 0, address: number, value: ArrayLike<number>, timeout?: number): Promise<void>;
  public writeMultipleRegisters<T extends ArrayLike<number> = ArrayLike<number>>(
    unit: number,
    address: number,
    value: T,
    timeout?: number,
  ): Promise<ModbusResponse<T>>;
  public writeMultipleRegisters<T extends ArrayLike<number> = ArrayLike<number>>(
    unit: number,
    address: number,
    value: T,
    timeout = this.timeout,
  ): Promise<ModbusResponse<T> | void> {
    const fc = FunctionCode.WRITE_MULTIPLE_REGISTERS;
    const byteCount = value.length * 2;

    const bufferTx = Buffer.allocUnsafe(5 + byteCount);
    // Inline big-endian writes — see writeFC1Or2 for the rationale.
    bufferTx[0] = (address >>> 8) & 0xff;
    bufferTx[1] = address & 0xff;
    bufferTx[2] = (value.length >>> 8) & 0xff;
    bufferTx[3] = value.length & 0xff;
    bufferTx[4] = byteCount;
    let off = 5;
    for (let i = 0; i < value.length; i++) {
      const v = value[i];
      bufferTx[off] = (v >>> 8) & 0xff;
      bufferTx[off + 1] = v & 0xff;
      off += 2;
    }

    return new Promise<ModbusResponse<T> | void>((resolve, reject) => {
      this._send(unit, fc, bufferTx, timeout, unit === 0, (err, frame) => {
        if (err) {
          reject(err);
          return;
        }
        if (!frame) {
          resolve(undefined);
          return;
        }
        const exception = detectException(frame, unit, fc);
        if (exception) {
          reject(exception);
          return;
        }
        try {
          validateEchoResponse(frame, unit, fc, bufferTx.subarray(0, 4));
          (frame as { data: unknown }).data = value;
          resolve(frame as unknown as ModbusResponse<T>);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Alias for {@link reportServerId}. */
  public handleFC17: this['reportServerId'];
  /**
   * FC 17 — Report Server ID (V1.1b3 §6.13). Queries the slave for its
   * vendor-specific identification block.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param serverIdLength Number of bytes the slave is expected to use for
   *   `serverId`. Defaults to `1`. The remaining bytes are surfaced as
   *   `additionalData` so legacy multi-byte server IDs can be parsed
   *   without losing the trailing payload.
   * @param timeout Per-request timeout override (ms).
   * @returns Promise resolving to `{ data: ServerId, ... }`.
   * @throws Same as {@link readCoils}; `Error('Report server ID response too short')`
   *   when the response is too short to contain `serverIdLength` bytes;
   *   `Error('Report server ID length mismatch')` when the embedded byte-count
   *   disagrees with the actual response length.
   */
  public reportServerId(unit: 0, serverIdLength?: number, timeout?: number): Promise<void>;
  public reportServerId(unit: number, serverIdLength?: number, timeout?: number): Promise<ModbusResponse<ServerId>>;
  public reportServerId(unit: number, serverIdLength = 1, timeout = this.timeout): Promise<ModbusResponse<ServerId> | void> {
    const fc = FunctionCode.REPORT_SERVER_ID;

    return new Promise<ModbusResponse<ServerId> | void>((resolve, reject) => {
      this._send(unit, fc, EMPTY_BUFFER, timeout, unit === 0, (err, frame) => {
        if (err) {
          reject(err);
          return;
        }
        if (!frame) {
          resolve(undefined);
          return;
        }
        const exception = detectException(frame, unit, fc);
        if (exception) {
          reject(exception);
          return;
        }
        try {
          validateResponse(frame, unit, fc);
          if (frame.data.length < 2 + serverIdLength) {
            throw new Error('Report server ID response too short');
          }
          if (frame.data.length !== 1 + frame.data[0]) {
            throw new Error('Report server ID length mismatch');
          }
          const runStatusIndex = 1 + serverIdLength;
          (frame as { data: unknown }).data = {
            serverId: frame.data.subarray(1, runStatusIndex),
            runIndicatorStatus: frame.data[runStatusIndex] === 0xff,
            additionalData: frame.data.subarray(runStatusIndex + 1),
          };
          resolve(frame as unknown as ModbusResponse<ServerId>);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Alias for {@link maskWriteRegister}. */
  public handleFC22: this['maskWriteRegister'];
  /**
   * FC 22 — Mask Write Register (V1.1b3 §6.16). Atomically updates one
   * holding register: `result = (current AND andMask) OR (orMask AND NOT andMask)`.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param address Zero-based register address (0..0xFFFF).
   * @param andMask 16-bit AND mask (0..0xFFFF).
   * @param orMask 16-bit OR mask (0..0xFFFF).
   * @param timeout Per-request timeout override (ms).
   * @returns Promise resolving to `{ data: { andMask, orMask }, ... }`
   *   echoed from the slave.
   * @throws Same as {@link readCoils}.
   */
  public maskWriteRegister(unit: 0, address: number, andMask: number, orMask: number, timeout?: number): Promise<void>;
  public maskWriteRegister(
    unit: number,
    address: number,
    andMask: number,
    orMask: number,
    timeout?: number,
  ): Promise<ModbusResponse<{ andMask: number; orMask: number }>>;
  public maskWriteRegister(
    unit: number,
    address: number,
    andMask: number,
    orMask: number,
    timeout = this.timeout,
  ): Promise<ModbusResponse<{ andMask: number; orMask: number }> | void> {
    const fc = FunctionCode.MASK_WRITE_REGISTER;

    const bufferTx = Buffer.allocUnsafe(6);
    // Inline big-endian writes — see writeFC1Or2 for the rationale.
    bufferTx[0] = (address >>> 8) & 0xff;
    bufferTx[1] = address & 0xff;
    bufferTx[2] = (andMask >>> 8) & 0xff;
    bufferTx[3] = andMask & 0xff;
    bufferTx[4] = (orMask >>> 8) & 0xff;
    bufferTx[5] = orMask & 0xff;

    return new Promise<ModbusResponse<{ andMask: number; orMask: number }> | void>((resolve, reject) => {
      this._send(unit, fc, bufferTx, timeout, unit === 0, (err, frame) => {
        if (err) {
          reject(err);
          return;
        }
        if (!frame) {
          resolve(undefined);
          return;
        }
        const exception = detectException(frame, unit, fc);
        if (exception) {
          reject(exception);
          return;
        }
        try {
          validateEchoResponse(frame, unit, fc, bufferTx);
          (frame as { data: unknown }).data = { andMask, orMask };
          resolve(frame as unknown as ModbusResponse<{ andMask: number; orMask: number }>);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Alias for {@link readAndWriteMultipleRegisters}. */
  public handleFC23: this['readAndWriteMultipleRegisters'];
  /**
   * FC 23 — Read/Write Multiple Registers (V1.1b3 §6.17). Atomically
   * performs a write-then-read against two register windows in one frame.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param read Read window: `{ address, length }` (length 1..125).
   * @param write Write window: `{ address, value }` where `value` is an
   *   `ArrayLike<number>` of 1..121 registers.
   * @param timeout Per-request timeout override (ms).
   * @returns Promise resolving to `{ data: number[], ... }` containing the
   *   read window values **after** the write has been applied.
   * @throws Same as {@link readCoils}.
   */
  public readAndWriteMultipleRegisters(
    unit: 0,
    read: { address: number; length: number },
    write: { address: number; value: ArrayLike<number> },
    timeout?: number,
  ): Promise<void>;
  public readAndWriteMultipleRegisters<T extends ArrayLike<number> = ArrayLike<number>>(
    unit: number,
    read: { address: number; length: number },
    write: { address: number; value: T },
    timeout?: number,
  ): Promise<ModbusResponse<number[]>>;
  public readAndWriteMultipleRegisters<T extends ArrayLike<number> = ArrayLike<number>>(
    unit: number,
    read: { address: number; length: number },
    write: { address: number; value: T },
    timeout = this.timeout,
  ): Promise<ModbusResponse<number[]> | void> {
    const fc = FunctionCode.READ_WRITE_MULTIPLE_REGISTERS;
    const byteCount = write.value.length * 2;
    const readByteCount = read.length * 2;

    const bufferTx = Buffer.allocUnsafe(9 + byteCount);
    // Inline big-endian writes — see writeFC1Or2 for the rationale.
    bufferTx[0] = (read.address >>> 8) & 0xff;
    bufferTx[1] = read.address & 0xff;
    bufferTx[2] = (read.length >>> 8) & 0xff;
    bufferTx[3] = read.length & 0xff;
    bufferTx[4] = (write.address >>> 8) & 0xff;
    bufferTx[5] = write.address & 0xff;
    bufferTx[6] = (write.value.length >>> 8) & 0xff;
    bufferTx[7] = write.value.length & 0xff;
    bufferTx[8] = byteCount;
    let off = 9;
    for (let i = 0; i < write.value.length; i++) {
      const v = write.value[i];
      bufferTx[off] = (v >>> 8) & 0xff;
      bufferTx[off + 1] = v & 0xff;
      off += 2;
    }

    return new Promise<ModbusResponse<number[]> | void>((resolve, reject) => {
      this._send(unit, fc, bufferTx, timeout, unit === 0, (err, frame) => {
        if (err) {
          reject(err);
          return;
        }
        if (!frame) {
          resolve(undefined);
          return;
        }
        const exception = detectException(frame, unit, fc);
        if (exception) {
          reject(exception);
          return;
        }
        try {
          validateByteCountResponse(frame, unit, fc, readByteCount);
          const data = new Array<number>(read.length);
          let off = 1;
          for (let i = 0; i < read.length; i++) {
            data[i] = (frame.data[off] << 8) | frame.data[off + 1];
            off += 2;
          }
          (frame as { data: unknown }).data = data;
          resolve(frame as unknown as ModbusResponse<number[]>);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /** Alias for {@link readDeviceIdentification}. */
  public handleFC43_14: this['readDeviceIdentification'];
  /**
   * FC 43 / MEI 14 — Read Device Identification (V1.1b3 §6.21). Queries
   * the slave's TLV identification table.
   *
   * The response is parsed into a {@link DeviceIdentification} record:
   * each TLV is unpacked into `{ id, value }` (where `value` is the ASCII
   * decoding of the byte run), and `moreFollows` / `nextObjectId` are
   * surfaced verbatim so callers can fragment-walk the table by re-issuing
   * the call with `objectId = nextObjectId` until `moreFollows === false`.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param readDeviceIDCode `1`/`2`/`3` for streaming basic / regular /
   *   extended; `4` for individual access — see `ReadDeviceIDCode`.
   * @param objectId Starting object id (0..0xFF). For streaming
   *   reads, the slave returns objects starting from this id.
   * @param timeout Per-request timeout override (ms).
   * @returns Promise resolving to `{ data: DeviceIdentification, ... }`.
   * @throws Same as {@link readCoils}; `Error('Read device identification response too short')`
   *   when the response is below the 6-byte MEI header; `Error('Invalid read device identification response')`
   *   when the MEI byte / readDeviceIDCode does not match; `Error('Device identification object count mismatch')`
   *   when the embedded number-of-objects disagrees with the parsed count; and
   *   `Error('Device identification length mismatch')` when the total length
   *   does not match the cumulative TLV body length.
   */
  public readDeviceIdentification(unit: 0, readDeviceIDCode: number, objectId: number, timeout?: number): Promise<void>;
  public readDeviceIdentification(
    unit: number,
    readDeviceIDCode: number,
    objectId: number,
    timeout?: number,
  ): Promise<ModbusResponse<DeviceIdentification>>;
  public readDeviceIdentification(
    unit: number,
    readDeviceIDCode: number,
    objectId: number,
    timeout = this.timeout,
  ): Promise<ModbusResponse<DeviceIdentification> | void> {
    const fc = FunctionCode.READ_DEVICE_IDENTIFICATION;

    return new Promise<ModbusResponse<DeviceIdentification> | void>((resolve, reject) => {
      this._send(unit, fc, Buffer.from([MEI_READ_DEVICE_ID, readDeviceIDCode, objectId]), timeout, unit === 0, (err, frame) => {
        if (err) {
          reject(err);
          return;
        }
        if (!frame) {
          resolve(undefined);
          return;
        }
        const exception = detectException(frame, unit, fc);
        if (exception) {
          reject(exception);
          return;
        }
        try {
          validateResponse(frame, unit, fc);
          if (frame.data.length < 6) {
            throw new Error('Read device identification response too short');
          }
          if (frame.data[0] !== MEI_READ_DEVICE_ID || frame.data[1] !== readDeviceIDCode) {
            throw new Error('Invalid read device identification response');
          }

          const objects: { id: number; value: string }[] = [];
          let object: [number?, number?, number[]?] = [];
          let totalBytes = 0;
          for (const v of frame.data.subarray(6)) {
            switch (object.length) {
              case 0:
              case 1: {
                object.push(v);
                break;
              }

              case 2: {
                object.push([v]);
                break;
              }

              case 3: {
                object[2]!.push(v);
                if (object[1] === object[2]!.length) {
                  objects.push({ id: object[0]!, value: Buffer.from(object[2]!).toString() });
                  totalBytes += 2 + object[1];
                  object = [];
                }
                break;
              }

              default:
                break;
            }
          }
          if (objects.length !== frame.data[5]) {
            throw new Error('Device identification object count mismatch');
          }
          if (frame.data.length !== 6 + totalBytes) {
            throw new Error('Device identification length mismatch');
          }

          (frame as { data: unknown }).data = {
            readDeviceIDCode,
            conformityLevel: frame.data[2],
            moreFollows: frame.data[3] === 0xff,
            nextObjectId: frame.data[4],
            objects,
          };
          resolve(frame as unknown as ModbusResponse<DeviceIdentification>);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /**
   * Issue a request against a custom (non-standard) function code.
   *
   * The FC must already be registered via {@link addCustomFunctionCode} on
   * the master — otherwise the queue layer rejects the call with
   * `Error('Unsupported function code 0x..')`.
   *
   * @param unit Unit / slave address; `0` = broadcast.
   * @param fc Custom function-code byte.
   * @param data Request PDU payload (bytes after FC, before checksum).
   *   Accepts a `Buffer` for arbitrary bytes, or a `number[]` for a
   *   word-oriented payload that will be encoded big-endian.
   * @param timeout Per-request timeout override (ms).
   * @returns Promise resolving to the raw response PDU `Buffer` (no FC,
   *   no checksum) — caller is responsible for parsing the body.
   * @throws `Error('Request timed out')` when no response arrives within `timeout`;
   *   typed {@link ModbusError} when the slave returns an exception response.
   */
  public sendCustomFC(unit: 0, fc: number, data: Buffer | number[], timeout?: number): Promise<void>;
  public sendCustomFC(unit: number, fc: number, data: Buffer | number[], timeout?: number): Promise<Buffer>;
  public sendCustomFC(unit: number, fc: number, data: Buffer | number[], timeout = this.timeout): Promise<Buffer | void> {
    let payload: Buffer;
    if (Buffer.isBuffer(data)) {
      payload = data;
    } else {
      payload = Buffer.allocUnsafe(data.length * 2);
      let off = 0;
      for (let i = 0; i < data.length; i++) {
        const v = data[i];
        payload[off] = (v >>> 8) & 0xff;
        payload[off + 1] = v & 0xff;
        off += 2;
      }
    }

    return new Promise<Buffer | void>((resolve, reject) => {
      this._send(unit, fc, payload, timeout, unit === 0, (err, frame) => {
        if (err) {
          reject(err);
          return;
        }
        if (!frame) {
          resolve(undefined);
          return;
        }
        const exception = detectException(frame, unit, fc);
        if (exception) {
          reject(exception);
          return;
        }
        try {
          validateResponse(frame, unit, fc);
          resolve(frame.data);
        } catch (e) {
          reject(e);
        }
      });
    });
  }

  /**
   * Register a custom (non-standard) function code for outbound requests.
   *
   * For RTU transports the descriptor must also include `determineFrameLength` so the
   * framing layer can determine the total frame length without buffering.
   *
   * @param cfc Custom function-code descriptor.
   */
  public addCustomFunctionCode(
    cfc: P extends 'RTU'
      ? CustomFunctionCode & { determineFrameLength: (getByte: (idx: number) => number, length: number) => number }
      : CustomFunctionCode,
  ): void {
    this._protocolLayer.addCustomFunctionCode(cfc);
  }

  /**
   * Unregister a previously added custom function code.
   *
   * @param fc Function code byte to remove.
   */
  public removeCustomFunctionCode(fc: number): void {
    this._protocolLayer.customFunctionCodes[fc] = undefined;
  }

  /** Remove all custom function codes registered on this master. */
  public removeAllCustomFunctionCodes(): void {
    this._protocolLayer.customFunctionCodes.fill(undefined);
  }

  /**
   * Install an access-control policy on the master.
   *
   * The policy is evaluated for every outbound request:
   * - `checkUnit` and `checkAddress` are evaluated in `_send`, before
   *   queue insertion, so rejected requests fail fast and never enter the queue.
   * - `checkRuntime` is evaluated in `_exchange`, after the queue drains but
   *   before any wire I/O.
   *
   * Requests that fail any gate are rejected locally and never sent to the
   * transport.
   *
   * @param authorizer The policy to enforce. Omit a hook to disable that gate.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * master.setAccessAuthorizer({
   *   checkUnit: (unit) => unit === 1,
   *   checkAddress: (_unit, table, [start, end]) =>
   *     table === 'holdingRegisters' && start >= 0 && end < 100,
   * });
   * ```
   */
  public setAccessAuthorizer(authorizer: AccessAuthorizer) {
    this._accessAuthorizer = authorizer;
  }

  /**
   * Remove the access-control policy installed by {@link setAccessAuthorizer}.
   *
   * After this call all outbound requests flow through the master without any
   * access-control gate until a new authorizer is installed.
   *
   * @returns `this` for chaining.
   */
  public deleteAccessAuthorizer() {
    this._accessAuthorizer = undefined;
  }

  /**
   * Destroy the master and cancel all pending activity.
   *
   * After this call the instance is unusable: pending queue entries and
   * in-flight exchanges are rejected with `Error('Master has been destroyed')`,
   * timers are cleared, and listeners are removed.
   */
  public destroy(): void {
    if (this._destroyed) {
      return;
    }
    this._destroyed = true;

    for (const cleanup of this._cleanupSession) {
      cleanup();
    }
    this._cleanupSession.clear();

    this.removeAllListeners();

    this._timerHeap.clear();

    const rejectErr = new Error('Master has been destroyed');
    const end = this._queueHead + this._queueLen;
    this._queueLen = 0;
    for (let i = this._queueHead; i < end; i++) {
      this._queueCallbacks[i](rejectErr);
    }
    this._queueUnits.length = 0;
    this._queueFcs.length = 0;
    this._queueDatas.length = 0;
    this._queueTimeouts.length = 0;
    this._queueBroadcasts.length = 0;
    this._queueCallbacks.length = 0;
    this._queueFingerprints.length = 0;
    this._queueHead = 0;

    this._masterSession.stopAll(rejectErr);

    for (const pending of this._pendingExchanges.values()) {
      if (pending.settled) {
        continue;
      }
      pending.settled = true;
      const cb = pending.callback;
      if (cb) {
        pending.callback = null;
        cb(rejectErr);
      }
    }
    this._pendingExchanges.clear();

    this.removeAllCustomFunctionCodes();
    this.deleteAccessAuthorizer();
  }
}
