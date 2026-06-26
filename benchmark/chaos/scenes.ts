/**
 * Chaos scene definitions.
 *
 * Builds corrupted/fragmented/sticky Modbus FC03 request frames for TCP, RTU,
 * and ASCII transports. Scene names follow the legacy convention
 * (`tcpSceneN`, `rtuSceneN`, `asciiSceneN`) so reports can compare directly.
 */

import type { AnyFrame, ChaosProtocol, SceneResult } from './types';

import { buildAsciiRequest, buildRtuRequest, buildTcpRequest, parseAsciiFrames, parseTcpFrames } from './frames';
import { flipBits, fragmentBySize, interleaveGarbage, patternGarbage, prependGarbage, sticky, truncate } from './primitives';

function buildRequests(protocol: ChaosProtocol, count: number): { frames: AnyFrame[]; raw: Buffer[] } {
  const frames: AnyFrame[] = [];
  const raw: Buffer[] = [];

  for (let i = 0; i < count; i++) {
    const addr = i;
    const qty = (i % 10) + 2;
    const data = [0x00, addr, 0x00, qty];

    if (protocol === 'TCP') {
      const buf = buildTcpRequest(i + 1, 1, 0x03, data);
      const parsed = parseTcpFrames(buf);
      frames.push(parsed.frames[0]);
      raw.push(buf);
    } else if (protocol === 'RTU') {
      const buf = buildRtuRequest(1, 0x03, data);
      frames.push({ unit: buf[0], fc: buf[1], data: buf.subarray(2, buf.length - 2), raw: buf });
      raw.push(buf);
    } else {
      const buf = buildAsciiRequest(1, 0x03, data);
      const parsed = parseAsciiFrames(buf);
      frames.push(parsed.frames[0]);
      raw.push(buf);
    }
  }

  return { frames, raw };
}

function findFramePositions(sentFrames: AnyFrame[], combined: Buffer): { index: number; start: number; end: number }[] {
  const positions: { index: number; start: number; end: number }[] = [];
  let searchFrom = 0;
  for (let i = 0; i < sentFrames.length; i++) {
    const raw = sentFrames[i].raw;
    const idx = combined.indexOf(raw, searchFrom);
    if (idx === -1) {
      continue;
    }
    positions.push({ index: i, start: idx, end: idx + raw.length });
    searchFrom = idx + raw.length;
  }
  return positions;
}

function countRecoverableFrames(sentFrames: AnyFrame[], combined: Buffer): number {
  return findFramePositions(sentFrames, combined).length;
}

function computeExpectedStrictCorrect(sentFrames: AnyFrame[], chunks: Buffer[]): number {
  const combined = Buffer.concat(chunks);
  const framePositions = findFramePositions(sentFrames, combined);
  if (framePositions.length === 0) {
    return 0;
  }

  const packetStarts = new Set<number>();
  let offset = 0;
  for (const chunk of chunks) {
    packetStarts.add(offset);
    offset += chunk.length;
  }

  const counted = new Set<number>();

  for (const fp of framePositions) {
    if (packetStarts.has(fp.start)) {
      counted.add(fp.index);
    }
  }

  let changed = true;
  while (changed) {
    changed = false;
    for (const fp of framePositions) {
      if (counted.has(fp.index)) {
        continue;
      }
      for (const other of framePositions) {
        if (!counted.has(other.index)) {
          continue;
        }
        if (fp.start === other.end) {
          counted.add(fp.index);
          changed = true;
          break;
        }
      }
    }
  }

  return counted.size;
}

function sceneBase(protocol: ChaosProtocol, chunks: Buffer[], description: string, sentFrames: AnyFrame[]): SceneResult {
  const expectedCorrect = countRecoverableFrames(sentFrames, Buffer.concat(chunks));
  const expectedStrictCorrect = computeExpectedStrictCorrect(sentFrames, chunks);
  return { chunks, description, sentFrames, protocol, expectedCorrect, expectedStrictCorrect };
}

function scene1SingleFrameDrip(protocol: ChaosProtocol): SceneResult {
  const { frames, raw } = buildRequests(protocol, 1);
  return sceneBase(protocol, fragmentBySize(sticky(raw), 1), 'Single frame drip-fed one byte at a time', frames);
}

function scene2TenFramesDrip(protocol: ChaosProtocol): SceneResult {
  const { frames, raw } = buildRequests(protocol, 10);
  return sceneBase(protocol, fragmentBySize(sticky(raw), 1), '10 frames drip-fed one byte at a time', frames);
}

function scene3TwoFramesSticky(protocol: ChaosProtocol): SceneResult {
  const { frames, raw } = buildRequests(protocol, 2);
  return sceneBase(protocol, [sticky(raw)], '2 valid frames stuck together', frames);
}

function scene4TenFramesSticky(protocol: ChaosProtocol): SceneResult {
  const { frames, raw } = buildRequests(protocol, 10);
  return sceneBase(protocol, [sticky(raw)], '10 valid frames stuck together', frames);
}

function scene5FiftyFramesVarying(protocol: ChaosProtocol): SceneResult {
  const { frames, raw } = buildRequests(protocol, 50);
  return sceneBase(protocol, [sticky(raw)], '50 frames with varying register counts stuck together', frames);
}

function scene6GarbageBetweenFrames(protocol: ChaosProtocol): SceneResult {
  const { frames, raw } = buildRequests(protocol, 2);
  return sceneBase(protocol, [interleaveGarbage(raw, Buffer.from([0xde, 0xad]))], 'Valid frame + 2 bytes garbage + valid frame', frames);
}

function scene7Mixed(protocol: ChaosProtocol): SceneResult {
  const { frames, raw } = buildRequests(protocol, 3);
  const combined = interleaveGarbage(raw, Buffer.from([0xbe, 0xef]));
  return sceneBase(protocol, fragmentBySize(combined, 3), '3 frames with interleaved garbage, sent in 3-byte chunks', frames);
}

function scene8CorruptChecksum(protocol: ChaosProtocol): SceneResult {
  const { frames, raw } = buildRequests(protocol, 2);

  if (protocol === 'TCP') {
    const corrupted = flipBits(raw[0], [4, 5], [0, 3]);
    return sceneBase(protocol, [Buffer.concat([corrupted, raw[1]])], 'MBAP length field corrupted in first frame', frames);
  }

  const corrupted = flipBits(raw[0], [raw[0].length - 1], [0]);
  return sceneBase(protocol, [Buffer.concat([corrupted, raw[1]])], 'Last byte (checksum) corrupted in first frame', frames);
}

function scene9GarbageThenFrame(protocol: ChaosProtocol): SceneResult {
  const { frames, raw } = buildRequests(protocol, 1);
  const garbage = patternGarbage(256, [0xde, 0xad, 0xbe, 0xef]);
  return sceneBase(protocol, [prependGarbage(raw[0], garbage)], '256 bytes garbage followed by one valid frame', frames);
}

function scene10SplitAtBoundary(protocol: ChaosProtocol): SceneResult {
  const { frames, raw } = buildRequests(protocol, 5);
  return sceneBase(protocol, fragmentBySize(sticky(raw), 2), '5 frames sent in 2-byte chunks (crosses frame boundaries)', frames);
}

function scene11GarbageAfterEveryFrame(protocol: ChaosProtocol): SceneResult {
  const { frames, raw } = buildRequests(protocol, 5);
  return sceneBase(
    protocol,
    [interleaveGarbage(raw, Buffer.from([0x00, 0x00, 0xff, 0xff]))],
    '5 frames with 4 bytes garbage after each',
    frames,
  );
}

function scene12TruncatedThenValid(protocol: ChaosProtocol): SceneResult {
  const { frames, raw } = buildRequests(protocol, 2);
  const truncated = truncate(raw[0], Math.floor(raw[0].length / 2));
  return sceneBase(protocol, [Buffer.concat([truncated, raw[1]])], 'Truncated first frame followed by valid second frame', frames);
}

function sceneAsciiColonInjection(): SceneResult {
  const protocol: ChaosProtocol = 'ASCII';
  const { frames, raw } = buildRequests(protocol, 2);
  const colon = Buffer.from([0x3a]);
  const injected = Buffer.concat([raw[0].subarray(0, 3), colon, raw[0].subarray(3), raw[1]]);
  return sceneBase(protocol, [injected], 'Colon injected mid-first-frame (forces parser restart)', frames);
}

function sceneAsciiCrNoLf(): SceneResult {
  const protocol: ChaosProtocol = 'ASCII';
  const { frames, raw } = buildRequests(protocol, 2);
  const modified = Buffer.from(raw[0]);
  modified[modified.length - 1] = 0x0d;
  return sceneBase(protocol, [Buffer.concat([modified, raw[1]])], 'First frame has CR+CR instead of CR+LF', frames);
}

const SCENES: Record<string, (protocol: ChaosProtocol) => SceneResult> = {
  scene1: scene1SingleFrameDrip,
  scene2: scene2TenFramesDrip,
  scene3: scene3TwoFramesSticky,
  scene4: scene4TenFramesSticky,
  scene5: scene5FiftyFramesVarying,
  scene6: scene6GarbageBetweenFrames,
  scene7: scene7Mixed,
  scene8: scene8CorruptChecksum,
  scene9: scene9GarbageThenFrame,
  scene10: scene10SplitAtBoundary,
  scene11: scene11GarbageAfterEveryFrame,
  scene12: scene12TruncatedThenValid,
};

const TCP_SCENE_MAP: Record<string, string> = {
  tcpScene1: 'scene1',
  tcpScene2: 'scene2',
  tcpScene3: 'scene3',
  tcpScene4: 'scene4',
  tcpScene5: 'scene5',
  tcpScene6: 'scene6',
  tcpScene7: 'scene7',
  tcpScene8: 'scene8',
  tcpScene9: 'scene9',
  tcpScene10: 'scene10',
  tcpScene11: 'scene11',
  tcpScene12: 'scene12',
};

const RTU_SCENE_MAP: Record<string, string> = {
  rtuScene1: 'scene1',
  rtuScene2: 'scene2',
  rtuScene3: 'scene3',
  rtuScene4: 'scene4',
  rtuScene5: 'scene5',
  rtuScene6: 'scene6',
  rtuScene7: 'scene7',
  rtuScene8: 'scene8',
  rtuScene9: 'scene9',
  rtuScene10: 'scene10',
  rtuScene11: 'scene11',
  rtuScene12: 'scene12',
};

const ASCII_SCENE_MAP: Record<string, string> = {
  asciiScene1: 'scene1',
  asciiScene2: 'scene2',
  asciiScene3: 'scene3',
  asciiScene4: 'scene4',
  asciiScene5: 'scene5',
  asciiScene6: 'scene6',
  asciiScene7: 'scene7',
  asciiScene8: 'scene8',
  asciiScene9: 'scene9',
  asciiScene10: 'scene10',
  asciiScene11: 'scene11',
  asciiScene12: 'scene12',
  asciiScene13: 'colonInjection',
  asciiScene14: 'crNoLf',
};

const ASCII_SPECIAL_SCENES: Record<string, () => SceneResult> = {
  colonInjection: sceneAsciiColonInjection,
  crNoLf: sceneAsciiCrNoLf,
};

/** Build a scene by name. */
export function buildScene(sceneName: string): SceneResult {
  let scene: SceneResult;

  if (sceneName.startsWith('tcp')) {
    const sceneKey = TCP_SCENE_MAP[sceneName];
    if (!sceneKey) {
      throw new Error(`Unknown TCP scene: ${sceneName}`);
    }
    scene = SCENES[sceneKey]('TCP');
  } else if (sceneName.startsWith('rtu')) {
    const sceneKey = RTU_SCENE_MAP[sceneName];
    if (!sceneKey) {
      throw new Error(`Unknown RTU scene: ${sceneName}`);
    }
    scene = SCENES[sceneKey]('RTU');
  } else if (sceneName.startsWith('ascii')) {
    const sceneKey = ASCII_SCENE_MAP[sceneName];
    if (!sceneKey) {
      throw new Error(`Unknown ASCII scene: ${sceneName}`);
    }
    scene = ASCII_SPECIAL_SCENES[sceneKey] ? ASCII_SPECIAL_SCENES[sceneKey]() : SCENES[sceneKey]('ASCII');
  } else {
    throw new Error(`Unknown scene: ${sceneName}`);
  }

  return scene;
}

export const SCENE_DESCRIPTIONS: Record<string, string> = {
  tcpScene1: 'Single frame drip-fed one byte at a time',
  tcpScene2: '10 frames drip-fed one byte at a time',
  tcpScene3: '2 valid frames stuck together',
  tcpScene4: '10 valid frames stuck together',
  tcpScene5: '50 frames with varying register counts stuck together',
  tcpScene6: 'Valid frame + 2 bytes garbage + valid frame',
  tcpScene7: '3 frames with interleaved garbage, sent in 3-byte chunks',
  tcpScene8: 'MBAP length field corrupted in first frame',
  tcpScene9: '256 bytes garbage followed by one valid frame',
  tcpScene10: '5 frames sent in 2-byte chunks (crosses frame boundaries)',
  tcpScene11: '5 frames with 4 bytes garbage after each',
  tcpScene12: 'Truncated first frame followed by valid second frame',
  rtuScene1: 'Single frame drip-fed one byte at a time',
  rtuScene2: '10 frames drip-fed one byte at a time',
  rtuScene3: '2 valid frames stuck together',
  rtuScene4: '10 valid frames stuck together',
  rtuScene5: '50 frames with varying register counts stuck together',
  rtuScene6: 'Valid frame + 2 bytes garbage + valid frame',
  rtuScene7: '3 frames with interleaved garbage, sent in 3-byte chunks',
  rtuScene8: 'Last byte (checksum) corrupted in first frame',
  rtuScene9: '256 bytes garbage followed by one valid frame',
  rtuScene10: '5 frames sent in 2-byte chunks (crosses frame boundaries)',
  rtuScene11: '5 frames with 4 bytes garbage after each',
  rtuScene12: 'Truncated first frame followed by valid second frame',
  asciiScene1: 'Single frame drip-fed one byte at a time',
  asciiScene2: '10 frames drip-fed one byte at a time',
  asciiScene3: '2 valid frames stuck together',
  asciiScene4: '10 valid frames stuck together',
  asciiScene5: '50 frames with varying register counts stuck together',
  asciiScene6: 'Valid frame + 2 bytes garbage + valid frame',
  asciiScene7: '3 frames with interleaved garbage, sent in 3-byte chunks',
  asciiScene8: 'Last byte (checksum) corrupted in first frame',
  asciiScene9: '256 bytes garbage followed by one valid frame',
  asciiScene10: '5 frames sent in 2-byte chunks (crosses frame boundaries)',
  asciiScene11: '5 frames with 4 bytes garbage after each',
  asciiScene12: 'Truncated first frame followed by valid second frame',
  asciiScene13: 'Colon injected mid-first-frame (forces parser restart)',
  asciiScene14: 'First frame has CR+CR instead of CR+LF',
};

export const SCENE_SHORT_LABELS: Record<string, string> = {
  tcpScene1: 'drip-1',
  tcpScene2: 'drip-10',
  tcpScene3: 'sticky-2',
  tcpScene4: 'sticky-10',
  tcpScene5: 'sticky-50',
  tcpScene6: 'garbage-2B',
  tcpScene7: 'mixed',
  tcpScene8: 'corrupt-len',
  tcpScene9: 'garbage-256B',
  tcpScene10: 'chunk-2B',
  tcpScene11: 'garbage-after',
  tcpScene12: 'truncated',
  rtuScene1: 'drip-1',
  rtuScene2: 'drip-10',
  rtuScene3: 'sticky-2',
  rtuScene4: 'sticky-10',
  rtuScene5: 'sticky-50',
  rtuScene6: 'garbage-2B',
  rtuScene7: 'mixed',
  rtuScene8: 'corrupt-crc',
  rtuScene9: 'garbage-256B',
  rtuScene10: 'chunk-2B',
  rtuScene11: 'garbage-after',
  rtuScene12: 'truncated',
  asciiScene1: 'drip-1',
  asciiScene2: 'drip-10',
  asciiScene3: 'sticky-2',
  asciiScene4: 'sticky-10',
  asciiScene5: 'sticky-50',
  asciiScene6: 'garbage-2B',
  asciiScene7: 'mixed',
  asciiScene8: 'corrupt-lrc',
  asciiScene9: 'garbage-256B',
  asciiScene10: 'chunk-2B',
  asciiScene11: 'garbage-after',
  asciiScene12: 'truncated',
  asciiScene13: 'colon-inject',
  asciiScene14: 'cr-no-lf',
};

/** All available scene names. */
export function getAllSceneNames(): string[] {
  return [...Object.keys(TCP_SCENE_MAP), ...Object.keys(RTU_SCENE_MAP), ...Object.keys(ASCII_SCENE_MAP)];
}

/** Scene names for a single protocol. */
export function getSceneNamesForProtocol(protocol: 'TCP' | 'RTU' | 'ASCII'): string[] {
  if (protocol === 'TCP') {
    return Object.keys(TCP_SCENE_MAP);
  }
  if (protocol === 'RTU') {
    return Object.keys(RTU_SCENE_MAP);
  }
  return Object.keys(ASCII_SCENE_MAP);
}
