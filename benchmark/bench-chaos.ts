/**
 * Standalone chaos benchmark entry point.
 *
 * Runs all chaos scenes (or a filtered protocol) for the requested libraries
 * and prints a JSON report to stdout.
 */

import { writeFileSync } from 'node:fs';

import { runChaos } from './reports/coordinator';

interface CliOptions {
  fast: boolean;
  runs: number | undefined;
  libraries: string[] | undefined;
  concurrency: number | undefined;
  protocol: 'TCP' | 'RTU' | 'ASCII' | undefined;
  output: string | undefined;
}

function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {
    fast: false,
    runs: undefined,
    libraries: undefined,
    concurrency: undefined,
    protocol: undefined,
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
    } else if (arg === '--concurrency' && i + 1 < argv.length) {
      options.concurrency = Number(argv[++i]);
    } else if (arg === '--protocol' && i + 1 < argv.length) {
      const p = argv[++i].toUpperCase();
      if (p === 'TCP' || p === 'RTU' || p === 'ASCII') {
        options.protocol = p;
      }
    } else if (arg === '--output' && i + 1 < argv.length) {
      options.output = argv[++i];
    }
  }
  return options;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  const report = await runChaos({
    fast: options.fast,
    runs: options.runs,
    libraries: options.libraries,
    concurrency: options.concurrency,
  });

  if (options.protocol) {
    report.scenes = report.scenes.filter((s) => s.protocol === options.protocol);
  }

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
