import type { BindOptions, Socket, SocketOptions } from 'node:dgram';

import { createSocket } from 'node:dgram';

import { AbstractPhysicalLayer } from './abstract-physical-layer';

export class UdpPhysicalLayer extends AbstractPhysicalLayer {
  override TYPE: 'SERIAL' | 'NET' = 'NET';

  private _socket: Socket;
  private _isOpen = false;
  private _destroyed = false;
  private _port: number;
  private _address?: string;

  public isServer: boolean;

  get isOpen(): boolean {
    return this._isOpen;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  /**
   *
   * @param options
   * @param remote If omitted, as server.
   * Otherwise as client.
   */
  constructor(options?: Partial<SocketOptions>, remote?: { port?: number; address?: string }) {
    super();

    this._socket = createSocket({ ...options, type: options?.type ?? 'udp4' }, (msg, rinfo) => {
      this.emit(
        'data',
        msg,
        (data) =>
          new Promise((resolve, reject) => {
            this._socket.send(data, rinfo.port, rinfo.address, (error) => {
              if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          }),
      );
    });
    this.isServer = !remote;
    this._port = remote?.port ?? 502;
    this._address = remote?.address;
  }

  override open(options: BindOptions): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('Port is destroyed'));
    }
    return new Promise((resolve, reject) => {
      if (this.isServer) {
        let called = false;
        this._socket.bind({ ...options, port: options.port ?? 502 }, () => {
          called = true;
          this._isOpen = true;
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
      } else {
        this._isOpen = true;
        resolve();
      }
    });
  }

  override write(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isOpen) {
        this._socket.send(data, this._port, this._address, (error) => {
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
      this._socket.close(() => {
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
