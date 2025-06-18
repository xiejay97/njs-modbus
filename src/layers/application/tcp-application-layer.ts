import type { ApplicationDataUnit } from '../../types';
import type { TcpClientPhysicalLayer, TcpServerPhysicalLayer, UdpPhysicalLayer } from '../physical';

import { AbstractApplicationLayer } from './abstract-application-layer';

export class TcpApplicationLayer extends AbstractApplicationLayer {
  private _transactionId = 1;
  private _removeAllListeners: (() => void)[] = [];

  constructor(physicalLayer: TcpServerPhysicalLayer | TcpClientPhysicalLayer | UdpPhysicalLayer) {
    super();

    const handleData = (data: Buffer, response: (data: Buffer) => Promise<void>) => {
      const frame = this.framing(data);
      if (frame) {
        this.emit('framing', frame, response);
      }
    };
    physicalLayer.on('data', handleData);
    this._removeAllListeners.push(() => {
      physicalLayer.removeListener('data', handleData);
    });
  }

  private framing(buffer: Buffer): (ApplicationDataUnit & { buffer: Buffer }) | undefined {
    if (buffer.length >= 8) {
      if (buffer[2] === 0 && buffer[3] === 0 && buffer.readUInt16BE(4) === buffer.length - 6) {
        return {
          transaction: buffer.readUInt16BE(0),
          unit: buffer[6],
          fc: buffer[7],
          data: Array.from(buffer.subarray(8)),
          buffer,
        };
      }
    }
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
