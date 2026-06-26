import type { AbstractPipelineLayer } from 'njs-modbus';
import type { WebSocket } from 'ws';

import { AbstractPhysicalLayer, PhysicalLayerState } from 'njs-modbus';
import WebSocketConstructor from 'ws';

import { WebSocketPipelineLayer } from './websocket-pipeline-layer.js';

export interface WebSocketClientPhysicalLayerOptions {
  /** WebSocket URL to connect to. Default: `ws://localhost:8080`. */
  url?: string;
}

/**
 * WebSocket client physical layer.
 *
 * Opens a `ws` client connection and emits a {@link WebSocketPipelineLayer} on
 * `connect`. The pipeline can be passed directly to {@link ModbusMaster} as its
 * `pipelineAdapter`.
 */
export class WebSocketClientPhysicalLayer extends AbstractPhysicalLayer {
  private _state: PhysicalLayerState = PhysicalLayerState.CLOSED;
  private _pipelines = new Set<AbstractPipelineLayer>();

  private _ws: WebSocket | null = null;
  private _opts: WebSocketClientPhysicalLayerOptions;

  private _pendingOpenCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _pendingCloseCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _cleanupFns = new Set<() => void>();

  /** Current lifecycle state of this physical layer. */
  get state(): PhysicalLayerState {
    return this._state;
  }

  /** Underlying `WebSocket` instance when connected, otherwise `null`. */
  get ws(): WebSocket | null {
    return this._ws;
  }

  /**
   * @param options Optional default connection options.
   */
  constructor(options?: WebSocketClientPhysicalLayerOptions) {
    super();

    this._opts = options ?? {};
  }

  /**
   * Connect to a WebSocket Modbus endpoint.
   *
   * @param url WebSocket URL. Defaults to `ws://localhost:8080` or the URL
   *   provided at construction time.
   * @param cb Optional callback invoked once the socket connects.
   * @returns `void`.
   */
  open(url?: string, cb?: (err: Error | null) => void): void {
    if (this.state === PhysicalLayerState.OPEN) {
      cb?.(null);
      return;
    }
    if (this.state === PhysicalLayerState.OPENING) {
      this._pendingOpenCbs.push(cb);
      return;
    }
    if (this.state === PhysicalLayerState.CLOSING) {
      cb?.(new Error('Port is closing'));
      return;
    }

    this._state = PhysicalLayerState.OPENING;
    this._pendingOpenCbs = [cb];

    const wsUrl = url ?? this._opts.url ?? 'ws://localhost:8080';
    const ws = new WebSocketConstructor(wsUrl);
    this._ws = ws;

    const onConnect = () => {
      ws.off('error', onError);

      this._state = PhysicalLayerState.OPEN;
      for (const fn of this._pendingOpenCbs) {
        if (fn) {
          fn(null);
        }
      }
      this._pendingOpenCbs.length = 0;
      this.emit('open');

      const pipeline = new WebSocketPipelineLayer(this, ws);
      this._pipelines.add(pipeline);

      const cleanupClose = () => pipeline.off('close', onClose);
      const onClose = () => {
        this._cleanupFns.delete(cleanupClose);

        this._pipelines.delete(pipeline);

        this._state = PhysicalLayerState.CLOSED;
        this._ws = null;
        for (const fn of this._cleanupFns) {
          fn();
        }
        this._cleanupFns.clear();
        for (const fn of this._pendingCloseCbs) {
          if (fn) {
            fn(null);
          }
        }
        this._pendingCloseCbs.length = 0;
        this.emit('close');
      };
      pipeline.once('close', onClose);
      this._cleanupFns.add(cleanupClose);

      this.emit('connect', pipeline);
    };

    const onError = (err: Error) => {
      ws.off('open', onConnect);

      this._state = PhysicalLayerState.CLOSED;
      this._ws = null;
      for (const fn of this._pendingOpenCbs) {
        if (fn) {
          fn(err);
        }
      }
      this._pendingOpenCbs.length = 0;
    };

    ws.once('open', onConnect);
    ws.once('error', onError);
  }

  /**
   * Close the WebSocket and destroy any associated pipelines.
   *
   * @param cb Optional callback invoked once the layer is closed.
   * @returns `void`.
   */
  close(cb?: (err: Error | null) => void): void {
    if (this.state === PhysicalLayerState.CLOSED) {
      cb?.(null);
      return;
    }
    if (this.state === PhysicalLayerState.CLOSING) {
      this._pendingCloseCbs.push(cb);
      return;
    }
    if (this.state === PhysicalLayerState.OPENING) {
      cb?.(new Error('Port is opening'));
      return;
    }

    this._state = PhysicalLayerState.CLOSING;
    this._pendingCloseCbs = [cb];

    for (const pipeline of [...this._pipelines]) {
      pipeline.destroy();
    }
  }
}
