/**
 * All-function-code TCP throughput benchmark entry point.
 *
 * Measures every standard Modbus function code end-to-end over TCP for each
 * registered library. Each (FC, library, run) triple runs in its own worker
 * thread on a dedicated port to keep measurements isolated.
 */

import type { ExecutionTask } from './engine/types';
import type { MacroBenchmarkResult } from './macro';
import type { AllFcsOutput, FcSummaryEntry } from './reports/types';

import { availableParallelism } from 'node:os';

import { list } from './adapters/registry';
import { runWorkerThread } from './engine/process-worker';
import { runTasks } from './engine/task-scheduler';
import { getTsxExecArgv } from './engine/tsx';

interface CliOptions {
  fast: boolean;
  runs: number;
  duration: number;
  maxPayload: boolean;
  only: string[] | undefined;
  libraries: string[];
  concurrency: number;
  output: string | undefined;
}

type Library = string;

interface FcSpec {
  fc: string;
  label: string;
  short: string;
  portBase: number;
}

interface Task {
  spec: FcSpec;
  library: Library;
  libIdx: number;
  runIdx: number;
  port: number;
}

const ALL_LIBS: Library[] = ['njs-modbus', 'modbus-serial', 'jsmodbus'];

const MODBUS_SERIAL_UNSUPPORTED = new Set([
  'fc08_00_diagnostics_return_query_data',
  'fc17_report_server_id',
  'fc22_mask_write_register',
  'fc23_read_write_multiple_registers',
]);

const JSMODBUS_UNSUPPORTED = new Set([
  'fc08_00_diagnostics_return_query_data',
  'fc17_report_server_id',
  'fc22_mask_write_register',
  'fc23_read_write_multiple_registers',
  'fc43_read_device_identification',
]);

function libSupports(lib: Library, fc: string): boolean {
  if (lib === 'modbus-serial' && MODBUS_SERIAL_UNSUPPORTED.has(fc)) {
    return false;
  }
  if (lib === 'jsmodbus' && JSMODBUS_UNSUPPORTED.has(fc)) {
    return false;
  }
  return true;
}

const ALL_FCS: FcSpec[] = [
  { fc: 'fc01_read_coils', label: 'FC01 Read Coils', short: 'Read Coils', portBase: 16001 },
  { fc: 'fc02_read_discrete_inputs', label: 'FC02 Read Discrete Inputs', short: 'Read Discrete Inputs', portBase: 16031 },
  { fc: 'fc03_read_holding_registers', label: 'FC03 Read Holding Registers', short: 'Read Holding Regs', portBase: 16061 },
  { fc: 'fc04_read_input_registers', label: 'FC04 Read Input Registers', short: 'Read Input Regs', portBase: 16091 },
  { fc: 'fc05_write_single_coil', label: 'FC05 Write Single Coil', short: 'Write Single Coil', portBase: 16121 },
  { fc: 'fc06_write_single_register', label: 'FC06 Write Single Register', short: 'Write Single Reg', portBase: 16151 },
  {
    fc: 'fc08_00_diagnostics_return_query_data',
    label: 'FC08/0 Diagnostics Return Query Data',
    short: 'Diag Return Query Data',
    portBase: 16361,
  },
  { fc: 'fc15_write_multiple_coils', label: 'FC15 Write Multiple Coils', short: 'Write Multiple Coils', portBase: 16181 },
  { fc: 'fc16_write_multiple_registers', label: 'FC16 Write Multiple Registers', short: 'Write Multiple Regs', portBase: 16211 },
  { fc: 'fc17_report_server_id', label: 'FC17 Report Server ID', short: 'Report Server ID', portBase: 16241 },
  { fc: 'fc22_mask_write_register', label: 'FC22 Mask Write Register', short: 'Mask Write Reg', portBase: 16271 },
  { fc: 'fc23_read_write_multiple_registers', label: 'FC23 Read/Write Multiple Registers', short: 'RW Multiple Regs', portBase: 16301 },
  { fc: 'fc43_read_device_identification', label: 'FC43 Read Device Identification', short: 'Read Device ID', portBase: 16331 },
];

function parseDurationMs(s: string | undefined, fallback: number): number {
  if (!s) {
    return fallback;
  }
  const lower = s.trim().toLowerCase();
  if (lower.endsWith('ms')) {
    return Number(lower.slice(0, -2));
  }
  if (lower.endsWith('s')) {
    return Number(lower.slice(0, -1)) * 1000;
  }
  if (lower.endsWith('m')) {
    return Number(lower.slice(0, -1)) * 60 * 1000;
  }
  const n = Number(lower);
  return n > 0 ? n : fallback;
}

function parseArgs(argv: string[]): CliOptions {
  const fast = argv.includes('--fast');
  const defaultDuration = fast ? 3000 : 10000;
  const defaultRuns = fast ? 1 : 3;

  function intFlag(name: string, fallback: number): number {
    const i = argv.indexOf(name);
    if (i >= 0 && argv[i + 1]) {
      const n = Number(argv[i + 1]);
      if (Number.isFinite(n) && n > 0) {
        return Math.floor(n);
      }
    }
    return fallback;
  }

  function stringFlag(name: string): string | undefined {
    const i = argv.indexOf(name);
    return i >= 0 && argv[i + 1] ? argv[i + 1] : undefined;
  }

  const rawLibs = stringFlag('--libs');
  const libraries = rawLibs
    ? rawLibs
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => list().includes(s))
    : list().filter((n) => ALL_LIBS.includes(n));

  const rawOnly = stringFlag('--only');
  const only = rawOnly
    ? rawOnly
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
    : undefined;

  const rawParallel = stringFlag('--parallel');
  const concurrency = rawParallel ? Number(rawParallel) : Math.max(1, (availableParallelism?.() ?? 4) - 1);

  return {
    fast,
    runs: intFlag('--runs', defaultRuns),
    duration: stringFlag('--duration') ? parseDurationMs(stringFlag('--duration'), defaultDuration) : defaultDuration,
    maxPayload: argv.includes('--max-payload'),
    only,
    libraries,
    concurrency,
    output: stringFlag('--output'),
  };
}

function warnIfEvenRuns(numRuns: number): number {
  if (numRuns >= 2 && numRuns % 2 === 0) {
    process.stderr.write(`[all-fcs] WARNING: --runs=${numRuns} is even; median is not uniquely defined. Prefer odd values.\n`);
  }
  return numRuns;
}

function pickMedianRun(runs: MacroBenchmarkResult[]): MacroBenchmarkResult & { opsValues: number[]; rsd: number } {
  const ops = runs.map((r) => r.opsPerSecond).sort((a, b) => a - b);

  const q1 = ops[Math.floor(ops.length * 0.25)] ?? ops[0];
  const q3 = ops[Math.floor(ops.length * 0.75)] ?? ops[ops.length - 1];
  const iqr = q3 - q1;
  const lo = q1 - iqr * 1.5;
  const hi = q3 + iqr * 1.5;
  const kept = runs.filter((r) => r.opsPerSecond >= lo && r.opsPerSecond <= hi);

  const sorted = (kept.length > 0 ? kept : runs).slice().sort((a, b) => a.opsPerSecond - b.opsPerSecond);
  const mid = Math.floor((sorted.length - 1) / 2);
  const median = sorted[mid] ?? sorted[0];

  const mean = ops.reduce((a, b) => a + b, 0) / ops.length;
  const variance = ops.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (ops.length - 1);
  const rsd = mean === 0 ? 0 : (Math.sqrt(variance) / mean) * 100;

  return { ...median, opsValues: ops, rsd };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  warnIfEvenRuns(options.runs);

  const fcs = options.only ? ALL_FCS.filter((s) => (options.only ?? []).some((o) => s.fc.includes(o))) : ALL_FCS;
  if (fcs.length === 0) {
    console.error(`No FCs match --only ${options.only?.join(',')}`);
    process.exit(1);
  }

  const libs = options.libraries.filter((lib) => ALL_LIBS.includes(lib));
  if (libs.length === 0) {
    console.error('No supported libraries selected');
    process.exit(1);
  }

  const tasks: ExecutionTask<Task, MacroBenchmarkResult>[] = [];
  for (const spec of fcs) {
    for (const library of libs) {
      if (!libSupports(library, spec.fc)) {
        continue;
      }
      const libIdx = ALL_LIBS.indexOf(library);
      for (let runIdx = 0; runIdx < options.runs; runIdx++) {
        const task: Task = {
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
            const workerPath = new URL('./workers/all-fcs-worker.ts', import.meta.url).pathname;
            return await runWorkerThread<
              { fc: string; library: string; port: number; durationMs: number; maxPayload: boolean },
              MacroBenchmarkResult
            >({
              modulePath: workerPath,
              workerData: {
                fc: t.spec.fc,
                library: t.library,
                port: t.port,
                durationMs: options.duration,
                maxPayload: options.maxPayload,
              },
              execArgv: getTsxExecArgv(),
            });
          },
        });
      }
    }
  }

  const results = await runTasks(tasks, { concurrency: options.concurrency });
  const byFcLib = new Map<string, Map<Library, MacroBenchmarkResult[]>>();

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const task = tasks[i].input;
    if (r.error || !r.output) {
      process.stderr.write(`[all-fcs] ${task.spec.fc}/${task.library} run ${task.runIdx} failed: ${r.error ?? 'unknown'}\n`);
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

  const outputFcs: AllFcsOutput['fcs'] = [];
  const summary: FcSummaryEntry[] = [];

  for (const spec of fcs) {
    const libMap = byFcLib.get(spec.fc);
    if (!libMap || libMap.size === 0) {
      continue;
    }

    const metrics: AllFcsOutput['fcs'][number]['metrics'] = {};
    for (const library of libs) {
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
      outputFcs.push({ fc: spec.fc, label: spec.label, metrics });
    }
  }

  const output: AllFcsOutput = { fcs: outputFcs, summary };
  const json = JSON.stringify(output, null, 2);
  if (options.output) {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(options.output, json);
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
