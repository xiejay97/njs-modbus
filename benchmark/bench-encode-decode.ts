/**
 * Standalone encode-decode micro-benchmark entry point.
 *
 * Runs all codec suites for the requested libraries and prints a JSON report
 * to stdout.
 */

import type { CodecSuite } from './codec/types';

import { writeFileSync } from 'node:fs';

import { runEncodeDecode } from './reports/coordinator';

interface CliOptions {
  fast: boolean;
  runs: number | undefined;
  libraries: string[] | undefined;
  suites: CodecSuite[] | undefined;
  concurrency: number | undefined;
  output: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    fast: false,
    runs: undefined,
    libraries: undefined,
    suites: undefined,
    concurrency: undefined,
    output: undefined,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--fast') {
      options.fast = true;
    } else if (arg === '--runs' && i + 1 < argv.length) {
      options.runs = Number(argv[++i]);
    } else if (arg === '--libraries' && i + 1 < argv.length) {
      options.libraries = argv[++i].split(',');
    } else if (arg === '--suites' && i + 1 < argv.length) {
      options.suites = argv[++i].split(',') as CodecSuite[];
    } else if (arg === '--concurrency' && i + 1 < argv.length) {
      options.concurrency = Number(argv[++i]);
    } else if (arg === '--output' && i + 1 < argv.length) {
      options.output = argv[++i];
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runEncodeDecode({
    fast: options.fast,
    runs: options.runs,
    libraries: options.libraries,
    suites: options.suites,
    concurrency: options.concurrency,
  });

  const json = JSON.stringify(report, null, 2);
  if (options.output) {
    writeFileSync(options.output, json);
  } else {
    console.log(json);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
