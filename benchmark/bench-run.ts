/**
 * Unified benchmark runner.
 *
 * Runs one or more benchmark suites by name and prints the aggregated JSON
 * result to stdout. With `--report`, it instead builds a full `ReportContext`
 * and writes the presentation Markdown report.
 *
 * Examples:
 *   tsx benchmark/bench-run.ts --all-fcs --fast --runs 1
 *   tsx benchmark/bench-run.ts --transport --all-fcs --report
 *   tsx benchmark/bench-run.ts --all --fast --runs 1 --max-payload
 */

import type { CodecSuite } from './codec/types';
import type { AllFcsOutput, ChaosReport, EncodeDecodeReport, ReportContext, TransportSuiteOutput } from './reports/types';

import { writeFileSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { arch, cpus, totalmem, type } from 'node:os';
import { resolve } from 'node:path';
import process from 'node:process'; // 🚀 显式引入 Node 原生进程模块

import { runAllFcs, runChaos, runEncodeDecode, runReport, runTransportSuite } from './reports';
import { renderDataReport } from './reports/data';
import { renderPresentationReport } from './reports/presentation';

import { NJS_MODBUS_VERSION } from '#njs-modbus';

const require = createRequire(import.meta.url);

const isDistMode =
  process.env['NODE_OPTIONS']?.includes('conditions=dist') || process.execArgv.some((arg) => arg.includes('conditions=dist'));
const targetTarget = isDistMode ? '📦 PRODUCTION (Compiled Dist Mode)' : '🧪 DEVELOPMENT (Workspace Source Mode)';
console.log('='.repeat(80));
console.log(`                 🔥 NJS-MODBUS CHAOS BENCHMARK ENGINE 🔥                 `);
console.log('='.repeat(80));

console.log(`[TARGET RUNTIME] : ${targetTarget}`);
console.log(`[DRIVER VERSION] : v${NJS_MODBUS_VERSION}`);
console.log(`[NODE RUNTIME]   : Node ${process.version} (V8 Engine: ${process.versions.v8})`);
console.log(`[HOST HARDWARE]  : ${type()} ${arch()} | CPU: ${cpus().length} Cores`);

interface CliOptions {
  fast: boolean;
  runs: number | undefined;
  libraries: string[] | undefined;
  codecSuites: CodecSuite[] | undefined;
  concurrency: number | undefined;
  maxPayload: boolean;
  durationMs: number | undefined;
  chaosRequests: number | undefined;
  suites: {
    encodeDecode: boolean;
    transport: boolean;
    allFcs: boolean;
    allFcsMax: boolean;
    chaos: boolean;
  };
  report: boolean;
  output: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    fast: false,
    runs: undefined,
    libraries: undefined,
    codecSuites: undefined,
    concurrency: undefined,
    maxPayload: false,
    durationMs: undefined,
    chaosRequests: undefined,
    suites: {
      encodeDecode: false,
      transport: false,
      allFcs: false,
      allFcsMax: false,
      chaos: false,
    },
    report: false,
    output: undefined,
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    switch (arg) {
      case '--all':
        options.suites.encodeDecode = true;
        options.suites.transport = true;
        options.suites.allFcs = true;
        options.suites.allFcsMax = true;
        options.suites.chaos = true;
        break;
      case '--encode-decode':
      case '--codec':
        options.suites.encodeDecode = true;
        break;
      case '--transport':
      case '--transport-suite':
        options.suites.transport = true;
        break;
      case '--all-fcs':
        options.suites.allFcs = true;
        break;
      case '--all-fcs-max':
        options.suites.allFcsMax = true;
        break;
      case '--chaos':
        options.suites.chaos = true;
        break;
      case '--fast':
        options.fast = true;
        break;
      case '--max-payload':
        options.maxPayload = true;
        break;
      case '--report':
        options.report = true;
        break;
      case '--runs':
        if (i + 1 < argv.length) {
          options.runs = Number(argv[++i]);
        }
        break;
      case '--duration':
      case '--duration-sec':
        if (i + 1 < argv.length) {
          options.durationMs = Number(argv[++i]) * 1000;
        }
        break;
      case '--duration-ms':
        if (i + 1 < argv.length) {
          options.durationMs = Number(argv[++i]);
        }
        break;
      case '--chaos-requests':
        if (i + 1 < argv.length) {
          options.chaosRequests = Number(argv[++i]);
        }
        break;
      case '--libraries':
      case '--libs':
        if (i + 1 < argv.length) {
          options.libraries = argv[++i]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean);
        }
        break;
      case '--suites':
        if (i + 1 < argv.length) {
          options.codecSuites = argv[++i]
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean) as CodecSuite[];
        }
        break;
      case '--concurrency':
      case '--parallel':
        if (i + 1 < argv.length) {
          options.concurrency = Number(argv[++i]);
        }
        break;
      case '--output':
      case '-o':
        if (i + 1 < argv.length) {
          options.output = argv[++i];
        }
        break;
      case '--help':
      case '-h':
        printUsage();
        process.exit(0);
        break;
      default:
        break;
    }
  }

  return options;
}

function printUsage(): void {
  console.log(
    `
Usage: tsx benchmark/bench-run.ts [options] [--suite ...]

Benchmark suites:
  --all              Run all suites (equivalent to --encode-decode --transport
                     --all-fcs --all-fcs-max --chaos)
  --encode-decode    Run the encode/decode micro-benchmark
  --transport        Run the transport suite
  --all-fcs          Run all function codes (normal payload)
  --all-fcs-max      Run all function codes (max payload)
  --chaos            Run the chaos scenes

Common options:
  --fast             Short durations and single run defaults
  --runs N           Number of repeated runs per test point
  --duration N       Per-test wall-clock duration in seconds (transport + all-fcs)
  --chaos-requests N Iteration count per (chaos scene, library) pair
  --libraries A,B,C  Comma-separated library subset
  --suites A,B,C     Comma-separated codec suite subset (e.g. asciiResDecode,tcpReqEncode)
  --concurrency N    Maximum concurrent benchmark tasks
  --max-payload      Include max-payload variant when running --all or report
  --report           Build and write Markdown report instead of JSON stdout
  --output PATH      Write JSON/Markdown to PATH instead of stdout/default
  -h, --help         Show this help
`.trim(),
  );
}

function buildReportOptions(options: CliOptions): {
  fast?: boolean;
  runs?: number;
  libraries?: string[];
  suites?: CodecSuite[];
  concurrency?: number;
  maxPayload?: boolean;
  durationMs?: number;
  chaosRequests?: number;
} {
  return {
    fast: options.fast || undefined,
    runs: options.runs,
    libraries: options.libraries,
    suites: options.codecSuites,
    concurrency: options.concurrency,
    maxPayload: options.maxPayload || undefined,
    durationMs: options.durationMs,
    chaosRequests: options.chaosRequests,
  };
}

function getSystemInfo(): ReportContext['sys'] {
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

function formatSelectedSuites(suites: CliOptions['suites']): string {
  const suiteLabels: Record<keyof CliOptions['suites'], string> = {
    encodeDecode: 'encode-decode',
    transport: 'transport',
    allFcs: 'all-fcs',
    allFcsMax: 'all-fcs-max',
    chaos: 'chaos',
  };

  const selected = (Object.entries(suiteLabels) as [keyof CliOptions['suites'], string][])
    .filter(([key]) => suites[key])
    .map(([, label]) => label);

  if (selected.length === Object.keys(suiteLabels).length) {
    return `ALL STRATEGIES MIXED (${selected.join(', ')})`;
  }
  return `SPECIFIC (${selected.join(', ') || 'none'})`;
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) {
    return 'default';
  }
  return `${durationMs / 1000}s`;
}

async function runStep<T>(label: string, shouldRun: boolean, runner: () => Promise<T>): Promise<T | null> {
  if (!shouldRun) {
    return null;
  }

  console.log(`▶ Running ${label}...`);
  const stepStart = process.hrtime.bigint();
  const result = await runner();
  const elapsedSec = Number(process.hrtime.bigint() - stepStart) / 1e9;
  console.log(`  ✓ ${label} completed in ${elapsedSec.toFixed(2)}s`);
  return result;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const selected = Object.values(options.suites).some(Boolean);

  if (!selected && !options.report) {
    console.error('No benchmark suite selected. Use --all or one of --encode-decode/--transport/--all-fcs/--all-fcs-max/--chaos.');
    printUsage();
    process.exit(1);
  }

  console.log('-'.repeat(80));
  console.log(`[STRATEGY MODE]  : ${formatSelectedSuites(options.suites)}`);
  console.log(`[CHAOS MATRIX]   : Total ${options.chaosRequests ?? 'default'} Chaos Requests Injected`);
  console.log(`[BURST CAPACITY] : Max Payload Size Locked (${options.maxPayload ? 'ENABLED' : 'DISABLED'})`);
  console.log(
    `[TIMING LIMIT]   : ${options.runs ?? (options.fast ? 1 : 3)} Rounds x ${formatDuration(options.durationMs)} Duration per case`,
  );
  console.log('='.repeat(80));

  const reportOptions = buildReportOptions(options);
  const startNs = process.hrtime.bigint();

  // If the user just wants a full report, delegate to runReport.
  if (options.report && !selected) {
    console.log('▶ Generating full report...');
    const stepStart = process.hrtime.bigint();
    const context = await runReport(reportOptions);
    const md = renderPresentationReport(context);
    const outputPath = options.output ?? resolve(process.cwd(), 'benchmark', 'report_presentation.md');
    writeFileSync(outputPath, md);
    console.log(`  Report written to ${outputPath}`);
    if (!options.output) {
      const dataPath = resolve(process.cwd(), 'benchmark', 'report_data.md');
      writeFileSync(dataPath, renderDataReport(context));
      console.log(`  Data report written to ${dataPath}`);
    }
    const elapsedSec = Number(process.hrtime.bigint() - stepStart) / 1e9;
    console.log(`  ✓ Full report completed in ${elapsedSec.toFixed(2)}s`);
    return;
  }

  // Run selected suites sequentially to avoid port collisions between suites.
  const results: {
    encodeDecode?: EncodeDecodeReport | null;
    transportSuite?: TransportSuiteOutput | null;
    allFcsNormal?: AllFcsOutput | null;
    allFcsMax?: AllFcsOutput | null;
    chaos?: ChaosReport | null;
  } = {};

  results.encodeDecode = await runStep('encode-decode benchmark', options.suites.encodeDecode, () => runEncodeDecode(reportOptions));
  results.transportSuite = await runStep('transport suite', options.suites.transport, () => runTransportSuite(reportOptions));
  results.allFcsNormal = await runStep('all-fcs benchmark (normal payload)', options.suites.allFcs, () => runAllFcs(false, reportOptions));
  results.allFcsMax = await runStep('all-fcs benchmark (max payload)', options.suites.allFcsMax, () => runAllFcs(true, reportOptions));
  results.chaos = await runStep('chaos benchmark', options.suites.chaos, () => runChaos(reportOptions));

  if (options.report) {
    console.log('▶ Building report from results...');
    const stepStart = process.hrtime.bigint();
    const context: ReportContext = {
      date: new Date().toISOString(),
      durationSec: Math.round(Number(process.hrtime.bigint() - startNs) / 1e9),
      numRuns: options.runs ?? (options.fast ? 1 : 3),
      sys: getSystemInfo(),
      versions: {
        own: getOwnVersion(),
        jsmodbus: getDependencyVersion('jsmodbus'),
        modbusSerial: getDependencyVersion('modbus-serial'),
      },
      encodeDecode: results.encodeDecode ?? null,
      transportSuite: results.transportSuite ?? null,
      allFcsNormal: results.allFcsNormal ?? null,
      allFcsMax: results.allFcsMax ?? null,
      chaos: results.chaos ?? null,
    };
    const md = renderPresentationReport(context);
    const outputPath = options.output ?? resolve(process.cwd(), 'benchmark', 'report_presentation.md');
    writeFileSync(outputPath, md);
    console.log(`  Report written to ${outputPath}`);
    if (!options.output) {
      const dataPath = resolve(process.cwd(), 'benchmark', 'report_data.md');
      writeFileSync(dataPath, renderDataReport(context));
      console.log(`  Data report written to ${dataPath}`);
    }
    const elapsedSec = Number(process.hrtime.bigint() - stepStart) / 1e9;
    console.log(`  ✓ Report building completed in ${elapsedSec.toFixed(2)}s`);
    return;
  }

  console.log('▶ Writing JSON results...');
  const json = JSON.stringify(results, null, 2);
  if (options.output) {
    writeFileSync(options.output, json);
    console.log(`  ✓ JSON results written to ${options.output}`);
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
