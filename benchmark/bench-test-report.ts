/**
 * Smoke-test report generator — produces `report_presentation.md` from mock
 * benchmark data so the report pipeline can be validated in seconds without
 * running any real benchmark.
 *
 * Usage:
 *   tsx benchmark/bench-test-report.ts
 *   pnpm benchmark:report:test
 *
 * Mocks mirror the participation matrices in coordinator.ts:
 *   - Codec: njs-modbus only (competitor adapters do not expose `codec`).
 *   - Transport suite: TCP for all three libs; RTU jsmodbus + njs-modbus;
 *     ASCII njs-modbus only (matches `runTransportSuite`).
 *   - All-FCs: jsmodbus has no FC08/17/22/23/43; modbus-serial has no FC08/17/22/23.
 *   - Chaos: 12 TCP + 12 RTU + 14 ASCII scenes (`getAllSceneNames()`).
 */

import type { ChaosRunResult, LatencyStats as ChaosLatencyStats } from './chaos/types';
import type { CodecBenchmarkResult, CodecSuite, LatencyStats as CodecLatencyStats } from './codec/types';
import type { MacroBenchmarkResult } from './macro';
import type {
  AllFcsOutput,
  ChaosReport,
  ChaosSceneReport,
  EncodeDecodeReport,
  FcSummaryEntry,
  ReportContext,
  ReportVersions,
  SystemInfo,
  TransportSuiteOutput,
} from './reports/types';

import { writeFileSync } from 'node:fs';
import { arch, cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';

import { getAllSceneNames } from './chaos/scenes';
import { renderPresentationReport, renderDataReport } from './reports';

// ── helpers ────────────────────────────────────────────────────────────────

/** Deterministic 0..1 generator so reports diff cleanly across runs. */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    // xorshift32
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    return ((s >>> 0) % 1_000_000) / 1_000_000;
  };
}

const rand = makeRng(0x4321);

function jitter(base: number, spread: number): number {
  return base + (rand() - 0.5) * spread;
}

function makeLatency(p50Ms: number, p99Ms: number): CodecLatencyStats & ChaosLatencyStats {
  return {
    min: p50Ms * 0.5,
    p50: p50Ms,
    p90: p99Ms * 0.8,
    p95: p99Ms * 0.9,
    p99: p99Ms,
    max: p99Ms * 1.5,
    avg: p50Ms * 1.05,
    rsd: 5,
  };
}

function makeMacro(
  name: string,
  opsPerSecond: number,
  p50Ms: number,
  p99Ms: number,
  cpuUsPerOp: number,
  gcCount = 3,
): MacroBenchmarkResult {
  const iterations = Math.max(1, Math.round(opsPerSecond * 5));
  return {
    name,
    opsPerSecond,
    totalTimeMs: 5000,
    iterations,
    latency: makeLatency(p50Ms, p99Ms),
    latencyFiltered: makeLatency(p50Ms * 0.95, p99Ms * 0.9),
    sampleStats: { seen: iterations, capacity: 100_000, overflowed: false, outliersRemoved: 0 },
    memory: { rssDelta: 0, heapUsedDelta: 0, heapTotalDelta: 0, externalDelta: 0, arrayBuffersDelta: 0 },
    gc: { count: gcCount, totalDurationMs: gcCount * 0.5, maxDurationMs: 0.6 },
    cpu: { totalUs: cpuUsPerOp * iterations, usPerOp: cpuUsPerOp },
  };
}

function makeCodec(name: string, opsPerSecond: number, p50Ms: number, p99Ms: number, cpuUsPerOp: number): CodecBenchmarkResult {
  const iterations = Math.max(1, Math.round(opsPerSecond * 5));
  return {
    name,
    opsPerSecond,
    totalTimeMs: 5000,
    iterations,
    latency: makeLatency(p50Ms, p99Ms),
    latencyFiltered: makeLatency(p50Ms * 0.95, p99Ms * 0.9),
    sampleStats: { seen: iterations, capacity: 100_000, overflowed: false, outliersRemoved: 0 },
    memory: { rssDelta: 0, heapUsedDelta: 0, heapTotalDelta: 0, externalDelta: 0, arrayBuffersDelta: 0 },
    gc: { count: 2, totalDurationMs: 0.6, maxDurationMs: 0.4 },
    cpu: { totalUs: cpuUsPerOp * iterations, usPerOp: cpuUsPerOp },
  };
}

// ── codec mock (njs-modbus only) ────────────────────────────────────────────

function mockEncodeDecode(): EncodeDecodeReport {
  const suites: CodecSuite[] = [
    'tcpReqEncode',
    'tcpResEncode',
    'tcpReqDecode',
    'tcpResDecode',
    'rtuReqEncode',
    'rtuResEncode',
    'rtuReqDecode',
    'rtuResDecode',
    'asciiReqEncode',
    'asciiResEncode',
    'asciiReqDecode',
    'asciiResDecode',
  ];

  const baseOps: Record<CodecSuite, number> = {
    tcpReqEncode: 5_900_000,
    tcpResEncode: 4_800_000,
    tcpReqDecode: 5_500_000,
    tcpResDecode: 5_100_000,
    rtuReqEncode: 5_700_000,
    rtuResEncode: 1_600_000,
    rtuReqDecode: 5_100_000,
    rtuResDecode: 1_600_000,
    asciiReqEncode: 5_500_000,
    asciiResEncode: 1_400_000,
    asciiReqDecode: 4_800_000,
    asciiResDecode: 1_150_000,
  };

  return {
    suites: suites.map((suite) => {
      const ops = Math.round(jitter(baseOps[suite], baseOps[suite] * 0.05));
      // Avg latency in legacy report ~0.1µs → 0.0001 ms; CPU usPerOp 2..10.
      const p50 = 0.0001;
      const p99 = 0.00018;
      const cpu = baseOps[suite] > 4_000_000 ? jitter(2.3, 0.5) : jitter(8.5, 2);
      return { suite, metrics: { 'njs-modbus': makeCodec('njs-modbus', ops, p50, p99, cpu) } };
    }),
  };
}

// ── transport-suite mock ───────────────────────────────────────────────────

function mockTransportSuite(): TransportSuiteOutput {
  // TCP: all three libs. RTU: jsmodbus + njs-modbus + modbus-serial (sequential
  // only). ASCII: njs-modbus only. Match runTransportSuite shape.
  const seqTcp = {
    'njs-modbus': makeMacro('seq/tcp/njs-modbus', 101_500, 0.009, 0.075, 10.5),
    jsmodbus: makeMacro('seq/tcp/jsmodbus', 63_000, 0.014, 0.13, 16.8),
    'modbus-serial': makeMacro('seq/tcp/modbus-serial', 855, 1.0, 4.5, 119.0),
  };
  const seqRtu = {
    'njs-modbus': makeMacro('seq/rtu/njs-modbus', 104, 0.6, 0.9, 878.5),
    jsmodbus: makeMacro('seq/rtu/jsmodbus', 103, 0.65, 1.0, 761.0),
    'modbus-serial': makeMacro('seq/rtu/modbus-serial', 31, 31.0, 35.0, 931.3),
  };
  const seqAscii = {
    'njs-modbus': makeMacro('seq/ascii/njs-modbus', 51, 0.6, 0.9, 923.2),
  };

  const multi = {
    'njs-modbus': makeMacro('multi/tcp/njs-modbus', 108_800, 0.073, 0.16, 79.0),
    jsmodbus: makeMacro('multi/tcp/jsmodbus', 63_500, 0.125, 0.3, 133.1),
    'modbus-serial': makeMacro('multi/tcp/modbus-serial', 6_220, 1.28, 4.2, 264.5),
  };

  return {
    sequential: { depth: 1, tcp: seqTcp, rtu: seqRtu, ascii: seqAscii },
    multiconn: { connections: 8, tcp: multi },
  };
}

// ── all-fcs mock ───────────────────────────────────────────────────────────

const FC_SPECS = [
  { fc: 'fc01_read_coils', label: 'FC01 Read Coils' },
  { fc: 'fc02_read_discrete_inputs', label: 'FC02 Read Discrete Inputs' },
  { fc: 'fc03_read_holding_registers', label: 'FC03 Read Holding Registers' },
  { fc: 'fc04_read_input_registers', label: 'FC04 Read Input Registers' },
  { fc: 'fc05_write_single_coil', label: 'FC05 Write Single Coil' },
  { fc: 'fc06_write_single_register', label: 'FC06 Write Single Register' },
  {
    fc: 'fc08_00_diagnostics_return_query_data',
    label: 'FC08/0 Diagnostics Return Query Data',
  },
  { fc: 'fc15_write_multiple_coils', label: 'FC15 Write Multiple Coils' },
  { fc: 'fc16_write_multiple_registers', label: 'FC16 Write Multiple Registers' },
  { fc: 'fc17_report_server_id', label: 'FC17 Report Server ID' },
  { fc: 'fc22_mask_write_register', label: 'FC22 Mask Write Register' },
  { fc: 'fc23_read_write_multiple_registers', label: 'FC23 Read/Write Multiple Registers' },
  { fc: 'fc43_read_device_identification', label: 'FC43 Read Device Identification' },
];

const FC_UNSUPPORTED: Record<string, Set<string>> = {
  'modbus-serial': new Set([
    'fc08_00_diagnostics_return_query_data',
    'fc17_report_server_id',
    'fc22_mask_write_register',
    'fc23_read_write_multiple_registers',
  ]),
  jsmodbus: new Set([
    'fc08_00_diagnostics_return_query_data',
    'fc17_report_server_id',
    'fc22_mask_write_register',
    'fc23_read_write_multiple_registers',
    'fc43_read_device_identification',
  ]),
};

function fcSupports(library: string, fc: string): boolean {
  return !FC_UNSUPPORTED[library]?.has(fc);
}

function mockAllFcs(maxPayload: boolean): AllFcsOutput {
  const factor = maxPayload ? 0.85 : 1.0;
  // Max payload makes encode/decode and serialization heavier — Ops/sec drops, CPU rises, P99 fattens.
  const cpuMul = maxPayload ? 1.6 : 1.0;
  const gcMul = maxPayload ? 1.5 : 1.0;
  const p99Mul = maxPayload ? 1.4 : 1.0;
  const p50Mul = maxPayload ? 1.2 : 1.0;
  const fcs: AllFcsOutput['fcs'] = [];
  const summary: FcSummaryEntry[] = [];

  for (const spec of FC_SPECS) {
    const baseOps = Math.round(jitter(60_000, 12_000) * factor);
    const profiles: { lib: string; ops: number; p50: number; p99: number; cpu: number; gc: number }[] = [
      {
        lib: 'njs-modbus',
        ops: baseOps,
        p50: Math.round(13 * p50Mul),
        p99: Math.round(75 * p99Mul),
        cpu: Math.round(175 * cpuMul),
        gc: Math.round(80 * gcMul),
      },
      {
        lib: 'jsmodbus',
        ops: ['fc01_read_coils', 'fc02_read_discrete_inputs', 'fc15_write_multiple_coils'].includes(spec.fc)
          ? Math.round(jitter(550, 80))
          : Math.round(jitter(35_000, 5_000) * factor),
        p50: Math.round(21 * p50Mul),
        p99: Math.round(130 * p99Mul),
        cpu: Math.round(305 * cpuMul),
        gc: Math.round(150 * gcMul),
      },
      {
        lib: 'modbus-serial',
        ops: Math.round(jitter(800, 80) * factor),
        p50: Math.round(1190 * p50Mul),
        p99: Math.round(1900 * p99Mul),
        cpu: Math.round(13_300 * cpuMul),
        gc: Math.round(5_000 * gcMul),
      },
    ];

    const metrics: AllFcsOutput['fcs'][number]['metrics'] = {};
    for (const p of profiles) {
      if (!fcSupports(p.lib, spec.fc)) {
        continue;
      }
      metrics[p.lib] = makeMacro(p.lib, p.ops, p.p50 / 1000, p.p99 / 1000, p.cpu);
      summary.push({
        fc: spec.label,
        library: p.lib,
        opsPerSecond: p.ops,
        p50: p.p50,
        p99: p.p99,
        cpuUsPerOp: p.cpu,
        gcNsPerOp: p.gc,
      });
    }

    fcs.push({ fc: spec.fc, label: spec.label, metrics });
  }

  return { fcs, summary };
}

// ── chaos mock ─────────────────────────────────────────────────────────────

const SCENE_SHORT_LABELS: Record<string, string> = {
  scene1: 'drip-1',
  scene2: 'drip-10',
  scene3: 'sticky-2',
  scene4: 'sticky-10',
  scene5: 'sticky-50',
  scene6: 'garbage-2B',
  scene7: 'mixed',
  scene8: 'corrupt',
  scene9: 'garbage-256B',
  scene10: 'chunk-2B',
  scene11: 'garbage-after',
  scene12: 'truncated',
  colonInjection: 'colon-inject',
  crNoLf: 'cr-no-lf',
};

const SCENE_DESCRIPTIONS: Record<string, string> = {
  scene1: 'Single frame drip-fed one byte at a time',
  scene2: '10 frames drip-fed one byte at a time',
  scene3: '2 valid frames stuck together',
  scene4: '10 valid frames stuck together',
  scene5: '50 frames with varying register counts stuck together',
  scene6: 'Valid frame + 2 bytes garbage + valid frame',
  scene7: '3 frames with interleaved garbage, sent in 3-byte chunks',
  scene8: 'Checksum/length corrupted in first frame',
  scene9: '256 bytes garbage followed by one valid frame',
  scene10: '5 frames sent in 2-byte chunks (crosses frame boundaries)',
  scene11: '5 frames with 4 bytes garbage after each',
  scene12: 'Truncated first frame followed by valid second frame',
  colonInjection: 'Colon injected mid-first-frame (forces parser restart)',
  crNoLf: 'First frame has CR+CR instead of CR+LF',
};

// Per-scene njs-modbus baseline correctness; competitors degrade off this.
const SCENE_BASELINE_CORRECT: Record<string, number> = {
  scene1: 1.0,
  scene2: 1.0,
  scene3: 1.0,
  scene4: 1.0,
  scene5: 1.0,
  scene6: 0.5,
  scene7: 0.35,
  scene8: 0.0,
  scene9: 0.0,
  scene10: 1.0,
  scene11: 0.2,
  scene12: 0.0,
  colonInjection: 0.5,
  crNoLf: 0.5,
};

function sceneKey(sceneName: string): string {
  if (sceneName === 'asciiScene13') {
    return 'colonInjection';
  }
  if (sceneName === 'asciiScene14') {
    return 'crNoLf';
  }
  // Strip transport prefix and lowercase the first letter: `tcpScene1` → `scene1`.
  const stripped = sceneName.replace(/^(tcp|rtu|ascii)/, '');
  return stripped.charAt(0).toLowerCase() + stripped.slice(1);
}

function makeChaosResult(library: string, sceneName: string): ChaosRunResult {
  const key = sceneKey(sceneName);
  const baseline = SCENE_BASELINE_CORRECT[key] ?? 0.5;
  const correctRate =
    library === 'njs-modbus'
      ? baseline
      : library === 'jsmodbus'
        ? Math.max(0, baseline - 0.2 + jitter(0, 0.1))
        : Math.max(0, baseline - 0.4 + jitter(0, 0.1));

  const requestCount = 200;
  // Simulate circuit-breaker trips on hard scenes for libraries that fail outright.
  const tripped = correctRate === 0 && library !== 'njs-modbus';
  const requestsCompleted = tripped ? Math.round(requestCount * (0.1 + jitter(0, 0.05))) : requestCount;
  const opsPerSecond = Math.max(1, Math.round(requestsCompleted / 8));
  const framesSent = requestsCompleted * (key === 'scene5' ? 50 : key === 'scene2' || key === 'scene4' ? 10 : key === 'scene7' ? 3 : 2);
  const framesCorrect = Math.round(framesSent * correctRate);
  const errors = framesSent - framesCorrect;
  const expectedCorrect = Math.round(framesSent * baseline);

  // Mock a sprinkle of jitter contamination so the ⚠ marker exercises.
  const jitterContaminated = ['scene7', 'scene11', 'crNoLf'].includes(key) && library !== 'njs-modbus';

  return {
    name: library,
    opsPerSecond,
    framesPerSecond: Math.round(opsPerSecond * (correctRate || 0.1)),
    correctRate,
    framesSent,
    framesReceived: framesCorrect,
    framesCorrect,
    framesExtra: 0,
    errors,
    expectedCorrect,
    expectedStrictCorrect: expectedCorrect,
    accuracyPass: framesCorrect >= expectedCorrect,
    totalTimeMs: 8000,
    iterations: requestsCompleted,
    latency: makeLatency(0.05 + (1 - correctRate) * 0.4, 0.08 + (1 - correctRate) * 0.6),
    latencyFiltered: makeLatency(0.04, 0.07),
    sampleStats: { seen: requestsCompleted, capacity: 100_000, overflowed: false, outliersRemoved: 0 },
    memory: { rssDelta: 0, heapUsedDelta: 0, heapTotalDelta: 0, externalDelta: 0, arrayBuffersDelta: 0 },
    cpu: {
      totalUs: (library === 'njs-modbus' ? 18 : library === 'jsmodbus' ? 32 : 65) * requestsCompleted,
      usPerOp: library === 'njs-modbus' ? 18 : library === 'jsmodbus' ? 32 : 65,
    },
    harnessCpu: { validationTotalUs: 1000, validationUsPerIter: 5 },
    recoveryP99: correctRate > 0 ? jitter(950, 300) : undefined,
    maxCpuTimeUs: jitter(2000, 1500),
    netHeapGrowthKB: jitter(180, 200),
    heapNoiseFloorKB: jitter(40, 20),
    circuitBreakerTripped: tripped,
    requestCount,
    requestsCompleted,
    jitterContaminated,
    jitterContaminatedCount: jitterContaminated ? Math.round(jitter(8, 4)) : 0,
  };
}

function mockChaos(): ChaosReport {
  const scenes: ChaosSceneReport[] = [];
  const protocolFor = (n: string): 'TCP' | 'RTU' | 'ASCII' => (n.startsWith('tcp') ? 'TCP' : n.startsWith('rtu') ? 'RTU' : 'ASCII');

  for (const scene of getAllSceneNames()) {
    const protocol = protocolFor(scene);
    const key = sceneKey(scene);
    const libs = protocol === 'ASCII' ? ['njs-modbus', 'modbus-serial'] : ['njs-modbus', 'jsmodbus', 'modbus-serial'];
    const metrics: ChaosSceneReport['metrics'] = {};
    for (const lib of libs) {
      metrics[lib] = makeChaosResult(lib, scene);
    }
    scenes.push({
      scene,
      protocol,
      description: SCENE_DESCRIPTIONS[key] ?? scene,
      shortLabel: SCENE_SHORT_LABELS[key] ?? scene,
      metrics,
    });
  }

  return { scenes };
}

// ── context assembly ───────────────────────────────────────────────────────

function getSystemInfo(): SystemInfo {
  return {
    cpu: cpus()[0]?.model ?? 'unknown',
    cores: cpus().length,
    memory: `${Math.round(totalmem() / 1024 / 1024 / 1024)} GB`,
    nodeVersion: process.version,
    v8Version: process.versions.v8,
    platform: `${process.platform} ${arch()}`,
  };
}

function buildContext(): ReportContext {
  const versions: ReportVersions = {
    own: '0.0.0-test',
    jsmodbus: '0.0.0-test',
    modbusSerial: '0.0.0-test',
  };

  return {
    date: new Date().toISOString(),
    durationSec: 5,
    numRuns: 1,
    sys: getSystemInfo(),
    versions,
    encodeDecode: mockEncodeDecode(),
    transportSuite: mockTransportSuite(),
    allFcsNormal: mockAllFcs(false),
    allFcsMax: mockAllFcs(true),
    chaos: mockChaos(),
  };
}

// ── main ───────────────────────────────────────────────────────────────────

function main(): void {
  const context = buildContext();

  const md = renderPresentationReport(context);
  const mdPath = resolve(process.cwd(), 'benchmark', 'report_presentation.md');
  writeFileSync(mdPath, md);
  console.log(`Mock markdown report written to ${mdPath}`);

  // AI-facing flat-table markdown for downstream analysis. Same kinds of data
  // as the presentation report, but stripped of grouping/decoration and with
  // chaos diagnostic columns the human report does not render.
  const dataPath = resolve(process.cwd(), 'benchmark', 'report_data.md');
  writeFileSync(dataPath, renderDataReport(context));
  console.log(`Mock data report written to ${dataPath}`);
}

main();
