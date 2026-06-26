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

import { AbstractProtocolLayer } from './abstract-protocol-layer';

/**
 * MBAP envelope cap: 7-byte MBAP header (transaction(2) + protocol(2) +
 * length(2) + unit(1)) plus 253-byte PDU = 260 bytes total. Frames longer
 * than this are rejected as malformed.
 */
const MAX_FRAME_LENGTH = 260;

/**
 * Modbus TCP/IP protocol framing layer.
 *
 * Handles the 7-byte MBAP header (transaction identifier, protocol ID `0x0000`,
 * length, unit ID) followed by the PDU. Frames are parsed from arbitrary byte
 * chunks, including fragmented or coalesced TCP reads, using a flat residual
 * buffer.
 */
export class TcpProtocolLayer extends AbstractProtocolLayer {
  /** Always `'TCP'` for this implementation. */
  public readonly PROTOCOL = 'TCP' as const;
  /** Role of the owning stack — `'MASTER'` or `'SLAVE'`. */
  public readonly ROLE: 'MASTER' | 'SLAVE';

  private _residual = Buffer.alloc(MAX_FRAME_LENGTH);
  private _residualLen = 0;

  /**
   * @param role `'MASTER'` for request issuance / response decoding,
   *   `'SLAVE'` for request decoding / response issuance.
   * @returns A new {@link TcpProtocolLayer} instance.
   */
  constructor(role: 'MASTER' | 'SLAVE') {
    super();

    this.ROLE = role;
  }

  /**
   * Reset the framing FSM — drop residual bytes.
   *
   * @returns `void`.
   */
  override flush(): void {
    this._residualLen = 0;
  }

  /**
   * Decode incoming TCP bytes into ADU `frame` events.
   *
   * @param data Raw bytes received from the transport. Must not be modified.
   * @returns `void`.
   * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
   */
  override decode(data: Buffer): void {
    const dataLen = data.length;
    const residualLen = this._residualLen;

    // Fast path: no residual data and the new chunk is exactly one frame
    if (residualLen === 0 && dataLen >= 8) {
      if (data[2] === 0 && data[3] === 0) {
        const length = (data[4] << 8) | data[5];
        const frameLen = 6 + length;
        if (frameLen === dataLen && frameLen <= MAX_FRAME_LENGTH && length >= 2) {
          if (this.onFrame) {
            this.onFrame({
              transaction: (data[0] << 8) | data[1],
              unit: data[6],
              fc: data[7],
              data: data.subarray(8),
              buffer: data,
            });
          } else if (this.onFrameLazy) {
            this.onFrameLazy(() => ({
              transaction: (data[0] << 8) | data[1],
              unit: data[6],
              fc: data[7],
              data: data.subarray(8),
              buffer: data,
            }));
          }
          return;
        }
      }
    }

    let dataIndex = 0;

    if (residualLen > 0) {
      const totalAvailable = residualLen + dataLen;

      if (totalAvailable < 6) {
        data.copy(this._residual, residualLen, 0, dataLen);
        this._residualLen += dataLen;
        return;
      }

      const b2 = residualLen > 2 ? this._residual[2] : data[2 - residualLen];
      const b3 = residualLen > 3 ? this._residual[3] : data[3 - residualLen];

      if (b2 !== 0 || b3 !== 0) {
        if (this.onFrameError) {
          const rawLen = totalAvailable > MAX_FRAME_LENGTH ? MAX_FRAME_LENGTH : totalAvailable;
          const badRaw = Buffer.allocUnsafe(rawLen);
          this._residual.copy(badRaw, 0, 0, residualLen);
          if (residualLen < rawLen) {
            data.copy(badRaw, residualLen, 0, rawLen - residualLen);
          }
          this.onFrameError({
            type: 'protocol_id_invalid',
            message: `TCP MBAP protocol ID invalid at byte offset 0: expected 0x0000`,
            raw: badRaw,
          });
        } else if (this.onFrameErrorLazy) {
          this.onFrameErrorLazy(() => {
            const rawLen = totalAvailable > MAX_FRAME_LENGTH ? MAX_FRAME_LENGTH : totalAvailable;
            const badRaw = Buffer.allocUnsafe(rawLen);
            this._residual.copy(badRaw, 0, 0, residualLen);
            if (residualLen < rawLen) {
              data.copy(badRaw, residualLen, 0, rawLen - residualLen);
            }
            return {
              type: 'protocol_id_invalid',
              message: `TCP MBAP protocol ID invalid at byte offset 0: expected 0x0000`,
              raw: badRaw,
            };
          });
        }
        this._residualLen = 0;
        return;
      }

      const b4 = residualLen > 4 ? this._residual[4] : data[4 - residualLen];
      const b5 = residualLen > 5 ? this._residual[5] : data[5 - residualLen];
      const length = (b4 << 8) | b5;
      const frameLen = 6 + length;

      if (frameLen > MAX_FRAME_LENGTH || length < 2) {
        if (this.onFrameError) {
          const rawLen = totalAvailable > MAX_FRAME_LENGTH ? MAX_FRAME_LENGTH : totalAvailable;
          const badRaw = Buffer.allocUnsafe(rawLen);
          this._residual.copy(badRaw, 0, 0, residualLen);
          if (residualLen < rawLen) {
            data.copy(badRaw, residualLen, 0, rawLen - residualLen);
          }
          this.onFrameError({
            type: 'frame_length_invalid',
            message: `TCP MBAP length field invalid at byte offset 0: ${length} bytes (must be 2..${MAX_FRAME_LENGTH - 6})`,
            raw: badRaw,
          });
        } else if (this.onFrameErrorLazy) {
          this.onFrameErrorLazy(() => {
            const rawLen = totalAvailable > MAX_FRAME_LENGTH ? MAX_FRAME_LENGTH : totalAvailable;
            const badRaw = Buffer.allocUnsafe(rawLen);
            this._residual.copy(badRaw, 0, 0, residualLen);
            if (residualLen < rawLen) {
              data.copy(badRaw, residualLen, 0, rawLen - residualLen);
            }
            return {
              type: 'frame_length_invalid',
              message: `TCP MBAP length field invalid at byte offset 0: ${length} bytes (must be 2..${MAX_FRAME_LENGTH - 6})`,
              raw: badRaw,
            };
          });
        }
        this._residualLen = 0;
        return;
      }

      const needBytes = frameLen - residualLen;

      if (dataLen < needBytes) {
        data.copy(this._residual, residualLen, 0, dataLen);
        this._residualLen += dataLen;
        return;
      }

      if (this.onFrame) {
        const raw = Buffer.allocUnsafe(frameLen);
        this._residual.copy(raw, 0, 0, residualLen);
        data.copy(raw, residualLen, 0, needBytes);
        this.onFrame({
          transaction: (raw[0] << 8) | raw[1],
          unit: raw[6],
          fc: raw[7],
          data: raw.subarray(8),
          buffer: raw,
        });
      } else if (this.onFrameLazy) {
        this.onFrameLazy(() => {
          const raw = Buffer.allocUnsafe(frameLen);
          this._residual.copy(raw, 0, 0, residualLen);
          data.copy(raw, residualLen, 0, needBytes);
          return {
            transaction: (raw[0] << 8) | raw[1],
            unit: raw[6],
            fc: raw[7],
            data: raw.subarray(8),
            buffer: raw,
          };
        });
      }

      this._residualLen = 0;
      dataIndex = needBytes;
    }

    const limit = dataLen - 6;
    while (dataIndex <= limit) {
      if (data[dataIndex + 2] !== 0 || data[dataIndex + 3] !== 0) {
        if (this.onFrameError) {
          const start = dataIndex;
          const badLen = dataLen - start;
          const rawLen = badLen > MAX_FRAME_LENGTH ? MAX_FRAME_LENGTH : badLen;
          const badRaw = Buffer.allocUnsafe(rawLen);
          data.copy(badRaw, 0, start, start + rawLen);
          this.onFrameError({
            type: 'protocol_id_invalid',
            message: `TCP MBAP protocol ID invalid at byte offset ${start}: expected 0x0000`,
            raw: badRaw,
          });
        } else if (this.onFrameErrorLazy) {
          const start = dataIndex;
          this.onFrameErrorLazy(() => {
            const badLen = dataLen - start;
            const rawLen = badLen > MAX_FRAME_LENGTH ? MAX_FRAME_LENGTH : badLen;
            const badRaw = Buffer.allocUnsafe(rawLen);
            data.copy(badRaw, 0, start, start + rawLen);
            return {
              type: 'protocol_id_invalid',
              message: `TCP MBAP protocol ID invalid at byte offset ${start}: expected 0x0000`,
              raw: badRaw,
            };
          });
        }
        this._residualLen = 0;
        return;
      }

      const length = (data[dataIndex + 4] << 8) | data[dataIndex + 5];
      const frameLen = 6 + length;

      if (frameLen > MAX_FRAME_LENGTH || length < 2) {
        if (this.onFrameError) {
          const start = dataIndex;
          const badLen = dataLen - start;
          const rawLen = badLen > MAX_FRAME_LENGTH ? MAX_FRAME_LENGTH : badLen;
          const badRaw = Buffer.allocUnsafe(rawLen);
          data.copy(badRaw, 0, start, start + rawLen);
          this.onFrameError({
            type: 'frame_length_invalid',
            message: `TCP MBAP length field invalid at byte offset ${start}: ${length} bytes (must be 2..${MAX_FRAME_LENGTH - 6})`,
            raw: badRaw,
          });
        } else if (this.onFrameErrorLazy) {
          const start = dataIndex;
          this.onFrameErrorLazy(() => {
            const badLen = dataLen - start;
            const rawLen = badLen > MAX_FRAME_LENGTH ? MAX_FRAME_LENGTH : badLen;
            const badRaw = Buffer.allocUnsafe(rawLen);
            data.copy(badRaw, 0, start, start + rawLen);
            return {
              type: 'frame_length_invalid',
              message: `TCP MBAP length field invalid at byte offset ${start}: ${length} bytes (must be 2..${MAX_FRAME_LENGTH - 6})`,
              raw: badRaw,
            };
          });
        }
        this._residualLen = 0;
        return;
      }

      if (dataLen < dataIndex + frameLen) {
        break;
      }

      if (this.onFrame) {
        const start = dataIndex;
        this.onFrame({
          transaction: (data[start + 0] << 8) | data[start + 1],
          unit: data[start + 6],
          fc: data[start + 7],
          data: data.subarray(start + 8, start + frameLen),
          buffer: data.subarray(start, start + frameLen),
        });
      } else if (this.onFrameLazy) {
        const start = dataIndex;
        this.onFrameLazy(() => ({
          transaction: (data[start + 0] << 8) | data[start + 1],
          unit: data[start + 6],
          fc: data[start + 7],
          data: data.subarray(start + 8, start + frameLen),
          buffer: data.subarray(start, start + frameLen),
        }));
      }

      dataIndex += frameLen;
    }

    const finalRestLen = dataLen - dataIndex;
    if (finalRestLen === 0) {
      this._residualLen = 0;
    } else {
      const keepLen = finalRestLen < MAX_FRAME_LENGTH ? finalRestLen : MAX_FRAME_LENGTH;
      data.copy(this._residual, 0, dataIndex, dataIndex + keepLen);
      this._residualLen = keepLen;
    }
  }

  /**
   * Encode a unit/FC/payload tuple into a complete Modbus TCP frame.
   *
   * @param unit Unit / slave address byte (0..247).
   * @param fc Modbus function code byte (0..255).
   * @param data PDU payload bytes (length 0..253; caller must respect the
   *   253-byte PDU ceiling, as this routine allocates `data.length + 8` bytes
   *   without a runtime ceiling check).
   * @param transaction 16-bit TCP transaction identifier (big-endian on the
   *   wire). The caller supplies and tracks transaction IDs; this layer does not
   *   maintain an internal counter.
   * @returns The framed TCP buffer (length `8 + data.length`).
   *
   * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
   */
  override encode(unit: number, fc: number, data: Buffer, transaction: number): Buffer {
    const buffer = Buffer.allocUnsafe(data.length + 8);
    // Inline big-endian header writes — direct typed-array stores skip the
    // argument validation + bounds checks that `writeUInt16BE/writeUInt8` run.
    const len = data.length + 2;
    buffer[0] = (transaction >>> 8) & 0xff;
    buffer[1] = transaction & 0xff;
    buffer[2] = 0;
    buffer[3] = 0;
    buffer[4] = (len >>> 8) & 0xff;
    buffer[5] = len & 0xff;
    buffer[6] = unit;
    buffer[7] = fc;
    // Small-payload fast path: avoid C++ TypedArray.prototype.set boundary
    // crossing when the copy is just a few bytes (common for FC 3/4/6 requests).
    if (data.length <= 16) {
      for (let i = 0; i < data.length; i++) {
        buffer[8 + i] = data[i];
      }
    } else {
      buffer.set(data, 8);
    }
    return buffer;
  }
}
