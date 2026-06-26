/**
 * Codec micro-benchmark runner.
 *
 * Runs a single (protocol, direction, operation) suite for one library adapter.
 * The harness is kept intentionally simple and JIT-friendly:
 *   - fixed-shape consume callbacks prevent dynamic closures in the hot loop;
 *   - payload buffers are preallocated outside the loop;
 *   - sampling uses the shared reservoir from the chaos module.
 */

import type { CodecBenchmarkResult, CodecRunOptions, CodecSuite } from './types';
import type { CodecFrame, LibraryAdapter } from '../adapters/types';

import { performance, PerformanceObserver } from 'node:perf_hooks';

import { Reservoir } from '../chaos/reservoir';
import { computeLatencyPair } from '../chaos/stats';

const DEFAULT_MIN_DURATION_MS = 5000;
const DEFAULT_WARMUP_DURATION_MS = 3000;
const DEFAULT_WARMUP_ITERATIONS = 50000;
const DEFAULT_MAX_SAMPLES = 100000;

/** DCE sink — exported so TurboFan cannot eliminate the consume calls. */
export let _sink = 0;

function consumeBuffer(buf: Buffer): void {
  _sink = buf.length;
}

function consumeFrame(frame: CodecFrame | null): void {
  _sink = frame ? 1 : 0;
}

function fillDefaults(options?: CodecRunOptions): Required<CodecRunOptions> {
  return {
    minDurationMs: options?.minDurationMs ?? DEFAULT_MIN_DURATION_MS,
    warmupDurationMs: options?.warmupDurationMs ?? DEFAULT_WARMUP_DURATION_MS,
    warmupIterations: options?.warmupIterations ?? DEFAULT_WARMUP_ITERATIONS,
    maxSamples: options?.maxSamples ?? DEFAULT_MAX_SAMPLES,
  };
}

function createGCTracker(): { stop: () => { count: number; totalDurationMs: number; maxDurationMs: number } } {
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
  obs.observe({ entryTypes: ['gc'] as const });
  return {
    stop: () => {
      obs.disconnect();
      return { count, totalDurationMs, maxDurationMs };
    },
  };
}

interface MicroMeasureOptions<T> {
  name: string;
  fn: () => T;
  consumeResult: (result: T) => void;
  options: Required<CodecRunOptions>;
}

function microMeasure<T>(options: MicroMeasureOptions<T>): CodecBenchmarkResult {
  const { name, fn, consumeResult, options: opts } = options;

  const minDurationNs = BigInt(opts.minDurationMs) * 1_000_000n;
  const warmupDurationNs = BigInt(opts.warmupDurationMs) * 1_000_000n;

  // Warmup: must satisfy both iteration count and duration.
  const warmupStart = process.hrtime.bigint();
  let wIter = 0;
  while (wIter < opts.warmupIterations || process.hrtime.bigint() - warmupStart < warmupDurationNs) {
    const result = fn();
    consumeResult(result);
    wIter++;
  }

  // Force GC before measurement so GC pauses fall outside the window.
  const gc = (globalThis as unknown as { gc?: () => void }).gc;
  if (gc) {
    gc();
  }

  const gcTracker = createGCTracker();
  const memBefore = process.memoryUsage();
  const cpuBefore = process.cpuUsage();

  const samples = new Reservoir(opts.maxSamples);
  let iterations = 0;
  const measureStart = process.hrtime.bigint();

  while (process.hrtime.bigint() - measureStart < minDurationNs) {
    const t0 = process.hrtime.bigint();
    const result = fn();
    consumeResult(result);
    const t1 = process.hrtime.bigint();
    samples.push(Number(t1 - t0) / 1e6);
    iterations++;
  }

  const measureEnd = process.hrtime.bigint();
  const totalTimeMs = Number(measureEnd - measureStart) / 1e6;

  const memAfter = process.memoryUsage();
  const cpuAfter = process.cpuUsage(cpuBefore);

  // Yield so the GC observer can flush pending entries.
  performance.mark('codec-measure-done');
  const gcStats = gcTracker.stop();

  const { raw: latency, filtered: latencyFiltered, outliersRemoved } = computeLatencyPair(samples.toArray());

  const opsPerSecond = Math.round((iterations / totalTimeMs) * 1000);

  return {
    name,
    opsPerSecond,
    totalTimeMs: Math.round(totalTimeMs * 100) / 100,
    iterations,
    latency,
    latencyFiltered,
    sampleStats: {
      seen: samples.seen,
      capacity: samples.capacity,
      overflowed: samples.overflowed,
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
      totalUs: cpuAfter.user + cpuAfter.system,
      usPerOp: iterations > 0 ? (cpuAfter.user + cpuAfter.system) / iterations : 0,
    },
  };
}

function buildPayloads(): { requestData: Buffer; responseData: Buffer } {
  const unit = 1;
  const fc = 0x03;
  const address = 0;
  const quantity = 125;

  const requestData = Buffer.allocUnsafe(4);
  requestData.writeUInt16BE(address, 0);
  requestData.writeUInt16BE(quantity, 2);

  const responseValues = Buffer.allocUnsafe(quantity * 2);
  for (let i = 0; i < quantity; i++) {
    responseValues.writeUInt16BE(i, i * 2);
  }

  const responseData = Buffer.allocUnsafe(1 + quantity * 2);
  responseData[0] = quantity * 2;
  responseValues.copy(responseData, 1);

  // Consume parameters so the compiler does not eliminate them.
  _sink = unit + fc;
  return { requestData, responseData };
}

export function runCodecSuite(suite: CodecSuite, adapter: LibraryAdapter, options?: CodecRunOptions): CodecBenchmarkResult {
  const codec = adapter.codec;
  if (!codec) {
    throw new Error(`Adapter "${adapter.name}" does not expose codec capabilities`);
  }

  const opts = fillDefaults(options);
  const { requestData, responseData } = buildPayloads();
  const unit = 1;
  const fc = 0x03;

  switch (suite) {
    case 'tcpReqEncode':
      return microMeasure({
        name: adapter.name,
        fn: () => codec.encodeTcpRequest(unit, fc, requestData),
        consumeResult: consumeBuffer,
        options: opts,
      });
    case 'tcpResEncode':
      return microMeasure({
        name: adapter.name,
        fn: () => codec.encodeTcpResponse(unit, fc, responseData),
        consumeResult: consumeBuffer,
        options: opts,
      });
    case 'tcpReqDecode': {
      const buffer = codec.encodeTcpRequest(unit, fc, requestData);
      return microMeasure({
        name: adapter.name,
        fn: () => codec.decodeTcpRequest(buffer),
        consumeResult: consumeFrame,
        options: opts,
      });
    }
    case 'tcpResDecode': {
      const buffer = codec.encodeTcpResponse(unit, fc, responseData);
      return microMeasure({
        name: adapter.name,
        fn: () => codec.decodeTcpResponse(buffer),
        consumeResult: consumeFrame,
        options: opts,
      });
    }
    case 'rtuReqEncode':
      return microMeasure({
        name: adapter.name,
        fn: () => codec.encodeRtuRequest(unit, fc, requestData),
        consumeResult: consumeBuffer,
        options: opts,
      });
    case 'rtuResEncode':
      return microMeasure({
        name: adapter.name,
        fn: () => codec.encodeRtuResponse(unit, fc, responseData),
        consumeResult: consumeBuffer,
        options: opts,
      });
    case 'rtuReqDecode': {
      const buffer = codec.encodeRtuRequest(unit, fc, requestData);
      return microMeasure({
        name: adapter.name,
        fn: () => codec.decodeRtuRequest(buffer),
        consumeResult: consumeFrame,
        options: opts,
      });
    }
    case 'rtuResDecode': {
      const buffer = codec.encodeRtuResponse(unit, fc, responseData);
      return microMeasure({
        name: adapter.name,
        fn: () => codec.decodeRtuResponse(buffer),
        consumeResult: consumeFrame,
        options: opts,
      });
    }
    case 'asciiReqEncode':
      return microMeasure({
        name: adapter.name,
        fn: () => codec.encodeAsciiRequest(unit, fc, requestData),
        consumeResult: consumeBuffer,
        options: opts,
      });
    case 'asciiResEncode':
      return microMeasure({
        name: adapter.name,
        fn: () => codec.encodeAsciiResponse(unit, fc, responseData),
        consumeResult: consumeBuffer,
        options: opts,
      });
    case 'asciiReqDecode': {
      const buffer = codec.encodeAsciiRequest(unit, fc, requestData);
      return microMeasure({
        name: adapter.name,
        fn: () => codec.decodeAsciiRequest(buffer),
        consumeResult: consumeFrame,
        options: opts,
      });
    }
    case 'asciiResDecode': {
      const buffer = codec.encodeAsciiResponse(unit, fc, responseData);
      return microMeasure({
        name: adapter.name,
        fn: () => codec.decodeAsciiResponse(buffer),
        consumeResult: consumeFrame,
        options: opts,
      });
    }
    default: {
      const _exhaustive: never = suite;
      throw new Error(`Unknown codec suite: ${_exhaustive}`);
    }
  }
}
