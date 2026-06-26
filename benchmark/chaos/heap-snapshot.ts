/**
 * Heap snapshot helper.
 *
 * Captures V8 heap sizes after forced GC so memory deltas are measured from a
 * consistent quiescent state. P5 extends this with noise-floor calibration:
 * run the target operation M times, take GC-stabilised before/after snapshots,
 * and use the median per-iteration delta as the baseline. Net growth is then
 * `measuredDelta - noiseFloor`, clamped to non-negative values.
 */

export interface HeapSnapshot {
  rss: number;
  heapUsed: number;
  heapTotal: number;
  external: number;
  arrayBuffers: number;
  usedHeapSize: number;
}

/** Numeric heap metrics that can be used for noise-floor calibration. */
export type NoiseFloorMetric = keyof HeapSnapshot;

async function readHeapSizes(): Promise<HeapSnapshot> {
  const mem = process.memoryUsage();
  const v8 = await import('node:v8');
  const stats = v8.getHeapStatistics();
  return {
    rss: mem.rss,
    heapUsed: mem.heapUsed,
    heapTotal: mem.heapTotal,
    external: mem.external,
    arrayBuffers: mem.arrayBuffers ?? 0,
    usedHeapSize: stats.used_heap_size,
  };
}

/** Force GC and read heap sizes. */
export async function snapshotHeapAfterGC(): Promise<HeapSnapshot> {
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (gc) {
    for (let i = 0; i < 3; i++) {
      gc();
      // Allow any finalizers to drain between GC calls.
      await new Promise<void>((r) => setImmediate(r));
    }
  }
  return readHeapSizes();
}

function median(values: number[]): number {
  if (values.length === 0) {
    return 0;
  }
  const sorted = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[mid] ?? 0) : ((sorted[mid - 1] ?? 0) + (sorted[mid] ?? 0)) / 2;
}

export interface CalibrateNoiseFloorOptions {
  /** Number of calibration iterations. Default 5. */
  iterations?: number;
  /** Heap metric to track. Default `usedHeapSize` (V8 used heap size). */
  metric?: NoiseFloorMetric;
}

export interface NoiseFloorResult {
  /** Median per-iteration delta, in KiB. */
  noiseFloorKB: number;
  /** Metric that was tracked. */
  metric: NoiseFloorMetric;
  /** Per-iteration `after - before` deltas, in KiB. */
  deltasKB: number[];
  /** Snapshots captured during calibration. */
  snapshots: { before: HeapSnapshot; after: HeapSnapshot }[];
}

/**
 * Calibrate the ambient noise floor for a repeatable operation.
 *
 * Runs `operation` M times, capturing a GC-stabilised heap snapshot before and
 * after each repetition. The median per-iteration delta becomes the noise floor
 * that should be subtracted from the final measured growth.
 */
export async function calibrateNoiseFloor<T>(
  operation: () => Promise<T> | T,
  options?: CalibrateNoiseFloorOptions,
): Promise<NoiseFloorResult> {
  const iterations = options?.iterations ?? 5;
  const metric = options?.metric ?? 'usedHeapSize';
  const deltasKB: number[] = [];
  const snapshots: { before: HeapSnapshot; after: HeapSnapshot }[] = [];

  for (let i = 0; i < iterations; i++) {
    const before = await snapshotHeapAfterGC();
    await operation();
    const after = await snapshotHeapAfterGC();

    const deltaBytes = after[metric] - before[metric];
    const deltaKB = deltaBytes / 1024;
    deltasKB.push(deltaKB);
    snapshots.push({ before, after });
  }

  return {
    noiseFloorKB: median(deltasKB),
    metric,
    deltasKB,
    snapshots,
  };
}

export interface MeasureNetGrowthOptions {
  /** Pre-calibrated noise floor in KiB. Default 0. */
  noiseFloorKB?: number;
  /** Heap metric to track. Default `usedHeapSize`. */
  metric?: NoiseFloorMetric;
}

export interface MeasureNetGrowthResult<T> {
  /** Value returned by `operation`. */
  result: T;
  /** `measuredDelta - noiseFloor`, clamped to >= 0, in KiB. */
  netGrowthKB: number;
  /** Raw before/after delta in KiB. */
  measuredDeltaKB: number;
  /** Noise floor subtracted from the raw delta, in KiB. */
  noiseFloorKB: number;
  before: HeapSnapshot;
  after: HeapSnapshot;
}

/**
 * Measure the net heap growth of `operation` after subtracting the noise floor.
 *
 * If no noise floor is supplied, the raw delta is reported as net growth.
 */
export async function measureNetGrowth<T>(
  operation: () => Promise<T> | T,
  options?: MeasureNetGrowthOptions,
): Promise<MeasureNetGrowthResult<T>> {
  const metric = options?.metric ?? 'usedHeapSize';
  const noiseFloorKB = options?.noiseFloorKB ?? 0;

  const before = await snapshotHeapAfterGC();
  const result = await operation();
  const after = await snapshotHeapAfterGC();

  const measuredDeltaKB = (after[metric] - before[metric]) / 1024;
  const netGrowthKB = Math.max(0, measuredDeltaKB - noiseFloorKB);

  return {
    result,
    netGrowthKB,
    measuredDeltaKB,
    noiseFloorKB,
    before,
    after,
  };
}
