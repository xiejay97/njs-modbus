/**
 * Transport throughput suite entry point.
 *
 * Compares registered Modbus libraries on FC03 readHoldingRegisters across:
 *   - modes: sequential, multiconn
 *   - transports: TCP, RTU, ASCII
 *
 * Each (mode, transport, library) cell runs in its own forked child process
 * because @serialport/bindings-cpp is incompatible with worker threads.
 */

import type { ExecutionTask } from './engine/types';
import type { MacroBenchmarkResult } from './macro';
import type { TransportSuiteOutput } from './reports/types';

import { availableParallelism } from 'node:os';

import { list, resolve as resolveAdapter } from './adapters/registry';
import { runForkedChild } from './engine/process-fork';
import { runTasks } from './engine/task-scheduler';
import { getTsxExecArgv } from './engine/tsx';
import { closePtyPair, spawnPtyPair } from './transport/serial';

interface CliOptions {
  fast: boolean;
  runs: number;
  duration: number;
  connections: number;
  libraries: string[];
  concurrency: number;
  output: string | undefined;
}

type Mode = 'sequential' | 'multiconn';
type Transport = 'tcp' | 'rtu' | 'ascii';
type Library = string;

interface Cell {
  mode: Mode;
  transport: Transport;
  library: Library;
  label: string;
}

interface Task {
  cell: Cell;
  port: number;
  runIdx: number;
}

const MODES: Mode[] = ['sequential', 'multiconn'];
const TRANSPORTS: Transport[] = ['tcp', 'rtu', 'ascii'];

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
  const defaultDuration = fast ? 8000 : 30000;
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
    : list();

  const rawParallel = stringFlag('--parallel');
  const concurrency = rawParallel ? Number(rawParallel) : Math.max(1, (availableParallelism?.() ?? 4) - 1);

  return {
    fast,
    runs: intFlag('--runs', defaultRuns),
    duration: stringFlag('--duration') ? parseDurationMs(stringFlag('--duration'), defaultDuration) : defaultDuration,
    connections: intFlag('--connections', 8),
    libraries,
    concurrency,
    output: stringFlag('--output'),
  };
}

function warnIfEvenRuns(numRuns: number): number {
  if (numRuns >= 2 && numRuns % 2 === 0) {
    process.stderr.write(`[transport-suite] WARNING: --runs=${numRuns} is even; median is not uniquely defined. Prefer odd values.\n`);
  }
  return numRuns;
}

function isSupported(cell: { mode: Mode; transport: Transport; library: Library }): boolean {
  // RTU/ASCII cannot host independent masters.
  if (cell.mode === 'multiconn' && cell.transport !== 'tcp') {
    return false;
  }
  // jsmodbus has no ASCII server.
  if (cell.library === 'jsmodbus' && cell.transport === 'ascii') {
    return false;
  }
  // modbus-serial ASCII over socat PTY times out in this harness.
  if (cell.library === 'modbus-serial' && cell.transport === 'ascii') {
    return false;
  }
  return true;
}

function buildCells(libraries: Library[]): Cell[] {
  const cells: Cell[] = [];
  for (const mode of MODES) {
    for (const transport of TRANSPORTS) {
      for (const library of libraries) {
        if (!isSupported({ mode, transport, library })) {
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

async function tryResolveAdapter(name: string): Promise<boolean> {
  try {
    await resolveAdapter(name);
    return true;
  } catch {
    return false;
  }
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

let durationMs = 30000;
let connections = 8;

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  durationMs = options.duration;
  connections = options.connections;

  const resolvedLibraries: string[] = [];
  for (const name of options.libraries) {
    if (await tryResolveAdapter(name)) {
      resolvedLibraries.push(name);
    }
  }

  if (resolvedLibraries.length === 0) {
    console.error('No libraries available');
    process.exit(1);
  }

  warnIfEvenRuns(options.runs);

  const cells = buildCells(resolvedLibraries);
  const tasks: ExecutionTask<Task, MacroBenchmarkResult>[] = [];
  let nextPort = 25000 + (Date.now() % 10000);
  for (const cell of cells) {
    for (let runIdx = 0; runIdx < options.runs; runIdx++) {
      const task: Task = {
        cell,
        port: cell.transport === 'tcp' ? nextPort++ : 0,
        runIdx,
      };
      tasks.push({
        id: `transport-${cell.label}-${runIdx}`,
        input: task,
        execute: async (t): Promise<MacroBenchmarkResult> => {
          const { cell: c, port: p, runIdx: r } = t;
          const env: Record<string, string> = {
            TRANSPORT_BENCH_MODE: c.mode,
            TRANSPORT_BENCH_TRANSPORT: c.transport,
            TRANSPORT_BENCH_LIBRARY: c.library,
            TRANSPORT_BENCH_DURATION: String(durationMs),
            TRANSPORT_BENCH_CONNECTIONS: String(connections),
            TRANSPORT_BENCH_PORT: String(p),
            TRANSPORT_BENCH_LABEL: `${c.label}-run${r}`,
          };

          let pty: Awaited<ReturnType<typeof spawnPtyPair>> | null = null;
          try {
            if (c.transport !== 'tcp') {
              pty = await spawnPtyPair();
              env['TRANSPORT_BENCH_MASTER_PATH'] = pty.masterPath;
              env['TRANSPORT_BENCH_SLAVE_PATH'] = pty.slavePath;
            }

            const workerPath = new URL('./workers/transport-suite-worker.ts', import.meta.url).pathname;
            return await runForkedChild<MacroBenchmarkResult>({
              modulePath: workerPath,
              env,
              execArgv: getTsxExecArgv(['--expose-gc']),
            });
          } finally {
            if (pty) {
              closePtyPair(pty);
            }
          }
        },
      });
    }
  }

  const results = await runTasks(tasks, { concurrency: options.concurrency });
  const byLabel = new Map<string, MacroBenchmarkResult[]>();
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const task = tasks[i].input;
    if (r.error || !r.output) {
      process.stderr.write(`[transport-suite] ${task.cell.label} run ${task.runIdx} task failed: ${r.error ?? 'unknown'}\n`);
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

  function buildMetrics(mode: Mode, transport: Transport): Record<Library, MacroBenchmarkResult> {
    const metrics: Record<Library, MacroBenchmarkResult> = {};
    for (const library of resolvedLibraries) {
      if (!isSupported({ mode, transport, library })) {
        continue;
      }
      metrics[library] = pickResultFor(`${mode}/${transport}/${library}`);
    }
    return metrics;
  }

  const output: TransportSuiteOutput = {
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
