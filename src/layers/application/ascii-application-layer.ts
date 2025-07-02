import type { ApplicationDataUnit } from '../../types';
import type { TcpClientPhysicalLayer, TcpServerPhysicalLayer, UdpPhysicalLayer } from '../physical';
import type { SerialPhysicalLayer } from '../physical';

import { AbstractApplicationLayer } from './abstract-application-layer';
import { lrc } from '../../utils';

const CHAR_CODE = {
  COLON: ':'.charCodeAt(0),
  CR: '\r'.charCodeAt(0),
  LF: '\n'.charCodeAt(0),
};

export class AsciiApplicationLayer extends AbstractApplicationLayer {
  private _waitingResponse?: {
    preCheck: ((frame: ApplicationDataUnit & { buffer: Buffer }) => boolean | number | undefined)[];
    callback: (error: Error | null, frame?: ApplicationDataUnit & { buffer: Buffer }) => void;
  };

  private _status: 'idle' | 'reception' | 'waiting end' = 'idle';
  private _frame: number[] = [];
  private _removeAllListeners: (() => void)[] = [];

  constructor(physicalLayer: SerialPhysicalLayer | TcpServerPhysicalLayer | TcpClientPhysicalLayer | UdpPhysicalLayer) {
    super();

    const handleData = (data: Buffer, response: (data: Buffer) => Promise<void>) => {
      data.forEach((value) => {
        switch (this._status) {
          case 'idle': {
            if (value === CHAR_CODE.COLON) {
              this._status = 'reception';
              this._frame = [];
            }
            break;
          }

          case 'reception': {
            if (value === CHAR_CODE.COLON) {
              this._frame = [];
            } else if (value === CHAR_CODE.CR) {
              this._status = 'waiting end';
            } else {
              this._frame.push(value);
            }
            break;
          }

          case 'waiting end': {
            if (value === CHAR_CODE.COLON) {
              this._status = 'reception';
              this._frame = [];
            } else {
              this._status = 'idle';
              if (value === CHAR_CODE.LF) {
                this.framing(Buffer.from(this._frame), (error, frame) => {
                  if (this._waitingResponse) {
                    this._waitingResponse.callback(error, frame);
                  } else if (!error) {
                    this.emit('framing', frame!, response);
                  }
                });
              }
            }
            break;
          }

          default:
            break;
        }
      });
    };
    physicalLayer.on('data', handleData);
    this._removeAllListeners.push(() => {
      physicalLayer.removeListener('data', handleData);
    });

    const handleClose = () => {
      this._status = 'idle';
      this._frame = [];
    };
    physicalLayer.on('close', handleClose);
    this._removeAllListeners.push(() => {
      physicalLayer.removeListener('close', handleClose);
    });
  }

  private framing(_buffer: Buffer, callback: (error: Error | null, frame?: ApplicationDataUnit & { buffer: Buffer }) => void) {
    if (_buffer.length >= 6) {
      if (_buffer.length % 2 === 0) {
        const ascii: number[] = [];
        let num = '';
        for (const value of _buffer) {
          num += String.fromCharCode(value);
          if (num.length === 2) {
            ascii.push(Number('0x' + num));
            num = '';
          }
        }
        const buffer = Buffer.from(ascii);
        const frame = {
          unit: buffer[0],
          fc: buffer[1],
          data: Array.from(buffer.subarray(2, buffer.length - 1)),
          buffer: _buffer,
        };
        if (this._waitingResponse) {
          for (const check of this._waitingResponse.preCheck) {
            const res = check(frame);
            if (typeof res === 'undefined') {
              callback(new Error('Insufficient data length'));
              return;
            }
            if (typeof res === 'number') {
              if (frame.data.length < res) {
                callback(new Error('Insufficient data length'));
                return;
              }
              if (frame.data.length !== res) {
                callback(new Error('Invalid response'));
                return;
              }
            }
            if (!res) {
              callback(new Error('Invalid response'));
              return;
            }
          }
        }
        const lrcPassed = buffer[buffer.length - 1] === lrc(buffer.subarray(0, buffer.length - 1));
        if (lrcPassed) {
          callback(null, frame);
        } else {
          callback(new Error('LRC check failed'));
        }
      } else {
        callback(new Error('Invalid data'));
      }
    } else {
      callback(new Error('Insufficient data length'));
    }
  }

  override startWaitingResponse(
    preCheck: ((frame: ApplicationDataUnit & { buffer: Buffer }) => boolean | number | undefined)[],
    callback: (error: Error | null, frame?: ApplicationDataUnit & { buffer: Buffer }) => void,
  ): void {
    this._waitingResponse = { preCheck, callback };
    this._status = 'idle';
    this._frame = [];
  }

  override stopWaitingResponse(): void {
    this._waitingResponse = undefined;
  }

  override encode(data: ApplicationDataUnit): Buffer {
    const buffer = Buffer.alloc(data.data.length + 3);
    buffer.writeUInt8(data.unit, 0);
    buffer.writeUInt8(data.fc, 1);
    data.data.forEach((num, index) => {
      buffer.writeUInt8(num, 2 + index);
    });
    buffer.writeUInt8(lrc(buffer.subarray(0, -1)), buffer.length - 1);
    let frame = ':';
    for (const value of buffer) {
      frame += value.toString(16).toUpperCase().padStart(2, '0');
    }
    frame += '\r\n';
    return Buffer.from(frame);
  }

  override destroy(): void {
    this.removeAllListeners();
    for (const removeAllListener of this._removeAllListeners) {
      removeAllListener();
    }
  }
}
