import type { AbstractPipelineLayer } from 'njs-modbus';
import type { ServerOptions, WebSocket } from 'ws';

import { AbstractPhysicalLayer, PhysicalLayerState } from 'njs-modbus';
import { WebSocketServer } from 'ws';

import { WebSocketPipelineLayer } from './websocket-pipeline-layer.js';

export interface WebSocketServerPhysicalLayerOptions {
  /** Port to listen on. Default 8080. */
  port?: number;
  /** Passed through to the underlying `WebSocketServer`. */
  serverOpts?: ServerOptions;
  /** Maximum number of concurrent WebSocket connections. */
  maxConnections?: number;
}

/**
 * WebSocket server physical layer.
 *
 * Listens on a local port and emits a {@link WebSocketPipelineLayer} for every
 * incoming connection. The pipeline can be passed directly to {@link ModbusSlave}
 * as its `pipelineAdapter`.
 */
export class WebSocketServerPhysicalLayer extends AbstractPhysicalLayer {
  private _state: PhysicalLayerState = PhysicalLayerState.CLOSED;
  private _pipelines = new Set<AbstractPipelineLayer>();

  private _wss: WebSocketServer | null = null;
  private _opts?: WebSocketServerPhysicalLayerOptions;

  private _pendingOpenCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _pendingCloseCbs: (((err: Error | null) => void) | undefined)[] = [];
  private _cleanupFns = new Set<() => void>();

  /** Current lifecycle state of this physical layer. */
  get state(): PhysicalLayerState {
    return this._state;
  }

  /**
   * @param options Optional `WebSocketServer` constructor options.
   */
  constructor(options?: WebSocketServerPhysicalLayerOptions) {
    super();

    this._opts = options;
  }

  /**
   * Start listening for incoming WebSocket connections.
   *
   * @param options Listen options. Port defaults to `8080` (unit: port number).
   * @param cb Optional callback invoked once the server is listening.
   * @returns `void`.
   */
  open(options?: WebSocketServerPhysicalLayerOptions, cb?: (err: Error | null) => void): void {
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

    const server = new WebSocketServer({
      port: options?.port ?? this._opts?.port ?? 8080,
      ...this._opts?.serverOpts,
      ...options?.serverOpts,
    });
    this._wss = server;

    const onListening = () => {
      server.off('error', onError);

      this._state = PhysicalLayerState.OPEN;
      for (const fn of this._pendingOpenCbs) {
        if (fn) {
          fn(null);
        }
      }
      this._pendingOpenCbs.length = 0;
      this.emit('open');

      {
        const onServerError = (err: Error) => {
          this.emit('error', err);
        };
        server.on('error', onServerError);
        this._cleanupFns.add(() => server.off('error', onServerError));

        const cleanupClose = () => server.off('close', onClose);
        const onClose = () => {
          this._cleanupFns.delete(cleanupClose);
          this._state = PhysicalLayerState.CLOSED;
          this._wss = null;
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
        server.once('close', onClose);
        this._cleanupFns.add(cleanupClose);
      }
    };

    const onConnection = (ws: WebSocket) => {
      const maxConnections = this._opts?.maxConnections;
      if (maxConnections && this._pipelines.size >= maxConnections) {
        ws.close();
        return;
      }

      const pipeline = new WebSocketPipelineLayer(this, ws);
      this._pipelines.add(pipeline);

      const cleanupClose = () => pipeline.off('close', onClose);
      const onClose = () => {
        this._cleanupFns.delete(cleanupClose);
        this._pipelines.delete(pipeline);
      };
      pipeline.once('close', onClose);
      this._cleanupFns.add(cleanupClose);

      this.emit('connect', pipeline);
    };

    const onError = (err: Error) => {
      server.off('listening', onListening);
      server.off('connection', onConnection);

      this._state = PhysicalLayerState.CLOSED;
      this._wss = null;
      for (const fn of this._pendingOpenCbs) {
        if (fn) {
          fn(err);
        }
      }
      this._pendingOpenCbs.length = 0;
    };

    server.on('connection', onConnection);
    this._cleanupFns.add(() => server.off('connection', onConnection));

    server.once('listening', onListening);
    server.once('error', onError);
  }

  /**
   * Close the server and destroy any active connection pipelines.
   *
   * @param cb Optional callback invoked once the server is closed.
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

    this._wss!.close();
    for (const pipeline of [...this._pipelines]) {
      pipeline.destroy();
    }
  }
}
