import type { AbstractPhysicalLayer } from 'njs-modbus';
import type { WebSocket } from 'ws';

import { AbstractPipelineLayer, PipelineLayerState } from 'njs-modbus';

/**
 * WebSocket pipeline layer backed by a `ws` `WebSocket`.
 *
 * Forwards binary `message` events as `data` and emits `tx` after a successful
 * `ws.send`. Each WebSocket message is treated as one complete Modbus ADU
 * because WebSocket preserves message boundaries.
 */
export class WebSocketPipelineLayer extends AbstractPipelineLayer {
  private _state: PipelineLayerState = PipelineLayerState.CONNECTED;
  private _physicalLayer: AbstractPhysicalLayer;
  private _ws: WebSocket;

  private _pendingDestroyCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _cleanupFns = new Set<() => void>();

  /** Current lifecycle state of this pipeline. */
  get state(): PipelineLayerState {
    return this._state;
  }

  /** Parent physical layer that created this pipeline. */
  get physicalLayer(): AbstractPhysicalLayer {
    return this._physicalLayer;
  }

  /** Underlying `WebSocket` instance. */
  get ws(): WebSocket {
    return this._ws;
  }

  /**
   * @param physicalLayer Parent physical layer.
   * @param ws Connected `WebSocket` instance.
   */
  constructor(physicalLayer: AbstractPhysicalLayer, ws: WebSocket) {
    super();

    this._physicalLayer = physicalLayer;
    this._ws = ws;

    const onMessage = (data: WebSocket.RawData) => {
      if (this.state !== PipelineLayerState.CONNECTED) {
        return;
      }
      // `ws` may emit Buffer, ArrayBufferView, or ArrayBuffer depending on options.
      const buffer = Buffer.isBuffer(data)
        ? data
        : ArrayBuffer.isView(data)
          ? Buffer.from(data.buffer, data.byteOffset, data.byteLength)
          : Buffer.from(data as ArrayBuffer);
      this.emit('rx', buffer);
      this.emit('data', buffer);
    };
    ws.on('message', onMessage);
    this._cleanupFns.add(() => ws.off('message', onMessage));

    const onError = (err: Error) => {
      this.physicalLayer.emit('error', err);
    };
    ws.on('error', onError);
    this._cleanupFns.add(() => ws.off('error', onError));

    const cleanupClose = () => ws.off('close', onClose);
    const onClose = () => {
      this._cleanupFns.delete(cleanupClose);

      this._state = PipelineLayerState.DESTROYED;
      for (const fn of this._cleanupFns) {
        fn();
      }
      this._cleanupFns.clear();

      for (const fn of this._pendingDestroyCbs) {
        if (fn) {
          fn(null);
        }
      }
      this._pendingDestroyCbs.length = 0;
      this.emit('close');
    };
    ws.once('close', onClose);
    this._cleanupFns.add(cleanupClose);
  }

  /**
   * Write a frame to the WebSocket as a binary message.
   *
   * @param data Encoded frame bytes (unit: byte). Must not be modified.
   * @param cb Optional callback invoked once the write completes.
   * @returns `void`.
   */
  override write(data: Buffer, cb?: (err: Error | null) => void): void {
    if (this.state === PipelineLayerState.CONNECTED) {
      this._ws.send(data, (err) => {
        if (err) {
          cb?.(err);
        } else {
          cb?.(null);
          this.emit('tx', data);
        }
      });
    } else {
      cb?.(new Error('Pipeline is not connected'));
    }
  }

  /**
   * Destroy the underlying WebSocket and tear down the pipeline.
   *
   * @param cb Optional callback invoked once the layer is destroyed.
   * @returns `void`.
   */
  override destroy(cb?: (err: Error | null) => void): void {
    if (this.state === PipelineLayerState.DESTROYED) {
      cb?.(null);
      return;
    }
    if (this.state === PipelineLayerState.DESTROYING) {
      this._pendingDestroyCbs.push(cb);
      return;
    }

    this._state = PipelineLayerState.DESTROYING;
    this._pendingDestroyCbs = [cb];

    this._ws.close();
  }
}
