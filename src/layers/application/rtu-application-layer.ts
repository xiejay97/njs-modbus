import type { ApplicationDataUnit } from '../../types';
import type { TcpClientPhysicalLayer, TcpServerPhysicalLayer, UdpPhysicalLayer } from '../physical';
import type { SerialPhysicalLayer } from '../physical';

import { AbstractApplicationLayer } from './abstract-application-layer';
import { crc, getThreePointFiveT } from '../../utils';

export class RtuApplicationLayer extends AbstractApplicationLayer {
  private _timerThreePointFive?: NodeJS.Timeout;
  private _bufferRx = Buffer.alloc(0);
  private _removeAllListeners: (() => void)[] = [];

  constructor(
    physicalLayer: SerialPhysicalLayer | TcpServerPhysicalLayer | TcpClientPhysicalLayer | UdpPhysicalLayer,
    /**
     * The time interval between two frames, support two formats:
     * - bit: `48bit` as default
     * - millisecond: `20ms`
     */
    intervalBetweenFrames?: `${number}bit` | `${number}ms`,
  ) {
    super();

    let threePointFiveT = 0;
    if (physicalLayer.TYPE === 'SERIAL') {
      if (intervalBetweenFrames && intervalBetweenFrames.endsWith('ms')) {
        threePointFiveT = Number(intervalBetweenFrames.slice(0, -2));
      } else {
        threePointFiveT = Math.ceil(
          (physicalLayer as SerialPhysicalLayer).baudRate > 19200
            ? 1.8
            : getThreePointFiveT(
                (physicalLayer as SerialPhysicalLayer).baudRate,
                intervalBetweenFrames ? Number(intervalBetweenFrames.slice(0, -3)) : 48,
              ),
        );
      }
    }
    const handleData = (data: Buffer, response: (data: Buffer) => Promise<void>) => {
      this._bufferRx = Buffer.concat([this._bufferRx, data]);
      clearTimeout(this._timerThreePointFive);
      const handleData = () => {
        const frame = this.framing(this._bufferRx);
        if (frame) {
          this.emit('framing', frame, response);
        }
        this._bufferRx = Buffer.alloc(0);
      };
      if (threePointFiveT) {
        this._timerThreePointFive = setTimeout(handleData, threePointFiveT);
      } else {
        handleData();
      }
    };
    physicalLayer.on('data', handleData);
    this._removeAllListeners.push(() => {
      physicalLayer.removeListener('data', handleData);
    });

    const handleClose = () => {
      clearTimeout(this._timerThreePointFive);
      this._bufferRx = Buffer.alloc(0);
    };
    physicalLayer.on('close', handleClose);
    this._removeAllListeners.push(() => {
      physicalLayer.removeListener('close', handleClose);
    });
  }

  private framing(buffer: Buffer): (ApplicationDataUnit & { buffer: Buffer }) | undefined {
    if (buffer.length >= 4) {
      const crcPassed = buffer.readUInt16LE(buffer.length - 2) === crc(buffer.subarray(0, buffer.length - 2));
      if (crcPassed) {
        return {
          unit: buffer[0],
          fc: buffer[1],
          data: Array.from(buffer.subarray(2, buffer.length - 2)),
          buffer,
        };
      }
    }
  }

  override encode(data: ApplicationDataUnit): Buffer {
    const buffer = Buffer.alloc(data.data.length + 4);
    buffer.writeUInt8(data.unit, 0);
    buffer.writeUInt8(data.fc, 1);
    data.data.forEach((num, index) => {
      buffer.writeUInt8(num, 2 + index);
    });
    buffer.writeUInt16LE(crc(buffer.subarray(0, -2)), buffer.length - 2);
    return buffer;
  }

  override destroy(): void {
    this.removeAllListeners();
    for (const removeAllListener of this._removeAllListeners) {
      removeAllListener();
    }
    clearTimeout(this._timerThreePointFive);
  }
}
