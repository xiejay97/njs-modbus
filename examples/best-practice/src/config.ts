/**
 * Shared configuration for the best-practice Modbus TCP example.
 *
 * Centralizing addresses, ranges, and policy limits makes the master and slave
 * stay in sync and gives operators a single place to tune the demo.
 */

/** TCP endpoint used by both the master and the slave in this example. */
export const TCP_ENDPOINT = {
  host: '127.0.0.1',
  port: 1502,
} as const;

/** Units exposed by the slave and expected by the master. */
export const UNITS = {
  /**
   * Process unit: holding registers for setpoints, coils for discrete outputs,
   * and discrete inputs for status bits.
   */
  PROCESS: 1,
  /**
   * Sensor unit: read-only input registers for measurements and coils for
   * alarm flags.
   */
  SENSOR: 2,
} as const;

/** Allowed unit addresses. Used by both sides as a whitelist. */
export const ALLOWED_UNITS = new Set<number>([UNITS.PROCESS, UNITS.SENSOR]);

/** Table address ranges enforced by the access authorizer (inclusive). */
export const ADDRESS_RANGES = {
  coils: { start: 0, end: 127 },
  discreteInputs: { start: 0, end: 127 },
  inputRegisters: { start: 0, end: 99 },
  holdingRegisters: { start: 0, end: 99 },
} as const;

/** Per-request timeout for the master (unit: ms). */
export const MASTER_TIMEOUT_MS = 2000;

/**
 * Queue strategy for the master.
 *
 * `'concurrent'` is safe on Modbus TCP because MBAP transaction ids let the
 * master match responses to requests. It is intentionally NOT used on the
 * slave in this example so inbound requests are processed one at a time and
 * the in-memory model never observes overlapping writes.
 */
export const MASTER_QUEUE_STRATEGY = 'concurrent' as const;

/**
 * Queue strategy for the slave.
 *
 * `'drop-stale'` keeps only the latest request when the queue backs up, which
 * is appropriate for a slow sensor/PLC workload where stale readings are not
 * useful.
 */
export const SLAVE_QUEUE_STRATEGY = 'drop-stale' as const;

/**
 * Default register values used to seed the in-memory slave model so the master
 * can read meaningful data immediately after connecting.
 */
export const DEFAULT_HOLDING_REGISTERS: number[] = Array.from({ length: ADDRESS_RANGES.holdingRegisters.end + 1 }, (_, i) => i);
export const DEFAULT_INPUT_REGISTERS: number[] = Array.from({ length: ADDRESS_RANGES.inputRegisters.end + 1 }, (_, i) => (i + 1) * 10);
