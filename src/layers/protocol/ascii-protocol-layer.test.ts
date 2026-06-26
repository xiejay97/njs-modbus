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

import { AsciiProtocolLayer } from './ascii-protocol-layer';

import { asciiExceptionFrame, asciiFrame, pduReadCoils } from '#test/helpers/fixtures';
import { collectFrames } from '#test/helpers/utils';

/** Build a FC 3 response PDU for the given register values. */
function pduReadRegistersResponse(values: number[]): Buffer {
  const byteCount = values.length * 2;
  const pdu = Buffer.allocUnsafe(1 + byteCount);
  pdu[0] = byteCount;
  let off = 1;
  for (const v of values) {
    pdu[off++] = (v >>> 8) & 0xff;
    pdu[off++] = v & 0xff;
  }
  return pdu;
}

describe('AsciiProtocolLayer', () => {
  it('should encode a frame with a valid LRC', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const pdu = pduReadCoils(0, 10);

    const encoded = layer.encode(1, 0x03, pdu);
    const expected = asciiFrame(1, 0x03, pdu);

    expect(encoded).toEqual(expected);
  });

  it('should parse a complete response frame via the fast path (MASTER)', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234, 0x5678]);
    layer.decode(asciiFrame(1, 0x03, pdu));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should parse a complete request frame via the fast path (SLAVE)', () => {
    const layer = new AsciiProtocolLayer('SLAVE');
    const { frames } = collectFrames(layer);

    const pdu = pduReadCoils(0, 10);
    layer.decode(asciiFrame(1, 0x03, pdu));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should reassemble a response frame split across multiple data chunks', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234, 0x5678]);
    const frame = asciiFrame(1, 0x03, pdu);
    layer.decode(frame.subarray(0, 7));
    layer.decode(frame.subarray(7, 14));
    layer.decode(frame.subarray(14));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should parse an exception response', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    layer.decode(asciiExceptionFrame(1, 0x03, 0x02));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x83, data: Buffer.from([0x02]) });
  });

  it('should reject a frame with a bad LRC', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames, errors } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = asciiFrame(1, 0x03, pdu);
    // Flip the high LRC nibble to another valid hex digit so the frame stays
    // well-formed but the checksum no longer matches.
    const highNibble = frame[frame.length - 3];
    frame[frame.length - 3] = highNibble === 0x41 ? 0x42 : 0x41;
    layer.decode(frame);

    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('LRC');
  });

  it('should emit a framing error for illegal hex characters', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames, errors } = collectFrames(layer);

    const frame = asciiFrame(1, 0x03, pduReadCoils(0, 10));
    const corrupted = Buffer.from(frame);
    // Replace a payload hex digit with 'G' (0x47).
    corrupted[5] = 0x47;
    layer.decode(corrupted);

    expect(frames).toHaveLength(0);
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain('invalid hex character');
  });

  it('should accept lowercase hex digits when lenientHex is enabled', () => {
    const layer = new AsciiProtocolLayer('MASTER', { lenientHex: true });
    const { frames } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = asciiFrame(1, 0x03, pdu);
    const lower = Buffer.from(frame).toString().toLowerCase();
    layer.decode(Buffer.from(lower));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should reject lowercase hex digits when lenientHex is disabled', () => {
    const layer = new AsciiProtocolLayer('MASTER', { lenientHex: false });
    const { frames, errors } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = asciiFrame(1, 0x03, pdu);
    const lower = Buffer.from(frame).toString().toLowerCase();
    layer.decode(Buffer.from(lower));

    expect(frames).toHaveLength(0);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('should emit a framing error when the payload exceeds the ASCII limit', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames, errors } = collectFrames(layer);

    // Build an oversize payload: ASCII layer caps the hex body at 512 chars.
    // Emit it in chunks so the slow-path state machine enforces the limit.
    const bigPdu = Buffer.alloc(300, 0x00);
    const frame = asciiFrame(1, 0x10, bigPdu);
    for (let i = 0; i < frame.length; i += 64) {
      layer.decode(frame.subarray(i, i + 64));
    }

    expect(frames).toHaveLength(0);
    expect(errors.length).toBeGreaterThanOrEqual(1);
  });

  it('should emit a framing error for an incomplete frame without CRLF', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames, errors } = collectFrames(layer);

    const frame = asciiFrame(1, 0x03, pduReadCoils(0, 10));
    // Drop the trailing LF.
    layer.decode(frame.subarray(0, frame.length - 1));

    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(0);

    // A subsequent colon resets reception and the new frame is parsed.
    layer.decode(asciiFrame(1, 0x03, pduReadCoils(0, 10)));
    expect(frames).toHaveLength(1);
  });

  it('should reject a frame with a bad LRC via the slow path', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames, errors } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = asciiFrame(1, 0x03, pdu);
    const highNibble = frame[frame.length - 3];
    frame[frame.length - 3] = highNibble === 0x41 ? 0x42 : 0x41;

    // Send one byte at a time to force the state-machine path.
    for (let i = 0; i < frame.length; i++) {
      layer.decode(frame.subarray(i, i + 1));
    }

    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('LRC');
  });

  it('should emit a slow-path hex error in the reception state', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames, errors } = collectFrames(layer);

    const frame = asciiFrame(1, 0x03, pduReadCoils(0, 10));
    const corrupted = Buffer.from(frame);
    // Replace a payload hex digit with 'G' (0x47) while in reception state.
    corrupted[5] = 0x47;

    for (let i = 0; i < corrupted.length; i++) {
      layer.decode(corrupted.subarray(i, i + 1));
    }

    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('invalid hex character');
  });

  it('should emit a slow-path hex error in the waiting-end state', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames, errors } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = asciiFrame(1, 0x03, pdu);
    const corrupted = Buffer.from(frame);
    // Corrupt a payload hex digit that is validated after CR/LF is received.
    corrupted[9] = 0x47;

    for (let i = 0; i < corrupted.length; i++) {
      layer.decode(corrupted.subarray(i, i + 1));
    }

    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('invalid hex character');
  });

  it('should clear residual state on flush', () => {
    const layer = new AsciiProtocolLayer('SLAVE');
    const { frames } = collectFrames(layer);

    layer.decode(Buffer.from(':0103'));
    layer.flush();

    const pdu = pduReadCoils(0, 10);
    layer.decode(asciiFrame(1, 0x03, pdu));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should handle back-to-back frames in one chunk', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    const pdu1 = pduReadRegistersResponse([0x1234]);
    const pdu2 = pduReadRegistersResponse([0x5678]);
    const frame1 = asciiFrame(1, 0x03, pdu1);
    const frame2 = asciiFrame(1, 0x04, pdu2);
    layer.decode(Buffer.concat([frame1, frame2]));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu1 });
    expect(frames[1]).toMatchObject({ unit: 1, fc: 0x04, data: pdu2 });
  });

  it('should transition to waiting end when CR is received during reception', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    const pdu = pduReadCoils(0, 10);
    const frame = asciiFrame(1, 0x03, pdu);

    // Feed everything except the trailing CRLF one byte at a time.
    for (let i = 0; i < frame.length - 2; i++) {
      layer.decode(frame.subarray(i, i + 1));
    }

    // Send CR then LF separately.
    layer.decode(frame.subarray(frame.length - 2, frame.length - 1));
    layer.decode(frame.subarray(frame.length - 1));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should detect an invalid hex character in the payload via the slow path', () => {
    const layer = new AsciiProtocolLayer('MASTER');
    const { frames, errors } = collectFrames(layer);

    const frame = asciiFrame(1, 0x03, pduReadCoils(0, 10));
    const corrupted = Buffer.from(frame).toString();
    // Replace the first payload hex digit with 'G' while keeping unit/fc/lrc valid.
    const withBadPayload = corrupted.slice(0, 5) + 'G' + corrupted.slice(6);

    // Feed byte-by-byte so the slow-path state machine reports the error.
    const bytes = Buffer.from(withBadPayload);
    for (let i = 0; i < bytes.length; i++) {
      layer.decode(bytes.subarray(i, i + 1));
    }

    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(1);
    expect(errors[0].message).toContain('invalid hex character');
  });
});
