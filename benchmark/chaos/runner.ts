/**
 * Unified chaos scene runner.
 *
 * Encapsulates warmup, measurement, recovery, and circuit-breaker logic for a
 * single (library, protocol, scene) combination. Accepts a `TransportHandle`
 * so the same runner works for TCP and serial transports.
 */

import type { ChaosRunOptions, ChaosRunResult } from './types';
import type { TransportHandle } from '../transport/types';

import { calibrateNoiseFloor, measureNetGrowth } from './heap-snapshot';
import { Reservoir } from './reservoir';
import { computeLatencyPair, percentile } from './stats';
import { drain, JitterResistantCollector } from '../jitter/collector';
import { writeAsync, writeChunks } from '../transport/tcp';

const DEFAULT_WARMUP_ITERATIONS = 10;
const DEFAULT_REQUEST_TIMEOUT_MS = 100;
const DEFAULT_CIRCUIT_BREAKER_THRESHOLD = 5;
const DEFAULT_SILENCE_TIMEOUT_MS = 50;
const DEFAULT_RECOVERY_FRAMES = 100;
const DEFAULT_RECOVERY_TIMEOUT_MS = 100;
const DEFAULT_MAX_SAMPLES = 100000;
const DEFAULT_NOISE_FLOOR_CALIBRATION_ITERATIONS = 5;

export let _sink = 0;

interface IterationOptions {
  transport: TransportHandle;
  parseFrameCount: (collected: Buffer) => number;
  chunks: Buffer[];
  expectedFrameCount: number;
  silenceTimeoutMs: number;
  requestTimeoutMs: number;
}

async function runOneIteration(options: IterationOptions): Promise<{
  received: Buffer;
  frameArrivals: bigint[];
  timedOut: boolean;
  jitterContaminated: boolean;
  jitterContaminatedCount: number;
}> {
  const { transport, parseFrameCount, chunks, expectedFrameCount, silenceTimeoutMs, requestTimeoutMs } = options;

  await drain(transport, { timeoutMs: silenceTimeoutMs });

  const collector = new JitterResistantCollector(transport, {
    parseFrameCount,
    silenceTimeoutMs,
    expectedFrames: expectedFrameCount,
  });
  collector.start();

  await writeChunks(transport, chunks);
  collector.startTimeout(requestTimeoutMs);

  const { data: received, frameArrivals, timedOut, jitterContaminated, jitterContaminatedCount } = await collector.promise;

  return { received, frameArrivals, timedOut, jitterContaminated, jitterContaminatedCount };
}

interface Measurement {
  iterations: number;
  requestsCompleted: number;
  totalSent: number;
  totalReceived: number;
  totalCorrect: number;
  totalExtra: number;
  totalErrors: number;
  latencies: Reservoir;
  recoveryLatencies: number[];
  perIterCpuIO: number[];
  perIterCpuVal: number[];
  totalMs: number;
  totalCpuUs: number;
  circuitBreakerTripped: boolean;
  jitterContaminated: boolean;
  jitterContaminatedCount: number;
}

export async function runChaosScene(options: ChaosRunOptions): Promise<ChaosRunResult> {
  const {
    transport,
    validate,
    parseFrameCount,
    buildCleanFrame,
    buildCleanFrameInto,
    requestCount,
    warmupIterations = DEFAULT_WARMUP_ITERATIONS,
    requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
    circuitBreakerThreshold = DEFAULT_CIRCUIT_BREAKER_THRESHOLD,
    silenceTimeoutMs = DEFAULT_SILENCE_TIMEOUT_MS,
    recoveryFrames = DEFAULT_RECOVERY_FRAMES,
    recoveryTimeoutMs = DEFAULT_RECOVERY_TIMEOUT_MS,
    maxSamples = DEFAULT_MAX_SAMPLES,
    noiseFloorCalibrationIterations = DEFAULT_NOISE_FLOOR_CALIBRATION_ITERATIONS,
    noiseFloorMetric = 'usedHeapSize',
  } = options;

  const iterationOptions: IterationOptions = {
    transport,
    parseFrameCount,
    chunks: options.chunks,
    expectedFrameCount: options.expectedFrameCount,
    silenceTimeoutMs,
    requestTimeoutMs,
  };

  // Pre-warm any parser state by discarding a few iterations.
  for (let i = 0; i < warmupIterations; i++) {
    const { received } = await runOneIteration(iterationOptions);
    const v = validate(received);
    _sink = v.framesCorrect;
  }

  // Calibrate the ambient memory noise floor using the same code path as the
  // measurement loop (I/O + validation), but without recording statistics.
  const { noiseFloorKB } = await calibrateNoiseFloor(
    async () => {
      const { received } = await runOneIteration(iterationOptions);
      const v = validate(received);
      _sink = v.framesCorrect;
    },
    { iterations: noiseFloorCalibrationIterations, metric: noiseFloorMetric },
  );

  const cpuBefore = process.cpuUsage();
  const startNs = process.hrtime.bigint();

  const measurement = await measureNetGrowth(
    async (): Promise<Measurement> => {
      const latencies = new Reservoir(maxSamples);
      const perIterCpuIO: number[] = [];
      const perIterCpuVal: number[] = [];
      const recoveryLatencies: number[] = [];

      let totalSent = 0;
      let totalReceived = 0;
      let totalCorrect = 0;
      let totalExtra = 0;
      let totalErrors = 0;
      let iterations = 0;
      let requestsCompleted = 0;
      let consecutiveTimeouts = 0;
      let circuitBreakerTripped = false;
      let jitterContaminated = false;
      let jitterContaminatedCount = 0;

      try {
        for (let i = 0; i < requestCount; i++) {
          const cpuIterStart = process.cpuUsage();
          const t0Ns = process.hrtime.bigint();

          const {
            received,
            frameArrivals,
            timedOut,
            jitterContaminated: jc,
            jitterContaminatedCount: jcc,
          } = await runOneIteration(iterationOptions);

          if (jc) {
            jitterContaminated = true;
          }
          jitterContaminatedCount += jcc;

          const cpuIoMark = process.cpuUsage(cpuIterStart);
          perIterCpuIO.push(cpuIoMark.user + cpuIoMark.system);

          if (timedOut || frameArrivals.length === 0) {
            consecutiveTimeouts++;
            if (consecutiveTimeouts >= circuitBreakerThreshold) {
              circuitBreakerTripped = true;
              const remaining = requestCount - i - 1;
              totalSent += options.expectedFrameCount * remaining;
              totalErrors += options.expectedFrameCount * remaining;
              requestsCompleted = i + 1;
              break;
            }
          } else {
            consecutiveTimeouts = 0;
          }

          const cpuValStart = process.cpuUsage();
          const v = validate(received);
          const cpuValEnd = process.cpuUsage(cpuValStart);
          perIterCpuVal.push(cpuValEnd.user + cpuValEnd.system);

          totalSent += v.framesSent;
          totalReceived += v.framesReceived;
          totalCorrect += v.framesCorrect;
          totalExtra += v.framesExtra;
          totalErrors += v.errors;

          for (const arrivalNs of frameArrivals) {
            latencies.push(Number(arrivalNs - t0Ns) / 1000);
          }

          iterations++;
          requestsCompleted = i + 1;
          _sink = v.framesCorrect;
        }

        await drain(transport, { timeoutMs: silenceTimeoutMs * 2 });

        if (!circuitBreakerTripped) {
          const recoveryBuf = buildCleanFrame(0);
          let recoveryCollector: JitterResistantCollector | null = null;

          for (let r = 0; r < recoveryFrames; r++) {
            buildCleanFrameInto(r, recoveryBuf);

            await drain(transport, { timeoutMs: 10 });

            if (!recoveryCollector) {
              recoveryCollector = new JitterResistantCollector(transport, {
                parseFrameCount,
                silenceTimeoutMs,
                expectedFrames: 1,
              });
            } else {
              recoveryCollector.reset();
            }
            recoveryCollector.start();

            const t0Ns = process.hrtime.bigint();
            await writeAsync(transport, recoveryBuf);
            recoveryCollector.startTimeout(recoveryTimeoutMs);

            const { frameArrivals } = await recoveryCollector.promise;
            if (frameArrivals.length > 0) {
              recoveryLatencies.push(Number(frameArrivals[0] - t0Ns) / 1000);
            }

            _sink = r;
          }
        }
      } finally {
        // cleanup is owned by the caller (transport + server handles)
      }

      return {
        iterations,
        requestsCompleted,
        totalSent,
        totalReceived,
        totalCorrect,
        totalExtra,
        totalErrors,
        latencies,
        recoveryLatencies,
        perIterCpuIO,
        perIterCpuVal,
        totalMs: Number(process.hrtime.bigint() - startNs) / 1e6,
        totalCpuUs: process.cpuUsage(cpuBefore).user + process.cpuUsage(cpuBefore).system,
        circuitBreakerTripped,
        jitterContaminated,
        jitterContaminatedCount,
      };
    },
    { noiseFloorKB, metric: noiseFloorMetric },
  );

  const { result: m, netGrowthKB, before, after } = measurement;

  const { raw: latency, filtered: latencyFiltered, outliersRemoved } = computeLatencyPair(m.latencies.toArray());

  const recoveryP99 = m.recoveryLatencies.length > 0 ? percentile(m.recoveryLatencies, 0.99) : undefined;

  const maxCpuTimeUs = m.perIterCpuIO.length > 0 ? m.perIterCpuIO.reduce((max, v) => (v > max ? v : max), 0) : undefined;
  const totalHarnessValCpuUs = m.perIterCpuVal.reduce((s, v) => s + v, 0);
  const validationUsPerIter = m.perIterCpuVal.length > 0 ? totalHarnessValCpuUs / m.perIterCpuVal.length : 0;

  const opsPerSecond = Math.round((m.iterations / m.totalMs) * 1000);
  const framesPerSecond = m.totalMs > 0 ? Math.round((m.totalCorrect / m.totalMs) * 1000) : 0;
  const correctRate = m.totalSent > 0 ? m.totalCorrect / m.totalSent : 0;

  return {
    name: options.name,
    opsPerSecond,
    framesPerSecond,
    correctRate,
    framesSent: m.totalSent,
    framesReceived: m.totalReceived,
    framesCorrect: m.totalCorrect,
    framesExtra: m.totalExtra,
    errors: m.totalErrors,
    expectedCorrect: options.expectedCorrect * m.iterations,
    expectedStrictCorrect: options.expectedStrictCorrect * m.iterations,
    accuracyPass: computeAccuracy(
      m.totalCorrect,
      options.expectedCorrect * m.iterations,
      options.expectedStrictCorrect * m.iterations,
      m.totalExtra,
    ),
    totalTimeMs: Math.round(m.totalMs * 100) / 100,
    iterations: m.iterations,
    latency,
    latencyFiltered,
    sampleStats: {
      seen: m.latencies.seen,
      capacity: m.latencies.capacity,
      overflowed: m.latencies.overflowed,
      outliersRemoved,
    },
    memory: {
      rssDelta: after.rss - before.rss,
      heapUsedDelta: after.heapUsed - before.heapUsed,
      heapTotalDelta: after.heapTotal - before.heapTotal,
      externalDelta: after.external - before.external,
      arrayBuffersDelta: after.arrayBuffers - before.arrayBuffers,
    },
    cpu: {
      totalUs: Math.max(0, m.totalCpuUs - totalHarnessValCpuUs),
      usPerOp: m.iterations > 0 ? Math.max(0, (m.totalCpuUs - totalHarnessValCpuUs) / m.iterations) : 0,
    },
    harnessCpu: {
      validationTotalUs: totalHarnessValCpuUs,
      validationUsPerIter: validationUsPerIter,
    },
    recoveryP99,
    maxCpuTimeUs,
    netHeapGrowthKB: netGrowthKB,
    heapNoiseFloorKB: noiseFloorKB,
    circuitBreakerTripped: m.circuitBreakerTripped,
    requestCount,
    requestsCompleted: m.requestsCompleted,
    jitterContaminated: m.jitterContaminated,
    jitterContaminatedCount: m.jitterContaminatedCount,
  };
}

function computeAccuracy(framesCorrect: number, expectedCorrect: number, expectedStrictCorrect: number, framesExtra: number): boolean {
  if (framesCorrect === expectedCorrect) {
    return true;
  }
  if (framesExtra === 0 && framesCorrect === expectedStrictCorrect) {
    return true;
  }
  return false;
}
