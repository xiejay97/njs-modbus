import { SerialPort } from 'serialport';

import { AbstractPhysicalLayer } from './abstract-physical-layer';

export interface SerialPhysicalLayerOptions {
  /** The system path of the serial port you want to open. For example, `/dev/tty.XXX` on Mac/Linux, or `COM1` on Windows */
  path: string;
  /**
   * The baud rate of the port to be opened. This should match one of the commonly available baud rates, such as 110, 300, 1200, 2400, 4800, 9600, 14400, 19200, 38400, 57600, or 115200. Custom rates are supported best effort per platform. The device connected to the serial port is not guaranteed to support the requested baud rate, even if the port itself supports that baud rate.
   */
  baudRate: number;
  /** Must be one of these: 5, 6, 7, or 8 defaults to 8 */
  dataBits?: 5 | 6 | 7 | 8;
  /** Prevent other processes from opening the port. Windows does not currently support `false`. Defaults to true */
  lock?: boolean;
  /** Must be 1, 1.5 or 2 defaults to 1 */
  stopBits?: 1 | 1.5 | 2;
  parity?: string;
  /** Flow control Setting. Defaults to false */
  rtscts?: boolean;
  /** Flow control Setting. Defaults to false */
  xon?: boolean;
  /** Flow control Setting. Defaults to false */
  xoff?: boolean;
  /** Flow control Setting defaults to false*/
  xany?: boolean;
  /** drop DTR on close. Defaults to true */
  hupcl?: boolean;
}

export class SerialPhysicalLayer extends AbstractPhysicalLayer {
  override TYPE: 'SERIAL' | 'NET' = 'SERIAL';

  private _serialport: SerialPort;
  private _destroyed = false;
  private _baudRate: number;

  get isOpen(): boolean {
    return this._serialport.isOpen;
  }

  get destroyed(): boolean {
    return this._destroyed;
  }

  get baudRate(): number {
    return this._baudRate;
  }

  constructor(options: SerialPhysicalLayerOptions) {
    super();

    this._serialport = new SerialPort({ ...options, autoOpen: false });
    this._baudRate = options.baudRate;
  }

  override open(): Promise<void> {
    if (this.destroyed) {
      return Promise.reject(new Error('Port is destroyed'));
    }
    return new Promise((resolve, reject) => {
      this._serialport.open((error) => {
        if (error) {
          reject(error);
        } else {
          this._serialport.on('data', (data: Buffer) => {
            this.emit('data', data, (data) => this.write(data));
          });
          this._serialport.on('error', (error) => {
            this.emit('error', error);
          });
          this._serialport.on('close', () => {
            this._serialport.removeAllListeners();
            this.emit('close');
          });
          resolve();
        }
      });
    });
  }

  override write(data: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
      if (this.isOpen) {
        this._serialport.write(data, (error) => {
          if (error) {
            reject(error);
          } else {
            this.emit('write', data);
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
      this._serialport.removeAllListeners();
      this._serialport.close(() => {
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
