/**
 * Benchmark report entry point.
 *
 * Orchestrates codec and chaos benchmarks via the execution engine, then writes
 * the presentation Markdown report to `benchmark/report_presentation.md`.
 */

import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { runReport, renderPresentationReport } from './reports';

interface CliOptions {
  fast: boolean;
  runs: number | undefined;
  maxPayload: boolean;
  dumpJson: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = { fast: false, runs: undefined, maxPayload: false, dumpJson: undefined };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fast') {
      options.fast = true;
    } else if (arg === '--runs' && i + 1 < argv.length) {
      options.runs = Number(argv[++i]);
    } else if (arg === '--max-payload') {
      options.maxPayload = true;
    } else if (arg === '--dump-json' && i + 1 < argv.length) {
      options.dumpJson = argv[++i];
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const reportOptions = {
    fast: options.fast,
    runs: options.runs,
    maxPayload: options.maxPayload,
  };

  const context = await runReport(reportOptions);

  if (options.dumpJson) {
    writeFileSync(options.dumpJson, JSON.stringify(context, null, 2));
  }

  const md = renderPresentationReport(context);
  const outputPath = resolve(process.cwd(), 'benchmark', 'report_presentation.md');
  writeFileSync(outputPath, md);

  console.log(`Report written to ${outputPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
