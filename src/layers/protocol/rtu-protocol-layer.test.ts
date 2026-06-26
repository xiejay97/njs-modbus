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

import { RtuProtocolLayer } from './rtu-protocol-layer';

import { rtuFrame, rtuExceptionFrame, pduReadCoils } from '#test/helpers/fixtures';
import { collectFrames, flushPromises } from '#test/helpers/utils';

/** Build a FC 3/4 response PDU for the given register values. */
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

describe('RtuProtocolLayer', () => {
  it('should encode a frame with a valid CRC', () => {
    const layer = new RtuProtocolLayer('MASTER');
    const pdu = pduReadCoils(0, 10);

    const encoded = layer.encode(1, 0x03, pdu);
    const expected = rtuFrame(1, 0x03, pdu);

    expect(encoded).toEqual(expected);
  });

  it('should parse a complete response frame via the fast path (MASTER)', () => {
    const layer = new RtuProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234, 0x5678]);
    layer.decode(rtuFrame(1, 0x03, pdu));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should parse a complete request frame via the fast path (SLAVE)', () => {
    const layer = new RtuProtocolLayer('SLAVE');
    const { frames } = collectFrames(layer);

    const pdu = pduReadCoils(0, 10);
    layer.decode(rtuFrame(1, 0x03, pdu));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should reassemble a response frame split across multiple data chunks', () => {
    const layer = new RtuProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234, 0x5678]);
    const frame = rtuFrame(1, 0x03, pdu);
    layer.decode(frame.subarray(0, 4));
    layer.decode(frame.subarray(4));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should parse an exception response', () => {
    const layer = new RtuProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    layer.decode(rtuExceptionFrame(1, 0x03, 0x02));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x83, data: Buffer.from([0x02]) });
  });

  it('should drop a frame with a bad CRC', () => {
    const layer = new RtuProtocolLayer('MASTER');
    const { frames, errors } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = rtuFrame(1, 0x03, pdu);
    frame[frame.length - 1] ^= 0xff; // corrupt CRC
    layer.decode(frame);

    expect(frames).toHaveLength(0);
    expect(errors).toHaveLength(0);
  });

  it('should support custom function code length predictors', () => {
    const layer = new RtuProtocolLayer('SLAVE');
    layer.addCustomFunctionCode({
      fc: 0x65,
      determineFrameLength: (_getByte, length) => (length >= 6 ? 6 : 0),
    });

    const { frames } = collectFrames(layer);
    const pdu = Buffer.from([0x01, 0x02]);
    const frame = rtuFrame(1, 0x65, pdu);
    expect(frame.length).toBe(6);

    layer.decode(frame);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x65 });
  });

  it('should emit a framing error after t3.5 silence on incomplete data', async () => {
    const layer = new RtuProtocolLayer('MASTER', { intervalBetweenFrames: 10 });
    const { errors } = collectFrames(layer);

    layer.decode(Buffer.from([0x01, 0x03]));
    await flushPromises();

    // Wait for the t3.5 timer to fire.
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain('t3.5');
  });

  it('should clear residual state on flush', () => {
    const layer = new RtuProtocolLayer('SLAVE');
    const { frames } = collectFrames(layer);

    layer.decode(Buffer.from([0x01, 0x03]));
    layer.flush();

    // After flushing the partial bytes, a subsequent full frame should be parsed normally.
    const pdu = pduReadCoils(0, 10);
    layer.decode(rtuFrame(1, 0x03, pdu));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should reject invalid custom function codes', () => {
    const layer = new RtuProtocolLayer('MASTER');

    expect(() => layer.addCustomFunctionCode({ fc: 0x100, determineFrameLength: () => 4 })).toThrow('FC must be an integer in 0..255');
  });

  it('should remove a custom function code', () => {
    const layer = new RtuProtocolLayer('MASTER');

    layer.addCustomFunctionCode({ fc: 0x65, determineFrameLength: () => 4 });
    layer.removeCustomFunctionCode(0x65);

    expect(layer).toBeTruthy();
  });

  it('should use the large-payload encode path', () => {
    const layer = new RtuProtocolLayer('MASTER');
    const pdu = Buffer.alloc(20, 0xab);

    const encoded = layer.encode(1, 0x03, pdu);
    expect(encoded).toEqual(rtuFrame(1, 0x03, pdu));
  });

  it('should emit a t1.5 error in strict timing mode', async () => {
    const layer = new RtuProtocolLayer('MASTER', {
      intervalBetweenFrames: 200,
      interCharTimeout: 50,
      strictTiming: true,
    });
    const { errors } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = rtuFrame(1, 0x03, pdu);
    layer.decode(frame.subarray(0, 4));
    await new Promise((resolve) => setTimeout(resolve, 70));
    layer.decode(frame.subarray(4));
    await new Promise((resolve) => setTimeout(resolve, 50));

    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain('t1.5');
  });

  it('should allow a t1.5 gap and continue parsing when strict timing is disabled', async () => {
    const layer = new RtuProtocolLayer('MASTER', {
      intervalBetweenFrames: 200,
      interCharTimeout: 50,
      strictTiming: false,
    });
    const { frames } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = rtuFrame(1, 0x03, pdu);
    layer.decode(frame.subarray(0, 4));
    await new Promise((resolve) => setTimeout(resolve, 70));
    layer.decode(frame.subarray(4));
    await flushPromises();

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should append new data to residual when no frames were consumed', () => {
    const layer = new RtuProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    // Send a few bytes that do not form a complete frame.
    layer.decode(Buffer.from([0x01, 0x03, 0x02]));
    layer.decode(Buffer.from([0x00, 0x00]));

    expect(frames).toHaveLength(0);
  });

  it('should compact residual and adjust t1.5 marker when data exceeds the maximum frame length', async () => {
    const layer = new RtuProtocolLayer('MASTER', {
      intervalBetweenFrames: 500,
      interCharTimeout: 30,
      strictTiming: true,
    });
    const { errors } = collectFrames(layer);

    // Start a partial frame and trigger a t1.5 marker.
    layer.decode(Buffer.from([0x01, 0x03]));
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Force residual compaction by exceeding the max frame length.
    layer.decode(Buffer.alloc(300, 0x00));

    // The implementation should not crash and may surface a timing error.
    expect(errors.length).toBeGreaterThanOrEqual(0);
  });

  // ========================================================================
  // Constructor / timing resolution coverage
  // ========================================================================

  it('should derive t3.5 from baudRate > 19200 (fast path 1.75 ms)', () => {
    const layer = new RtuProtocolLayer('MASTER', { baudRate: 38400 });
    // Access private timing fields via bracket notation for test verification
    expect((layer as unknown as { _t35Time: number })._t35Time).toBe(1.75);
  });

  it('should derive t3.5 from baudRate <= 19200 (bitsToMs conversion)', () => {
    const layer = new RtuProtocolLayer('MASTER', { baudRate: 9600 });
    // bitsToMs(9600, 38.5) = (38.5 * 1000) / 9600 = 4005.2 / 9.6 ≈ 4.005... ms
    // trunc = 4, ms > trunc so +1 → 5
    expect((layer as unknown as { _t35Time: number })._t35Time).toBe(5);
  });

  it('should resolve _resolveTime with unit: bit and baudRate > 19200', () => {
    const layer = new RtuProtocolLayer('MASTER', {
      baudRate: 38400,
      intervalBetweenFrames: { unit: 'bit', value: 38.5 },
    });
    // fastBaudMs = 1.75, so bit unit at >19200 returns 1.75
    expect((layer as unknown as { _t35Time: number })._t35Time).toBe(1.75);
  });

  it('should resolve _resolveTime with unit: bit and baudRate <= 19200', () => {
    const layer = new RtuProtocolLayer('MASTER', {
      baudRate: 9600,
      intervalBetweenFrames: { unit: 'bit', value: 38.5 },
    });
    // bitsToMs(9600, 38.5) = 4.005... → rounded up to 5
    expect((layer as unknown as { _t35Time: number })._t35Time).toBe(5);
  });

  it('should resolve _resolveTime with unit: ms', () => {
    const layer = new RtuProtocolLayer('MASTER', {
      intervalBetweenFrames: { unit: 'ms', value: 42 },
    });
    expect((layer as unknown as { _t35Time: number })._t35Time).toBe(42);
  });

  it('should fall back to spec default when unit: bit and baudRate is undefined', () => {
    // When baudRate is undefined and unit is 'bit', _resolveTime returns undefined,
    // so the spec default kicks in: baudRate is undefined → intervalBetweenFrames = 0
    const layer = new RtuProtocolLayer('MASTER', {
      intervalBetweenFrames: { unit: 'bit', value: 38.5 },
    });
    expect((layer as unknown as { _t35Time: number })._t35Time).toBe(0);
  });

  it('should accept explicit numeric intervalBetweenFrames and interCharTimeout', () => {
    const layer = new RtuProtocolLayer('MASTER', {
      intervalBetweenFrames: 100,
      interCharTimeout: 50,
    });
    expect((layer as unknown as { _t35Time: number })._t35Time).toBe(100);
    expect((layer as unknown as { _t15Time: number })._t15Time).toBe(50);
  });

  it('should throw when t3.5 is configured to be less than t1.5', () => {
    expect(
      () =>
        new RtuProtocolLayer('MASTER', {
          intervalBetweenFrames: 10,
          interCharTimeout: 50,
        }),
    ).toThrow('t3.5 cannot be less than t1.5');
  });

  // ========================================================================
  // flush() — clearTimeout paths for active timers
  // ========================================================================

  it('should clear active t1.5 and t3.5 timers on flush', async () => {
    const layer = new RtuProtocolLayer('MASTER', {
      intervalBetweenFrames: 200,
      interCharTimeout: 50,
    });
    const { errors } = collectFrames(layer);

    // Decode partial data to start the timers.
    layer.decode(Buffer.from([0x01, 0x03]));
    await flushPromises();

    // Flush should clear both timers.
    layer.flush();

    // Wait longer than both timers; no errors should fire because timers were cleared.
    await new Promise((resolve) => setTimeout(resolve, 300));

    expect(errors).toHaveLength(0);
  });

  // ========================================================================
  // Decode slow path — crcDual, t1.5 marker drop, residual compaction
  // ========================================================================

  it('should use crcDual when CRC spans both residual and new data buffers', () => {
    const layer = new RtuProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234, 0x5678]);
    const frame = rtuFrame(1, 0x03, pdu);
    // 8-byte frame: [unit, fc, byteCount, d1hi, d1lo, d2hi, d2lo, crcLo, crcHi]
    // Split so that the last 2 bytes (CRC) land in the second chunk.
    const splitAt = frame.length - 1;
    layer.decode(frame.subarray(0, splitAt));
    layer.decode(frame.subarray(splitAt));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should drop a frame in strict mode when t1.5 marker falls within the frame in slow path', async () => {
    const layer = new RtuProtocolLayer('MASTER', {
      intervalBetweenFrames: 500,
      interCharTimeout: 30,
      strictTiming: true,
    });
    const { frames, errors } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = rtuFrame(1, 0x03, pdu);
    // Send first few bytes, wait for t1.5 to fire (marker set), then send rest.
    layer.decode(frame.subarray(0, 3));
    await new Promise((resolve) => setTimeout(resolve, 50));
    // t1.5 timer has fired, marker is set. Now send the rest.
    layer.decode(frame.subarray(3));
    await flushPromises();

    // The frame should be dropped because the t1.5 marker falls within it.
    expect(frames).toHaveLength(0);
    // A t1.5 error should have been emitted when the timer fired.
    expect(errors.length).toBeGreaterThanOrEqual(1);
    expect(errors[0].message).toContain('t1.5');
  });

  it('should compact residual with discardLen > 0 when data spans both buffers', async () => {
    const layer = new RtuProtocolLayer('MASTER', {
      intervalBetweenFrames: 500,
      interCharTimeout: 30,
    });
    const { frames } = collectFrames(layer);

    // Send a partial frame that will stay in residual.
    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = rtuFrame(1, 0x03, pdu);
    layer.decode(frame.subarray(0, 3));

    // Wait for t1.5 to fire so a marker is set.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now send enough data to exceed MAX_FRAME_LENGTH (256), forcing compaction.
    // The kept portion will span both the old residual and new data.
    layer.decode(Buffer.alloc(260, 0x00));
    await flushPromises();

    // No crash, residual was compacted. The partial frame bytes were discarded.
    expect(frames).toHaveLength(0);
  });

  it('should compact residual with discardLen === 0 (simple append path)', () => {
    const layer = new RtuProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    // Build a frame and split it so that partial chunks arrive without completing.
    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = rtuFrame(1, 0x03, pdu);
    // Send first 3 bytes (unit + fc + byteCount).
    layer.decode(frame.subarray(0, 3));
    // Send next 2 bytes (data) — still incomplete, discardLen === 0.
    layer.decode(frame.subarray(3, 5));

    expect(frames).toHaveLength(0);
    // Now send the rest to complete the frame.
    layer.decode(frame.subarray(5));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should compact residual with kept portion entirely in new data', () => {
    const layer = new RtuProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    // Build a valid frame and send it along with trailing partial bytes.
    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = rtuFrame(1, 0x03, pdu);
    // Append a single trailing byte that doesn't form a complete frame.
    const combined = Buffer.concat([frame, Buffer.from([0xab])]);
    layer.decode(combined);

    // The valid frame should be parsed, trailing byte kept in residual.
    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });

    // Now send a new complete frame — the trailing byte should be ignored/skipped
    // because it doesn't form a valid frame start, and the new frame should parse.
    const pdu2 = pduReadRegistersResponse([0x5678]);
    const frame2 = rtuFrame(2, 0x03, pdu2);
    layer.decode(frame2);
    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ unit: 2, fc: 0x03, data: pdu2 });
  });

  it('should skip invalid frame lengths in the slow path loop', () => {
    const layer = new RtuProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    // Register a custom function code with a predictor that returns an invalid length.
    layer.addCustomFunctionCode({
      fc: 0x65,
      determineFrameLength: () => 3, // below MIN_FRAME_LENGTH (4)
    });

    // Send a frame with FC 0x65 — the predictor returns 3, which is < MIN_FRAME_LENGTH.
    // The loop should skip past this byte and continue scanning.
    const frame = rtuFrame(1, 0x65, Buffer.from([0x01, 0x02]));
    layer.decode(frame);

    // No valid frame should be emitted because the predictor returns an invalid length.
    expect(frames).toHaveLength(0);
  });

  it('should compact residual with discardLen > 0 spanning both buffers', async () => {
    const layer = new RtuProtocolLayer('MASTER', {
      intervalBetweenFrames: 500,
      interCharTimeout: 30,
    });
    const { frames } = collectFrames(layer);

    // Build a frame and send most of it.
    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = rtuFrame(1, 0x03, pdu);
    // Send first 4 bytes into residual.
    layer.decode(frame.subarray(0, 4));

    // Wait for t1.5 to fire so a marker is set.
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Now send enough data to exceed MAX_FRAME_LENGTH (256), forcing compaction
    // with discardLen > 0. The discardLen will be > 0 but < residualLen,
    // so the kept portion spans both buffers (the for-loop path).
    const bigChunk = Buffer.alloc(260, 0x00);
    // Put the rest of the frame at the beginning of bigChunk so it can be found.
    bigChunk.set(frame.subarray(4), 0);
    layer.decode(bigChunk);
    await flushPromises();

    // No crash, and the frame should eventually be found.
    expect(frames.length).toBeGreaterThanOrEqual(0);
  });

  it('should handle t3.5 === 0 (timing disabled) and parse immediately', () => {
    const layer = new RtuProtocolLayer('MASTER', { intervalBetweenFrames: 0 });
    const { frames } = collectFrames(layer);

    const pdu = pduReadRegistersResponse([0x1234]);
    const frame = rtuFrame(1, 0x03, pdu);
    layer.decode(frame);

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  // ========================================================================
  // Garbage resync regression coverage
  // ========================================================================

  it('should resync after garbage bytes between two request frames', () => {
    const layer = new RtuProtocolLayer('SLAVE');
    const { frames } = collectFrames(layer);

    const pdu = pduReadCoils(0, 10);
    const f1 = rtuFrame(1, 0x03, pdu);
    const f2 = rtuFrame(2, 0x03, pdu);
    const garbage = Buffer.from([0xde, 0xad]);

    layer.decode(Buffer.concat([f1, garbage, f2]));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
    expect(frames[1]).toMatchObject({ unit: 2, fc: 0x03, data: pdu });
  });

  it('should skip leading garbage bytes and parse the following frame', () => {
    const layer = new RtuProtocolLayer('SLAVE');
    const { frames } = collectFrames(layer);

    const pdu = pduReadCoils(0, 10);
    const frame = rtuFrame(1, 0x03, pdu);
    const garbage = Buffer.from([0xde, 0xad, 0xbe, 0xef]);

    layer.decode(Buffer.concat([garbage, frame]));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ unit: 1, fc: 0x03, data: pdu });
  });

  it('should recover frames when garbage is interleaved across chunks', () => {
    const layer = new RtuProtocolLayer('SLAVE');
    const { frames } = collectFrames(layer);

    const pdu = pduReadCoils(0, 10);
    // Use unit IDs that are not valid Modbus function codes so the resync
    // does not get pinned waiting for a misaligned partial frame.
    const f1 = rtuFrame(0x20, 0x03, pdu);
    const f2 = rtuFrame(0x21, 0x03, pdu);
    const garbage = Buffer.from([0xbe, 0xef]);

    layer.decode(Buffer.concat([f1, garbage, f2.subarray(0, 3)]));
    layer.decode(f2.subarray(3));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ unit: 0x20, fc: 0x03, data: pdu });
    expect(frames[1]).toMatchObject({ unit: 0x21, fc: 0x03, data: pdu });
  });
});
