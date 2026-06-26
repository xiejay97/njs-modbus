/**
 * Shared macro benchmark harness.
 *
 * Provides `runMacro()` for end-to-end I/O benchmarks. It uses millisecond
 * timing, reservoir sampling, GC/CPU/memory tracking, and the same raw +
 * IQR-filtered latency pair used by the chaos and codec runners.
 */

import { PerformanceObserver } from 'node:perf_hooks';

import { Reservoir } from './chaos/reservoir';
import { computeLatencyPair } from './chaos/stats';

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

export interface MemoryStats {
  rssDelta: number;
  heapUsedDelta: number;
  heapTotalDelta: number;
  externalDelta: number;
  arrayBuffersDelta: number;
}

export interface GCStats {
  count: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export interface CpuStats {
  totalUs: number;
  usPerOp: number;
}

export interface MacroBenchmarkResult {
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
  gc: GCStats;
  cpu: CpuStats;
}

export interface MacroOptions {
  name: string;
  fn: () => Promise<unknown>;
  durationMs: number;
  warmupIterations?: number;
  maxSamples?: number;
  afterEach?: (latencyMs: number) => Promise<void> | void;
  onError?: (err: unknown) => boolean;
}

function createGCTracker(): { stop: () => GCStats } {
  let count = 0;
  let totalDurationMs = 0;
  let maxDurationMs = 0;
  const obs = new PerformanceObserver((list) => {
    for (const entry of list.getEntries()) {
      count++;
      totalDurationMs += entry.duration;
      if (entry.duration > maxDurationMs) {
        maxDurationMs = entry.duration;
      }
    }
  });
  // Node 18 requires 'gc' as any; Node 20 accepts it as a const entry type.
  obs.observe({ entryTypes: ['gc'] as const });
  return {
    stop: () => {
      obs.disconnect();
      return { count, totalDurationMs, maxDurationMs };
    },
  };
}

/**
 * Run a macro benchmark.
 *
 * Warmup is iteration-only. The measurement loop runs for `durationMs`, samples
 * every operation latency into a reservoir, and tracks GC pauses, CPU usage,
 * and memory deltas.
 */
export async function runMacro(options: MacroOptions): Promise<MacroBenchmarkResult> {
  const { name, fn, durationMs, warmupIterations = 200, maxSamples = 100000, afterEach, onError } = options;

  // Warmup with the same error handling and pacing as the measurement loop so
  // serial transports do not fire requests faster than the line can carry them.
  for (let i = 0; i < warmupIterations; i++) {
    const t0Ns = process.hrtime.bigint();
    try {
      await fn();
    } catch (err) {
      if (onError && onError(err)) {
        continue;
      }
      throw err;
    }
    const t1Ns = process.hrtime.bigint();
    if (afterEach) {
      await afterEach(Number(t1Ns - t0Ns) / 1e6);
    }
  }

  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (gc) {
    gc();
  }
  await new Promise<void>((resolve) => setImmediate(resolve));

  // Measurement
  const gcTracker = createGCTracker();
  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();

  const latencies = new Reservoir(maxSamples);
  let iterations = 0;
  const durationNs = BigInt(durationMs) * 1_000_000n;
  const startNs = process.hrtime.bigint();

  while (process.hrtime.bigint() - startNs < durationNs) {
    const t0Ns = process.hrtime.bigint();
    try {
      await fn();
    } catch (err) {
      if (onError && onError(err)) {
        continue;
      }
      throw err;
    }
    const t1Ns = process.hrtime.bigint();
    const latencyMs = Number(t1Ns - t0Ns) / 1e6;
    latencies.push(latencyMs);
    iterations++;
    if (afterEach) {
      await afterEach(latencyMs);
    }
  }

  const totalTimeMs = Number(process.hrtime.bigint() - startNs) / 1e6;
  const memAfter = process.memoryUsage();
  const cpuAfter = process.cpuUsage(cpuBefore);
  const totalCpuUs = cpuAfter.user + cpuAfter.system;

  // Yield so the GC observer can flush pending entries.
  await new Promise<void>((resolve) => setImmediate(resolve));
  const gcStats = gcTracker.stop();

  const { raw: latency, filtered: latencyFiltered, outliersRemoved } = computeLatencyPair(latencies.toArray());

  const opsPerSecond = Math.round((iterations / totalTimeMs) * 1000);

  return {
    name,
    opsPerSecond,
    totalTimeMs: Math.round(totalTimeMs * 100) / 100,
    iterations,
    latency,
    latencyFiltered,
    sampleStats: {
      seen: latencies.seen,
      capacity: latencies.capacity,
      overflowed: latencies.overflowed,
      outliersRemoved,
    },
    memory: {
      rssDelta: memAfter.rss - memBefore.rss,
      heapUsedDelta: memAfter.heapUsed - memBefore.heapUsed,
      heapTotalDelta: memAfter.heapTotal - memBefore.heapTotal,
      externalDelta: memAfter.external - memBefore.external,
      arrayBuffersDelta: memAfter.arrayBuffers - memBefore.arrayBuffers,
    },
    gc: gcStats,
    cpu: {
      totalUs: totalCpuUs,
      usPerOp: iterations > 0 ? totalCpuUs / iterations : 0,
    },
  };
}
