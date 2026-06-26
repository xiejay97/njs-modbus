/**
 * Response validators for chaos benchmarks.
 *
 * Verifies that received frames match sent requests at the frame-metadata
 * level (TID/unit/FC/byteCount). Business-data correctness is delegated to
 * the server implementations.
 */

import type { AnyFrame, AsciiFrame, BaseFrame, RtuFrame, TcpFrame, ValidationResult } from './types';

import { parseAsciiFrames, parseRtuFrames, parseTcpFrames } from './frames';

function matchesRequest(req: BaseFrame, resp: BaseFrame): boolean {
  if (resp.unit !== req.unit) {
    return false;
  }
  const isException = (resp.fc & 0x80) !== 0;
  const expectedFc = isException ? req.fc | 0x80 : req.fc;
  if (resp.fc !== expectedFc) {
    return false;
  }
  if (!isException && req.fc === 0x03) {
    const reqQty = (req.data[2] << 8) | req.data[3];
    const expectedByteCount = reqQty * 2;
    if (resp.data[0] !== expectedByteCount) {
      return false;
    }
  }
  return true;
}

export function validateTcpResponses(sent: TcpFrame[], received: Buffer): ValidationResult {
  const { frames: receivedFrames } = parseTcpFrames(received);
  const details: { index: number; ok: boolean; reason?: string }[] = [];
  let correct = 0;

  const byTid = new Map<number, TcpFrame[]>();
  for (const f of receivedFrames) {
    const arr = byTid.get(f.tid) ?? [];
    arr.push(f);
    byTid.set(f.tid, arr);
  }

  for (let i = 0; i < sent.length; i++) {
    const req = sent[i];
    const candidates = byTid.get(req.tid);

    if (!candidates || candidates.length === 0) {
      details.push({ index: i, ok: false, reason: `missing response for TID=${req.tid}` });
      continue;
    }

    const resp = candidates.find((f) => matchesRequest(req, f));
    if (!resp) {
      details.push({ index: i, ok: false, reason: `unit/FC mismatch for TID=${req.tid}` });
      continue;
    }

    details.push({ index: i, ok: true });
    correct++;

    const idx = candidates.indexOf(resp);
    candidates.splice(idx, 1);
    if (candidates.length === 0) {
      byTid.delete(req.tid);
    }
  }

  let extraFrames = 0;
  for (const arr of byTid.values()) {
    extraFrames += arr.length;
  }

  return {
    framesSent: sent.length,
    framesReceived: receivedFrames.length,
    framesCorrect: correct,
    framesExtra: extraFrames,
    errors: sent.length - correct + extraFrames,
    details,
  };
}

function validateSerialResponses(sent: AnyFrame[], received: Buffer, parse: (b: Buffer) => { frames: BaseFrame[] }): ValidationResult {
  const { frames: receivedFrames } = parse(received);
  const details: { index: number; ok: boolean; reason?: string }[] = [];
  let correct = 0;

  const matched = new Set<number>();
  for (let reqIdx = 0; reqIdx < sent.length; reqIdx++) {
    const req = sent[reqIdx];
    let found = false;
    for (let respIdx = 0; respIdx < receivedFrames.length; respIdx++) {
      if (matched.has(respIdx)) {
        continue;
      }
      if (matchesRequest(req, receivedFrames[respIdx])) {
        matched.add(respIdx);
        details.push({ index: reqIdx, ok: true });
        correct++;
        found = true;
        break;
      }
    }
    if (!found) {
      details.push({ index: reqIdx, ok: false, reason: 'no matching response' });
    }
  }

  const extraFrames = receivedFrames.length - matched.size;

  return {
    framesSent: sent.length,
    framesReceived: receivedFrames.length,
    framesCorrect: correct,
    framesExtra: extraFrames,
    errors: sent.length - correct + extraFrames,
    details,
  };
}

export function validateRtuResponses(sent: RtuFrame[], received: Buffer): ValidationResult {
  return validateSerialResponses(sent, received, (b) => parseRtuFrames(b));
}

export function validateAsciiResponses(sent: AsciiFrame[], received: Buffer): ValidationResult {
  return validateSerialResponses(sent, received, (b) => parseAsciiFrames(b));
}

/** Select the right validator by protocol. */
export function getValidator(protocol: 'TCP' | 'RTU' | 'ASCII'): (sent: AnyFrame[], received: Buffer) => ValidationResult {
  if (protocol === 'TCP') {
    return (sent, received) => validateTcpResponses(sent as TcpFrame[], received);
  }
  if (protocol === 'RTU') {
    return (sent, received) => validateRtuResponses(sent as RtuFrame[], received);
  }
  return (sent, received) => validateAsciiResponses(sent as AsciiFrame[], received);
}
