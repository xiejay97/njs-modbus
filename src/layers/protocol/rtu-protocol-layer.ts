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

/* eslint-disable @typescript-eslint/no-unsafe-declaration-merging */
import type { CustomFunctionCode } from '../../types';

import { AbstractProtocolLayer } from './abstract-protocol-layer';
import { CRC_TABLE, bitsToMs } from '../../utils';
import { EXCEPTION_OFFSET, FunctionCode, MEI_READ_DEVICE_ID } from '../../vars';

/** Hard upper bound on a Modbus RTU frame: 256 bytes (unit 1 + PDU 253 + CRC 2). */
const MAX_FRAME_LENGTH = 256;
/** Minimum legal frame: unit + FC + 2-byte CRC = 4 bytes. */
const MIN_FRAME_LENGTH = 4;

/** Sentinel returned when the predictor needs more bytes before it can decide a frame length. */
const PREDICT_NEED_MORE = 0;
/** Sentinel returned when the predictor cannot determine the frame length at all. */
const PREDICT_UNKNOWN = -1;

/** Per-FC RTU request length descriptor table. Same encoding as the legacy utility table. */
const REQ_TABLE = new Int32Array(256);
/** Per-FC RTU response length descriptor table. Same encoding as the legacy utility table. */
const RES_TABLE = new Int32Array(256);

(function initRtuFrameTables() {
  REQ_TABLE[FunctionCode.READ_COILS] = 8;
  REQ_TABLE[FunctionCode.READ_DISCRETE_INPUTS] = 8;
  REQ_TABLE[FunctionCode.READ_HOLDING_REGISTERS] = 8;
  REQ_TABLE[FunctionCode.READ_INPUT_REGISTERS] = 8;
  REQ_TABLE[FunctionCode.WRITE_SINGLE_COIL] = 8;
  REQ_TABLE[FunctionCode.WRITE_SINGLE_REGISTER] = 8;
  REQ_TABLE[FunctionCode.DIAGNOSTICS] = 8;
  REQ_TABLE[FunctionCode.REPORT_SERVER_ID] = 4;
  REQ_TABLE[FunctionCode.MASK_WRITE_REGISTER] = 10;
  REQ_TABLE[FunctionCode.READ_DEVICE_IDENTIFICATION] = 7;

  REQ_TABLE[FunctionCode.WRITE_MULTIPLE_COILS] = -((6 << 8) | 9);
  REQ_TABLE[FunctionCode.WRITE_MULTIPLE_REGISTERS] = -((6 << 8) | 9);
  REQ_TABLE[FunctionCode.READ_WRITE_MULTIPLE_REGISTERS] = -((10 << 8) | 13);

  RES_TABLE[FunctionCode.WRITE_SINGLE_COIL] = 8;
  RES_TABLE[FunctionCode.WRITE_SINGLE_REGISTER] = 8;
  RES_TABLE[FunctionCode.DIAGNOSTICS] = 8;
  RES_TABLE[FunctionCode.WRITE_MULTIPLE_COILS] = 8;
  RES_TABLE[FunctionCode.WRITE_MULTIPLE_REGISTERS] = 8;
  RES_TABLE[FunctionCode.MASK_WRITE_REGISTER] = 10;

  RES_TABLE[FunctionCode.READ_COILS] = -((2 << 8) | 5);
  RES_TABLE[FunctionCode.READ_DISCRETE_INPUTS] = -((2 << 8) | 5);
  RES_TABLE[FunctionCode.READ_HOLDING_REGISTERS] = -((2 << 8) | 5);
  RES_TABLE[FunctionCode.READ_INPUT_REGISTERS] = -((2 << 8) | 5);
  RES_TABLE[FunctionCode.REPORT_SERVER_ID] = -((2 << 8) | 5);
  RES_TABLE[FunctionCode.READ_WRITE_MULTIPLE_REGISTERS] = -((2 << 8) | 5);

  RES_TABLE[FunctionCode.READ_DEVICE_IDENTIFICATION] = -999;
})();

/**
 * RTU timing parameter — accepts either:
 * - a bare `number` in milliseconds (`0` to disable the timer entirely)
 * - `{ unit: 'ms', value: N }` — explicit milliseconds (equivalent to bare `N`)
 * - `{ unit: 'bit', value: N }` — bit-time approximation, derived from `baudRate`
 *
 * The bare-number form is the recommended default; the object form exists for
 * specs that quote bit-time. Pass `0` (or `{ unit: 'ms', value: 0 }`) to disable
 * the timer; either form short-circuits the baudRate-derived fallback.
 */
export type RtuTimingValue = number | { unit: 'bit' | 'ms'; value: number };

/** User-facing RTU protocol options (supports both bit and ms units). */
export interface RtuProtocolLayerOptions {
  /**
   * Serial baud rate, in bits per second.
   * Required when using `{ unit: 'bit', value: N }` timing values; ignored otherwise.
   */
  baudRate?: number;
  /**
   * Inter-frame silence (Modbus RTU t3.5).
   *
   * - `20` or `{ unit: 'ms', value: 20 }` — 20 ms
   * - `{ unit: 'bit', value: 38.5 }` — spec bit-time approximation (default when `baudRate` is provided)
   * - `0` — disable t3.5 timing (immediate parse on every chunk; useful for
   *   lossless transports such as RTU-over-TCP or PTY-based tests where the
   *   wire's silence semantics do not apply)
   *
   * Per Modbus V1.02 §2.5.1.1, at baud rates > 19200 a fixed 1.75 ms is used
   * regardless of the bit value.
   */
  intervalBetweenFrames?: RtuTimingValue;
  /**
   * Inter-character timeout (Modbus RTU t1.5). Opt-in; **disabled** by default.
   *
   * - `1` or `{ unit: 'ms', value: 1 }` — 1 ms
   * - `{ unit: 'bit', value: 21 }` — bit-time approximation (~1.5 char times)
   * - `0` — disable explicitly
   *
   * Per Modbus V1.02 §2.5.1.1, at baud rates > 19200 a fixed 0.75 ms is used
   * regardless of the bit value.
   */
  interCharTimeout?: RtuTimingValue;
  /**
   * Enforces strict Modbus RTU timing. When true, any frame containing a t1.5
   * inter-character timeout event will be discarded immediately, even if the
   * CRC16 is valid.
   * @default false
   */
  strictTiming?: boolean;
}

/**
 * RTU-specific narrowing of the protocol-layer contract.
 *
 * Merged with the {@link RtuProtocolLayer} class via TypeScript declaration
 * merging. It overrides the inherited {@link AbstractProtocolLayer.customFunctionCodes}
 * and {@link AbstractProtocolLayer.addCustomFunctionCode} signatures so that
 * every RTU custom function code must declare a `determineFrameLength` callback; the
 * RTU framing FSM needs it to determine the total frame length without a
 * sliding-window CRC fallback.
 */
export interface RtuProtocolLayer {
  /**
   * Registry of RTU custom function codes.
   *
   * Unlike the base {@link AbstractProtocolLayer.customFunctionCodes} array, each
   * entry must include a `determineFrameLength` callback so the framing layer can
   * predict the total frame length from leading bytes.
   */
  customFunctionCodes: (
    | (CustomFunctionCode & { determineFrameLength: (getByte: (idx: number) => number, length: number) => number })
    | undefined
  )[];

  /**
   * Register a custom function code for RTU framing.
   *
   * @param cfc Custom function code descriptor. Must include `determineFrameLength`
   *   so the RTU framing layer can derive the total frame length
   *   (unit + FC + PDU + 2-byte CRC) from the bytes received so far.
   * @returns `void`.
   * @throws When `cfc.fc` is not an integer in `0..255`.
   */
  addCustomFunctionCode: (
    cfc: CustomFunctionCode & {
      determineFrameLength: (getByte: (idx: number) => number, length: number) => number;
    },
  ) => void;

  /**
   * Remove a previously registered custom function code.
   *
   * @param fc Function code byte (0..255) to deregister.
   * @returns `void`.
   */
  removeCustomFunctionCode: (fc: number) => void;
}

/**
 * Modbus RTU protocol framing layer.
 *
 * Parses binary RTU frames (unit + FC + PDU + CRC16) from arbitrary byte chunks,
 * validates CRC16, and optionally enforces Modbus V1.02 t1.5 / t3.5 timing using
 * a single t3.5 `setTimeout` deadline plus inter-chunk timestamp comparison for
 * t1.5. Custom function codes can be registered so variable-length frames can be
 * predicted without a sliding-window CRC fallback.
 */
export class RtuProtocolLayer extends AbstractProtocolLayer {
  /** Always `'RTU'` for this implementation. */
  public readonly PROTOCOL = 'RTU' as const;
  /** Role of the owning stack — `'MASTER'` or `'SLAVE'`. */
  public readonly ROLE: 'MASTER' | 'SLAVE';

  private _residual = Buffer.alloc(MAX_FRAME_LENGTH);
  private _residualLen = 0;
  private _expectedLen = PREDICT_NEED_MORE;

  private _isMaster: boolean;

  private _t15Time: number;
  private _t35Time: number;
  private _t15Strict: boolean;
  private _t35Timer?: NodeJS.Timeout;
  // t1.5 cursor: 0 = not triggered; > 0 = virtual index where the gap occurred
  private _t15Marker = 0;
  private _lastChunkTime = 0;
  private _timingEnabled: boolean;

  /**
   * @param role `'MASTER'` for request issuance / response decoding,
   *   `'SLAVE'` for request decoding / response issuance.
   * @param options RTU timing and strictness options.
   * @returns A new {@link RtuProtocolLayer} instance.
   * @throws When `t3.5` is configured to be less than `t1.5`.
   */
  constructor(role: 'MASTER' | 'SLAVE', options: RtuProtocolLayerOptions = {}) {
    super();

    this.ROLE = role;
    this._isMaster = role === 'MASTER';

    const { baudRate, intervalBetweenFrames: _intervalBetweenFrames, interCharTimeout: _interCharTimeout, strictTiming } = options;
    let intervalBetweenFrames = this._resolveTime(_intervalBetweenFrames, baudRate, 1.75);
    if (intervalBetweenFrames === undefined) {
      // Spec default: t3.5 derived from baudRate, or 0 when neither option nor
      // baudRate were supplied.
      if (baudRate === undefined) {
        intervalBetweenFrames = 0;
      } else if (baudRate > 19200) {
        intervalBetweenFrames = 1.75;
      } else {
        const ms = bitsToMs(baudRate, 38.5);
        const trunc = ms | 0;
        intervalBetweenFrames = trunc + (ms > trunc ? 1 : 0);
      }
    }
    this._t35Time = intervalBetweenFrames ?? 0;
    let interCharTimeout = this._resolveTime(_interCharTimeout, baudRate, 0.75);
    if (interCharTimeout === undefined) {
      // t1.5 is opt-in — no spec-default fallback.
      interCharTimeout = 0;
    }
    this._t15Time = this._t35Time === 0 ? 0 : (interCharTimeout ?? 0);
    if (this._t35Time < this._t15Time) {
      throw new Error('t3.5 cannot be less than t1.5');
    }
    this._t15Strict = strictTiming ?? false;
    this._timingEnabled = this._t35Time > 0;
  }

  /**
   * Resolve a {@link RtuTimingValue} into a concrete millisecond value.
   *
   * @param value Raw timing option supplied by the caller.
   * @param baudRate Baud rate, required only for `{ unit: 'bit' }` values.
   * @param fastBaudMs Fixed millisecond value used when `baudRate > 19200`.
   * @returns Resolved milliseconds, or `undefined` when the value requires a
   *   `baudRate` that was not provided.
   */
  private _resolveTime(value: RtuTimingValue | undefined, baudRate: number | undefined, fastBaudMs: number): number | undefined {
    if (value === undefined) {
      return undefined;
    }
    if (typeof value === 'number') {
      return value;
    }
    if (value.unit === 'ms') {
      return value.value;
    }
    // unit === 'bit' — needs baudRate to convert
    if (baudRate === undefined) {
      return undefined;
    }
    if (baudRate > 19200) {
      return fastBaudMs;
    }
    const ms = bitsToMs(baudRate, value.value);
    const trunc = ms | 0;
    return trunc + (ms > trunc ? 1 : 0);
  }

  /**
   * Reset the framing FSM — drop residual bytes, expected-length pin, and
   * any pending silence safety timer. Used by the master/slave after
   * a transport hiccup to re-align with the next clean frame boundary.
   *
   * @returns `void`.
   */
  override flush(): void {
    this._residualLen = 0;
    this._expectedLen = PREDICT_NEED_MORE;
    this._t15Marker = 0;
    this._lastChunkTime = 0;
    if (this._t35Timer !== undefined) {
      clearTimeout(this._t35Timer);
      this._t35Timer = undefined;
    }
  }

  /**
   * Decode incoming RTU bytes into ADU `frame` events.
   *
   * Incoming bus activity unconditionally cancels the pending t3.5 silence
   * deadline. The gap since the previous chunk is then compared against t3.5
   * (frame boundary) and, when configured, t1.5 (inter-character). The t3.5
   * deadline is re-armed at the end of the pass whenever residual bytes remain.
   * Frames are predicted from leading bytes using standard FC tables,
   * custom-function-code predictors, or the shared RTU predictor; only once the
   * full frame is available is the CRC16 validated. Frames that experience a
   * t1.5 gap may be discarded when strict timing is enabled.
   *
   * @param data Raw bytes received from the transport. Must not be modified.
   * @returns `void`.
   *
   * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
   */
  override decode(data: Buffer): void {
    let now = 0;

    // =======================================================================
    // 1. Timing reset: any bus activity unconditionally kills all silence timers
    // =======================================================================
    if (this._t35Timer !== undefined) {
      clearTimeout(this._t35Timer);
      this._t35Timer = undefined;

      now = performance.now();
      const gapMs = now - this._lastChunkTime;
      if (gapMs > this._t35Time) {
        const errorResidualLen = this._residualLen;
        this._residualLen = 0;
        this._expectedLen = PREDICT_NEED_MORE;
        this._t15Marker = 0;
        this._lastChunkTime = 0;

        if (this.onFrameError) {
          this.onFrameError({
            type: 't3.5_timeout',
            message: 'RTU frame incomplete: t3.5 inter-frame silence expired before a complete frame was received',
            raw: Buffer.copyBytesFrom(this._residual, 0, errorResidualLen),
          });
        } else if (this.onFrameErrorLazy) {
          this.onFrameErrorLazy(() => ({
            type: 't3.5_timeout',
            message: 'RTU frame incomplete: t3.5 inter-frame silence expired before a complete frame was received',
            raw: Buffer.copyBytesFrom(this._residual, 0, errorResidualLen),
          }));
        }
      } else if (this._t15Time > 0 && gapMs > this._t15Time) {
        this._t15Marker = this._residualLen;
        if (this._t15Strict) {
          if (this.onFrameError) {
            this.onFrameError({
              type: 't1.5_timeout',
              message: 'RTU inter-character timeout (t1.5) exceeded',
              raw: Buffer.copyBytesFrom(this._residual, 0, this._residualLen),
            });
          } else if (this.onFrameErrorLazy) {
            this.onFrameErrorLazy(() => ({
              type: 't1.5_timeout',
              message: 'RTU inter-character timeout (t1.5) exceeded',
              raw: Buffer.copyBytesFrom(this._residual, 0, this._residualLen),
            }));
          }
        }
      }
    }

    const dataLen = data.length;
    const residualLen = this._residualLen;

    // =======================================================================
    // 2. Fast path: no residual data and the new chunk is exactly one frame
    // =======================================================================
    if (residualLen === 0 && dataLen >= MIN_FRAME_LENGTH) {
      const fc = data[1];
      let frameLen = PREDICT_NEED_MORE;
      const cfc = this.customFunctionCodes[fc];
      if (cfc) {
        frameLen = cfc.determineFrameLength((idx) => data[idx], dataLen);
      } else if (this._isMaster) {
        if ((fc & 0x80) !== 0) {
          frameLen = 5;
        } else {
          const val = RES_TABLE[fc];
          if (val > 0) {
            frameLen = val;
          } else if (val < 0 && val !== -999) {
            const decode = -val;
            const offset = decode >>> 8;
            if (dataLen > offset) {
              frameLen = (decode & 0xff) + data[offset];
            }
          }
        }
      } else {
        const val = REQ_TABLE[fc];
        if (val > 0) {
          frameLen = val;
        } else if (val < 0) {
          const decode = -val;
          const offset = decode >>> 8;
          if (dataLen > offset) {
            frameLen = (decode & 0xff) + data[offset];
          }
        }
      }

      if (frameLen === dataLen) {
        const expectedCrc = data[frameLen - 2] | (data[frameLen - 1] << 8);
        // Inline CRC for the hot single-buffer path — local table reference helps V8 IC.
        let crc = 0xffff;
        const crcEnd = frameLen - 2;
        for (let i = 0; i < crcEnd; i++) {
          crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
        }
        if (expectedCrc === crc) {
          const dropFrame = this._timingEnabled && this._t15Strict && this._t15Marker > 0;
          if (!dropFrame) {
            if (this.onFrame) {
              const len = frameLen;
              this.onFrame({
                unit: data[0],
                fc: data[1],
                data: data.subarray(2, len - 2),
                buffer: data,
              });
            } else if (this.onFrameLazy) {
              const len = frameLen;
              this.onFrameLazy(() => ({
                unit: data[0],
                fc: data[1],
                data: data.subarray(2, len - 2),
                buffer: data,
              }));
            }
          }
          this._expectedLen = PREDICT_NEED_MORE;
          this._t15Marker = 0;
          return;
        }
      }
    }

    const totalAvailable = residualLen + dataLen;
    let index = 0;
    if (!(this._expectedLen > 0 && totalAvailable < this._expectedLen)) {
      while (index <= totalAvailable - MIN_FRAME_LENGTH) {
        const fc = index + 1 < residualLen ? this._residual[index + 1] : data[index + 1 - residualLen];
        const cfc = this.customFunctionCodes[fc];
        let frameLen = PREDICT_NEED_MORE;
        if (cfc) {
          frameLen = cfc.determineFrameLength((idx) => {
            const pos = index + idx;
            return pos < residualLen ? this._residual[pos] : data[pos - residualLen];
          }, totalAvailable - index);
        } else {
          // Inlined RTU frame-length predictor — avoids function-call overhead on
          // the framing hot path. The loop condition guarantees >= MIN_FRAME_LENGTH
          // bytes are available, so the `len < 2` short-circuit is unnecessary.
          if (this._isMaster) {
            if ((fc & EXCEPTION_OFFSET) !== 0) {
              frameLen = 5;
            } else {
              const val = RES_TABLE[fc];
              if (val > 0) {
                frameLen = val;
              } else if (val < 0) {
                if (val === -999) {
                  // FC 43 / MEI 14 response — uncommon, but still inlined.
                  if (totalAvailable - index < 8) {
                    frameLen = PREDICT_NEED_MORE;
                  } else if ((index + 2 < residualLen ? this._residual[index + 2] : data[index + 2 - residualLen]) !== MEI_READ_DEVICE_ID) {
                    frameLen = PREDICT_UNKNOWN;
                  } else {
                    const numObjs = index + 7 < residualLen ? this._residual[index + 7] : data[index + 7 - residualLen];
                    let cursor = index + 8;
                    let needMore = false;
                    for (let i = 0; i < numObjs; i++) {
                      if (totalAvailable < cursor + 2) {
                        needMore = true;
                        break;
                      }
                      cursor += 2 + (cursor + 1 < residualLen ? this._residual[cursor + 1] : data[cursor + 1 - residualLen]);
                    }
                    frameLen = needMore ? PREDICT_NEED_MORE : cursor - index + 2;
                  }
                } else {
                  const decode = -val;
                  const offset = decode >>> 8;
                  if (totalAvailable - index <= offset) {
                    frameLen = PREDICT_NEED_MORE;
                  } else {
                    frameLen =
                      (decode & 0xff) +
                      (index + offset < residualLen ? this._residual[index + offset] : data[index + offset - residualLen]);
                  }
                }
              } else {
                frameLen = PREDICT_UNKNOWN;
              }
            }
          } else {
            const val = REQ_TABLE[fc];
            if (val > 0) {
              frameLen = val;
            } else if (val < 0) {
              const decode = -val;
              const offset = decode >>> 8;
              if (totalAvailable - index <= offset) {
                frameLen = PREDICT_NEED_MORE;
              } else {
                frameLen =
                  (decode & 0xff) + (index + offset < residualLen ? this._residual[index + offset] : data[index + offset - residualLen]);
              }
            } else {
              frameLen = PREDICT_UNKNOWN;
            }
          }
        }

        if (frameLen === PREDICT_UNKNOWN) {
          index++;
          continue;
        }

        if (frameLen === PREDICT_NEED_MORE) {
          break;
        }

        if (frameLen > MAX_FRAME_LENGTH || frameLen < MIN_FRAME_LENGTH) {
          index++;
          continue;
        }

        if (totalAvailable - index < frameLen) {
          this._expectedLen = index + frameLen;
          break;
        }

        const expectedCrc =
          (index + frameLen - 2 < residualLen ? this._residual[index + frameLen - 2] : data[index + frameLen - 2 - residualLen]) |
          ((index + frameLen - 1 < residualLen ? this._residual[index + frameLen - 1] : data[index + frameLen - 1 - residualLen]) << 8);
        const crcEnd = index + frameLen - 2;
        let actualCrc: number;
        if (crcEnd <= residualLen) {
          // Entire CRC range sits in the old residual buffer
          let crc = 0xffff;
          for (let i = index; i < crcEnd; i++) {
            crc = CRC_TABLE[(crc ^ this._residual[i]) & 0xff] ^ (crc >>> 8);
          }
          actualCrc = crc;
        } else if (index >= residualLen) {
          // Entire CRC range sits in the new data chunk
          const crcStart = index - residualLen;
          const crcStop = crcEnd - residualLen;
          let crc = 0xffff;
          for (let i = crcStart; i < crcStop; i++) {
            crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
          }
          actualCrc = crc;
        } else {
          // CRC range spans both buffers
          let crc = 0xffff;
          for (let i = index; i < residualLen; i++) {
            crc = CRC_TABLE[(crc ^ this._residual[i]) & 0xff] ^ (crc >>> 8);
          }
          const tailEnd = crcEnd - residualLen;
          for (let i = 0; i < tailEnd; i++) {
            crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
          }
          actualCrc = crc;
        }

        if (expectedCrc !== actualCrc) {
          index++;
          continue;
        }

        // CRC verified; frame is complete.
        this._expectedLen = PREDICT_NEED_MORE;
        const dropFrame = this._t15Strict && this._t15Marker > index && this._t15Marker < index + frameLen;
        if (!dropFrame) {
          if (this.onFrame) {
            const idx = index;
            const len = frameLen;
            // Build contiguous raw buffer — one alloc, zero-copy subarray for data.
            const raw = Buffer.allocUnsafe(len);
            if (idx + len <= residualLen) {
              this._residual.copy(raw, 0, idx, idx + len);
            } else if (idx >= residualLen) {
              data.copy(raw, 0, idx - residualLen, idx - residualLen + len);
            } else {
              const headLen = residualLen - idx;
              this._residual.copy(raw, 0, idx, residualLen);
              data.copy(raw, headLen, 0, len - headLen);
            }
            this.onFrame({
              unit: raw[0],
              fc: raw[1],
              data: raw.subarray(2, len - 2),
              buffer: raw,
            });
          } else if (this.onFrameLazy) {
            const idx = index;
            const len = frameLen;
            this.onFrameLazy(() => {
              // Build contiguous raw buffer — one alloc, zero-copy subarray for data.
              const raw = Buffer.allocUnsafe(len);
              if (idx + len <= residualLen) {
                this._residual.copy(raw, 0, idx, idx + len);
              } else if (idx >= residualLen) {
                data.copy(raw, 0, idx - residualLen, idx - residualLen + len);
              } else {
                const headLen = residualLen - idx;
                this._residual.copy(raw, 0, idx, residualLen);
                data.copy(raw, headLen, 0, len - headLen);
              }
              return {
                unit: raw[0],
                fc: raw[1],
                data: raw.subarray(2, len - 2),
                buffer: raw,
              };
            });
          }
        }

        index += frameLen;
      }
    }

    // ========================================================================
    // 4. Compact residual buffer and rebuild silence timers
    // ========================================================================
    const finalRestLen = totalAvailable - index;
    if (finalRestLen === 0) {
      this._residualLen = 0;
      this._expectedLen = PREDICT_NEED_MORE;
      this._t15Marker = 0;
    } else {
      const keepLen = finalRestLen < MAX_FRAME_LENGTH ? finalRestLen : MAX_FRAME_LENGTH;
      const discardLen = totalAvailable - keepLen;

      if (discardLen >= residualLen) {
        // Kept portion lies entirely within the new `data`
        data.copy(this._residual, 0, discardLen - residualLen, dataLen);
      } else if (discardLen > 0) {
        // Kept portion spans both buffers, or physical left-shift truncation occurred
        const headLen = residualLen - discardLen;
        this._residual.copy(this._residual, 0, discardLen, residualLen);
        data.copy(this._residual, headLen, 0, dataLen);
      } else {
        // discardLen === 0 (old data not consumed, truncation limit not hit) — simple append
        data.copy(this._residual, residualLen, 0, dataLen);
      }
      this._residualLen = keepLen;

      // Unify physical coordinate system translation
      if (discardLen > 0) {
        if (this._expectedLen > 0) {
          const newExpectedLen = this._expectedLen - discardLen;
          this._expectedLen = newExpectedLen > PREDICT_NEED_MORE ? newExpectedLen : PREDICT_NEED_MORE;
        }
        if (this._t15Marker > 0) {
          const newT15Marker = this._t15Marker - discardLen;
          this._t15Marker = newT15Marker > 0 ? newT15Marker : 0;
        }
      }

      if (this._timingEnabled) {
        if (now) {
          this._lastChunkTime = now;
        } else {
          this._lastChunkTime = performance.now();
        }
        // Establish t3.5 absolute deadline
        this._t35Timer = setTimeout(() => {
          this._t35Timer = undefined;

          // No complete frame parsed within t3.5: circuit-break, discard all data
          const errorResidualLen = this._residualLen;
          this._residualLen = 0;
          this._expectedLen = PREDICT_NEED_MORE;
          this._t15Marker = 0;
          this._lastChunkTime = 0;

          if (this.onFrameError) {
            this.onFrameError({
              type: 't3.5_timeout',
              message: 'RTU frame incomplete: t3.5 inter-frame silence expired before a complete frame was received',
              raw: Buffer.copyBytesFrom(this._residual, 0, errorResidualLen),
            });
          } else if (this.onFrameErrorLazy) {
            this.onFrameErrorLazy(() => ({
              type: 't3.5_timeout',
              message: 'RTU frame incomplete: t3.5 inter-frame silence expired before a complete frame was received',
              raw: Buffer.copyBytesFrom(this._residual, 0, errorResidualLen),
            }));
          }
        }, this._t35Time);
      }
    }
  }

  /**
   * Encode a unit/FC/payload tuple into a complete Modbus RTU frame.
   *
   * @param unit Unit / slave address byte (0..247).
   * @param fc Modbus function code byte (0..255).
   * @param data PDU payload bytes (length 0..254).
   * @param transaction Ignored by RTU; present only for signature compatibility.
   * @returns The framed RTU buffer (length `4 + data.length`) with little-endian CRC16.
   *
   * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
   */
  override encode(unit: number, fc: number, data: Buffer, transaction?: number): Buffer {
    const buffer = Buffer.allocUnsafe(data.length + 4);
    // Inline header — direct typed-array stores skip Buffer's per-call checks.
    buffer[0] = unit;
    buffer[1] = fc;
    if (data.length <= 16) {
      for (let i = 0; i < data.length; i++) {
        buffer[2 + i] = data[i];
      }
    } else {
      buffer.set(data, 2);
    }
    // Inline CRC-16 table lookup — eliminates the encode-side function call.
    let crc = 0xffff;
    const crcEnd = buffer.length - 2;
    for (let i = 0; i < crcEnd; i++) {
      crc = CRC_TABLE[(crc ^ buffer[i]) & 0xff] ^ (crc >>> 8);
    }
    // Little-endian inline write of CRC trailer.
    buffer[crcEnd] = crc & 0xff;
    buffer[crcEnd + 1] = (crc >>> 8) & 0xff;
    return buffer;
  }
}
