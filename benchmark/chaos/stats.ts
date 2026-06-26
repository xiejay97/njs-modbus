/**
 * Chaos statistics helpers.
 *
 * Latency percentile computation with optional IQR 1.5× outlier filtering.
 * Reports both raw (true tail) and filtered (stable avg/CV) sets.
 */

import type { LatencyStats } from './types';

/** 5% trimmed mean (winsorized at the trimmed boundaries). */
function trimmedMean(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) {
    return 0;
  }
  const trimCount = Math.floor(n * 0.05);
  if (trimCount === 0) {
    let sum = 0;
    for (const v of sorted) {
      sum += v;
    }
    return sum / n;
  }
  const lo = sorted[trimCount];
  const hi = sorted[n - 1 - trimCount];
  let sum = 0;
  for (let i = trimCount; i < n - trimCount; i++) {
    sum += sorted[i];
  }
  return (sum + lo * trimCount + hi * trimCount) / n;
}

/** Relative standard deviation (%). */
function rsd(sorted: number[]): number {
  const n = sorted.length;
  if (n < 2) {
    return 0;
  }
  let sum = 0;
  for (const v of sorted) {
    sum += v;
  }
  const mean = sum / n;
  if (mean === 0) {
    return 0;
  }
  let sq = 0;
  for (const v of sorted) {
    const d = v - mean;
    sq += d * d;
  }
  const sd = Math.sqrt(sq / (n - 1));
  return (sd / mean) * 100;
}

export function computeLatency(samples: number[]): LatencyStats | undefined {
  const sorted = [...samples].sort((a, b) => a - b);
  const count = sorted.length;
  if (count === 0) {
    return undefined;
  }
  return {
    min: sorted[0],
    p50: sorted[Math.floor(count * 0.5)],
    p90: sorted[Math.floor(count * 0.9)],
    p95: sorted[Math.floor(count * 0.95)],
    p99: sorted[Math.floor(count * 0.99)],
    max: sorted[count - 1],
    avg: trimmedMean(sorted),
    rsd: rsd(sorted),
  };
}

/** IQR 1.5× filter. Returns the input unchanged when there are < 4 samples. */
export function filterOutliers(samples: number[]): number[] {
  if (samples.length < 4) {
    return samples;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  const q1 = sorted[Math.floor(sorted.length * 0.25)];
  const q3 = sorted[Math.floor(sorted.length * 0.75)];
  const iqr = q3 - q1;
  const lo = q1 - iqr * 1.5;
  const hi = q3 + iqr * 1.5;
  return samples.filter((v) => v >= lo && v <= hi);
}

export interface LatencyPair {
  raw: LatencyStats | undefined;
  filtered: LatencyStats | undefined;
  outliersRemoved: number;
}

export function computeLatencyPair(samples: number[]): LatencyPair {
  if (samples.length === 0) {
    return { raw: undefined, filtered: undefined, outliersRemoved: 0 };
  }
  const raw = computeLatency(samples);
  const filteredArr = filterOutliers(samples);
  const outliersRemoved = samples.length - filteredArr.length;
  const filtered = filteredArr.length > 0 ? computeLatency(filteredArr) : raw;
  return { raw, filtered, outliersRemoved };
}

/** Percentile of a sorted or unsorted sample. */
export function percentile(samples: number[], p: number): number {
  if (samples.length === 0) {
    return 0;
  }
  const sorted = [...samples].sort((a, b) => a - b);
  return sorted[Math.floor(samples.length * p)];
}
