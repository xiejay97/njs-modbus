import type { ApplicationDataUnit } from '../../types';
import type { TcpClientPhysicalLayer, TcpServerPhysicalLayer, UdpPhysicalLayer } from '../physical';

import { AbstractApplicationLayer } from './abstract-application-layer';

export class TcpApplicationLayer extends AbstractApplicationLayer {
  private _waitingResponse?: {
    preCheck: ((frame: ApplicationDataUnit & { buffer: Buffer }) => boolean | number | undefined)[];
    callback: (error: Error | null, frame?: ApplicationDataUnit & { buffer: Buffer }) => void;
  };

  private _transactionId = 1;
  private _removeAllListeners: (() => void)[] = [];

  constructor(physicalLayer: TcpServerPhysicalLayer | TcpClientPhysicalLayer | UdpPhysicalLayer) {
    super();

    const handleData = (data: Buffer, response: (data: Buffer) => Promise<void>) => {
      this.framing(data, (error, frame) => {
        if (this._waitingResponse) {
          this._waitingResponse.callback(error, frame);
        } else if (!error) {
          this.emit('framing', frame!, response);
        }
      });
    };
    physicalLayer.on('data', handleData);
    this._removeAllListeners.push(() => {
      physicalLayer.removeListener('data', handleData);
    });
  }

  private framing(buffer: Buffer, callback: (error: Error | null, frame?: ApplicationDataUnit & { buffer: Buffer }) => void) {
    if (buffer.length >= 8) {
      if (buffer[2] === 0 && buffer[3] === 0 && buffer.readUInt16BE(4) === buffer.length - 6) {
        const frame = {
          transaction: buffer.readUInt16BE(0),
          unit: buffer[6],
          fc: buffer[7],
          data: Array.from(buffer.subarray(8)),
          buffer,
        };
        if (this._waitingResponse) {
          for (const check of this._waitingResponse.preCheck) {
            const res = check(frame);
            if (typeof res === 'undefined') {
              callback(new Error('Insufficient data length'));
              return;
            }
            if (typeof res === 'number') {
              if (res < frame.data.length) {
                callback(new Error('Insufficient data length'));
                return;
              }
              if (res !== frame.data.length) {
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
        callback(null, frame);
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
  }

  override stopWaitingResponse(): void {
    this._waitingResponse = undefined;
  }

  override encode(data: ApplicationDataUnit): Buffer {
    const buffer = Buffer.alloc(data.data.length + 8);
    buffer.writeUInt16BE(data.transaction ?? this._transactionId, 0);
    buffer.writeUInt16BE(0, 2);
    buffer.writeUInt16BE(data.data.length + 2, 4);
    buffer.writeUInt8(data.unit, 6);
    buffer.writeUInt8(data.fc, 7);
    data.data.forEach((num, index) => {
      buffer.writeUInt8(num, 8 + index);
    });
    this._transactionId = (this._transactionId + 1) % 256 || 1;
    return buffer;
  }

  override destroy(): void {
    this.removeAllListeners();
    for (const removeAllListener of this._removeAllListeners) {
      removeAllListener();
    }
  }
}
