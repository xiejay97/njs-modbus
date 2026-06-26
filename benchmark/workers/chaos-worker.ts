/**
 * Generic chaos worker.
 *
 * Reads environment variables, resolves the library adapter, creates the
 * server, connects a raw transport handle, and runs the chaos scene through
 * {@link runChaosScene}.
 *
 * Forked as a child process (not a worker thread) so `process.cpuUsage()`
 * reports worker-local CPU.
 */

import { resolve } from '../adapters/registry';
import { buildCleanFrame, buildCleanFrameInto, buildScene, getValidator, parseFrameCountFor } from '../chaos';
import { runChaosScene } from '../chaos/runner';
import { connectSerialPort } from '../transport/serial';
import { connectRawTcpClient } from '../transport/tcp';

async function main(): Promise<void> {
  const library = process.env['CHAOS_BENCH_LIBRARY'];
  const protocol = process.env['CHAOS_BENCH_PROTOCOL'] as 'TCP' | 'RTU' | 'ASCII' | undefined;
  const sceneName = process.env['CHAOS_BENCH_SCENE'];
  const port = process.env['CHAOS_BENCH_PORT'] ? Number(process.env['CHAOS_BENCH_PORT']) : undefined;
  const masterPath = process.env['CHAOS_BENCH_MASTER_PATH'];
  const slavePath = process.env['CHAOS_BENCH_SLAVE_PATH'];
  const requestCount = process.env['CHAOS_BENCH_REQUESTS'] ? Number(process.env['CHAOS_BENCH_REQUESTS']) : 200;

  if (!library || !protocol || !sceneName) {
    throw new Error('Missing CHAOS_BENCH_LIBRARY, CHAOS_BENCH_PROTOCOL, or CHAOS_BENCH_SCENE');
  }

  const adapter = await resolve(library);
  const scene = buildScene(sceneName);

  let transport;
  let server;

  if (protocol === 'TCP') {
    if (port === undefined) {
      throw new Error('CHAOS_BENCH_PORT required for TCP');
    }
    server = await adapter.createTcpServer(port, { unitId: 1 });
    transport = await connectRawTcpClient(port, { host: '127.0.0.1' });
  } else {
    if (!masterPath || !slavePath) {
      throw new Error('CHAOS_BENCH_MASTER_PATH and CHAOS_BENCH_SLAVE_PATH required for serial');
    }
    server = await adapter.createSerialServer(slavePath, protocol, { unitId: 1 });
    transport = await connectSerialPort(masterPath, { baudRate: 115200 });
  }

  try {
    const result = await runChaosScene({
      name: library,
      sceneName,
      transport,
      chunks: scene.chunks,
      expectedFrameCount: scene.sentFrames.length,
      expectedCorrect: scene.expectedCorrect,
      expectedStrictCorrect: scene.expectedStrictCorrect,
      validate: (received) => getValidator(protocol)(scene.sentFrames, received),
      parseFrameCount: parseFrameCountFor(protocol),
      buildCleanFrame: (iteration) => buildCleanFrame(protocol, iteration),
      buildCleanFrameInto: (iteration, out) => buildCleanFrameInto(protocol, iteration, out),
      requestCount,
    });

    if (process.send) {
      process.send(result, () => process.exit(0));
    } else {
      console.log(JSON.stringify(result, null, 2));
      process.exit(0);
    }
  } finally {
    await transport.end().catch(() => {
      /* ignore */
    });
    await server.close().catch(() => {
      /* ignore */
    });
  }
}

main().catch((err) => {
  const message = err instanceof Error ? err.message : String(err);
  if (process.send) {
    process.send({ error: message }, () => process.exit(1));
  } else {
    console.error(message);
    process.exit(1);
  }
});
