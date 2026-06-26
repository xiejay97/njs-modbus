/**
 * Report coordinator.
 *
 * Orchestrates codec and chaos benchmark tasks through the execution engine,
 * aggregates multi-run results (median run), and builds a `ReportContext` for
 * the Markdown generators.
 */

import type {
  AllFcsOutput,
  ChaosReport,
  ChaosSceneReport,
  EncodeDecodeReport,
  FcSummaryEntry,
  ReportContext,
  ReportOptions,
  SystemInfo,
  TransportSuiteOutput,
} from './types';
import type { LibraryAdapter } from '../adapters/types';
import type { ChaosRunResult } from '../chaos/types';
import type { CodecSuite, CodecBenchmarkResult } from '../codec/types';
import type { ExecutionTask } from '../engine/types';
import type { MacroBenchmarkResult } from '../macro';

import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { availableParallelism, arch, cpus, totalmem } from 'node:os';
import { resolve } from 'node:path';

import { list, resolve as resolveAdapter } from '../adapters/registry';
import { getAllSceneNames, SCENE_DESCRIPTIONS, SCENE_SHORT_LABELS } from '../chaos/scenes';
import { runForkedChild } from '../engine/process-fork';
import { runWorkerThread } from '../engine/process-worker';
import { runTasks } from '../engine/task-scheduler';
import { getTsxExecArgv } from '../engine/tsx';
import { spawnPtyPair, closePtyPair } from '../transport/serial';

const require = createRequire(import.meta.url);

const CODEC_SUITES: CodecSuite[] = [
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

const CHAOS_TCP_PORT_BASE = 18000;

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

function getOwnVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(process.cwd(), 'package.json'), 'utf8')) as { version?: string };
    return pkg.version ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

function getDependencyVersion(name: string): string | null {
  try {
    const pkg = JSON.parse(readFileSync(require.resolve(`${name}/package.json`), 'utf8')) as {
      version?: string;
    };
    return pkg.version ?? null;
  } catch {
    return null;
  }
}

function fillOptions(options?: ReportOptions): Required<ReportOptions> {
  return {
    fast: options?.fast ?? false,
    runs: options?.runs ?? (options?.fast ? 1 : 3),
    libraries: options?.libraries ?? list(),
    suites: options?.suites ?? CODEC_SUITES,
    concurrency: options?.concurrency ?? Math.max(1, availableParallelism() - 1),
    maxPayload: options?.maxPayload ?? false,
    durationMs: options?.durationMs ?? 0,
    chaosRequests: options?.chaosRequests ?? 0,
  };
}

/** Effective concurrency for a benchmark stage.
 *
 * Normal runs keep conservative caps to protect measurement stability;
 * `--fast` lifts them and uses the full `availableParallelism() - 1` default
 * to minimize wall-clock time.
 */
function taskConcurrency(opts: Required<ReportOptions>, normalCap: number): number {
  return opts.fast ? opts.concurrency : Math.min(opts.concurrency, normalCap);
}

function pickMedianRun<T extends { opsPerSecond: number }>(results: T[]): T & { opsValues?: number[]; rsd?: number } {
  if (results.length === 0) {
    throw new Error('Cannot pick median run from empty results');
  }
  const ops = results.map((r) => r.opsPerSecond).sort((a, b) => a - b);

  // 1.5× IQR outlier removal at the run level before picking the median.
  const q1 = ops[Math.floor(ops.length * 0.25)] ?? ops[0];
  const q3 = ops[Math.floor(ops.length * 0.75)] ?? ops[ops.length - 1];
  const iqr = q3 - q1;
  const lo = q1 - iqr * 1.5;
  const hi = q3 + iqr * 1.5;
  const kept = results.filter((r) => r.opsPerSecond >= lo && r.opsPerSecond <= hi);

  const sorted = (kept.length > 0 ? kept : results).slice().sort((a, b) => a.opsPerSecond - b.opsPerSecond);
  const mid = Math.floor((sorted.length - 1) / 2);
  const median = sorted[mid] ?? sorted[0];

  const mean = ops.reduce((a, b) => a + b, 0) / ops.length;
  const variance = ops.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (ops.length - 1);
  const rsd = mean === 0 ? 0 : (Math.sqrt(variance) / mean) * 100;

  return {
    ...median,
    opsValues: ops,
    rsd,
  };
}

interface EncodeDecodeTaskOutput {
  suite: CodecSuite;
  library: string;
  result: CodecBenchmarkResult;
}

async function tryResolveAdapter(name: string): Promise<LibraryAdapter | null> {
  try {
    return await resolveAdapter(name);
  } catch {
    // Optional dependency (jsmodbus, modbus-serial) not installed.
    return null;
  }
}

export async function runEncodeDecode(options?: ReportOptions): Promise<EncodeDecodeReport> {
  const opts = fillOptions(options);
  const libraries: string[] = [];
  for (const name of opts.libraries) {
    const adapter = await tryResolveAdapter(name);
    if (adapter?.codec) {
      libraries.push(name);
    }
  }

  const selectedSuites = opts.suites ?? CODEC_SUITES;
  const tasks = [];
  for (const suite of selectedSuites) {
    for (const library of libraries) {
      for (let run = 0; run < opts.runs; run++) {
        const id = `codec-${suite}-${library}-${run}`;
        tasks.push({
          id,
          input: { suite, library, run },
          execute: async (): Promise<EncodeDecodeTaskOutput> => {
            const microOpts = opts.fast ? { minDurationMs: 500, warmupDurationMs: 200, warmupIterations: 1000 } : undefined;
            const workerPath = new URL('../workers/encode-decode-worker.ts', import.meta.url).pathname;
            const output = await runWorkerThread<
              { suite: CodecSuite; library: string; microOpts?: object },
              { result: CodecBenchmarkResult }
            >({
              modulePath: workerPath,
              workerData: { suite, library, microOpts },
              execArgv: getTsxExecArgv(),
            });
            return { suite, library, result: output.result };
          },
        });
      }
    }
  }

  // Codec is a sub-microsecond CPU microbenchmark — running multiple suites
  // concurrently has them fight for CPU, JIT, and L1/L2 cache, biasing the
  // numbers downward. Keep it serial for normal runs; allow higher concurrency
  // in --fast mode to shorten wall-clock time at the cost of some accuracy.
  const results = await runTasks(tasks, { concurrency: taskConcurrency(opts, 1) });
  const bySuiteLibrary = new Map<CodecSuite, Map<string, CodecBenchmarkResult[]>>();

  for (const result of results) {
    if (result.error || !result.output) {
      console.error(`Codec task ${result.taskId} failed: ${result.error ?? 'unknown'}`);
      continue;
    }
    const { suite, library, result: benchResult } = result.output;
    let byLibrary = bySuiteLibrary.get(suite);
    if (!byLibrary) {
      byLibrary = new Map();
      bySuiteLibrary.set(suite, byLibrary);
    }
    const runs = byLibrary.get(library) ?? [];
    runs.push(benchResult);
    byLibrary.set(library, runs);
  }

  const suites: EncodeDecodeReport['suites'] = [];
  for (const suite of selectedSuites) {
    const byLibrary = bySuiteLibrary.get(suite);
    if (!byLibrary) {
      continue;
    }
    const metrics: EncodeDecodeReport['suites'][number]['metrics'] = {};
    for (const [library, runs] of byLibrary) {
      metrics[library] = pickMedianRun(runs);
    }
    suites.push({ suite, metrics });
  }

  return { suites };
}

interface ChaosTaskOutput {
  scene: string;
  library: string;
  result: ChaosRunResult;
}

function protocolForScene(scene: string): 'TCP' | 'RTU' | 'ASCII' {
  if (scene.startsWith('tcp')) {
    return 'TCP';
  }
  if (scene.startsWith('rtu')) {
    return 'RTU';
  }
  return 'ASCII';
}

export async function runChaos(options?: ReportOptions): Promise<ChaosReport> {
  const opts = fillOptions(options);
  const scenes = getAllSceneNames();
  const requestCount = opts.chaosRequests > 0 ? opts.chaosRequests : opts.fast ? 50 : 200;

  const tasks = [];
  let portCounter = 0;

  for (const scene of scenes) {
    const protocol = protocolForScene(scene);
    for (const library of opts.libraries) {
      const adapter = await tryResolveAdapter(library);
      if (!adapter || !adapter.capability.protocols.includes(protocol)) {
        continue;
      }

      for (let run = 0; run < opts.runs; run++) {
        const id = `chaos-${scene}-${library}-${run}`;
        const portOffset = portCounter++;
        tasks.push({
          id,
          input: { scene, library, protocol, portOffset, run },
          execute: async (): Promise<ChaosTaskOutput> => {
            let ptyPair: Awaited<ReturnType<typeof spawnPtyPair>> | null = null;
            try {
              const env: Record<string, string> = {
                CHAOS_BENCH_LIBRARY: library,
                CHAOS_BENCH_PROTOCOL: protocol,
                CHAOS_BENCH_SCENE: scene,
                CHAOS_BENCH_REQUESTS: String(requestCount),
              };

              if (protocol === 'TCP') {
                env['CHAOS_BENCH_PORT'] = String(CHAOS_TCP_PORT_BASE + portOffset);
              } else {
                ptyPair = await spawnPtyPair();
                env['CHAOS_BENCH_MASTER_PATH'] = ptyPair.masterPath;
                env['CHAOS_BENCH_SLAVE_PATH'] = ptyPair.slavePath;
              }

              const workerPath = new URL('../workers/chaos-worker.ts', import.meta.url).pathname;
              const output = await runForkedChild<ChaosRunResult>({
                modulePath: workerPath,
                env,
                execArgv: getTsxExecArgv(['--expose-gc']),
              });
              return { scene, library, result: output };
            } finally {
              if (ptyPair) {
                closePtyPair(ptyPair);
              }
            }
          },
        });
      }
    }
  }

  // Cap concurrency at 4 for normal runs: chaos correctness columns are
  // concurrency-invariant, but `recoveryP99` measures wall-clock time and is
  // heavily distorted by event-loop contention. In --fast mode we trade that
  // accuracy for speed and use the full default concurrency.
  const results = await runTasks(tasks, { concurrency: taskConcurrency(opts, 4) });
  const bySceneLibrary = new Map<string, Map<string, ChaosRunResult[]>>();

  for (const result of results) {
    if (result.error || !result.output) {
      console.error(`Chaos task ${result.taskId} failed: ${result.error ?? 'unknown'}`);
      continue;
    }
    const { scene, library, result: chaosResult } = result.output;
    let byLibrary = bySceneLibrary.get(scene);
    if (!byLibrary) {
      byLibrary = new Map();
      bySceneLibrary.set(scene, byLibrary);
    }
    const runs = byLibrary.get(library) ?? [];
    runs.push(chaosResult);
    byLibrary.set(library, runs);
  }

  const sceneReports: ChaosSceneReport[] = [];
  for (const scene of scenes) {
    const byLibrary = bySceneLibrary.get(scene);
    if (!byLibrary) {
      continue;
    }
    const metrics: Record<string, ChaosRunResult> = {};
    for (const [library, runs] of byLibrary) {
      metrics[library] = pickMedianRun(runs);
    }
    const firstLibrary = Object.keys(metrics)[0];
    const firstResult = firstLibrary ? metrics[firstLibrary] : undefined;
    sceneReports.push({
      scene,
      protocol: protocolForScene(scene),
      description: SCENE_DESCRIPTIONS[scene] ?? firstResult?.name ?? scene,
      shortLabel: SCENE_SHORT_LABELS[scene] ?? scene,
      metrics,
    });
  }

  return { scenes: sceneReports };
}

// ---------------------------------------------------------------------------
// Transport suite
// ---------------------------------------------------------------------------

const TRANSPORT_MODES: ('sequential' | 'multiconn')[] = ['sequential', 'multiconn'];
const TRANSPORT_PROTOCOLS: ('tcp' | 'rtu' | 'ascii')[] = ['tcp', 'rtu', 'ascii'];

function transportCellSupported(mode: string, transport: string, library: string): boolean {
  if (mode === 'multiconn' && transport !== 'tcp') {
    return false;
  }
  if (library === 'jsmodbus' && transport === 'ascii') {
    return false;
  }
  if (library === 'modbus-serial' && transport === 'ascii') {
    return false;
  }
  return true;
}

interface TransportCell {
  mode: 'sequential' | 'multiconn';
  transport: 'tcp' | 'rtu' | 'ascii';
  library: string;
  label: string;
}

function buildTransportCells(libraries: string[]): TransportCell[] {
  const cells: TransportCell[] = [];
  for (const mode of TRANSPORT_MODES) {
    for (const transport of TRANSPORT_PROTOCOLS) {
      for (const library of libraries) {
        if (!transportCellSupported(mode, transport, library)) {
          continue;
        }
        cells.push({
          mode,
          transport,
          library,
          label: `${mode}/${transport}/${library}`,
        });
      }
    }
  }
  return cells;
}

export async function runTransportSuite(options?: ReportOptions): Promise<TransportSuiteOutput> {
  const opts = fillOptions(options);
  const durationMs = opts.durationMs > 0 ? opts.durationMs : opts.fast ? 8000 : 30000;
  const connections = 8;

  const resolvedLibraries: string[] = [];
  for (const name of opts.libraries) {
    if (await tryResolveAdapter(name)) {
      resolvedLibraries.push(name);
    }
  }

  const cells = buildTransportCells(resolvedLibraries);
  interface TransportTask {
    cell: TransportCell;
    port: number;
    runIdx: number;
  }

  const tasks: ExecutionTask<TransportTask, MacroBenchmarkResult>[] = [];
  let nextPort = 25000 + (Date.now() % 10000);
  for (const cell of cells) {
    for (let runIdx = 0; runIdx < opts.runs; runIdx++) {
      const task: TransportTask = {
        cell,
        port: cell.transport === 'tcp' ? nextPort++ : 0,
        runIdx,
      };
      tasks.push({
        id: `transport-${cell.label}-${runIdx}`,
        input: task,
        execute: async (t): Promise<MacroBenchmarkResult> => {
          let ptyPair: Awaited<ReturnType<typeof spawnPtyPair>> | null = null;
          try {
            const env: Record<string, string> = {
              TRANSPORT_BENCH_MODE: t.cell.mode,
              TRANSPORT_BENCH_TRANSPORT: t.cell.transport,
              TRANSPORT_BENCH_LIBRARY: t.cell.library,
              TRANSPORT_BENCH_DURATION: String(durationMs),
              TRANSPORT_BENCH_CONNECTIONS: String(connections),
              TRANSPORT_BENCH_PORT: String(t.port),
              TRANSPORT_BENCH_LABEL: `${t.cell.label}-run${t.runIdx}`,
            };
            if (t.cell.transport !== 'tcp') {
              ptyPair = await spawnPtyPair();
              env['TRANSPORT_BENCH_MASTER_PATH'] = ptyPair.masterPath;
              env['TRANSPORT_BENCH_SLAVE_PATH'] = ptyPair.slavePath;
            }
            const workerPath = new URL('../workers/transport-suite-worker.ts', import.meta.url).pathname;
            return await runForkedChild<MacroBenchmarkResult>({
              modulePath: workerPath,
              env,
              execArgv: getTsxExecArgv(['--expose-gc']),
            });
          } finally {
            if (ptyPair) {
              closePtyPair(ptyPair);
            }
          }
        },
      });
    }
  }

  // Cap concurrency at 4 for normal runs: each task hosts a Modbus server +
  // client (TCP loopback or socat PTY) inside a worker, and the bottleneck is
  // the kernel network/PTY stack rather than CPU. In --fast mode we lift the
  // cap to reduce wall-clock time.
  const results = await runTasks(tasks, { concurrency: taskConcurrency(opts, 4) });
  const byLabel = new Map<string, MacroBenchmarkResult[]>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const task = tasks[i].input;
    if (r.error || !r.output) {
      console.error(`Transport task ${tasks[i].id} failed: ${r.error ?? 'unknown'}`);
      continue;
    }
    const arr = byLabel.get(task.cell.label) ?? [];
    arr.push(r.output);
    byLabel.set(task.cell.label, arr);
  }

  function pickResultFor(label: string): MacroBenchmarkResult {
    const runs = byLabel.get(label);
    if (!runs || runs.length === 0) {
      return {
        name: label,
        opsPerSecond: 0,
        totalTimeMs: 0,
        iterations: 0,
        latency: undefined,
        latencyFiltered: undefined,
        sampleStats: { seen: 0, capacity: 0, overflowed: false, outliersRemoved: 0 },
        memory: { rssDelta: 0, heapUsedDelta: 0, heapTotalDelta: 0, externalDelta: 0, arrayBuffersDelta: 0 },
        gc: { count: 0, totalDurationMs: 0, maxDurationMs: 0 },
        cpu: { totalUs: 0, usPerOp: 0 },
      };
    }
    return pickMedianRun(runs);
  }

  function buildMetrics(mode: string, transport: string): Record<string, MacroBenchmarkResult> {
    const metrics: Record<string, MacroBenchmarkResult> = {};
    for (const library of resolvedLibraries) {
      if (!transportCellSupported(mode, transport, library)) {
        continue;
      }
      metrics[library] = pickResultFor(`${mode}/${transport}/${library}`);
    }
    return metrics;
  }

  return {
    sequential: {
      depth: 1,
      tcp: buildMetrics('sequential', 'tcp'),
      rtu: buildMetrics('sequential', 'rtu'),
      ascii: buildMetrics('sequential', 'ascii'),
    },
    multiconn: {
      connections,
      tcp: buildMetrics('multiconn', 'tcp'),
    },
  };
}

// ---------------------------------------------------------------------------
// All function codes
// ---------------------------------------------------------------------------

const ALL_FCS_SPECS: { fc: string; label: string; portBase: number }[] = [
  { fc: 'fc01_read_coils', label: 'FC01 Read Coils', portBase: 16001 },
  { fc: 'fc02_read_discrete_inputs', label: 'FC02 Read Discrete Inputs', portBase: 16031 },
  { fc: 'fc03_read_holding_registers', label: 'FC03 Read Holding Registers', portBase: 16061 },
  { fc: 'fc04_read_input_registers', label: 'FC04 Read Input Registers', portBase: 16091 },
  { fc: 'fc05_write_single_coil', label: 'FC05 Write Single Coil', portBase: 16121 },
  { fc: 'fc06_write_single_register', label: 'FC06 Write Single Register', portBase: 16151 },
  {
    fc: 'fc08_00_diagnostics_return_query_data',
    label: 'FC08/0 Diagnostics Return Query Data',
    portBase: 16361,
  },
  { fc: 'fc15_write_multiple_coils', label: 'FC15 Write Multiple Coils', portBase: 16181 },
  { fc: 'fc16_write_multiple_registers', label: 'FC16 Write Multiple Registers', portBase: 16211 },
  { fc: 'fc17_report_server_id', label: 'FC17 Report Server ID', portBase: 16241 },
  { fc: 'fc22_mask_write_register', label: 'FC22 Mask Write Register', portBase: 16271 },
  { fc: 'fc23_read_write_multiple_registers', label: 'FC23 Read/Write Multiple Registers', portBase: 16301 },
  { fc: 'fc43_read_device_identification', label: 'FC43 Read Device Identification', portBase: 16331 },
];

const ALL_FCS_LIBS = ['njs-modbus', 'modbus-serial', 'jsmodbus'];

const ALL_FCS_UNSUPPORTED: Record<string, Set<string>> = {
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

function allFcsSupported(library: string, fc: string): boolean {
  return !ALL_FCS_UNSUPPORTED[library]?.has(fc);
}

export async function runAllFcs(maxPayload: boolean, options?: ReportOptions): Promise<AllFcsOutput> {
  const opts = fillOptions(options);
  const durationMs = opts.durationMs > 0 ? opts.durationMs : opts.fast ? 3000 : 10000;

  const resolvedLibraries: string[] = [];
  for (const name of opts.libraries) {
    if (ALL_FCS_LIBS.includes(name) && (await tryResolveAdapter(name))) {
      resolvedLibraries.push(name);
    }
  }

  interface AllFcsTask {
    spec: (typeof ALL_FCS_SPECS)[number];
    library: string;
    libIdx: number;
    runIdx: number;
    port: number;
  }

  const tasks: ExecutionTask<AllFcsTask, MacroBenchmarkResult>[] = [];
  for (const spec of ALL_FCS_SPECS) {
    for (const library of resolvedLibraries) {
      if (!allFcsSupported(library, spec.fc)) {
        continue;
      }
      const libIdx = ALL_FCS_LIBS.indexOf(library);
      for (let runIdx = 0; runIdx < opts.runs; runIdx++) {
        const task: AllFcsTask = {
          spec,
          library,
          libIdx,
          runIdx,
          port: spec.portBase + libIdx * 10 + runIdx,
        };
        tasks.push({
          id: `all-fcs-${spec.fc}-${library}-${runIdx}`,
          input: task,
          execute: async (t): Promise<MacroBenchmarkResult> => {
            const workerPath = new URL('../workers/all-fcs-worker.ts', import.meta.url).pathname;
            return await runWorkerThread<
              { fc: string; library: string; port: number; durationMs: number; maxPayload: boolean },
              MacroBenchmarkResult
            >({
              modulePath: workerPath,
              workerData: {
                fc: t.spec.fc,
                library: t.library,
                port: t.port,
                durationMs,
                maxPayload,
              },
              execArgv: getTsxExecArgv(),
            });
          },
        });
      }
    }
  }

  // Cap concurrency at 4 for normal runs: each cell spins up a TCP server +
  // client (or serial PTY pair) and competes for kernel network/PTY resources
  // and ephemeral ports. In --fast mode we lift the cap to shorten wall time.
  const results = await runTasks(tasks, { concurrency: taskConcurrency(opts, 4) });
  const byFcLib = new Map<string, Map<string, MacroBenchmarkResult[]>>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const task = tasks[i].input;
    if (r.error || !r.output) {
      console.error(`All-fcs task ${tasks[i].id} failed: ${r.error ?? 'unknown'}`);
      continue;
    }
    let libMap = byFcLib.get(task.spec.fc);
    if (!libMap) {
      libMap = new Map();
      byFcLib.set(task.spec.fc, libMap);
    }
    const arr = libMap.get(task.library) ?? [];
    arr.push(r.output);
    libMap.set(task.library, arr);
  }

  const fcs: AllFcsOutput['fcs'] = [];
  const summary: FcSummaryEntry[] = [];

  for (const spec of ALL_FCS_SPECS) {
    const libMap = byFcLib.get(spec.fc);
    if (!libMap || libMap.size === 0) {
      continue;
    }
    const metrics: AllFcsOutput['fcs'][number]['metrics'] = {};
    for (const library of resolvedLibraries) {
      const runs = libMap.get(library);
      if (!runs || runs.length === 0) {
        continue;
      }
      const merged = pickMedianRun(runs);
      metrics[library] = merged;

      const gcNsPerOp =
        merged.gc?.totalDurationMs && merged.iterations ? Math.round((merged.gc.totalDurationMs * 1e6) / merged.iterations) : 0;
      summary.push({
        fc: spec.label,
        library,
        opsPerSecond: merged.opsPerSecond,
        p50: Math.round((merged.latency?.p50 ?? 0) * 1000),
        p99: Math.round((merged.latency?.p99 ?? 0) * 1000),
        cpuUsPerOp: merged.cpu?.usPerOp ?? 0,
        gcNsPerOp,
      });
    }
    if (Object.keys(metrics).length > 0) {
      fcs.push({ fc: spec.fc, label: spec.label, metrics });
    }
  }

  return { fcs, summary };
}

// ---------------------------------------------------------------------------
// Full report
// ---------------------------------------------------------------------------

export async function runReport(options?: ReportOptions): Promise<ReportContext> {
  const startNs = process.hrtime.bigint();
  const opts = fillOptions(options);

  const transportSuite = await runTransportSuite(opts);
  const allFcsNormal = await runAllFcs(false, opts);
  const allFcsMax = opts.maxPayload ? await runAllFcs(true, opts) : null;

  const [encodeDecode, chaos] = await Promise.all([runEncodeDecode(opts), runChaos(opts)]);

  return {
    date: new Date().toISOString(),
    durationSec: Math.round(Number(process.hrtime.bigint() - startNs) / 1e9),
    numRuns: opts.runs,
    sys: getSystemInfo(),
    versions: {
      own: getOwnVersion(),
      jsmodbus: getDependencyVersion('jsmodbus'),
      modbusSerial: getDependencyVersion('modbus-serial'),
    },
    encodeDecode,
    transportSuite,
    allFcsNormal,
    allFcsMax,
    chaos,
  };
}

// Re-export report options so consumers can build typed options objects.
export type { ReportOptions };
