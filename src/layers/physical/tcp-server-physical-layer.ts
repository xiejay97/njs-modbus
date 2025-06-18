import type { NetConnectOpts, Server, Socket, ListenOptions } from 'node:net';

import { createServer } from 'node:net';

import { AbstractPhysicalLayer } from './abstract-physical-layer';

export class TcpServerPhysicalLayer extends AbstractPhysicalLayer {
  override TYPE: 'SERIAL' | 'NET' = 'NET';

  private _server: Server;
  private _isOpen = false;
  private _destroyed = false;
  private _sockets = new Set<Socket>();

  get isOpen(): boolean {
    return this._isOpen;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  constructor(options?: NetConnectOpts) {
    super();

    this._server = createServer(options, (socket) => {
      this._sockets.add(socket);
      socket.on('data', (data) => {
        this.emit(
          'data',
          data,
          (data) =>
            new Promise((resolve, reject) => {
              socket.write(data, (error) => {
                if (error) {
                  reject(error);
                } else {
                  resolve();
                }
              });
            }),
        );
      });
      socket.once('close', () => {
        socket.removeAllListeners();
        this._sockets.delete(socket);
      });
    });
  }

  override open(options: ListenOptions): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('Port is destroyed'));
    }
    return new Promise((resolve, reject) => {
      let called = false;
      this._server.listen({ ...options, port: options.port ?? 502 }, () => {
        called = true;
        this._isOpen = true;
        this._sockets.clear();
        this._server.on('close', () => {
          this._isOpen = false;
          this._server.removeAllListeners();
          for (const socket of this._sockets) {
            socket.removeAllListeners();
          }
          this.emit('close');
        });
        resolve();
      });

      this._server.on('error', (error) => {
        if (called) {
          this.emit('error', error);
        } else {
          reject(error);
        }
      });
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  override write(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      reject(new Error('Not supported'));
    });
  }

  override close(): Promise<void> {
    return new Promise((resolve) => {
      this._isOpen = false;
      this._server.removeAllListeners();
      for (const socket of this._sockets) {
        socket.removeAllListeners();
      }
      this._server.close(() => {
        resolve();
      });
    });
  }

  override destroy(): Promise<void> {
    this._destroyed = true;
    this.removeAllListeners();
    return this.close();
  }
}
