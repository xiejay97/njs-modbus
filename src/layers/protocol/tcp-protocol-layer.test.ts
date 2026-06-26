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

import { TcpProtocolLayer } from './tcp-protocol-layer';

import { tcpFrame, tcpExceptionFrame, pduReadHoldingRegisters } from '#test/helpers/fixtures';
import { collectFrames } from '#test/helpers/utils';

describe('TcpProtocolLayer', () => {
  it('should encode a frame with an MBAP header', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const pdu = pduReadHoldingRegisters(0, 5);

    const encoded = layer.encode(1, 0x03, pdu, 1);
    const expected = tcpFrame(1, 1, 0x03, pdu);

    expect(encoded).toEqual(expected);
  });

  it('should parse a complete single frame via the fast path', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    const pdu = pduReadHoldingRegisters(0, 5);
    layer.decode(tcpFrame(7, 1, 0x03, pdu));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ transaction: 7, unit: 1, fc: 0x03, data: pdu });
  });

  it('should reassemble a frame split across multiple data chunks', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    const pdu = pduReadHoldingRegisters(0, 5);
    const frame = tcpFrame(2, 1, 0x03, pdu);
    layer.decode(frame.subarray(0, 6));
    layer.decode(frame.subarray(6));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ transaction: 2, unit: 1, fc: 0x03 });
  });

  it('should parse an exception response', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    layer.decode(tcpExceptionFrame(3, 1, 0x03, 0x02));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ transaction: 3, unit: 1, fc: 0x83, data: Buffer.from([0x02]) });
  });

  it('should emit a framing error for an invalid protocol ID', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const { errors } = collectFrames(layer);

    const bad = Buffer.from([0x00, 0x01, 0xab, 0xcd, 0x00, 0x04, 0x01, 0x03, 0x00, 0x00]);
    layer.decode(bad);

    expect(errors).toHaveLength(1);
  });

  it('should use the large-payload encode path', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const pdu = Buffer.alloc(20, 0xab);

    const encoded = layer.encode(1, 0x03, pdu, 1);
    expect(encoded).toEqual(tcpFrame(1, 1, 0x03, pdu));
  });

  it('should handle back-to-back frames in one chunk', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    const pdu = pduReadHoldingRegisters(0, 1);
    const frame1 = tcpFrame(1, 1, 0x03, pdu);
    const frame2 = tcpFrame(2, 1, 0x04, pdu);
    layer.decode(Buffer.concat([frame1, frame2]));

    expect(frames).toHaveLength(2);
    expect(frames[0]).toMatchObject({ transaction: 1, fc: 0x03 });
    expect(frames[1]).toMatchObject({ transaction: 2, fc: 0x04 });
  });

  it('should emit a framing error for an invalid protocol ID split across buffers', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const { errors } = collectFrames(layer);

    // First chunk leaves a residual that contains the invalid protocol-ID bytes
    // only after the second chunk arrives.
    layer.decode(Buffer.from([0x00, 0x01, 0xab]));
    layer.decode(Buffer.from([0xcd, 0x00, 0x04, 0x01, 0x03, 0x00, 0x00]));

    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('protocol_id_invalid');
  });

  it('should emit a framing error when the invalid protocol ID is entirely in new data', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const { errors } = collectFrames(layer);

    layer.decode(Buffer.from([0x00, 0x01]));
    layer.decode(Buffer.from([0xab, 0xcd, 0x00, 0x04, 0x01, 0x03, 0x00, 0x00]));

    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('protocol_id_invalid');
  });

  it('should emit a framing error for an invalid length field split across buffers', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const { errors } = collectFrames(layer);

    layer.decode(Buffer.from([0x00, 0x01, 0x00, 0x00]));
    layer.decode(Buffer.from([0xff, 0xff, 0x01, 0x03, 0x00, 0x00]));

    expect(errors).toHaveLength(1);
    expect(errors[0].type).toBe('frame_length_invalid');
  });

  it('should reassemble a frame that spans residual and new data', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    const pdu = pduReadHoldingRegisters(0, 5);
    const frame = tcpFrame(2, 1, 0x03, pdu);
    // Split so the MBAP header is in the residual and the payload in new data.
    layer.decode(frame.subarray(0, 7));
    layer.decode(frame.subarray(7));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ transaction: 2, unit: 1, fc: 0x03 });
  });

  it('should append new data to existing residual when the frame is still incomplete', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    layer.decode(Buffer.from([0x00, 0x01, 0x00, 0x00, 0x00]));
    layer.decode(Buffer.from([0x00, 0x06, 0x01, 0x03]));

    expect(frames).toHaveLength(0);
  });

  it('should handle an explicit transaction ID in encode', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const pdu = pduReadHoldingRegisters(0, 1);

    const encoded = layer.encode(1, 0x03, pdu, 42);
    expect(encoded.readUInt16BE(0)).toBe(42);
  });

  it('should buffer trailing bytes after a complete frame', () => {
    const layer = new TcpProtocolLayer('MASTER');
    const { frames } = collectFrames(layer);

    const pdu = pduReadHoldingRegisters(0, 1);
    const frame1 = tcpFrame(1, 1, 0x03, pdu);
    const frame2 = tcpFrame(2, 1, 0x04, pdu);
    layer.decode(Buffer.concat([frame1, frame2.subarray(0, 5)]));

    expect(frames).toHaveLength(1);
    expect(frames[0]).toMatchObject({ transaction: 1, fc: 0x03 });

    layer.decode(frame2.subarray(5));

    expect(frames).toHaveLength(2);
    expect(frames[1]).toMatchObject({ transaction: 2, fc: 0x04 });
  });
});
