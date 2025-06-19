import type { SocketConstructorOpts, SocketConnectOpts } from 'node:net';

import { Socket } from 'node:net';

import { AbstractPhysicalLayer } from './abstract-physical-layer';

export class TcpClientPhysicalLayer extends AbstractPhysicalLayer {
  override TYPE: 'SERIAL' | 'NET' = 'NET';

  private _socket: Socket;
  private _isOpen = false;
  private _destroyed = false;

  get isOpen(): boolean {
    return this._isOpen;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  constructor(options?: SocketConstructorOpts) {
    super();

    this._socket = new Socket(options);
  }

  override open(options?: SocketConnectOpts): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('Port is destroyed'));
    }
    return new Promise((resolve, reject) => {
      let called = false;
      this._socket.connect(options ?? { port: 502 }, () => {
        called = true;
        this._isOpen = true;
        this._socket.on('data', (data: Buffer) => {
          this.emit('data', data, (data) => this.write(data));
        });
        this._socket.on('close', () => {
          this._isOpen = false;
          this._socket.removeAllListeners();
          this.emit('close');
        });
        resolve();
      });

      this._socket.on('error', (error) => {
        if (called) {
          this.emit('error', error);
        } else {
          reject(error);
        }
      });
    });
  }

  override write(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isOpen) {
        this._socket.write(data, (error) => {
          if (error) {
            reject(error);
          } else {
            resolve();
          }
        });
      } else {
        reject(new Error('Port is not open'));
      }
    });
  }

  override close(): Promise<void> {
    return new Promise((resolve) => {
      this._isOpen = false;
      this._socket.removeAllListeners();
      this._socket.destroy();
      resolve();
    });
  }

  override destroy(): Promise<void> {
    this._destroyed = true;
    this.removeAllListeners();
    return this.close();
  }
}
