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

import type { AccessAuthorizer, ApplicationDataUnit, CustomFunctionCode, ModbusFrame, ModbusQueueStrategy } from '../types';
import type { AccessAuditEvent, CallbackLazy, ModbusUnitModel, PipelineFaultEvent, ProtocolExceptionEvent } from './types';
import type { AbstractPipelineAdapter } from '../layers/abstract-pipeline-adapter';
import type { AbstractProtocolLayer, AsciiProtocolLayerOptions, FrameErrorEvent, RtuProtocolLayerOptions } from '../layers/protocol';

import { ErrorCode } from '../error-code';
import { AsciiProtocolLayer, RtuProtocolLayer, TcpProtocolLayer } from '../layers/protocol';
import { CompactEventEmitter, generateRequestFingerprint, runCheckAddress, runCheckUnit } from '../utils';
import {
  COIL_OFF,
  COIL_ON,
  ConformityLevel,
  DIAGNOSTICS_RETURN_QUERY_DATA,
  EXCEPTION_OFFSET,
  FunctionCode,
  LIMITS,
  MEI_READ_DEVICE_ID,
  ReadDeviceIDCode,
} from '../vars';

const WRITE_FUNCTION_FLAGS = new Uint8Array(256);
WRITE_FUNCTION_FLAGS[FunctionCode.WRITE_SINGLE_COIL] = 1;
WRITE_FUNCTION_FLAGS[FunctionCode.WRITE_SINGLE_REGISTER] = 1;
WRITE_FUNCTION_FLAGS[FunctionCode.WRITE_MULTIPLE_COILS] = 1;
WRITE_FUNCTION_FLAGS[FunctionCode.WRITE_MULTIPLE_REGISTERS] = 1;
WRITE_FUNCTION_FLAGS[FunctionCode.MASK_WRITE_REGISTER] = 1;
WRITE_FUNCTION_FLAGS[FunctionCode.READ_WRITE_MULTIPLE_REGISTERS] = 1;

const ADDRESS_TABLES: ('coils' | 'discreteInputs' | 'inputRegisters' | 'holdingRegisters')[] = [
  'coils',
  'discreteInputs',
  'inputRegisters',
  'holdingRegisters',
];

/**
 * Events emitted by {@link ModbusSlave}.
 */
export interface ModbusSlaveEvents {
  /** A frame failed validation; see {@link FrameErrorEvent}. */
  frameError: [event: FrameErrorEvent];
  /** The slave produced a Modbus exception response; see {@link ProtocolExceptionEvent}. */
  protocolException: [event: ProtocolExceptionEvent];
  /** A request was rejected by the configured access authorizer; see {@link AccessAuditEvent}. */
  accessAudit: [event: AccessAuditEvent];
  /** The pipeline layer failed to transmit a response; see {@link PipelineFaultEvent}. */
  pipelineFault: [event: PipelineFaultEvent];
}

/**
 * Construction-time configuration for {@link ModbusSlave}.
 *
 * The `protocol` discriminator selects the application-layer codec (RTU / TCP /
 * ASCII); `queueStrategy` and `enableWriteRangeLock` tune the frame scheduler.
 *
 * @template P Transport protocol literal — `'TCP'`, `'RTU'`, or `'ASCII'`.
 */
export interface ModbusSlaveOptions<P extends 'TCP' | 'RTU' | 'ASCII'> {
  pipelineAdapter: AbstractPipelineAdapter;
  protocol: P extends 'TCP'
    ? { type: 'TCP' }
    : P extends 'RTU'
      ? { type: 'RTU'; opts?: RtuProtocolLayerOptions }
      : { type: 'ASCII'; opts?: AsciiProtocolLayerOptions };
  /**
   * Modbus ADU queue processing strategy.
   * Controls pruning, deduplication, and scheduling behavior when new frames arrive.
   * - 'fifo': strict first-in-first-out, execute in queued order.
   * - 'drop-stale' (default): last-arrived overwrites; new frames clear all stale unexecuted items in the queue.
   * - 'deduplicate': smart deduplication based on ADU fingerprint.
   * - 'concurrent': concurrent async dispatch (⚠️ Modbus TCP only, use with caution on RTU bus).
   */
  queueStrategy?: P extends 'TCP' ? ModbusQueueStrategy : Exclude<ModbusQueueStrategy, 'concurrent'>;
  /**
   * When `queueStrategy` is `'concurrent'`, serialize concurrent write
   * requests (FC05/06/15/16) whose address ranges overlap on the same unit.
   * Set to `false` for purely synchronous in-memory slaves that do not need
   * the coordination overhead.
   * @default true
   */
  enableWriteRangeLock?: boolean;
}

interface QueueEntry {
  frames: ModbusFrame[];
  processing: boolean;
}

interface WriteRequest {
  unit: number;
  ranges: number[];
  shouldRespond: boolean;
  frame: ModbusFrame;
  model: ModbusUnitModel | null;
  onDone?: () => void;
  inFlightIndex?: number;
}

interface UnitWriteQueue {
  inFlight: WriteRequest[];
  pending: WriteRequest[];
}

function rangesOverlap(a: WriteRequest, b: WriteRequest): boolean {
  const aRanges = a.ranges;
  const bRanges = b.ranges;
  for (let i = 0; i < aRanges.length; i += 2) {
    const aStart = aRanges[i];
    const aEnd = aRanges[i + 1];
    for (let j = 0; j < bRanges.length; j += 2) {
      const bStart = bRanges[j];
      const bEnd = bRanges[j + 1];
      if (aStart < bEnd && bStart < aEnd) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Modbus slave / server orchestrator.
 *
 * One instance owns:
 * 1. A single {@link AbstractProtocolLayer} (RTU / TCP / ASCII codec) created
 *    at construction time.
 * 2. A single {@link AbstractPipelineAdapter} supplied at construction time.
 * 3. A {@link ModbusQueueStrategy} frame queue for non-concurrent modes.
 * 4. Per-unit write-range locking for concurrent TCP mode when
 *    `enableWriteRangeLock` is `true`.
 * 5. Typed access control, protocol, and pipeline fault events.
 *
 * Register unit models with {@link addUnit}, install an optional
 * {@link AccessAuthorizer} with {@link setAccessAuthorizer}, and destroy with
 * {@link destroy} when the transport closes.
 *
 * @template P Transport protocol literal — `'TCP'`, `'RTU'`, or `'ASCII'`.
 */
export class ModbusSlave<P extends 'TCP' | 'RTU' | 'ASCII'> extends CompactEventEmitter<ModbusSlaveEvents> {
  public readonly queueStrategy: ModbusQueueStrategy;
  public readonly enableWriteRangeLock: boolean;

  /** `true` after {@link destroy} has been called. */
  public get destroyed(): boolean {
    return this._destroyed;
  }

  private _destroyed = false;
  private _units = new Map<number, ModbusUnitModel>();
  private _protocolLayer: AbstractProtocolLayer;
  private _pipelineAdapter: AbstractPipelineAdapter;
  private _cfcResponses = new Map<number, (unit: number, fc: number, data: Buffer, callback: CallbackLazy<Buffer>) => void>();
  private _accessAuthorizer?: AccessAuthorizer;
  private _queue: QueueEntry = { frames: [], processing: false };
  private _cleanupSession = new Set<() => void>();
  private _unitWriteQueues: UnitWriteQueue[] = Array.from({ length: 256 }, () => ({
    inFlight: [],
    pending: [],
  }));
  private _flushingPending = false;
  private _pendingFlushPending = false;

  /**
   * @param options Construction options; `protocol` is mandatory,
   *   `queueStrategy` defaults to `'drop-stale'`, and `enableWriteRangeLock`
   *   defaults to `true`.
   * @throws `Error('Concurrent mode requires a Modbus TCP protocol layer')`
   *   when `queueStrategy: 'concurrent'` is paired with a non-TCP protocol.
   */
  constructor(options: ModbusSlaveOptions<P>) {
    super();

    this.queueStrategy = options.queueStrategy ?? 'drop-stale';
    this.enableWriteRangeLock = options.enableWriteRangeLock ?? true;
    const protocol = options.protocol;
    const protocolLayer: AbstractProtocolLayer =
      protocol.type === 'TCP'
        ? new TcpProtocolLayer('SLAVE')
        : protocol.type === 'RTU'
          ? new RtuProtocolLayer('SLAVE', protocol.opts)
          : new AsciiProtocolLayer('SLAVE', protocol.opts);
    this._protocolLayer = protocolLayer;
    const pipelineAdapter = options.pipelineAdapter;
    this._pipelineAdapter = pipelineAdapter;

    const cleanupFrame = () => (protocolLayer.onFrame = undefined);
    const onFrame = (frame: ModbusFrame) => {
      runCheckUnit(this._accessAuthorizer ? this._accessAuthorizer.checkUnit : undefined, frame.unit, (unitErr, unitErrCode) => {
        if (unitErr) {
          if (frame.unit !== 0x00 && unitErrCode !== undefined) {
            const responseRaw = protocolLayer.encode(
              frame.unit,
              frame.fc | EXCEPTION_OFFSET,
              Buffer.from([unitErrCode]),
              frame.transaction,
            );
            pipelineAdapter.write(responseRaw, (err) => {
              if (err) {
                this.emit('pipelineFault', {
                  type: 'write_failed',
                  message: `Failed to write unit access denied response for unit ${frame.unit}, function ${frame.fc}`,
                  transaction: frame.transaction,
                  unit: frame.unit,
                  fc: frame.fc,
                  data: Buffer.from(frame.data),
                  responseRaw,
                  error: err,
                });
              }
            });
          }
          this.emitLazy('accessAudit', () => ({
            type: 'unit_access_denied',
            message: `Unit ${frame.unit} access denied`,
            transaction: frame.transaction,
            unit: frame.unit,
            fc: frame.fc,
            data: Buffer.from(frame.data),
          }));
          return;
        }

        const customFC = protocolLayer.customFunctionCodes[frame.fc];
        const fingerprint = generateRequestFingerprint(frame.unit, frame.fc, frame.data, customFC);
        if (fingerprint === null) {
          if (frame.unit !== 0x00) {
            const responseRaw = protocolLayer.encode(
              frame.unit,
              frame.fc | EXCEPTION_OFFSET,
              Buffer.from([ErrorCode.ILLEGAL_FUNCTION]),
              frame.transaction,
            );
            pipelineAdapter.write(responseRaw, (err) => {
              if (err) {
                this.emit('pipelineFault', {
                  type: 'write_failed',
                  message: `Failed to write illegal function response for unit ${frame.unit}, function ${frame.fc}`,
                  transaction: frame.transaction,
                  unit: frame.unit,
                  fc: frame.fc,
                  data: Buffer.from(frame.data),
                  responseRaw,
                  error: err,
                });
              }
            });
          }
          this.emit('protocolException', {
            type: 'function_illegal',
            message: `Function code ${frame.fc} is not supported`,
            transaction: frame.transaction,
            unit: frame.unit,
            fc: frame.fc,
            data: Buffer.from(frame.data),
          });
          return;
        }
        (frame as any)._fingerprint = fingerprint;

        runCheckAddress(
          this._accessAuthorizer ? this._accessAuthorizer.checkAddress : undefined,
          frame.unit,
          frame.fc,
          frame.data,
          customFC,
          (addrErr, addrErrCode) => {
            if (addrErr) {
              if (frame.unit !== 0x00 && addrErrCode !== undefined) {
                const responseRaw = protocolLayer.encode(
                  frame.unit,
                  frame.fc | EXCEPTION_OFFSET,
                  Buffer.from([addrErrCode]),
                  frame.transaction,
                );
                pipelineAdapter.write(responseRaw, (err) => {
                  if (err) {
                    this.emit('pipelineFault', {
                      type: 'write_failed',
                      message: `Failed to write address access denied response for unit ${frame.unit}, function ${frame.fc}`,
                      transaction: frame.transaction,
                      unit: frame.unit,
                      fc: frame.fc,
                      data: Buffer.from(frame.data),
                      responseRaw,
                      error: err,
                    });
                  }
                });
              }
              this.emitLazy('accessAudit', () => ({
                type: 'address_access_denied',
                message: `Address access denied for unit ${frame.unit}, function ${frame.fc}`,
                transaction: frame.transaction,
                unit: frame.unit,
                fc: frame.fc,
                data: Buffer.from(frame.data),
              }));
              return;
            }

            if (this.queueStrategy === 'concurrent') {
              this._processFrame(frame);
              return;
            }

            if (this._queue.frames.length > 0) {
              if (this.queueStrategy === 'drop-stale') {
                this._queue.frames.length = 0;
              } else if (this.queueStrategy === 'deduplicate') {
                const newKey = fingerprint;
                for (let i = this._queue.frames.length - 1; i >= 0; i--) {
                  const f = this._queue.frames[i];
                  const fCustomFC = protocolLayer.customFunctionCodes[f.fc];
                  const fKey =
                    (f as any)._fingerprint !== undefined
                      ? (f as any)._fingerprint
                      : generateRequestFingerprint(f.unit, f.fc, f.data, fCustomFC);

                  if (fKey !== null && fKey === newKey) {
                    this._queue.frames.splice(i, 1);
                  }
                }
              }
            }

            this._queue.frames.push(frame);
            if (!this._queue.processing) {
              this._queue.processing = true;
              const next = () => {
                while (this._queue.frames.length > 0) {
                  const frame = this._queue.frames.shift()!;
                  let completed = false;
                  let returned = false;
                  this._processFrame(frame, () => {
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
                this._queue.processing = false;
              };
              next();
            }
          },
        );
      });
    };
    protocolLayer.onFrame = onFrame;
    this._cleanupSession.add(cleanupFrame);

    const cleanupFrameError = () => (protocolLayer.onFrameErrorLazy = undefined);
    const onFrameError = (lazy: () => FrameErrorEvent) => {
      this.emitLazy('frameError', lazy);
    };
    protocolLayer.onFrameErrorLazy = onFrameError;
    this._cleanupSession.add(cleanupFrameError);

    const onData = (data: Buffer) => {
      this._protocolLayer.decode(data);
    };
    pipelineAdapter.on('data', onData);
    this._cleanupSession.add(() => pipelineAdapter.off('data', onData));
  }

  private _handleFC1(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length !== 4) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC01`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const length = (frame.data[2] << 8) | frame.data[3];
    if (length < LIMITS.READ_COILS_MIN || length > LIMITS.READ_COILS_MAX) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `Read coil count ${length} is out of range`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    if (!model.readCoils) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Read coils handler not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const address = (frame.data[0] << 8) | frame.data[1];

    model.readCoils(address, length, (errorCode, coils) => {
      if (errorCode) {
        callback(errorCode, undefined);
      } else {
        callback(null, () => {
          const byteCount = (length + 7) >> 3;
          const pdu = Buffer.allocUnsafe(byteCount + 1);
          pdu[0] = byteCount;
          let out = 1;
          const fullBytes = length >> 3;
          for (let i = 0; i < fullBytes; i++) {
            const base = i << 3;
            pdu[out++] =
              (coils[base] & 1) |
              ((coils[base + 1] & 1) << 1) |
              ((coils[base + 2] & 1) << 2) |
              ((coils[base + 3] & 1) << 3) |
              ((coils[base + 4] & 1) << 4) |
              ((coils[base + 5] & 1) << 5) |
              ((coils[base + 6] & 1) << 6) |
              ((coils[base + 7] & 1) << 7);
          }
          const rem = length & 7;
          if (rem) {
            const base = fullBytes << 3;
            let acc = coils[base] & 1;
            if (rem > 1) {
              acc |= (coils[base + 1] & 1) << 1;
            }
            if (rem > 2) {
              acc |= (coils[base + 2] & 1) << 2;
            }
            if (rem > 3) {
              acc |= (coils[base + 3] & 1) << 3;
            }
            if (rem > 4) {
              acc |= (coils[base + 4] & 1) << 4;
            }
            if (rem > 5) {
              acc |= (coils[base + 5] & 1) << 5;
            }
            if (rem > 6) {
              acc |= (coils[base + 6] & 1) << 6;
            }
            pdu[out] = acc;
          }
          return pdu;
        });
      }
    });
  }

  private _handleFC2(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length !== 4) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC02`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const length = (frame.data[2] << 8) | frame.data[3];
    if (length < LIMITS.READ_COILS_MIN || length > LIMITS.READ_COILS_MAX) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `Read discrete input count ${length} is out of range`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    if (!model.readDiscreteInputs) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Read discrete inputs handler not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const address = (frame.data[0] << 8) | frame.data[1];

    model.readDiscreteInputs(address, length, (errorCode, inputs) => {
      if (errorCode) {
        callback(errorCode, undefined);
      } else {
        callback(null, () => {
          const byteCount = (length + 7) >> 3;
          const pdu = Buffer.allocUnsafe(byteCount + 1);
          pdu[0] = byteCount;
          let out = 1;
          const fullBytes = length >> 3;
          for (let i = 0; i < fullBytes; i++) {
            const base = i << 3;
            pdu[out++] =
              (inputs[base] & 1) |
              ((inputs[base + 1] & 1) << 1) |
              ((inputs[base + 2] & 1) << 2) |
              ((inputs[base + 3] & 1) << 3) |
              ((inputs[base + 4] & 1) << 4) |
              ((inputs[base + 5] & 1) << 5) |
              ((inputs[base + 6] & 1) << 6) |
              ((inputs[base + 7] & 1) << 7);
          }
          const rem = length & 7;
          if (rem) {
            const base = fullBytes << 3;
            let acc = inputs[base] & 1;
            if (rem > 1) {
              acc |= (inputs[base + 1] & 1) << 1;
            }
            if (rem > 2) {
              acc |= (inputs[base + 2] & 1) << 2;
            }
            if (rem > 3) {
              acc |= (inputs[base + 3] & 1) << 3;
            }
            if (rem > 4) {
              acc |= (inputs[base + 4] & 1) << 4;
            }
            if (rem > 5) {
              acc |= (inputs[base + 5] & 1) << 5;
            }
            if (rem > 6) {
              acc |= (inputs[base + 6] & 1) << 6;
            }
            pdu[out] = acc;
          }
          return pdu;
        });
      }
    });
  }

  private _handleFC3(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length !== 4) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC03`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const length = (frame.data[2] << 8) | frame.data[3];
    if (length < LIMITS.READ_REGISTERS_MIN || length > LIMITS.READ_REGISTERS_MAX) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `Read holding register count ${length} is out of range`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    if (!model.readHoldingRegisters) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Read holding registers handler not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const address = (frame.data[0] << 8) | frame.data[1];

    model.readHoldingRegisters(address, length, (errorCode, registers) => {
      if (errorCode) {
        callback(errorCode, undefined);
      } else {
        callback(null, () => {
          const pdu = Buffer.allocUnsafe(length * 2 + 1);
          pdu[0] = length * 2;
          let off = 1;
          for (let i = 0; i < length; i++) {
            const v = registers[i];
            pdu[off] = (v >>> 8) & 0xff;
            pdu[off + 1] = v & 0xff;
            off += 2;
          }
          return pdu;
        });
      }
    });
  }

  private _handleFC4(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length !== 4) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC04`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const length = (frame.data[2] << 8) | frame.data[3];
    if (length < LIMITS.READ_REGISTERS_MIN || length > LIMITS.READ_REGISTERS_MAX) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `Read input register count ${length} is out of range`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    if (!model.readInputRegisters) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Read input registers handler not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const address = (frame.data[0] << 8) | frame.data[1];

    model.readInputRegisters(address, length, (errorCode, registers) => {
      if (errorCode) {
        callback(errorCode, undefined);
      } else {
        callback(null, () => {
          const pdu = Buffer.allocUnsafe(length * 2 + 1);
          pdu[0] = length * 2;
          let off = 1;
          for (let i = 0; i < length; i++) {
            const v = registers[i];
            pdu[off] = (v >>> 8) & 0xff;
            pdu[off + 1] = v & 0xff;
            off += 2;
          }
          return pdu;
        });
      }
    });
  }

  private _handleFC5(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length !== 4) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC05`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const value = (frame.data[2] << 8) | frame.data[3];
    if (value !== COIL_OFF && value !== COIL_ON) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `Write single coil value ${value} is invalid`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    if (!model.writeSingleCoil) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Write single coil handler not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const address = (frame.data[0] << 8) | frame.data[1];

    model.writeSingleCoil(address, value === COIL_ON ? 1 : 0, (errorCode) => {
      if (errorCode) {
        callback(errorCode, undefined);
      } else {
        callback(null, () => frame.data);
      }
    });
  }

  private _handleFC6(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length !== 4) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC06`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    if (!model.writeSingleRegister) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Write single register handler not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const address = (frame.data[0] << 8) | frame.data[1];
    const value = (frame.data[2] << 8) | frame.data[3];

    model.writeSingleRegister(address, value, (errorCode) => {
      if (errorCode) {
        callback(errorCode, undefined);
      } else {
        callback(null, () => frame.data);
      }
    });
  }

  private _handleFC8_0(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length !== 4) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC08`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const subFunction = (frame.data[0] << 8) | frame.data[1];
    if (subFunction !== DIAGNOSTICS_RETURN_QUERY_DATA) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `Sub-function 0x${subFunction.toString(16).padStart(4, '0')} is not supported for FC08`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const data = (frame.data[2] << 8) | frame.data[3];

    const handler = model.diagnosticsReturnQueryData;
    if (!handler) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Diagnostics return query data handler not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    handler(data, (errorCode) => {
      if (errorCode) {
        callback(errorCode, undefined);
        return;
      }
      // FC 08/00 always echoes the original request verbatim.
      callback(null, () => frame.data);
    });
  }

  private _handleFC15(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length <= 5 || frame.data.length !== 5 + frame.data[4]) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC15`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const length = (frame.data[2] << 8) | frame.data[3];
    const byteCount = frame.data[4];
    if (length < LIMITS.READ_COILS_MIN || length > LIMITS.WRITE_COILS_MAX || byteCount !== (length + 7) >> 3) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `Write multiple coils length ${length} or byte count ${byteCount} is invalid`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const writeMultipleCoils = model.writeMultipleCoils;
    if (!writeMultipleCoils) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Write multiple coils handler not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const address = (frame.data[0] << 8) | frame.data[1];

    const value = new Array<0 | 1>(length);
    let byteIdx = 5;
    let outIdx = 0;
    const fullBytes = length >> 3;
    for (let b = 0; b < fullBytes; b++) {
      const byte = frame.data[byteIdx++];
      value[outIdx++] = (byte & 0x01) as 0 | 1;
      value[outIdx++] = ((byte >>> 1) & 0x01) as 0 | 1;
      value[outIdx++] = ((byte >>> 2) & 0x01) as 0 | 1;
      value[outIdx++] = ((byte >>> 3) & 0x01) as 0 | 1;
      value[outIdx++] = ((byte >>> 4) & 0x01) as 0 | 1;
      value[outIdx++] = ((byte >>> 5) & 0x01) as 0 | 1;
      value[outIdx++] = ((byte >>> 6) & 0x01) as 0 | 1;
      value[outIdx++] = ((byte >>> 7) & 0x01) as 0 | 1;
    }
    const rem = length & 7;
    if (rem) {
      const byte = frame.data[byteIdx];
      value[outIdx++] = (byte & 0x01) as 0 | 1;
      if (rem > 1) {
        value[outIdx++] = ((byte >>> 1) & 0x01) as 0 | 1;
      }
      if (rem > 2) {
        value[outIdx++] = ((byte >>> 2) & 0x01) as 0 | 1;
      }
      if (rem > 3) {
        value[outIdx++] = ((byte >>> 3) & 0x01) as 0 | 1;
      }
      if (rem > 4) {
        value[outIdx++] = ((byte >>> 4) & 0x01) as 0 | 1;
      }
      if (rem > 5) {
        value[outIdx++] = ((byte >>> 5) & 0x01) as 0 | 1;
      }
      if (rem > 6) {
        value[outIdx++] = ((byte >>> 6) & 0x01) as 0 | 1;
      }
    }

    writeMultipleCoils(address, value, (errorCode) => {
      if (errorCode) {
        callback(errorCode, undefined);
      } else {
        callback(null, () => frame.data.subarray(0, 4));
      }
    });
  }

  private _handleFC16(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length <= 5 || frame.data.length !== 5 + frame.data[4]) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC16`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const length = (frame.data[2] << 8) | frame.data[3];
    const byteCount = frame.data[4];
    if (length < LIMITS.READ_REGISTERS_MIN || length > LIMITS.WRITE_REGISTERS_MAX || byteCount !== length * 2) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `Write multiple registers length ${length} or byte count ${byteCount} is invalid`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const writeMultipleRegisters = model.writeMultipleRegisters;
    if (!writeMultipleRegisters) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Write multiple registers handler not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const address = (frame.data[0] << 8) | frame.data[1];

    const value = new Array<number>(length);
    let off = 5;
    for (let i = 0; i < length; i++) {
      value[i] = (frame.data[off] << 8) | frame.data[off + 1];
      off += 2;
    }

    writeMultipleRegisters(address, value, (errorCode) => {
      if (errorCode) {
        callback(errorCode, undefined);
      } else {
        callback(null, () => frame.data.subarray(0, 4));
      }
    });
  }

  private _handleFC17(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length !== 0) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC17`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    if (!model.reportServerId) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Report server ID handler not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    model.reportServerId((errorCode, result) => {
      if (errorCode) {
        callback(errorCode, undefined);
        return;
      }

      const sid = result.serverId;
      const extra = result.additionalData;
      const sidLen = sid?.length ?? 1;
      const extraLen = extra?.length ?? 0;
      const byteCount = sidLen + 1 + extraLen;
      if (byteCount > 251) {
        callback(ErrorCode.SERVER_DEVICE_FAILURE, undefined);
        return;
      }

      callback(null, () => {
        const data = Buffer.allocUnsafe(byteCount + 1);
        data[0] = byteCount;
        let out = 1;

        if (sid) {
          for (let i = 0; i < sidLen; i++) {
            data[out++] = sid[i];
          }
        } else {
          data[out++] = model.unit ?? 1;
        }

        data[out++] = (result.runIndicatorStatus ?? true) ? 0xff : 0x00;

        if (extra) {
          extra.copy(data, out);
        }

        return data;
      });
    });
  }

  private _handleFC22(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length !== 6) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC22`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const maskWriteRegister = model.maskWriteRegister;
    if (!maskWriteRegister) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Mask write register handler not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const address = (frame.data[0] << 8) | frame.data[1];
    const andMask = (frame.data[2] << 8) | frame.data[3];
    const orMask = (frame.data[4] << 8) | frame.data[5];

    maskWriteRegister(address, andMask, orMask, (errorCode) => {
      if (errorCode) {
        callback(errorCode, undefined);
      } else {
        callback(null, () => frame.data);
      }
    });
  }

  private _handleFC23(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length <= 9 || frame.data.length !== 9 + frame.data[8]) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC23`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const readLength = (frame.data[2] << 8) | frame.data[3];
    const writeLength = (frame.data[6] << 8) | frame.data[7];
    const byteCount = frame.data[8];
    if (
      readLength < LIMITS.READ_REGISTERS_MIN ||
      readLength > LIMITS.READ_REGISTERS_MAX ||
      writeLength < LIMITS.READ_REGISTERS_MIN ||
      writeLength > LIMITS.RW_REGISTERS_WRITE_MAX ||
      byteCount !== writeLength * 2
    ) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `Read/write register lengths or byte count are invalid for FC23`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const readHoldingRegisters = model.readHoldingRegisters;
    const writeMultipleRegisters = model.writeMultipleRegisters;

    if (!readHoldingRegisters || !writeMultipleRegisters) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Read/write multiple registers handlers not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const readAddress = (frame.data[0] << 8) | frame.data[1];
    const writeAddress = (frame.data[4] << 8) | frame.data[5];

    const value = new Array<number>(writeLength);
    let off = 9;
    for (let i = 0; i < writeLength; i++) {
      value[i] = (frame.data[off] << 8) | frame.data[off + 1];
      off += 2;
    }

    const doRead = () => {
      readHoldingRegisters(readAddress, readLength, (errorCode, registers) => {
        if (errorCode) {
          callback(errorCode, undefined);
          return;
        }
        callback(null, () => {
          const pdu = Buffer.allocUnsafe(readLength * 2 + 1);
          pdu[0] = readLength * 2;
          let off = 1;
          for (let i = 0; i < readLength; i++) {
            const v = registers[i];
            pdu[off] = (v >>> 8) & 0xff;
            pdu[off + 1] = v & 0xff;
            off += 2;
          }
          return pdu;
        });
      });
    };

    writeMultipleRegisters(writeAddress, value, (errorCode) => {
      if (errorCode !== null) {
        callback(errorCode, undefined);
        return;
      }
      doRead();
    });
  }

  private _handleFC43_14(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    if (frame.data.length !== 3) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `PDU length ${frame.data.length} is invalid for FC43/14`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    if (frame.data[0] !== MEI_READ_DEVICE_ID) {
      callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
      this.emit('protocolException', {
        type: 'data_value_illegal',
        message: `MEI type 0x${frame.data[0].toString(16).padStart(2, '0')} is invalid for FC43/14`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    const readDeviceIDCode = frame.data[1];
    let objectID = frame.data[2];

    switch (readDeviceIDCode) {
      case ReadDeviceIDCode.BASIC_STREAM: {
        if (objectID > 0x02 || (objectID > 0x06 && objectID < 0x80)) {
          objectID = 0x00;
        }
        break;
      }

      case ReadDeviceIDCode.REGULAR_STREAM: {
        if (objectID >= 0x80 || (objectID > 0x06 && objectID < 0x80)) {
          objectID = 0x00;
        }
        break;
      }

      case ReadDeviceIDCode.EXTENDED_STREAM: {
        if (objectID > 0x06 && objectID < 0x80) {
          objectID = 0x00;
        }
        break;
      }

      case ReadDeviceIDCode.SPECIFIC_ACCESS: {
        if (objectID > 0x06 && objectID < 0x80) {
          callback(ErrorCode.ILLEGAL_DATA_ADDRESS, undefined);
          this.emit('protocolException', {
            type: 'data_address_illegal',
            message: `Object ID ${objectID} is invalid for specific device identification access`,
            transaction: frame.transaction,
            unit: frame.unit,
            fc: frame.fc,
            data: Buffer.from(frame.data),
          });
          return;
        }
        break;
      }

      default: {
        callback(ErrorCode.ILLEGAL_DATA_VALUE, undefined);
        this.emit('protocolException', {
          type: 'data_value_illegal',
          message: `Read device ID code ${readDeviceIDCode} is invalid`,
          transaction: frame.transaction,
          unit: frame.unit,
          fc: frame.fc,
          data: Buffer.from(frame.data),
        });
        return;
      }
    }

    if (!model.readDeviceIdentification) {
      callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
      this.emit('protocolException', {
        type: 'function_not_implemented',
        message: `Read device identification handler not implemented for unit ${frame.unit}`,
        transaction: frame.transaction,
        unit: frame.unit,
        fc: frame.fc,
        data: Buffer.from(frame.data),
      });
      return;
    }

    model.readDeviceIdentification((errorCode, identification) => {
      if (errorCode) {
        callback(errorCode, undefined);
        return;
      }

      // Use the array index as the Object ID. Object IDs are a single byte
      // (0x00..0xFF), so a sparse string[] gives us natural ascending order
      // and O(1) random access without Map insertion-order pitfalls.
      const objects: (string | undefined)[] = [];
      for (const key of Object.keys(identification)) {
        const id = Number(key);
        if (Number.isNaN(id) || !Number.isInteger(id) || id < 0x00 || id > 0xff) {
          callback(ErrorCode.SERVER_DEVICE_FAILURE, undefined);
          this.emit('protocolException', {
            type: 'server_device_failure',
            message: `Object ID ${key} is out of allowed range`,
            transaction: frame.transaction,
            unit: frame.unit,
            fc: frame.fc,
            data: Buffer.from(frame.data),
          });
          return;
        }
        if (id >= 0x07 && id <= 0x7f) {
          callback(ErrorCode.SERVER_DEVICE_FAILURE, undefined);
          this.emit('protocolException', {
            type: 'server_device_failure',
            message: `Object ID ${id} is in reserved range 0x07..0x7F`,
            transaction: frame.transaction,
            unit: frame.unit,
            fc: frame.fc,
            data: Buffer.from(frame.data),
          });
          return;
        }
        objects[id] = identification[id];
      }

      for (let id = 0x00; id <= 0x02; id++) {
        if (objects[id] === undefined) {
          objects[id] = 'null';
        }
      }

      if (objects[objectID] === undefined) {
        if (readDeviceIDCode === ReadDeviceIDCode.SPECIFIC_ACCESS) {
          callback(ErrorCode.ILLEGAL_DATA_ADDRESS, undefined);
          this.emit('protocolException', {
            type: 'data_address_illegal',
            message: `Object ID ${objectID} not found for specific device identification access`,
            transaction: frame.transaction,
            unit: frame.unit,
            fc: frame.fc,
            data: Buffer.from(frame.data),
          });
          return;
        }
        objectID = 0x00;
      }

      let maxId = 0;
      for (let id = 0x00; id <= 0xff; id++) {
        if (objects[id] !== undefined && id > maxId) {
          maxId = id;
        }
      }

      const conformityLevel = maxId >= 0x80 ? ConformityLevel.EXTENDED : maxId > 0x02 ? ConformityLevel.REGULAR : ConformityLevel.BASIC;

      const ids: { id: number; byteLength: number }[] = [];
      // Whole PDU max = 253 bytes; payload after FC has 252 bytes.
      // Header inside payload is 6 bytes (MEI / code / conformity / more /
      // next / count), so account for the 1-byte FC as well -> 7 bytes total.
      let totalLength = 7;
      let lastID = 0;

      if (readDeviceIDCode === ReadDeviceIDCode.SPECIFIC_ACCESS) {
        const value = objects[objectID];
        if (value === undefined) {
          callback(ErrorCode.ILLEGAL_DATA_ADDRESS, undefined);
          this.emit('protocolException', {
            type: 'data_address_illegal',
            message: `Object ID ${objectID} not found for specific device identification access`,
            transaction: frame.transaction,
            unit: frame.unit,
            fc: frame.fc,
            data: Buffer.from(frame.data),
          });
          return;
        }
        const byteLength = Buffer.byteLength(value);
        if (byteLength > 244) {
          callback(ErrorCode.SERVER_DEVICE_FAILURE, undefined);
          this.emit('protocolException', {
            type: 'server_device_failure',
            message: `Object ${objectID} value length ${byteLength} exceeds maximum`,
            transaction: frame.transaction,
            unit: frame.unit,
            fc: frame.fc,
            data: Buffer.from(frame.data),
          });
          return;
        }
        if (byteLength + 2 <= 253 - totalLength) {
          totalLength += byteLength + 2;
          ids.push({ id: objectID, byteLength });
        } else {
          // Defensive: a valid object should never exceed the single-frame
          // limit, but mark it as the next fragment boundary if it does.
          lastID = objectID;
        }
      } else {
        for (let id = 0x00; id <= 0xff; id++) {
          if (id < objectID) {
            continue;
          }

          // Enforce stream-category boundaries per V1.1b3 §6.21.
          if (readDeviceIDCode === ReadDeviceIDCode.BASIC_STREAM && id > 0x02) {
            continue;
          }
          if (readDeviceIDCode === ReadDeviceIDCode.REGULAR_STREAM && id > 0x06) {
            continue;
          }
          // Extended stream allows 0x00..0x06 and 0x80..0xFF; reserved
          // 0x07..0x7F were rejected while populating the array.

          const value = objects[id];
          if (value === undefined) {
            continue;
          }
          const byteLength = Buffer.byteLength(value);

          if (byteLength > 244) {
            callback(ErrorCode.SERVER_DEVICE_FAILURE, undefined);
            this.emit('protocolException', {
              type: 'server_device_failure',
              message: `Object ${id} value length ${byteLength} exceeds maximum`,
              transaction: frame.transaction,
              unit: frame.unit,
              fc: frame.fc,
              data: Buffer.from(frame.data),
            });
            return;
          }

          if (lastID !== 0) {
            continue;
          }

          if (byteLength + 2 > 253 - totalLength) {
            lastID = id;
          } else {
            totalLength += byteLength + 2;
            ids.push({ id, byteLength });
          }
        }
      }

      let dataLength = 6;
      for (const { byteLength } of ids) {
        dataLength += 2 + byteLength;
      }
      const data = Buffer.allocUnsafe(dataLength);
      let offset = 0;
      data[offset++] = MEI_READ_DEVICE_ID;
      data[offset++] = readDeviceIDCode;
      data[offset++] = conformityLevel;
      data[offset++] = lastID === 0 ? 0x00 : 0xff;
      data[offset++] = lastID;
      data[offset++] = ids.length;
      for (const { id, byteLength } of ids) {
        const value = objects[id];
        if (value === undefined) {
          callback(ErrorCode.SERVER_DEVICE_FAILURE, undefined);
          this.emit('protocolException', {
            type: 'server_device_failure',
            message: `Object ${id} value is missing during encoding`,
            transaction: frame.transaction,
            unit: frame.unit,
            fc: frame.fc,
            data: Buffer.from(frame.data),
          });
          return;
        }
        data[offset++] = id;
        data[offset++] = byteLength;
        offset += data.write(value, offset);
      }

      callback(null, () => data);
    });
  }

  /**
   * Dispatch a validated ADU to the appropriate FC handler.
   *
   * Kept synchronous so the slave dispatch path avoids one `async/await`
   * suspend/resume per request.
   *
   * @param model Unit model that will handle the request.
   * @param frame Parsed ADU including the PDU payload.
   * @param callback Lazy callback that receives the encoded response PDU.
   * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
   */
  private _handleFC(model: ModbusUnitModel, frame: ApplicationDataUnit, callback: CallbackLazy<Buffer>): void {
    switch (frame.fc) {
      case FunctionCode.READ_COILS: {
        this._handleFC1(model, frame, callback);
        return;
      }

      case FunctionCode.READ_DISCRETE_INPUTS: {
        this._handleFC2(model, frame, callback);
        return;
      }

      case FunctionCode.READ_HOLDING_REGISTERS: {
        this._handleFC3(model, frame, callback);
        return;
      }

      case FunctionCode.READ_INPUT_REGISTERS: {
        this._handleFC4(model, frame, callback);
        return;
      }

      case FunctionCode.WRITE_SINGLE_COIL: {
        this._handleFC5(model, frame, callback);
        return;
      }

      case FunctionCode.WRITE_SINGLE_REGISTER: {
        this._handleFC6(model, frame, callback);
        return;
      }

      case FunctionCode.DIAGNOSTICS: {
        this._handleFC8_0(model, frame, callback);
        return;
      }

      case FunctionCode.WRITE_MULTIPLE_COILS: {
        this._handleFC15(model, frame, callback);
        return;
      }

      case FunctionCode.WRITE_MULTIPLE_REGISTERS: {
        this._handleFC16(model, frame, callback);
        return;
      }

      case FunctionCode.REPORT_SERVER_ID: {
        this._handleFC17(model, frame, callback);
        return;
      }

      case FunctionCode.MASK_WRITE_REGISTER: {
        this._handleFC22(model, frame, callback);
        return;
      }

      case FunctionCode.READ_WRITE_MULTIPLE_REGISTERS: {
        this._handleFC23(model, frame, callback);
        return;
      }

      case FunctionCode.READ_DEVICE_IDENTIFICATION: {
        this._handleFC43_14(model, frame, callback);
        return;
      }

      default: {
        const cfcResponse = this._cfcResponses.get(frame.fc);
        if (cfcResponse) {
          cfcResponse(frame.unit, frame.fc, frame.data, callback);
          return;
        }
        callback(ErrorCode.ILLEGAL_FUNCTION, undefined);
        this.emit('protocolException', {
          type: 'function_illegal',
          message: `Function code ${frame.fc} is not supported`,
          transaction: frame.transaction,
          unit: frame.unit,
          fc: frame.fc,
          data: Buffer.from(frame.data),
        });
        return;
      }
    }
  }

  private _flushPendingWrites(unit: number): void {
    if (this._flushingPending) {
      this._pendingFlushPending = true;
      return;
    }
    this._flushingPending = true;
    try {
      do {
        this._pendingFlushPending = false;
        const queue = this._unitWriteQueues[unit];
        let writeIdx = 0;
        for (let i = 0; i < queue.pending.length; i++) {
          const req = queue.pending[i];
          const inFlight = queue.inFlight;
          let conflicts = false;
          for (let k = 0; k < inFlight.length; k++) {
            const checkReq = inFlight[k];
            if (rangesOverlap(req, checkReq)) {
              conflicts = true;
              break;
            }
          }
          if (!conflicts) {
            queue.inFlight.push(req);
            req.inFlightIndex = queue.inFlight.length - 1;
            if (!req.model) {
              this._onLockedUnitWriteDone(req);
            } else {
              this._executeUnitWrite(
                req.model,
                req.frame,
                req.unit,
                () => {
                  this._onLockedUnitWriteDone(req);
                },
                req.shouldRespond,
              );
            }
          } else {
            queue.pending[writeIdx++] = req;
          }
        }
        queue.pending.length = writeIdx;
      } while (this._pendingFlushPending);
    } finally {
      this._flushingPending = false;
    }
  }

  private _executeUnitWrite(
    model: ModbusUnitModel,
    frame: ModbusFrame,
    unit: number,
    callback: (() => void) | undefined,
    shouldRespond: boolean,
  ): void {
    this._handleFC(model, frame, (errorCode, data) => {
      if (errorCode === null) {
        if (!this._accessAuthorizer || !this._accessAuthorizer.checkRuntime) {
          if (shouldRespond) {
            const responseRaw = this._protocolLayer.encode(unit, frame.fc, data(), frame.transaction);
            this._pipelineAdapter.write(responseRaw, (err) => {
              if (err) {
                this.emit('pipelineFault', {
                  type: 'write_failed',
                  message: `Failed to write response for unit ${unit}, function ${frame.fc}`,
                  transaction: frame.transaction,
                  unit,
                  fc: frame.fc,
                  data: Buffer.from(frame.data),
                  responseRaw,
                  error: err,
                });
              }
            });
          }
          if (callback) {
            callback();
          }
          return;
        }

        const auth = this._accessAuthorizer.checkRuntime(unit, frame.fc, frame.data);
        if (auth === true) {
          if (shouldRespond) {
            const responseRaw = this._protocolLayer.encode(unit, frame.fc, data(), frame.transaction);
            this._pipelineAdapter.write(responseRaw, (err) => {
              if (err) {
                this.emit('pipelineFault', {
                  type: 'write_failed',
                  message: `Failed to write response for unit ${unit}, function ${frame.fc}`,
                  transaction: frame.transaction,
                  unit,
                  fc: frame.fc,
                  data: Buffer.from(frame.data),
                  responseRaw,
                  error: err,
                });
              }
            });
          }
          if (callback) {
            callback();
          }
          return;
        }
        if (auth === false) {
          if (callback) {
            callback();
          }
          this.emitLazy('accessAudit', () => ({
            type: 'runtime_access_denied',
            message: `Runtime access denied for unit ${unit}, function ${frame.fc}`,
            transaction: frame.transaction,
            unit,
            fc: frame.fc,
            data: Buffer.from(frame.data),
          }));
          return;
        }
        if (typeof auth === 'number') {
          if (shouldRespond) {
            const responseRaw = this._protocolLayer.encode(unit, frame.fc | EXCEPTION_OFFSET, Buffer.from([auth]), frame.transaction);
            this._pipelineAdapter.write(responseRaw, (err) => {
              if (err) {
                this.emit('pipelineFault', {
                  type: 'write_failed',
                  message: `Failed to write runtime access denied response for unit ${unit}, function ${frame.fc}`,
                  transaction: frame.transaction,
                  unit,
                  fc: frame.fc,
                  data: Buffer.from(frame.data),
                  responseRaw,
                  error: err,
                });
              }
            });
          }
          if (callback) {
            callback();
          }
          this.emitLazy('accessAudit', () => ({
            type: 'runtime_access_denied',
            message: `Runtime access denied with exception code ${auth} for unit ${unit}, function ${frame.fc}`,
            transaction: frame.transaction,
            unit,
            fc: frame.fc,
            data: Buffer.from(frame.data),
          }));
          return;
        }

        auth.then((res) => {
          if (res === false) {
            if (callback) {
              callback();
            }
            this.emitLazy('accessAudit', () => ({
              type: 'runtime_access_denied',
              message: `Runtime access denied for unit ${unit}, function ${frame.fc}`,
              transaction: frame.transaction,
              unit,
              fc: frame.fc,
              data: Buffer.from(frame.data),
            }));
            return;
          }
          if (typeof res === 'number') {
            if (shouldRespond) {
              const responseRaw = this._protocolLayer.encode(unit, frame.fc | EXCEPTION_OFFSET, Buffer.from([res]), frame.transaction);
              this._pipelineAdapter.write(responseRaw, (err) => {
                if (err) {
                  this.emit('pipelineFault', {
                    type: 'write_failed',
                    message: `Failed to write runtime access denied response for unit ${unit}, function ${frame.fc}`,
                    transaction: frame.transaction,
                    unit,
                    fc: frame.fc,
                    data: Buffer.from(frame.data),
                    responseRaw,
                    error: err,
                  });
                }
              });
            }
            if (callback) {
              callback();
            }
            this.emitLazy('accessAudit', () => ({
              type: 'runtime_access_denied',
              message: `Runtime access denied with exception code ${res} for unit ${unit}, function ${frame.fc}`,
              transaction: frame.transaction,
              unit,
              fc: frame.fc,
              data: Buffer.from(frame.data),
            }));
            return;
          }
          if (shouldRespond) {
            const responseRaw = this._protocolLayer.encode(unit, frame.fc, data(), frame.transaction);
            this._pipelineAdapter.write(responseRaw, (err) => {
              if (err) {
                this.emit('pipelineFault', {
                  type: 'write_failed',
                  message: `Failed to write response for unit ${unit}, function ${frame.fc}`,
                  transaction: frame.transaction,
                  unit,
                  fc: frame.fc,
                  data: Buffer.from(frame.data),
                  responseRaw,
                  error: err,
                });
              }
            });
          }
          if (callback) {
            callback();
          }
        });
      } else {
        if (shouldRespond) {
          const responseRaw = this._protocolLayer.encode(unit, frame.fc | EXCEPTION_OFFSET, Buffer.from([errorCode]), frame.transaction);
          this._pipelineAdapter.write(responseRaw, (err) => {
            if (err) {
              this.emit('pipelineFault', {
                type: 'write_failed',
                message: `Failed to write exception response for unit ${unit}, function ${frame.fc}`,
                transaction: frame.transaction,
                unit,
                fc: frame.fc,
                data: Buffer.from(frame.data),
                responseRaw,
                error: err,
              });
            }
          });
        }
        if (callback) {
          callback();
        }
      }
    });
  }

  private _processUnitWrite(
    model: ModbusUnitModel,
    unit: number,
    frame: ModbusFrame,
    callback: (() => void) | undefined,
    shouldRespond: boolean,
  ): void {
    if (this.queueStrategy === 'concurrent' && this.enableWriteRangeLock) {
      let ranges: number[] | null = null;

      if (WRITE_FUNCTION_FLAGS[frame.fc] === 1) {
        let start: number;
        let end: number;
        if (frame.fc === FunctionCode.MASK_WRITE_REGISTER) {
          if (frame.data.length === 6) {
            start = (frame.data[0] << 8) | frame.data[1];
            end = start + 1;
            ranges = [start, end];
          }
        } else if (frame.fc === FunctionCode.READ_WRITE_MULTIPLE_REGISTERS) {
          if (frame.data.length > 9) {
            start = (frame.data[4] << 8) | frame.data[5];
            end = start + ((frame.data[6] << 8) | frame.data[7]);
            ranges = [start, end];
          }
        } else if (frame.fc === FunctionCode.WRITE_MULTIPLE_COILS || frame.fc === FunctionCode.WRITE_MULTIPLE_REGISTERS) {
          start = (frame.data[0] << 8) | frame.data[1];
          end = start + ((frame.data[2] << 8) | frame.data[3]);
          ranges = [start, end];
        } else {
          start = (frame.data[0] << 8) | frame.data[1];
          end = start + 1;
          ranges = [start, end];
        }
      } else {
        const cfc = this._protocolLayer.customFunctionCodes[frame.fc];
        if (cfc && cfc.requestAddressRange) {
          const declared = cfc.requestAddressRange(unit, frame.fc, frame.data);
          for (let t = 0; t < ADDRESS_TABLES.length; t++) {
            const tableRanges = declared[ADDRESS_TABLES[t]];
            if (!tableRanges) {
              continue;
            }
            for (let i = 0; i < tableRanges.length; i++) {
              const r = tableRanges[i];
              const lo = r[0];
              const hi = r[1];
              if (ranges === null) {
                ranges = [];
              }
              if (lo <= hi) {
                ranges.push(lo, hi + 1);
              } else {
                ranges.push(hi, lo + 1);
              }
            }
          }
        }
      }

      if (ranges !== null && ranges.length > 0) {
        const req: WriteRequest = {
          unit,
          ranges,
          shouldRespond,
          frame,
          model,
          onDone: callback,
        };

        const inFlight = this._unitWriteQueues[unit].inFlight;
        let conflicts = false;
        for (let k = 0; k < inFlight.length; k++) {
          const checkReq = inFlight[k];
          if (rangesOverlap(req, checkReq)) {
            conflicts = true;
            break;
          }
        }
        if (conflicts) {
          this._unitWriteQueues[unit].pending.push(req);
          return;
        }

        this._unitWriteQueues[unit].inFlight.push(req);
        req.inFlightIndex = this._unitWriteQueues[unit].inFlight.length - 1;
        if (!req.model) {
          this._onLockedUnitWriteDone(req);
        } else {
          this._executeUnitWrite(
            req.model,
            req.frame,
            req.unit,
            () => {
              this._onLockedUnitWriteDone(req);
            },
            req.shouldRespond,
          );
        }
        return;
      }
    }

    this._executeUnitWrite(model, frame, unit, callback, shouldRespond);
  }

  private _onLockedUnitWriteDone(req: WriteRequest): void {
    const unit = req.unit;
    const onDone = req.onDone;
    const arr = this._unitWriteQueues[unit].inFlight;
    const i = req.inFlightIndex ?? -1;
    if (i >= 0 && i < arr.length) {
      const lastIdx = arr.length - 1;
      const last = arr[lastIdx];
      arr[i] = last;
      if (last !== req) {
        last.inFlightIndex = i;
      }
      arr.length--;
    }
    this._flushPendingWrites(unit);
    if (onDone) {
      onDone();
    }
  }

  private _processFrame(frame: ModbusFrame, callback?: () => void) {
    if (frame.unit !== 0) {
      const model = this._units.get(frame.unit);
      if (!model) {
        const responseRaw = this._protocolLayer.encode(
          frame.unit,
          frame.fc | EXCEPTION_OFFSET,
          Buffer.from([ErrorCode.GATEWAY_PATH_UNAVAILABLE]),
          frame.transaction,
        );
        this._pipelineAdapter.write(responseRaw, (err) => {
          if (err) {
            this.emit('pipelineFault', {
              type: 'write_failed',
              message: `Failed to write gateway path unavailable response for unit ${frame.unit}, function ${frame.fc}`,
              transaction: frame.transaction,
              unit: frame.unit,
              fc: frame.fc,
              data: Buffer.from(frame.data),
              responseRaw,
              error: err,
            });
          }
        });
        if (callback) {
          callback();
        }
        this.emit('protocolException', {
          type: 'gateway_path_unavailable',
          message: `Unit ${frame.unit} is not registered`,
          transaction: frame.transaction,
          unit: frame.unit,
          fc: frame.fc,
          data: Buffer.from(frame.data),
        });
        return;
      }

      this._processUnitWrite(model, frame.unit, frame, callback, true);
      return;
    }

    const unitCount = this._units.size;
    if (unitCount === 0) {
      if (callback) {
        callback();
      }
      return;
    }

    let remaining = unitCount;
    const onUnitDone = () => {
      remaining--;
      if (remaining === 0) {
        if (callback) {
          callback();
        }
      }
    };

    for (const unit of this._units) {
      this._processUnitWrite(unit[1], unit[0], frame, onUnitDone, false);
    }
  }

  /**
   * Register a unit model that will handle requests for `unit`.
   *
   * @param unit Unit / slave address (1..247).
   * @param model Handler model implementing the function codes to support.
   * @returns `this` for chaining.
   * @throws When `unit` is not an integer in `1..247`.
   */
  public addUnit(unit: number, model: ModbusUnitModel) {
    if ((unit & 0xff) !== unit || unit < 1 || unit > 247) {
      throw new Error(`Unit must be an integer in 1..247, got ${unit}`);
    }
    this._units.set(unit, model);
    return this;
  }

  /**
   * Unregister the model for `unit`.
   *
   * @param unit Unit / slave address to remove.
   * @returns `this` for chaining.
   */
  public removeUnit(unit: number): void {
    this._units.delete(unit);
  }

  /**
   * Unregister every unit model on this slave.
   *
   * @returns `this` for chaining.
   */
  public removeAllUnits(): void {
    this._units.clear();
  }

  /**
   * Register a custom function code and its handler on this slave.
   *
   * For RTU transports the descriptor must also include `determineFrameLength` so the
   * framing layer can determine the total frame length without buffering.
   *
   * @param cfc Custom function-code descriptor.
   * @param response Handler called to produce the response PDU.
   * @returns `this` for chaining.
   */
  public addCustomFunctionCode(
    cfc: P extends 'RTU'
      ? CustomFunctionCode & { determineFrameLength: (getByte: (idx: number) => number, length: number) => number }
      : CustomFunctionCode,
    response: (unit: number, fc: number, data: Buffer, callback: CallbackLazy<Buffer>) => void,
  ): void {
    this._protocolLayer.addCustomFunctionCode(cfc);
    this._cfcResponses.set(cfc.fc, response);
  }

  /**
   * Unregister a previously added custom function code.
   *
   * @param fc Function code byte to remove.
   * @returns `this` for chaining.
   */
  public removeCustomFunctionCode(fc: number): void {
    this._protocolLayer.customFunctionCodes[fc] = undefined;
    this._cfcResponses.delete(fc);
  }

  /**
   * Remove all custom function codes registered on this slave.
   *
   * @returns `this` for chaining.
   */
  public removeAllCustomFunctionCodes(): void {
    this._protocolLayer.customFunctionCodes.fill(undefined);
    this._cfcResponses.clear();
  }

  /**
   * Install an access-control policy on the slave.
   *
   * The policy is evaluated for every inbound frame:
   * - `checkUnit` and `checkAddress` run before dispatch.
   * - `checkRuntime` runs after the unit handler produces a successful response
   *   but before the response is encoded and written.
   *
   * @param authorizer The policy to enforce. Omit a hook to disable that gate.
   * @returns `this` for chaining.
   *
   * @example
   * ```ts
   * slave.setAccessAuthorizer({
   *   checkUnit: (unit) => allowedUnits.has(unit),
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
   * After this call all inbound frames flow through the slave without any
   * access-control gate until a new authorizer is installed.
   *
   * @returns `this` for chaining.
   */
  public deleteAccessAuthorizer() {
    this._accessAuthorizer = undefined;
  }

  /**
   * Destroy the slave and release all resources.
   *
   * After this call the instance is unusable: protocol callbacks are cleaned,
   * queues are cleared, units and custom function codes are removed, and
   * listeners are detached.
   *
   * @returns `this` for chaining.
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

    this._queue.frames.length = 0;
    this._queue.processing = false;
    this._flushingPending = false;
    this._pendingFlushPending = false;

    for (const queue of this._unitWriteQueues) {
      queue.inFlight.length = 0;
      queue.pending.length = 0;
    }

    this.removeAllUnits();
    this.removeAllCustomFunctionCodes();
    this.deleteAccessAuthorizer();
  }
}
