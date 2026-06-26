/**
 * Protocol frame builders and parsers for chaos benchmarks.
 *
 * Provides TCP / RTU / ASCII request/response frame construction and
 * incremental parsing. Parsers tolerate incomplete trailing bytes.
 */

import type { AsciiFrame, BaseFrame, RtuFrame, TcpFrame } from './types';

// ---------------------------------------------------------------------------
// CRC-16 (Modbus) — inlined hot path
// ---------------------------------------------------------------------------

const CRC_TABLE = new Uint16Array([
  0x0000, 0xc0c1, 0xc181, 0x0140, 0xc301, 0x03c0, 0x0280, 0xc241, 0xc601, 0x06c0, 0x0780, 0xc741, 0x0500, 0xc5c1, 0xc481, 0x0440, 0xcc01,
  0x0cc0, 0x0d80, 0xcd41, 0x0f00, 0xcfc1, 0xce81, 0x0e40, 0x0a00, 0xcac1, 0xcb81, 0x0b40, 0xc901, 0x09c0, 0x0880, 0xc841, 0xd801, 0x18c0,
  0x1980, 0xd941, 0x1b00, 0xdbc1, 0xda81, 0x1a40, 0x1e00, 0xdec1, 0xdf81, 0x1f40, 0xdd01, 0x1dc0, 0x1c80, 0xdc41, 0x1400, 0xd4c1, 0xd581,
  0x1540, 0xd701, 0x17c0, 0x1680, 0xd641, 0xd201, 0x12c0, 0x1380, 0xd341, 0x1100, 0xd1c1, 0xd081, 0x1040, 0xf001, 0x30c0, 0x3180, 0xf141,
  0x3300, 0xf3c1, 0xf281, 0x3240, 0x3600, 0xf6c1, 0xf781, 0x3740, 0xf501, 0x35c0, 0x3480, 0xf441, 0x3c00, 0xfcc1, 0xfd81, 0x3d40, 0xff01,
  0x3fc0, 0x3e80, 0xfe41, 0xfa01, 0x3ac0, 0x3b80, 0xfb41, 0x3900, 0xf9c1, 0xf881, 0x3840, 0x2800, 0xe8c1, 0xe981, 0x2940, 0xeb01, 0x2bc0,
  0x2a80, 0xea41, 0xee01, 0x2ec0, 0x2f80, 0xef41, 0x2d00, 0xedc1, 0xec81, 0x2c40, 0xe401, 0x24c0, 0x2580, 0xe541, 0x2700, 0xe7c1, 0xe681,
  0x2640, 0x2200, 0xe2c1, 0xe381, 0x2340, 0xe101, 0x21c0, 0x2080, 0xe041, 0xa001, 0x60c0, 0x6180, 0xa141, 0x6300, 0xa3c1, 0xa281, 0x6240,
  0x6600, 0xa6c1, 0xa781, 0x6740, 0xa501, 0x65c0, 0x6480, 0xa441, 0x6c00, 0xacc1, 0xad81, 0x6d40, 0xaf01, 0x6fc0, 0x6e80, 0xae41, 0xaa01,
  0x6ac0, 0x6b80, 0xab41, 0x6900, 0xa9c1, 0xa881, 0x6840, 0x7800, 0xb8c1, 0xb981, 0x7940, 0xbb01, 0x7bc0, 0x7a80, 0xba41, 0xbe01, 0x7ec0,
  0x7f80, 0xbf41, 0x7d00, 0xbdc1, 0xbc81, 0x7c40, 0xb401, 0x74c0, 0x7580, 0xb541, 0x7700, 0xb7c1, 0xb681, 0x7640, 0x7200, 0xb2c1, 0xb381,
  0x7340, 0xb101, 0x71c0, 0x7080, 0xb041, 0x5000, 0x90c1, 0x9181, 0x5140, 0x9301, 0x53c0, 0x5280, 0x9241, 0x9601, 0x56c0, 0x5780, 0x9741,
  0x5500, 0x95c1, 0x9481, 0x5440, 0x9c01, 0x5cc0, 0x5d80, 0x9d41, 0x5f00, 0x9fc1, 0x9e81, 0x5e40, 0x5a00, 0x9ac1, 0x9b81, 0x5b40, 0x9901,
  0x59c0, 0x5880, 0x9841, 0x8801, 0x48c0, 0x4980, 0x8941, 0x4b00, 0x8bc1, 0x8a81, 0x4a40, 0x4e00, 0x8ec1, 0x8f81, 0x4f40, 0x8d01, 0x4dc0,
  0x4c80, 0x8c41, 0x4400, 0x84c1, 0x8581, 0x4540, 0x8701, 0x47c0, 0x4680, 0x8641, 0x8201, 0x42c0, 0x4380, 0x8341, 0x4100, 0x81c1, 0x8081,
  0x4040,
]);

function crc16(data: Uint8Array): number {
  let crc = 0xffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >> 8);
  }
  return crc;
}

// ---------------------------------------------------------------------------
// LRC (ASCII)
// ---------------------------------------------------------------------------

function lrc8(data: Uint8Array): number {
  let sum = 0;
  for (let i = 0; i < data.length; i++) {
    sum += data[i];
  }
  return -sum & 0xff;
}

const HEX_ENCODE = Buffer.from('0123456789ABCDEF');

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

// ---------------------------------------------------------------------------
// TCP
// ---------------------------------------------------------------------------

export function buildTcpRequest(tid: number, unit: number, fc: number, data: number[]): Buffer {
  const payload = Buffer.from(data);
  const len = payload.length + 2;
  const buf = Buffer.allocUnsafe(8 + payload.length);
  buf.writeUInt16BE(tid, 0);
  buf.writeUInt16BE(0, 2);
  buf.writeUInt16BE(len, 4);
  buf.writeUInt8(unit, 6);
  buf.writeUInt8(fc, 7);
  payload.copy(buf, 8);
  return buf;
}

export function buildTcpRequestInto(tid: number, unit: number, fc: number, data: number[], out: Buffer): void {
  const payloadLen = data.length;
  const len = payloadLen + 2;
  out.writeUInt16BE(tid, 0);
  out.writeUInt16BE(0, 2);
  out.writeUInt16BE(len, 4);
  out.writeUInt8(unit, 6);
  out.writeUInt8(fc, 7);
  for (let i = 0; i < payloadLen; i++) {
    out[8 + i] = data[i];
  }
}

export function buildTcpResponse(tid: number, unit: number, fc: number, data: number[]): Buffer {
  return buildTcpRequest(tid, unit, fc, data);
}

export function parseTcpFrames(buffer: Buffer): { frames: TcpFrame[]; incomplete: Buffer } {
  const frames: TcpFrame[] = [];
  let offset = 0;

  while (offset + 8 <= buffer.length) {
    const tid = buffer.readUInt16BE(offset);
    const pid = buffer.readUInt16BE(offset + 2);
    const len = buffer.readUInt16BE(offset + 4);
    const unit = buffer[offset + 6];
    const fc = buffer[offset + 7];
    const frameLen = 6 + len;

    if (offset + frameLen > buffer.length) {
      break;
    }

    const data = buffer.subarray(offset + 8, offset + frameLen);
    frames.push({ tid, pid, unit, fc, data, raw: buffer.subarray(offset, offset + frameLen) });
    offset += frameLen;
  }

  return { frames, incomplete: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// RTU
// ---------------------------------------------------------------------------

export function buildRtuRequest(unit: number, fc: number, data: number[]): Buffer {
  const payload = Buffer.from(data);
  const buf = Buffer.allocUnsafe(payload.length + 4);
  buf[0] = unit;
  buf[1] = fc;
  payload.copy(buf, 2);
  const c = crc16(buf.subarray(0, payload.length + 2));
  buf[payload.length + 2] = c & 0xff;
  buf[payload.length + 3] = (c >>> 8) & 0xff;
  return buf;
}

export function buildRtuRequestInto(unit: number, fc: number, data: number[], out: Buffer): void {
  const payloadLen = data.length;
  out[0] = unit;
  out[1] = fc;
  for (let i = 0; i < payloadLen; i++) {
    out[2 + i] = data[i];
  }
  const c = crc16(out.subarray(0, payloadLen + 2));
  out[payloadLen + 2] = c & 0xff;
  out[payloadLen + 3] = (c >>> 8) & 0xff;
}

export function buildRtuResponse(unit: number, fc: number, data: number[]): Buffer {
  return buildRtuRequest(unit, fc, data);
}

function predictRtuResponseLength(fc: number, buf: Buffer, offset: number, available: number): number {
  if ((fc & 0x80) !== 0) {
    return 5;
  }

  switch (fc) {
    case 0x01:
    case 0x02:
    case 0x03:
    case 0x04:
    case 0x11:
      if (available < 3) {
        return -1;
      }
      return 5 + buf[offset + 2];
    case 0x05:
    case 0x06:
    case 0x0f:
    case 0x10:
      return 8;
    case 0x07:
      return 5;
    default:
      return -2;
  }
}

export function parseRtuFrames(buffer: Buffer): { frames: RtuFrame[]; incomplete: Buffer } {
  const frames: RtuFrame[] = [];
  let offset = 0;

  while (offset + 4 <= buffer.length) {
    const unit = buffer[offset];
    const fc = buffer[offset + 1];
    const frameLen = predictRtuResponseLength(fc, buffer, offset, buffer.length - offset);

    if (frameLen === -1) {
      break;
    }
    if (frameLen === -2) {
      offset++;
      continue;
    }

    if (offset + frameLen > buffer.length) {
      break;
    }

    const expectedCrc = buffer[offset + frameLen - 2] | (buffer[offset + frameLen - 1] << 8);
    const actualCrc = crc16(buffer.subarray(offset, offset + frameLen - 2));
    if (expectedCrc !== actualCrc) {
      offset++;
      continue;
    }

    const data = buffer.subarray(offset + 2, offset + frameLen - 2);
    frames.push({ unit, fc, data, raw: buffer.subarray(offset, offset + frameLen) });
    offset += frameLen;
  }

  return { frames, incomplete: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// ASCII
// ---------------------------------------------------------------------------

function writeHexByte(buf: Buffer, off: number, byte: number): number {
  buf[off++] = HEX_ENCODE[byte >> 4];
  buf[off++] = HEX_ENCODE[byte & 0x0f];
  return off;
}

export function buildAsciiRequest(unit: number, fc: number, data: number[]): Buffer {
  const payload = Buffer.from(data);
  const byteLen = payload.length + 3;
  const out = Buffer.allocUnsafe(1 + byteLen * 2 + 2);
  out[0] = 0x3a;
  let off = 1;

  off = writeHexByte(out, off, unit);
  off = writeHexByte(out, off, fc);
  for (let i = 0; i < payload.length; i++) {
    off = writeHexByte(out, off, payload[i]);
  }

  let sum = unit + fc;
  for (let i = 0; i < payload.length; i++) {
    sum += payload[i];
  }
  off = writeHexByte(out, off, -sum & 0xff);

  out[off++] = 0x0d;
  out[off++] = 0x0a;
  return out;
}

export function buildAsciiRequestInto(unit: number, fc: number, data: number[], out: Buffer): void {
  const payloadLen = data.length;
  out[0] = 0x3a;
  let off = 1;

  off = writeHexByte(out, off, unit);
  off = writeHexByte(out, off, fc);
  for (let i = 0; i < payloadLen; i++) {
    off = writeHexByte(out, off, data[i]);
  }

  let sum = unit + fc;
  for (let i = 0; i < payloadLen; i++) {
    sum += data[i];
  }
  off = writeHexByte(out, off, -sum & 0xff);

  out[off++] = 0x0d;
  out[off++] = 0x0a;
}

export function buildAsciiResponse(unit: number, fc: number, data: number[]): Buffer {
  return buildAsciiRequest(unit, fc, data);
}

export function parseAsciiFrames(buffer: Buffer): { frames: AsciiFrame[]; incomplete: Buffer } {
  const frames: AsciiFrame[] = [];
  let offset = 0;

  while (offset < buffer.length) {
    const colonIdx = buffer.indexOf(0x3a, offset);
    if (colonIdx === -1) {
      offset = buffer.length;
      break;
    }

    const crIdx = buffer.indexOf(0x0d, colonIdx + 1);
    if (crIdx === -1 || crIdx + 1 >= buffer.length) {
      offset = colonIdx;
      break;
    }
    if (buffer[crIdx + 1] !== 0x0a) {
      offset = colonIdx + 1;
      continue;
    }

    const frameLen = crIdx + 2 - colonIdx;
    if (frameLen < 9 || ((frameLen - 3) & 1) !== 0) {
      offset = colonIdx + 1;
      continue;
    }

    const asciiPayload = buffer.subarray(colonIdx + 1, crIdx);
    const byteLen = asciiPayload.length >> 1;

    let valid = true;
    for (let i = 0; i < asciiPayload.length; i++) {
      if (HEX_DECODE[asciiPayload[i]] > 15) {
        valid = false;
        break;
      }
    }
    if (!valid) {
      offset = colonIdx + 1;
      continue;
    }

    const decoded = Buffer.allocUnsafe(byteLen);
    for (let i = 0; i < byteLen; i++) {
      decoded[i] = (HEX_DECODE[asciiPayload[i * 2]] << 4) | HEX_DECODE[asciiPayload[i * 2 + 1]];
    }

    const unit = decoded[0];
    const fc = decoded[1];
    const lrcIn = decoded[decoded.length - 1];
    const data = decoded.subarray(2, decoded.length - 1);

    const lrcComputed = lrc8(decoded.subarray(0, decoded.length - 1));
    if (lrcIn !== lrcComputed) {
      offset = colonIdx + 1;
      continue;
    }

    frames.push({ unit, fc, data, raw: buffer.subarray(colonIdx, crIdx + 2) });
    offset = crIdx + 2;
  }

  return { frames, incomplete: buffer.subarray(offset) };
}

// ---------------------------------------------------------------------------
// Convenience
// ---------------------------------------------------------------------------

/** Build an FC03 request for the selected protocol. */
export function buildRequest(protocol: 'TCP' | 'RTU' | 'ASCII', tid: number, unit: number, data: number[]): Buffer {
  if (protocol === 'TCP') {
    return buildTcpRequest(tid, unit, 0x03, data);
  }
  if (protocol === 'RTU') {
    return buildRtuRequest(unit, 0x03, data);
  }
  return buildAsciiRequest(unit, 0x03, data);
}

/** Parse frames for the selected protocol. */
export function parseFrames(protocol: 'TCP' | 'RTU' | 'ASCII', buffer: Buffer): { frames: BaseFrame[]; incomplete: Buffer } {
  if (protocol === 'TCP') {
    const { frames, incomplete } = parseTcpFrames(buffer);
    return { frames, incomplete };
  }
  if (protocol === 'RTU') {
    const { frames, incomplete } = parseRtuFrames(buffer);
    return { frames: frames as BaseFrame[], incomplete };
  }
  const { frames, incomplete } = parseAsciiFrames(buffer);
  return { frames: frames as BaseFrame[], incomplete };
}

/** Frame-count parser usable by {@link JitterResistantCollector}. */
export function parseFrameCountFor(protocol: 'TCP' | 'RTU' | 'ASCII'): (collected: Buffer) => number {
  return (collected) => parseFrames(protocol, collected).frames.length;
}

/** Build a single clean FC03 request frame for recovery phases into a pre-allocated buffer. */
export function buildCleanFrameInto(protocol: 'TCP' | 'RTU' | 'ASCII', iteration: number, out: Buffer): void {
  const addr = iteration % 125;
  const qty = (iteration % 10) + 2;
  const data = [0x00, addr, 0x00, qty];
  if (protocol === 'TCP') {
    buildTcpRequestInto(iteration + 1, 1, 0x03, data, out);
    return;
  }
  if (protocol === 'RTU') {
    buildRtuRequestInto(1, 0x03, data, out);
    return;
  }
  buildAsciiRequestInto(1, 0x03, data, out);
}

/** Build a single clean FC03 request frame for recovery phases. */
export function buildCleanFrame(protocol: 'TCP' | 'RTU' | 'ASCII', iteration: number): Buffer {
  const addr = iteration % 125;
  const qty = (iteration % 10) + 2;
  const data = [0x00, addr, 0x00, qty];
  if (protocol === 'TCP') {
    return buildTcpRequest(iteration + 1, 1, 0x03, data);
  }
  if (protocol === 'RTU') {
    return buildRtuRequest(1, 0x03, data);
  }
  return buildAsciiRequest(1, 0x03, data);
}
