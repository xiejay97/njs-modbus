/**
 * Chaos benchmark types.
 *
 * Defines scene contracts, validation results, and the runner options/result
 * shapes. These types are intentionally separate from the legacy report types
 * so the runner can evolve without breaking the report schema.
 */

import type { NoiseFloorMetric } from './heap-snapshot';
import type { TransportHandle } from '../transport/types';

/** Supported chaos transports. */
export type ChaosProtocol = 'TCP' | 'RTU' | 'ASCII';

/** Scene-send shape. */
export interface SceneResult {
  /** Raw byte chunks to send in order. */
  chunks: Buffer[];
  /** Human-readable description. */
  description: string;
  /** Frames that were conceptually sent (for validation). */
  sentFrames: AnyFrame[];
  /** Transport protocol. */
  protocol: ChaosProtocol;
  /** Number of sent frames that a correct implementation should recover. */
  expectedCorrect: number;
  /** Strict per-packet expected correct count. */
  expectedStrictCorrect: number;
}

/** Generic frame metadata used by validators. */
export interface BaseFrame {
  unit: number;
  fc: number;
  data: Buffer;
  raw: Buffer;
}

/** TCP frame. */
export interface TcpFrame extends BaseFrame {
  tid: number;
  pid: number;
}

/** RTU frame. */
export type RtuFrame = BaseFrame;

/** ASCII frame. */
export type AsciiFrame = BaseFrame;

/** Any frame type handled by chaos validators. */
export type AnyFrame = TcpFrame | RtuFrame | AsciiFrame;

/** Validation outcome for a single sent frame. */
export interface FrameCheck {
  index: number;
  ok: boolean;
  reason?: string;
}

/** Result of validating received bytes against sent frames. */
export interface ValidationResult {
  framesSent: number;
  framesReceived: number;
  framesCorrect: number;
  framesExtra: number;
  errors: number;
  details: FrameCheck[];
}

/** Options for {@link runChaosScene}. */
export interface ChaosRunOptions {
  /** Library name used for metrics. */
  name: string;
  /** Scene name, e.g. `tcpScene3`. */
  sceneName: string;
  /** Raw transport handle to the server under test. */
  transport: TransportHandle;
  /** Chunks to send in each chaos iteration. */
  chunks: Buffer[];
  /** Number of frames expected per iteration. */
  expectedFrameCount: number;
  /** Total recoverable frames across the iteration. */
  expectedCorrect: number;
  /** Strict per-packet recoverable frames across the iteration. */
  expectedStrictCorrect: number;
  /** Validator for the selected protocol. */
  validate: (received: Buffer) => ValidationResult;
  /** Frame parser used by the collector. */
  parseFrameCount: (collected: Buffer) => number;
  /** Total chaos iterations. */
  requestCount: number;
  /** Iterations to discard before measurement. Default 10. */
  warmupIterations?: number;
  /** Per-iteration hard timeout. Default 100 ms. */
  requestTimeoutMs?: number;
  /** Consecutive timeouts before giving up. Default 5. */
  circuitBreakerThreshold?: number;
  /** Collector silence timeout. Default 50 ms. */
  silenceTimeoutMs?: number;
  /** Recovery phase clean-frame count. Default 100. */
  recoveryFrames?: number;
  /** Recovery per-frame timeout. Default 100 ms. */
  recoveryTimeoutMs?: number;
  /** Latency reservoir capacity. Default 100000. */
  maxSamples?: number;
  /** Number of calibration iterations for the memory noise floor. Default 5. */
  noiseFloorCalibrationIterations?: number;
  /** Heap metric used for noise-floor calibration. Default `usedHeapSize`. */
  noiseFloorMetric?: NoiseFloorMetric;
  /** Build a single clean request frame for the recovery phase. */
  buildCleanFrame: (iteration: number) => Buffer;
  /** Build a single clean request frame into a pre-allocated buffer. */
  buildCleanFrameInto: (iteration: number, out: Buffer) => void;
}

/** Latency percentile set (raw or filtered). */
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

/** Sample statistics from the reservoir. */
export interface SampleStats {
  seen: number;
  capacity: number;
  overflowed: boolean;
  outliersRemoved: number;
}

/** CPU accounting. */
export interface CpuStats {
  totalUs: number;
  usPerOp: number;
}

/** Harness-side CPU overhead. */
export interface HarnessCpu {
  validationTotalUs: number;
  validationUsPerIter: number;
}

/** Memory delta snapshot. */
export interface MemoryStats {
  rssDelta: number;
  heapUsedDelta: number;
  heapTotalDelta: number;
  externalDelta: number;
  arrayBuffersDelta: number;
}

/** Result returned by {@link runChaosScene}. */
export interface ChaosRunResult {
  name: string;
  opsPerSecond: number;
  framesPerSecond: number;
  correctRate: number;
  framesSent: number;
  framesReceived: number;
  framesCorrect: number;
  framesExtra: number;
  errors: number;
  expectedCorrect: number;
  expectedStrictCorrect: number;
  accuracyPass: boolean;
  totalTimeMs: number;
  iterations: number;
  latency: LatencyStats | undefined;
  latencyFiltered: LatencyStats | undefined;
  sampleStats: SampleStats;
  memory: MemoryStats;
  cpu: CpuStats;
  harnessCpu: HarnessCpu;
  recoveryP99: number | undefined;
  maxCpuTimeUs: number | undefined;
  /** Net heap growth after subtracting the noise floor, in KiB. */
  netHeapGrowthKB: number;
  /** Noise floor subtracted from the raw heap delta, in KiB. */
  heapNoiseFloorKB: number;
  circuitBreakerTripped: boolean;
  requestCount: number;
  requestsCompleted: number;
  jitterContaminated: boolean;
  jitterContaminatedCount: number;
}
