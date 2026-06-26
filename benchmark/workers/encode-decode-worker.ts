/**
 * Encode-decode micro-benchmark worker.
 *
 * Reads suite/library/options from `workerData`, resolves the adapter, and runs
 * a single codec suite through {@link runCodecSuite}.
 */

import type { CodecRunOptions, CodecSuite } from '../codec/types';

import v8 from 'node:v8';
import { parentPort, workerData } from 'node:worker_threads';

import { resolve } from '../adapters/registry';
import { runCodecSuite } from '../codec/runner';

// Expose global.gc() inside this worker thread so the codec runner can force
// GC before measurement. Worker threads do not inherit --expose-gc from execArgv.
v8.setFlagsFromString('--expose_gc');

interface EncodeDecodeWorkerData {
  suite: CodecSuite;
  library: string;
  microOpts?: CodecRunOptions;
}

async function main(): Promise<void> {
  const { suite, library, microOpts } = workerData as EncodeDecodeWorkerData;
  const adapter = await resolve(library);
  const result = runCodecSuite(suite, adapter, microOpts);

  if (parentPort) {
    parentPort.postMessage({ result });
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (parentPort) {
    parentPort.postMessage({ error: message });
  } else {
    console.error(message);
    process.exit(1);
  }
});
