/**
 * Jitter-resistant frame collector.
 *
 * Replaces the legacy `io-collect.ts` + `io-drain.ts` pair with a single module
 * that measures silence via byte-deltas rather than wall-clock since-last-data.
 * Byte-delta detection survives event-loop stalls: a GC pause simply delays the
 * next sample, but the comparison is still "did any bytes arrive in the last
 * complete Poll cycle?".
 *
 * Additional jitter awareness:
 *   - `stallThresholdMs`: if a scheduled sample is delayed by more than this,
 *     the run is flagged as `jitterContaminated`. Reports can then exclude or
 *     annotate polluted latency percentiles.
 *   - `jitterContaminatedCount`: number of times the sample loop observed a
 *     delay larger than `stallThresholdMs`.
 *
 * Usage:
 *   const collector = new JitterResistantCollector(socket, { parseFrameCount, silenceTimeoutMs });
 *   collector.start(); // attaches listener
 *   // ...write frames...
 *   collector.startTimeout(100);
 *   const result = await collector.promise;
 */

import type { TransportHandle } from '../transport/types';

import { performance } from 'node:perf_hooks';

export interface CollectorOptions {
  /**
   * Parses the accumulated buffer and returns the number of complete frames.
   * Keep it cheap — called on every data chunk.
   */
  parseFrameCount: (collected: Buffer) => number;
  /**
   * Observed-quiet window before declaring the peer stopped sending. Same
   * byte-delta semantics as the legacy drain: N consecutive zero-delta samples.
   */
  silenceTimeoutMs: number;
  /** Optional early-exit count. Resolves immediately when reached. */
  expectedFrames?: number;
  /** Inter-sample gap. Default 5 ms. */
  pollIntervalMs?: number;
  /**
   * If a scheduled sample is delayed by more than this, the run is marked
   * jitter-contaminated. Default 50 ms.
   */
  stallThresholdMs?: number;
}

export interface CollectorResult {
  /** All bytes received during the collection window. */
  data: Buffer;
  /** `process.hrtime.bigint()` timestamp (nanoseconds) for each newly-observed frame. */
  frameArrivals: bigint[];
  /** True if the hard timeout fired before all expected frames arrived. */
  timedOut: boolean;
  /** True if event-loop jitter exceeded the stall threshold at least once. */
  jitterContaminated: boolean;
  /** Number of samples whose actual delay exceeded `stallThresholdMs`. */
  jitterContaminatedCount: number;
}

/** Drain-only options for the standalone `drain` helper. */
export interface DrainOptions {
  /** Max wall-clock time the drain may spend. Default 50 ms. */
  timeoutMs?: number;
  /** Inter-sample gap. Default 5 ms. */
  pollIntervalMs?: number;
  /** Consecutive zero-delta samples required. Default 2. */
  quietSamples?: number;
  /** Stall threshold for jitter contamination. Default 50 ms. */
  stallThresholdMs?: number;
}

export interface DrainResult {
  /** True if event-loop jitter exceeded the stall threshold. */
  jitterContaminated: boolean;
  jitterContaminatedCount: number;
}

/** Wait until no bytes arrive for `quietSamples` consecutive windows. */
export async function drain(handle: TransportHandle, options: DrainOptions = {}): Promise<DrainResult> {
  const { timeoutMs = 50, pollIntervalMs = 5, quietSamples = 2, stallThresholdMs = 50 } = options;

  let totalBytes = 0;
  let consecutiveQuiet = 0;
  let lastBytes = -1;
  let jitterContaminatedCount = 0;
  const deadline = performance.now() + timeoutMs;

  const removeListener = handle.onData((chunk) => {
    totalBytes += chunk.length;
  });

  try {
    while (performance.now() < deadline) {
      const scheduledAt = performance.now();
      await sleepOneLoop(pollIntervalMs);
      const actualDelay = performance.now() - scheduledAt;

      if (actualDelay > stallThresholdMs) {
        jitterContaminatedCount++;
      }

      if (totalBytes === lastBytes) {
        consecutiveQuiet++;
        if (consecutiveQuiet >= quietSamples) {
          return {
            jitterContaminated: jitterContaminatedCount > 0,
            jitterContaminatedCount,
          };
        }
      } else {
        consecutiveQuiet = 0;
        lastBytes = totalBytes;
      }
    }

    return {
      jitterContaminated: jitterContaminatedCount > 0,
      jitterContaminatedCount,
    };
  } finally {
    removeListener();
  }
}

async function sleepOneLoop(pollIntervalMs: number): Promise<void> {
  // setTimeout schedules in Timers; setImmediate guarantees the Poll phase
  // drains any kernel-buffered bytes before the next byte-count comparison.
  await new Promise<void>((r) => setTimeout(r, pollIntervalMs));
  await new Promise<void>((r) => setImmediate(r));
}

export class JitterResistantCollector {
  private readonly handle: TransportHandle;
  private readonly parseFrameCount: (collected: Buffer) => number;
  private readonly silenceTimeoutMs: number;
  private readonly expectedFrames: number;
  private readonly pollIntervalMs: number;
  private readonly stallThresholdMs: number;

  private static readonly INITIAL_CAPACITY = 16 * 1024;

  private resolved = false;
  private hardTimer: NodeJS.Timeout | null = null;
  private removeDataListener: (() => void) | null = null;
  private resolvePromise!: (result: CollectorResult) => void;
  private promiseInternal: Promise<CollectorResult> | null = null;

  private collected = Buffer.allocUnsafe(JitterResistantCollector.INITIAL_CAPACITY);
  private collectedLen = 0;
  private totalBytes = 0;
  private frameArrivals: bigint[] = [];
  private knownFrameCount = 0;
  private jitterContaminatedCount = 0;

  constructor(handle: TransportHandle, options: CollectorOptions) {
    this.handle = handle;
    this.parseFrameCount = options.parseFrameCount;
    this.silenceTimeoutMs = options.silenceTimeoutMs;
    this.expectedFrames = options.expectedFrames ?? 0;
    this.pollIntervalMs = options.pollIntervalMs ?? 5;
    this.stallThresholdMs = options.stallThresholdMs ?? 50;
  }

  /** Attach the data listener. Safe to call before writes start. */
  start(): void {
    if (this.promiseInternal !== null) {
      throw new Error('JitterResistantCollector already started');
    }
    this.promiseInternal = new Promise((r) => {
      this.resolvePromise = r;
    });
    this.removeDataListener = this.handle.onData((chunk) => this.onData(chunk));
    void this.watchSilence();
  }

  /** Reset internal state so the same instance can be reused for a new collection. */
  reset(): void {
    if (this.hardTimer !== null) {
      clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }
    if (this.removeDataListener !== null) {
      this.removeDataListener();
      this.removeDataListener = null;
    }
    this.resolved = false;
    this.promiseInternal = null;
    this.collectedLen = 0;
    this.totalBytes = 0;
    this.frameArrivals.length = 0;
    this.knownFrameCount = 0;
    this.jitterContaminatedCount = 0;
  }

  /** Promise that resolves when collection finishes. */
  get promise(): Promise<CollectorResult> {
    if (this.promiseInternal === null) {
      throw new Error('JitterResistantCollector not started; call start() first');
    }
    return this.promiseInternal;
  }

  /** Arm the hard timeout. Typically called after all writes complete. */
  startTimeout(ms: number): void {
    if (this.resolved) {
      return;
    }
    if (this.hardTimer !== null) {
      clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }
    this.hardTimer = setTimeout(() => {
      if (this.resolved) {
        return;
      }
      const noFrames = this.knownFrameCount < (this.expectedFrames > 0 ? this.expectedFrames : 1);
      this.finish(noFrames);
    }, ms);
  }

  private onData(chunk: Buffer): void {
    if (this.resolved) {
      return;
    }
    const need = this.collectedLen + chunk.length;
    if (need > this.collected.length) {
      let nextCap = this.collected.length * 2;
      while (nextCap < need) {
        nextCap *= 2;
      }
      const next = Buffer.allocUnsafe(nextCap);
      this.collected.copy(next, 0, 0, this.collectedLen);
      this.collected = next;
    }
    chunk.copy(this.collected, this.collectedLen);
    this.collectedLen += chunk.length;
    this.totalBytes += chunk.length;

    const newFrameCount = this.parseFrameCount(this.collected.subarray(0, this.collectedLen));
    while (this.knownFrameCount < newFrameCount) {
      this.frameArrivals.push(process.hrtime.bigint());
      this.knownFrameCount++;
    }

    if (this.expectedFrames > 0 && this.knownFrameCount >= this.expectedFrames) {
      this.finish(false);
    }
  }

  private async watchSilence(): Promise<void> {
    let lastBytes = -1;
    let consecutiveQuiet = 0;
    const quietSamples = Math.max(1, Math.ceil(this.silenceTimeoutMs / this.pollIntervalMs));

    while (!this.resolved) {
      const scheduledAt = performance.now();
      await sleepOneLoop(this.pollIntervalMs);
      if (this.resolved) {
        return;
      }
      const actualDelay = performance.now() - scheduledAt;
      if (actualDelay > this.stallThresholdMs) {
        this.jitterContaminatedCount++;
      }

      // Don't trip silence before any data has arrived — that is the hard
      // timeout's responsibility.
      if (this.totalBytes === 0) {
        lastBytes = 0;
        continue;
      }

      if (this.totalBytes === lastBytes) {
        consecutiveQuiet++;
        if (consecutiveQuiet >= quietSamples) {
          this.finish(false);
          return;
        }
      } else {
        consecutiveQuiet = 0;
        lastBytes = this.totalBytes;
      }
    }
  }

  private finish(timedOut: boolean): void {
    if (this.resolved) {
      return;
    }
    this.resolved = true;
    if (this.hardTimer !== null) {
      clearTimeout(this.hardTimer);
      this.hardTimer = null;
    }
    if (this.removeDataListener !== null) {
      this.removeDataListener();
      this.removeDataListener = null;
    }
    this.resolvePromise({
      data: this.collected.subarray(0, this.collectedLen),
      frameArrivals: this.frameArrivals,
      timedOut,
      jitterContaminated: this.jitterContaminatedCount > 0,
      jitterContaminatedCount: this.jitterContaminatedCount,
    });
  }
}
