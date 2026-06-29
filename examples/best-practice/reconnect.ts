/**
 * Focused reconnection example for a Modbus TCP master.
 *
 * Why this example exists:
 * `njs-modbus` intentionally does NOT provide a built-in auto-reconnect policy.
 * Reconnection is an application concern: different deployments need different
 * backoff strategies, retry budgets, circuit breakers, logging, and shutdown
 * behavior. This file shows one robust, production-oriented pattern you can
 * adapt to your own needs.
 *
 * Demonstrates:
 * - Exponential backoff with full jitter and a fixed upper cap.
 * - A retry budget so a permanently unreachable peer eventually gives up.
 * - Clean separation between "open the wire" and "create the master".
 * - Recreating the {@link ModbusMaster} on every successful connection.
 * - A polling loop that pauses while disconnected and resumes after reconnect.
 * - Graceful shutdown that cancels pending reconnect timers and closes the wire.
 *
 * Run with the best-practice slave running:
 *   pnpm --filter njs-modbus-best-practice server
 *   pnpm --filter njs-modbus-best-practice reconnect
 */

import { ModbusMaster, TcpClientPhysicalLayer } from 'njs-modbus';

import { sharedAuthorizer } from './src/authorizer';
import { MASTER_QUEUE_STRATEGY, MASTER_TIMEOUT_MS, TCP_ENDPOINT, UNITS } from './src/config';

/** Initial reconnect delay (ms). */
const INITIAL_RECONNECT_MS = 500;
/** Maximum reconnect delay (ms). */
const MAX_RECONNECT_MS = 8000;
/** Maximum consecutive reconnect attempts before giving up. */
const MAX_RECONNECT_ATTEMPTS = 20;
/** Interval between polled reads while connected (ms). */
const POLL_INTERVAL_MS = 2000;

const physical = new TcpClientPhysicalLayer();

let master: ModbusMaster<'TCP'> | null = null;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let shutdownRequested = false;
let reconnectAttempts = 0;

/**
 * Open the TCP connection. If it fails, schedule a reconnect. If it succeeds,
 * the `physical.on('connect', ...)` handler creates the master and starts polling.
 */
function connect(): void {
  if (shutdownRequested) {
    return;
  }

  physical.open({ host: TCP_ENDPOINT.host, port: TCP_ENDPOINT.port }, (err) => {
    if (err) {
      console.error('[reconnect] open failed:', err.message);
      scheduleReconnect();
      return;
    }
    // The 'connect' event (below) is where the pipeline is handed to us.
  });
}

physical.on('connect', (pipeline) => {
  // A fresh connection is a fresh protocol context. Always create a new master
  // instead of reusing an old one; the old master's queue, timers, and listeners
  // belong to the previous pipeline.
  master = new ModbusMaster({
    pipelineAdapter: pipeline,
    protocol: { type: 'TCP' },
    queueStrategy: MASTER_QUEUE_STRATEGY,
    timeout: MASTER_TIMEOUT_MS,
  });
  master.setAccessAuthorizer(sharedAuthorizer);

  // Reset the reconnect budget: we are now successfully connected.
  reconnectAttempts = 0;
  console.log(`[reconnect] connected to ${TCP_ENDPOINT.host}:${TCP_ENDPOINT.port}`);

  // Start reading from the slave. In a real application this loop might be
  // driven by an external scheduler; here it is a simple repeating poll.
  schedulePoll();

  // When the socket closes, tear down the master and start reconnecting.
  pipeline.once('close', () => {
    console.log('[reconnect] connection closed');
    stopPoll();
    master?.destroy();
    master = null;
    scheduleReconnect();
  });
});

physical.on('error', (err) => {
  // Non-fatal transport errors are logged; the close event drives reconnect logic.
  console.error('[reconnect] physical layer error:', err.message);
});

/**
 * Schedule the next reconnect attempt with capped exponential backoff plus jitter.
 *
 * Backoff formula: delay = min(MAX_RECONNECT_MS, INITIAL_RECONNECT_MS * 2^attempt) * (0.5 + random/2)
 * The jitter prevents a thundering-herd when a whole fleet of clients loses the
 * same server and all retries at the same instant.
 */
function scheduleReconnect(): void {
  if (shutdownRequested || reconnectTimer || reconnectAttempts >= MAX_RECONNECT_ATTEMPTS) {
    if (reconnectAttempts >= MAX_RECONNECT_ATTEMPTS && !shutdownRequested) {
      console.error(`[reconnect] gave up after ${MAX_RECONNECT_ATTEMPTS} attempts`);
      stop();
    }
    return;
  }

  reconnectAttempts += 1;
  const base = Math.min(INITIAL_RECONNECT_MS * 2 ** (reconnectAttempts - 1), MAX_RECONNECT_MS);
  const jitter = 0.5 + Math.random() / 2;
  const delay = Math.round(base * jitter);

  console.log(`[reconnect] attempt ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${delay}ms...`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, delay);
}

/**
 * Schedule the next polled read. The loop cancels itself automatically when the
 * master is destroyed (e.g. on disconnect), so there is no risk of firing
 * requests into a dead pipeline.
 */
function schedulePoll(): void {
  if (shutdownRequested || pollTimer || !master) {
    return;
  }

  pollTimer = setTimeout(async () => {
    pollTimer = null;

    if (!master) {
      // Disconnected while this tick was queued; the reconnect loop will take over.
      return;
    }

    try {
      const response = await master.readHoldingRegisters(UNITS.PROCESS, 0, 5);
      console.log('[reconnect] polled registers 0..4:', response.data);
    } catch (err) {
      console.error('[reconnect] poll failed:', (err as Error).message);
      // A single failed poll does not trigger reconnect; wait for the pipeline
      // 'close' event, which is the authoritative signal that the wire is gone.
    }

    schedulePoll();
  }, POLL_INTERVAL_MS);
}

/**
 * Cancel the polling loop. Called on disconnect and shutdown.
 */
function stopPoll(): void {
  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }
}

/**
 * Graceful shutdown: stop polling, cancel pending reconnects, destroy the
 * active master, and close the physical layer.
 */
function stop(): void {
  if (shutdownRequested) {
    return;
  }
  shutdownRequested = true;

  stopPoll();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  master?.destroy();
  master = null;

  physical.close((err) => {
    if (err) {
      console.error('[reconnect] close error:', err.message);
    }
    console.log('[reconnect] stopped');
    process.exit(0);
  });
}

process.on('SIGINT', () => {
  console.log('\n[reconnect] shutdown requested');
  stop();
});

// Kick off the first connection attempt.
connect();
