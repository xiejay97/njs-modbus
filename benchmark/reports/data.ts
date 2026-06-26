/**
 * AI-facing markdown data dump.
 *
 * Companion to the human-readable presentation report. Designed for downstream
 * automated analysis (LLMs, scripts) — flat tables, lowercase snake_case
 * column names, no grouping/bolding/decoration, no descriptive prose. Carries
 * the chaos diagnostic fields the presentation layer does not render
 * (accuracy_pass, circuit_breaker_tripped, jitter_contaminated, expected_correct).
 */

import type { ReportContext } from './types';
import type { ChaosRunResult } from '../chaos/types';
import type { CodecBenchmarkResult } from '../codec/types';
import type { MacroBenchmarkResult } from '../macro';

type Cell = MacroBenchmarkResult | CodecBenchmarkResult;

function num(n: number | undefined | null, digits = 2): string {
  if (n === undefined || n === null || !Number.isFinite(n)) {
    return '';
  }
  return (Math.round(n * 10 ** digits) / 10 ** digits).toString();
}

/** ms → µs, fixed `digits` precision; empty cell when input is missing. */
function us(ms: number | undefined | null, digits = 2): string {
  return num(ms === undefined || ms === null ? null : ms * 1000, digits);
}

function gcNsPerOp(cell: Cell): string {
  if (!cell.gc || !cell.iterations) {
    return '';
  }
  return Math.round((cell.gc.totalDurationMs * 1e6) / cell.iterations).toString();
}

/** Strip `FC` prefix and zero-pad to two digits: `FC01 Read Coils` → `01`. */
function fcNumber(label: string): string {
  const m = /^FC0*(\d+)/i.exec(label);
  return m ? m[1].padStart(2, '0') : label;
}

function fcName(label: string): string {
  return label.replace(/^FC\d+\s*/i, '');
}

function renderHeader(context: ReportContext): string {
  const lines: string[] = [
    '# Benchmark Data',
    '',
    `generated: ${context.date}`,
    `duration_sec: ${context.durationSec}`,
    `runs: ${context.numRuns}`,
    `platform: ${context.sys.platform}`,
    `cpu: ${context.sys.cpu}`,
    `cores: ${context.sys.cores}`,
    `memory: ${context.sys.memory}`,
    `node: ${context.sys.nodeVersion}`,
    `v8: ${context.sys.v8Version}`,
    '',
    '## versions',
    '',
    '| library | version |',
    '|---|---|',
    `| njs-modbus | ${context.versions.own} |`,
  ];
  if (context.versions.jsmodbus) {
    lines.push(`| jsmodbus | ${context.versions.jsmodbus} |`);
  }
  if (context.versions.modbusSerial) {
    lines.push(`| modbus-serial | ${context.versions.modbusSerial} |`);
  }
  return lines.join('\n');
}

function renderCodec(context: ReportContext): string {
  if (!context.encodeDecode) {
    return '';
  }
  const lines = [
    '',
    '## codec',
    '',
    '| suite | library | ops | iterations | p50_us | p99_us | avg_us | cpu_us_per_op | gc_ns_per_op |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const { suite, metrics } of context.encodeDecode.suites) {
    for (const [library, cell] of Object.entries(metrics)) {
      lines.push(
        `| ${suite} | ${library} | ${cell.opsPerSecond} | ${cell.iterations} | ${us(cell.latency?.p50, 3)} | ${us(cell.latency?.p99, 3)} | ${us(cell.latency?.avg, 3)} | ${num(cell.cpu?.usPerOp)} | ${gcNsPerOp(cell)} |`,
      );
    }
  }
  return lines.join('\n');
}

function renderTransport(context: ReportContext): string {
  if (!context.transportSuite) {
    return '';
  }
  const { sequential, multiconn } = context.transportSuite;
  const lines = [
    '',
    '## transport',
    '',
    '| mode | depth | connections | transport | library | ops | p50_us | p99_us | avg_us | cpu_us_per_op | gc_ns_per_op |',
    '|---|---|---|---|---|---|---|---|---|---|---|',
  ];

  function pushCell(mode: string, depth: number | '', connections: number | '', transport: string, library: string, cell: Cell): void {
    lines.push(
      `| ${mode} | ${depth} | ${connections} | ${transport} | ${library} | ${cell.opsPerSecond} | ${us(cell.latency?.p50)} | ${us(cell.latency?.p99)} | ${us(cell.latency?.avg)} | ${num(cell.cpu?.usPerOp)} | ${gcNsPerOp(cell)} |`,
    );
  }

  for (const t of ['tcp', 'rtu', 'ascii'] as const) {
    for (const [library, cell] of Object.entries(sequential[t])) {
      pushCell('sequential', sequential.depth, '', t.toUpperCase(), library, cell);
    }
  }
  for (const [library, cell] of Object.entries(multiconn.tcp)) {
    pushCell('multiconn', '', multiconn.connections, 'TCP', library, cell);
  }
  return lines.join('\n');
}

function renderAllFcs(context: ReportContext): string {
  const all = [
    ['normal', context.allFcsNormal],
    ['max', context.allFcsMax],
  ] as const;
  if (!all.some(([, d]) => d)) {
    return '';
  }
  const lines = [
    '',
    '## all_fcs',
    '',
    '| payload | fc | fc_name | library | ops | p50_us | p99_us | cpu_us_per_op | gc_ns_per_op |',
    '|---|---|---|---|---|---|---|---|---|',
  ];
  for (const [payload, data] of all) {
    if (!data) {
      continue;
    }
    for (const e of data.summary) {
      lines.push(
        `| ${payload} | ${fcNumber(e.fc)} | ${fcName(e.fc)} | ${e.library} | ${e.opsPerSecond} | ${e.p50} | ${e.p99} | ${num(e.cpuUsPerOp)} | ${e.gcNsPerOp} |`,
      );
    }
  }
  return lines.join('\n');
}

function renderChaos(context: ReportContext): string {
  if (!context.chaos) {
    return '';
  }
  const lines = [
    '',
    '## chaos',
    '',
    '| protocol | scene | library | request_count | requests_completed | frames_sent | frames_correct | frames_extra | errors | expected_correct | accuracy_pass | circuit_breaker_tripped | jitter_contaminated | recovery_p99_us | max_cpu_us | net_heap_kb | cpu_us_per_op |',
    '|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|',
  ];
  for (const scene of context.chaos.scenes) {
    for (const [library, r] of Object.entries(scene.metrics) as [string, ChaosRunResult][]) {
      lines.push(
        `| ${scene.protocol} | ${scene.shortLabel} | ${library} | ${r.requestCount} | ${r.requestsCompleted} | ${r.framesSent} | ${r.framesCorrect} | ${r.framesExtra} | ${r.errors} | ${r.expectedCorrect} | ${r.accuracyPass} | ${r.circuitBreakerTripped} | ${r.jitterContaminated} | ${num(r.recoveryP99)} | ${num(r.maxCpuTimeUs, 0)} | ${num(r.netHeapGrowthKB)} | ${num(r.cpu?.usPerOp)} |`,
      );
    }
  }
  return lines.join('\n');
}

export function renderDataReport(context: ReportContext): string {
  return [renderHeader(context), renderCodec(context), renderTransport(context), renderAllFcs(context), renderChaos(context), ''].join(
    '\n',
  );
}
