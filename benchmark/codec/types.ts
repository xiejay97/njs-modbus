/**
 * Codec micro-benchmark types.
 *
 * Defines the 12 encode/decode suites, runner options, and the result shape.
 * The result shape intentionally mirrors the legacy `BenchmarkResult` so the
 * P7 report layer can consume it without extra mapping.
 */

export type CodecSuite =
  | 'tcpReqEncode'
  | 'tcpResEncode'
  | 'tcpReqDecode'
  | 'tcpResDecode'
  | 'rtuReqEncode'
  | 'rtuResEncode'
  | 'rtuReqDecode'
  | 'rtuResDecode'
  | 'asciiReqEncode'
  | 'asciiResEncode'
  | 'asciiReqDecode'
  | 'asciiResDecode';

/** Latency percentile stats. */
export interface LatencyStats {
  min: number;
  p50: number;
  p90: number;
  p95: number;
  p99: number;
  max: number;
  avg: number;
  rsd: number;
}

/** Memory delta snapshot. */
export interface MemoryStats {
  rssDelta: number;
  heapUsedDelta: number;
  heapTotalDelta: number;
  externalDelta: number;
  arrayBuffersDelta: number;
}

/** GC pause stats. */
export interface GcStats {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

/** CPU accounting. */
export interface CpuStats {
  totalUs: number;
  usPerOp: number;
}

/** Result returned by {@link runCodecSuite}. */
export interface CodecBenchmarkResult {
  name: string;
  opsPerSecond: number;
  totalTimeMs: number;
  iterations: number;
  latency: LatencyStats | undefined;
  latencyFiltered: LatencyStats | undefined;
  sampleStats: {
    seen: number;
    capacity: number;
    overflowed: boolean;
    outliersRemoved: number;
  };
  memory: MemoryStats;
  gc: GcStats;
  cpu: CpuStats;
}

/** Options for {@link runCodecSuite}. */
export interface CodecRunOptions {
  /** Minimum measurement duration in milliseconds. Default 5000. */
  minDurationMs?: number;
  /** Minimum warmup duration in milliseconds. Default 3000. */
  warmupDurationMs?: number;
  /** Minimum warmup iterations. Default 50000. */
  warmupIterations?: number;
  /** Maximum latency samples to retain. Default 100000. */
  maxSamples?: number;
}
