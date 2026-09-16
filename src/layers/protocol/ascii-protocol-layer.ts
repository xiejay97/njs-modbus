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

/** Maximum number of hex characters allowed between the leading ':' and trailing CRLF in an ASCII frame. */
const MAX_FRAME_LENGTH = 512;

/**
 * Maximum number of decoded bytes staged during fragmented reception
 * (unit + FC + PDU + LRC). Exactly half of {@link MAX_FRAME_LENGTH}: every two
 * on-wire hex characters are folded into one byte the moment they arrive, so
 * the staging buffer is 256 bytes instead of 512.
 */
const MAX_BODY_LENGTH = MAX_FRAME_LENGTH >> 1;

/** Wire byte codes for the ASCII frame delimiter characters. */
const CHAR_CODE = {
  COLON: ':'.charCodeAt(0),
  CR: '\r'.charCodeAt(0),
  LF: '\n'.charCodeAt(0),
};

/**
 * Hex-decode lookup table — `HEX_DECODE[byte]` returns the 4-bit nibble for
 * `'0'..'9' / 'A'..'F' / 'a'..'f'`, and `0xFF` for any non-hex byte. The
 * single-table-lookup form keeps the inner FSM loop branchless.
 *
 * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
 */
const HEX_DECODE = new Uint8Array(256);
HEX_DECODE.fill(0xff);
for (let i = 0x30; i <= 0x39; i++) {
  HEX_DECODE[i] = i - 0x30;
}
for (let i = 0x41; i <= 0x46; i++) {
  HEX_DECODE[i] = i - 0x41 + 10;
}
for (let i = 0x61; i <= 0x66; i++) {
  HEX_DECODE[i] = i - 0x61 + 10;
}
/**
 * Strict hex-decode lookup table.
 *
 * Lowercase hex digits (`a`..`f`) are treated as invalid so the hot-path
 * validation loop needs only one table lookup instead of two case checks.
 */
const HEX_DECODE_STRICT = new Uint8Array(HEX_DECODE);
for (let i = 0x61; i <= 0x66; i++) {
  HEX_DECODE_STRICT[i] = 0xff;
}

/** Hex-encode lookup table — index 0..15 → ASCII byte for `'0'..'9' / 'A'..'F'`. */
const HEX_ENCODE = new Uint8Array('0123456789ABCDEF'.split('').map((c) => c.charCodeAt(0)));

/**
 * Flat 512-byte hex-encode pair table — `HEX_ENCODE_PAIR[byte << 1]` and
 * `HEX_ENCODE_PAIR[(byte << 1) + 1]` are the two uppercase ASCII characters
 * for that byte value. Removes per-byte shifts and masks from the encode hot path.
 */
const HEX_ENCODE_PAIR = new Uint8Array(512);
for (let byte = 0; byte < 256; byte++) {
  const off = byte << 1;
  HEX_ENCODE_PAIR[off] = HEX_ENCODE[byte >> 4];
  HEX_ENCODE_PAIR[off + 1] = HEX_ENCODE[byte & 0x0f];
}

/** User-facing ASCII protocol options. */
export interface AsciiProtocolLayerOptions {
  /**
   * Allow lowercase hex digits (`a..f`) in incoming frames.
   * The Modbus ASCII spec requires uppercase only; enable lenience only when
   * interoperating with non-compliant peers.
   * @default false
   */
  lenientHex?: boolean;
}

/**
 * Modbus ASCII protocol framing layer.
 *
 * Frames begin with a colon (`:`), carry two hex characters per byte, and end
 * with `\r\n`. An LRC sum-of-bytes checksum immediately precedes the CRLF. The
 * layer parses frames from arbitrary byte chunks using a small FSM and supports
 * strict uppercase hex or lenient lowercase hex.
 *
 * Fragmented reception stages decoded bytes (not hex characters) in a 256-byte
 * buffer with a running LRC accumulator: each arriving hex character folds into
 * a pending nibble or completes a byte, so end-of-frame validation is O(1) and
 * the staged frame is emitted with a single copy. Because the on-wire hex
 * characters are never retained, the `buffer` / `raw` fields of events emitted
 * from this path report the decoded frame bytes (unit + FC + PDU + LRC).
 */
export class AsciiProtocolLayer extends AbstractProtocolLayer {
  /** Always `'ASCII'` for this implementation. */
  public readonly PROTOCOL = 'ASCII' as const;
  /** Role of the owning stack — `'MASTER'` or `'SLAVE'`. */
  public readonly ROLE: 'MASTER' | 'SLAVE';

  private _status: 'idle' | 'reception' | 'waiting end' = 'idle';
  // Decoded-byte staging for fragmented reception. Hex characters are folded
  // into bytes on arrival, so 256 bytes cover the full 512-character hex body.
  private _body: Uint8Array = new Uint8Array(MAX_BODY_LENGTH);
  private _bodyLen: number = 0;
  // High nibble (0..15) awaiting its low half, or -1 when byte-aligned.
  private _pendingNibble: number = -1;
  // Running LRC accumulator over every staged byte, including the LRC byte
  // itself — a complete frame is valid iff `_lrcSum & 0xff === 0`.
  private _lrcSum: number = 0;

  private _lenientHex: boolean;
  private _hexTable: Uint8Array;

  /**
   * @param role `'MASTER'` for request issuance / response decoding,
   *   `'SLAVE'` for request decoding / response issuance.
   * @param options ASCII framing options.
   * @returns A new {@link AsciiProtocolLayer} instance.
   */
  constructor(role: 'MASTER' | 'SLAVE', options: AsciiProtocolLayerOptions = {}) {
    super();

    this.ROLE = role;

    this._lenientHex = options.lenientHex ?? false;
    this._hexTable = this._lenientHex ? HEX_DECODE : HEX_DECODE_STRICT;
  }

  /**
   * Reset the framing FSM to its `idle` state and discard any partial frame.
   *
   * @returns `void`.
   */
  override flush(): void {
    this._status = 'idle';
    this._bodyLen = 0;
    this._pendingNibble = -1;
    this._lrcSum = 0;
  }

  /**
   * Decode incoming ASCII bytes into ADU `frame` events.
   *
   * @param data Raw bytes received from the transport. Must not be modified.
   * @returns `void`.
   *
   * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
   */
  override decode(data: Buffer): void {
    const dataLen = data.length;

    // Fast path: idle state and the new chunk is exactly one complete frame.
    // ASCII frame: length >= 9, always odd (9 + 2n), and the hex body must not
    // exceed MAX_FRAME_LENGTH characters (1 colon + 512 hex + 2 CRLF = 515).
    if (this._status === 'idle' && dataLen >= 9 && dataLen <= MAX_FRAME_LENGTH + 3 && dataLen % 2 !== 0) {
      if (data[0] === CHAR_CODE.COLON && data[dataLen - 2] === CHAR_CODE.CR && data[dataLen - 1] === CHAR_CODE.LF) {
        const byteLen = (dataLen - 3) >> 1;
        const payloadLen = byteLen - 3;
        let dataOff = 1;

        const unitHi = this._hexTable[data[dataOff++]];
        const unitLo = this._hexTable[data[dataOff++]];
        const fcHi = this._hexTable[data[dataOff++]];
        const fcLo = this._hexTable[data[dataOff++]];
        if ((unitHi | unitLo | fcHi | fcLo) <= 15) {
          const unit = (unitHi << 4) | unitLo;
          const fc = (fcHi << 4) | fcLo;
          const payload = Buffer.allocUnsafe(payloadLen);
          let sum = unit + fc;
          let valid = true;

          for (let i = 0; i < payloadLen; i++) {
            const hi = this._hexTable[data[dataOff]];
            const lo = this._hexTable[data[dataOff + 1]];
            if ((hi | lo) > 15) {
              valid = false;
              break;
            }
            const byte = (hi << 4) | lo;
            payload[i] = byte;
            sum += byte;
            dataOff += 2;
          }

          if (valid) {
            const lrcHi = this._hexTable[data[dataOff]];
            const lrcLo = this._hexTable[data[dataOff + 1]];
            if ((lrcHi | lrcLo) <= 15) {
              const lrcIn = (lrcHi << 4) | lrcLo;
              const lrcComputed = (~sum + 1) & 0xff;
              if (lrcComputed === lrcIn) {
                if (this.onFrame) {
                  this.onFrame({ unit, fc, data: payload, buffer: data });
                } else if (this.onFrameLazy) {
                  this.onFrameLazy(() => ({ unit, fc, data: payload, buffer: data }));
                }
              } else {
                if (this.onFrameError) {
                  this.onFrameError({
                    type: 'lrc_check_failed',
                    message: `ASCII frame LRC check failed: expected 0x${lrcComputed.toString(16).padStart(2, '0').toUpperCase()}, received 0x${lrcIn.toString(16).padStart(2, '0').toUpperCase()}`,
                    raw: data,
                    fc,
                  });
                } else if (this.onFrameErrorLazy) {
                  this.onFrameErrorLazy(() => ({
                    type: 'lrc_check_failed',
                    message: `ASCII frame LRC check failed: expected 0x${lrcComputed.toString(16).padStart(2, '0').toUpperCase()}, received 0x${lrcIn.toString(16).padStart(2, '0').toUpperCase()}`,
                    raw: data,
                    fc,
                  }));
                }
              }
              return;
            }
          }
        }
      }
    }

    // Streaming state machine. Once reception begins, a tight inline lookahead
    // loop consumes every consecutive valid hex byte before returning to the
    // outer dispatch, eliminating per-byte switch overhead.
    let index = 0;
    while (index < dataLen) {
      if (this._status === 'idle') {
        if (data[index] === CHAR_CODE.COLON) {
          this._status = 'reception';
          this._bodyLen = 0;
          this._pendingNibble = -1;
          this._lrcSum = 0;
        }
        index++;
        continue;
      }

      if (this._status === 'reception') {
        while (index < dataLen) {
          const value = data[index];
          if (value === CHAR_CODE.COLON) {
            this._bodyLen = 0;
            this._pendingNibble = -1;
            this._lrcSum = 0;
            index++;
            continue;
          }
          if (value === CHAR_CODE.CR) {
            this._status = 'waiting end';
            index++;
            break;
          }
          if (this._bodyLen >= MAX_BODY_LENGTH) {
            const exceededLen = this._bodyLen;
            this._status = 'idle';
            this._bodyLen = 0;
            this._pendingNibble = -1;
            if (this.onFrameError) {
              this.onFrameError({
                type: 'frame_too_long',
                message: `ASCII frame hex body exceeds maximum length of ${MAX_FRAME_LENGTH} characters`,
                raw: Buffer.copyBytesFrom(this._body, 0, exceededLen),
              });
            } else if (this.onFrameErrorLazy) {
              this.onFrameErrorLazy(() => ({
                type: 'frame_too_long',
                message: `ASCII frame hex body exceeds maximum length of ${MAX_FRAME_LENGTH} characters`,
                raw: Buffer.copyBytesFrom(this._body, 0, exceededLen),
              }));
            }
            index++;
            break;
          }
          const nibble = this._hexTable[value];
          if (nibble > 15) {
            const bodyLen = this._bodyLen;
            const invalidPos = (bodyLen << 1) + (this._pendingNibble >= 0 ? 1 : 0);
            this._status = 'idle';
            this._bodyLen = 0;
            this._pendingNibble = -1;
            if (this.onFrameError) {
              this.onFrameError({
                type: 'hex_character_invalid',
                message: `ASCII frame contains invalid hex character 0x${value.toString(16).padStart(2, '0').toUpperCase()} at hex body position ${invalidPos}`,
                raw: Buffer.copyBytesFrom(this._body, 0, bodyLen),
              });
            } else if (this.onFrameErrorLazy) {
              this.onFrameErrorLazy(() => ({
                type: 'hex_character_invalid',
                message: `ASCII frame contains invalid hex character 0x${value.toString(16).padStart(2, '0').toUpperCase()} at hex body position ${invalidPos}`,
                raw: Buffer.copyBytesFrom(this._body, 0, bodyLen),
              }));
            }
            index++;
            break;
          }
          // Fold each hex pair into one staged byte and accumulate the LRC as
          // the characters arrive — no decode pass is needed at end-of-frame.
          if (this._pendingNibble >= 0) {
            const byte = (this._pendingNibble << 4) | nibble;
            this._body[this._bodyLen++] = byte;
            this._lrcSum += byte;
            this._pendingNibble = -1;
          } else {
            this._pendingNibble = nibble;
          }
          index++;
        }
        continue;
      }

      // 'waiting end'
      const value = data[index];
      if (value === CHAR_CODE.COLON) {
        this._status = 'reception';
        this._bodyLen = 0;
        this._pendingNibble = -1;
        this._lrcSum = 0;
      } else {
        this._status = 'idle';
        if (value === CHAR_CODE.LF) {
          const bodyLen = this._bodyLen;
          const hexLen = (bodyLen << 1) + (this._pendingNibble >= 0 ? 1 : 0);
          if (hexLen < 6) {
            if (this.onFrameError) {
              this.onFrameError({
                type: 'frame_length_insufficient',
                message: `ASCII frame hex body too short: received ${hexLen} characters, minimum is 6`,
                raw: Buffer.copyBytesFrom(this._body, 0, bodyLen),
              });
            } else if (this.onFrameErrorLazy) {
              this.onFrameErrorLazy(() => ({
                type: 'frame_length_insufficient',
                message: `ASCII frame hex body too short: received ${hexLen} characters, minimum is 6`,
                raw: Buffer.copyBytesFrom(this._body, 0, bodyLen),
              }));
            }
          } else if (this._pendingNibble >= 0) {
            if (this.onFrameError) {
              this.onFrameError({
                type: 'frame_length_invalid',
                message: `ASCII frame hex body has odd character count: ${hexLen}`,
                raw: Buffer.copyBytesFrom(this._body, 0, bodyLen),
              });
            } else if (this.onFrameErrorLazy) {
              this.onFrameErrorLazy(() => ({
                type: 'frame_length_invalid',
                message: `ASCII frame hex body has odd character count: ${hexLen}`,
                raw: Buffer.copyBytesFrom(this._body, 0, bodyLen),
              }));
            }
          } else if ((this._lrcSum & 0xff) !== 0) {
            const lrcIn = this._body[bodyLen - 1];
            const lrcComputed = -(this._lrcSum - lrcIn) & 0xff;
            const fc = this._body[1];
            if (this.onFrameError) {
              this.onFrameError({
                type: 'lrc_check_failed',
                message: `ASCII frame LRC check failed: expected 0x${lrcComputed.toString(16).padStart(2, '0').toUpperCase()}, received 0x${lrcIn.toString(16).padStart(2, '0').toUpperCase()}`,
                raw: Buffer.copyBytesFrom(this._body, 0, bodyLen),
                fc,
              });
            } else if (this.onFrameErrorLazy) {
              this.onFrameErrorLazy(() => ({
                type: 'lrc_check_failed',
                message: `ASCII frame LRC check failed: expected 0x${lrcComputed.toString(16).padStart(2, '0').toUpperCase()}, received 0x${lrcIn.toString(16).padStart(2, '0').toUpperCase()}`,
                raw: Buffer.copyBytesFrom(this._body, 0, bodyLen),
                fc,
              }));
            }
          } else {
            // LRC already verified by the running accumulator — emit one
            // contiguous decoded buffer with a zero-copy payload subarray,
            // mirroring the RTU layer's completion path.
            if (this.onFrame) {
              const raw = Buffer.copyBytesFrom(this._body, 0, bodyLen);
              this.onFrame({
                unit: raw[0],
                fc: raw[1],
                data: raw.subarray(2, bodyLen - 1),
                buffer: raw,
              });
            } else if (this.onFrameLazy) {
              this.onFrameLazy(() => {
                const raw = Buffer.copyBytesFrom(this._body, 0, bodyLen);
                return {
                  unit: raw[0],
                  fc: raw[1],
                  data: raw.subarray(2, bodyLen - 1),
                  buffer: raw,
                };
              });
            }
          }
        }
      }
      index++;
    }
  }

  /**
   * Encode a unit/FC/payload tuple into a complete Modbus ASCII frame.
   *
   * @param unit Unit / slave address byte (0..247).
   * @param fc Modbus function code byte (0..255).
   * @param data PDU payload bytes (length 0..253).
   * @param transaction Ignored by ASCII; present only for signature compatibility.
   * @returns The framed ASCII buffer (`:` + uppercase hex body + LRC + `\r\n`).
   *
   * @note Hot Path: Strictly Inline. Do not refactor into sub-routines.
   */
  override encode(unit: number, fc: number, data: Buffer, transaction?: number): Buffer {
    let sum = unit + fc;
    for (let i = 0; i < data.length; i++) {
      sum += data[i];
    }
    const lrcVal = -sum & 0xff;

    const out = Buffer.allocUnsafe(1 + (data.length + 3) * 2 + 2);
    out[0] = CHAR_CODE.COLON;
    let outOff = 1;

    // Hex encode unit
    let pairOff = unit << 1;
    out[outOff++] = HEX_ENCODE_PAIR[pairOff];
    out[outOff++] = HEX_ENCODE_PAIR[pairOff + 1];

    // Hex encode fc
    pairOff = fc << 1;
    out[outOff++] = HEX_ENCODE_PAIR[pairOff];
    out[outOff++] = HEX_ENCODE_PAIR[pairOff + 1];

    // Hex encode data
    for (let i = 0; i < data.length; i++) {
      const byte = data[i];
      pairOff = byte << 1;
      out[outOff++] = HEX_ENCODE_PAIR[pairOff];
      out[outOff++] = HEX_ENCODE_PAIR[pairOff + 1];
    }

    // Hex encode LRC
    pairOff = lrcVal << 1;
    out[outOff++] = HEX_ENCODE_PAIR[pairOff];
    out[outOff++] = HEX_ENCODE_PAIR[pairOff + 1];

    out[outOff++] = CHAR_CODE.CR;
    out[outOff++] = CHAR_CODE.LF;
    return out;
  }
}
