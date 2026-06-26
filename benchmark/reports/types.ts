/**
 * Report-layer shared types.
 *
 * `ReportContext` is the aggregated result container passed to Markdown
 * generators. It intentionally mirrors the legacy `BenchmarkContext` where
 * possible, but omits fields that are not yet produced by the new architecture
 * (transport-suite / all-fcs can be added later without breaking consumers).
 */

import type { ChaosRunResult } from '../chaos/types';
import type { CodecBenchmarkResult, CodecSuite } from '../codec/types';
import type { MacroBenchmarkResult } from '../macro';

export interface SystemInfo {
  cpu: string;
  cores: number;
  memory: string;
  nodeVersion: string;
  v8Version: string;
  platform: string;
}

export interface ReportVersions {
  own: string;
  jsmodbus: string | null;
  modbusSerial: string | null;
}

export interface EncodeDecodeReport {
  suites: {
    suite: CodecSuite;
    metrics: Record<string, CodecBenchmarkResult & { opsValues?: number[] }>;
  }[];
}

export interface ChaosSceneReport {
  scene: string;
  protocol: string;
  description: string;
  shortLabel: string;
  metrics: Record<string, ChaosRunResult>;
}

export interface ChaosReport {
  scenes: ChaosSceneReport[];
}

export interface TransportSuiteOutput {
  sequential: {
    depth: 1;
    tcp: Record<string, MacroBenchmarkResult>;
    rtu: Record<string, MacroBenchmarkResult>;
    ascii: Record<string, MacroBenchmarkResult>;
  };
  multiconn: {
    connections: number;
    tcp: Record<string, MacroBenchmarkResult>;
  };
}

export interface FcSummaryEntry {
  fc: string;
  library: string;
  opsPerSecond: number;
  p50: number;
  p99: number;
  cpuUsPerOp: number;
  gcNsPerOp: number;
}

export interface AllFcsOutput {
  fcs: {
    fc: string;
    label: string;
    metrics: Record<string, MacroBenchmarkResult & { opsValues?: number[] }>;
  }[];
  summary: FcSummaryEntry[];
}

export interface ReportOptions {
  /** Use short durations and a single run. */
  fast?: boolean;
  /** Number of repeated runs per test point. */
  runs?: number;
  /** Libraries to include; defaults to all registered adapters. */
  libraries?: string[];
  /** Maximum concurrent benchmark tasks. */
  concurrency?: number;
  /** Run the all-fcs max-payload variant in addition to the normal payload. */
  maxPayload?: boolean;
  /** Override per-test wall-clock duration in milliseconds (transport + all-fcs). */
  durationMs?: number;
  /** Override per-(scene, library) chaos iteration count. */
  chaosRequests?: number;
  /** Codec suites to run; defaults to all registered suites. */
  suites?: CodecSuite[];
}

export interface ReportContext {
  date: string;
  durationSec: number;
  numRuns: number;
  sys: SystemInfo;
  versions: ReportVersions;
  encodeDecode: EncodeDecodeReport | null;
  transportSuite: TransportSuiteOutput | null;
  allFcsNormal: AllFcsOutput | null;
  allFcsMax: AllFcsOutput | null;
  chaos: ChaosReport | null;
}
