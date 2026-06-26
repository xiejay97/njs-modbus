import type { AbstractPipelineAdapter, AbstractPipelineAdapterEvents } from 'njs-modbus';

import EventEmitter from 'node:events';

/**
 * In-memory {@link AbstractPipelineAdapter} for unit tests.
 *
 * Records every byte written via {@link written} and can inject received bytes
 * back through the `data` event so the protocol layer decodes them.
 */
export class MockPipelineAdapter extends EventEmitter<AbstractPipelineAdapterEvents> implements AbstractPipelineAdapter {
  /** All encoded frames passed to {@link write}. */
  public readonly written: Buffer[] = [];

  /** `true` after {@link destroy} has been called. */
  public destroyed = false;

  write(data: Buffer, cb?: (err: Error | null) => void): void {
    this.written.push(Buffer.from(data));
    cb?.(null);
  }

  /** Simulate receiving raw bytes from the wire. */
  emitData(data: Buffer): void {
    this.emit('data', data);
  }

  /** Mark the adapter as destroyed (does not emit `close`). */
  destroy(): void {
    this.destroyed = true;
  }
}
