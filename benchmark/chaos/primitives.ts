/**
 * Chaos data perturbation primitives.
 *
 * Pure Buffer transformations used by scene builders. Protocol-agnostic.
 */

/**
 * Split data into chunks of specified sizes.
 * The last chunk gets any remaining bytes.
 */
export function fragment(data: Buffer, chunkSizes: number[]): Buffer[] {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (const size of chunkSizes) {
    if (offset >= data.length) {
      break;
    }
    chunks.push(data.subarray(offset, offset + size));
    offset += size;
  }
  if (offset < data.length) {
    chunks.push(data.subarray(offset));
  }
  return chunks;
}

/**
 * Split data into N chunks as evenly as possible.
 */
export function fragmentEqual(data: Buffer, numChunks: number): Buffer[] {
  if (numChunks <= 1) {
    return [data];
  }
  const base = Math.floor(data.length / numChunks);
  const extra = data.length % numChunks;
  const sizes: number[] = [];
  for (let i = 0; i < numChunks; i++) {
    sizes.push(base + (i < extra ? 1 : 0));
  }
  return fragment(data, sizes);
}

/**
 * Split data into chunks of exactly `byteSize` bytes each.
 * The last chunk may be smaller.
 */
export function fragmentBySize(data: Buffer, byteSize: number): Buffer[] {
  if (byteSize <= 0) {
    return [data];
  }
  const chunks: Buffer[] = [];
  for (let i = 0; i < data.length; i += byteSize) {
    chunks.push(data.subarray(i, i + byteSize));
  }
  return chunks;
}

/** Concatenate multiple frames into a single sticky buffer. */
export function sticky(frames: Buffer[]): Buffer {
  return Buffer.concat(frames);
}

/**
 * Flip bits at specified positions.
 * If `bitIndices` is omitted, flips a random bit in each byte.
 */
export function flipBits(data: Buffer, bytePositions: number[], bitIndices?: number[]): Buffer {
  const result = Buffer.from(data);
  for (let i = 0; i < bytePositions.length; i++) {
    const pos = bytePositions[i];
    if (pos < 0 || pos >= result.length) {
      continue;
    }
    let bit = Math.floor(Math.random() * 8);
    if (bitIndices) {
      const specified = bitIndices[i];
      if (specified !== undefined) {
        bit = specified & 0x07;
      }
    }
    result[pos] ^= 1 << bit;
  }
  return result;
}

/** Truncate buffer to `byteCount` bytes. */
export function truncate(data: Buffer, byteCount: number): Buffer {
  return data.subarray(0, Math.max(0, byteCount));
}

/** Append garbage to the end of data. */
export function appendGarbage(data: Buffer, garbage: Buffer): Buffer {
  return Buffer.concat([data, garbage]);
}

/** Prepend garbage to the beginning of data. */
export function prependGarbage(data: Buffer, garbage: Buffer): Buffer {
  return Buffer.concat([garbage, data]);
}

/**
 * Interleave frames with garbage.
 * `[frameA, garbage, frameB, garbage, frameC]`
 */
export function interleaveGarbage(frames: Buffer[], garbage: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let i = 0; i < frames.length; i++) {
    parts.push(frames[i]);
    if (i < frames.length - 1) {
      parts.push(garbage);
    }
  }
  return Buffer.concat(parts);
}

/** Generate a repeating pattern of garbage bytes. */
export function patternGarbage(length: number, pattern: number[]): Buffer {
  const buf = Buffer.alloc(length);
  for (let i = 0; i < length; i++) {
    buf[i] = pattern[i % pattern.length];
  }
  return buf;
}
