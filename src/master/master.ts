import type { AbstractApplicationLayer } from '../layers/application';
import type { AbstractPhysicalLayer } from '../layers/physical';
import type { ApplicationDataUnit, DeviceIdentification, ServerId } from '../types';

import EventEmitter from 'node:events';

interface ModbusMasterEvents {
  error: [error: Error];
  close: [];
}

interface ReturnValue<T> {
  transaction?: number;
  unit: number;
  fc: number;
  data: T;
  buffer: Buffer;
}

export class ModbusMaster<A extends AbstractApplicationLayer, P extends AbstractPhysicalLayer> extends EventEmitter<ModbusMasterEvents> {
  private _responses = new Set<(frame: ApplicationDataUnit & { buffer: Buffer }) => void>();

  get isOpen(): boolean {
    return this.physicalLayer.isOpen;
  }

  get destroyed(): boolean {
    return this.physicalLayer.destroyed;
  }

  constructor(
    private applicationLayer: A,
    private physicalLayer: P,
    public timeout = 1000,
  ) {
    super();

    this.writeFC1 = this.readCoils;
    this.writeFC2 = this.readDiscreteInputs;
    this.writeFC3 = this.readHoldingRegisters;
    this.writeFC4 = this.readInputRegisters;
    this.writeFC5 = this.writeSingleCoil;
    this.writeFC6 = this.writeSingleRegister;
    this.writeFC15 = this.writeMultipleCoils;
    this.writeFC16 = this.writeMultipleRegisters;
    this.handleFC17 = this.reportServerId;
    this.handleFC22 = this.maskWriteRegister;
    this.handleFC23 = this.readAndWriteMultipleRegisters;
    this.handleFC43_14 = this.readDeviceIdentification;

    applicationLayer.on('framing', async (frame) => {
      for (const response of this._responses) {
        response(frame);
      }
    });
    physicalLayer.on('error', (error) => {
      this.emit('error', error);
    });
    physicalLayer.on('close', () => {
      this.emit('close');
    });
  }

  private waitResponse<R>(timeout: number, cb: (frame: ApplicationDataUnit) => R | undefined) {
    return new Promise<ReturnValue<R>>((resolve, reject) => {
      const tid = setTimeout(() => {
        this._responses.delete(response);
        reject('Timeout');
      }, timeout);
      const response = (frame: ApplicationDataUnit & { buffer: Buffer }) => {
        const data = cb(frame);
        if (typeof data !== 'undefined') {
          clearTimeout(tid);
          this._responses.delete(response);
          resolve({
            transaction: frame.transaction,
            unit: frame.unit,
            fc: frame.fc,
            data,
            buffer: frame.buffer,
          });
        }
      };
      this._responses.add(response);
    });
  }

  private writeFC1Or2(unit: number, fc: number, address: number, length: number, timeout: number) {
    const bufferTx = Buffer.alloc(4);
    bufferTx.writeUInt16BE(address, 0);
    bufferTx.writeUInt16BE(length, 2);
    this.physicalLayer.write(
      this.applicationLayer.encode({
        unit,
        fc,
        data: Array.from(bufferTx),
      }),
    );
    if (unit !== 0) {
      return this.waitResponse(timeout, (frame) => {
        const byteCount = Math.ceil(length / 8);
        if (frame.unit === unit && frame.fc === fc && frame.data.length === 1 + byteCount && frame.data[0] === byteCount) {
          return Array.from({ length }).map((_, index) => (frame.data[1 + ~~(index / 8)] & (1 << index % 8)) > 0);
        }
      });
    }
  }

  public writeFC1: this['readCoils'];
  public readCoils(unit: 0, address: number, length: number, timeout?: number): void;
  public readCoils(unit: number, address: number, length: number, timeout?: number): Promise<ReturnValue<boolean[]>>;
  public readCoils(unit: number, address: number, length: number, timeout = this.timeout): any {
    return this.writeFC1Or2(unit, 0x01, address, length, timeout);
  }

  public writeFC2: this['readDiscreteInputs'];
  public readDiscreteInputs(unit: 0, address: number, length: number, timeout?: number): void;
  public readDiscreteInputs(unit: number, address: number, length: number, timeout?: number): Promise<ReturnValue<boolean[]>>;
  public readDiscreteInputs(unit: number, address: number, length: number, timeout = this.timeout): any {
    return this.writeFC1Or2(unit, 0x02, address, length, timeout);
  }

  private writeFC3Or4(unit: number, fc: number, address: number, length: number, timeout: number) {
    const bufferTx = Buffer.alloc(4);
    bufferTx.writeUInt16BE(address, 0);
    bufferTx.writeUInt16BE(length, 2);
    this.physicalLayer.write(
      this.applicationLayer.encode({
        unit,
        fc,
        data: Array.from(bufferTx),
      }),
    );
    if (unit !== 0) {
      return this.waitResponse(timeout, (frame) => {
        const byteCount = length * 2;
        if (frame.unit === unit && frame.fc === fc && frame.data.length === 1 + byteCount && frame.data[0] === byteCount) {
          const bufferRx = Buffer.from(frame.data.slice(1));
          return Array.from({ length }).map((_, index) => bufferRx.readUInt16BE(index * 2));
        }
      });
    }
  }

  public writeFC3: this['readHoldingRegisters'];
  public readHoldingRegisters(unit: 0, address: number, length: number, timeout?: number): void;
  public readHoldingRegisters(unit: number, address: number, length: number, timeout?: number): Promise<ReturnValue<number[]>>;
  public readHoldingRegisters(unit: number, address: number, length: number, timeout = this.timeout): any {
    return this.writeFC3Or4(unit, 0x03, address, length, timeout);
  }

  public writeFC4: this['readInputRegisters'];
  public readInputRegisters(unit: 0, address: number, length: number, timeout?: number): void;
  public readInputRegisters(unit: number, address: number, length: number, timeout?: number): Promise<ReturnValue<number[]>>;
  public readInputRegisters(unit: number, address: number, length: number, timeout = this.timeout): any {
    return this.writeFC3Or4(unit, 0x04, address, length, timeout);
  }

  public writeFC5: this['writeSingleCoil'];
  public writeSingleCoil(unit: 0, address: number, value: boolean, timeout?: number): void;
  public writeSingleCoil(unit: number, address: number, value: boolean, timeout?: number): Promise<ReturnValue<boolean>>;
  public writeSingleCoil(unit: number, address: number, value: boolean, timeout = this.timeout): any {
    const fc = 0x05;
    const bufferTx = Buffer.alloc(4);
    bufferTx.writeUInt16BE(address, 0);
    bufferTx.writeUInt16BE(value ? 0xff00 : 0x0000, 2);
    this.physicalLayer.write(
      this.applicationLayer.encode({
        unit,
        fc,
        data: Array.from(bufferTx),
      }),
    );
    if (unit !== 0) {
      return this.waitResponse(timeout, (frame) => {
        if (
          frame.unit === unit &&
          frame.fc === fc &&
          frame.data.length === bufferTx.length &&
          frame.data.every((v, i) => v === bufferTx[i])
        ) {
          return value;
        }
      });
    }
  }

  public writeFC6: this['writeSingleRegister'];
  public writeSingleRegister(unit: 0, address: number, value: number, timeout?: number): void;
  public writeSingleRegister(unit: number, address: number, value: number, timeout?: number): Promise<ReturnValue<number>>;
  public writeSingleRegister(unit: number, address: number, value: number, timeout = this.timeout): any {
    const fc = 0x06;
    const bufferTx = Buffer.alloc(4);
    bufferTx.writeUInt16BE(address, 0);
    bufferTx.writeUInt16BE(value, 2);
    this.physicalLayer.write(
      this.applicationLayer.encode({
        unit,
        fc,
        data: Array.from(bufferTx),
      }),
    );
    if (unit !== 0) {
      return this.waitResponse(timeout, (frame) => {
        if (
          frame.unit === unit &&
          frame.fc === fc &&
          frame.data.length === bufferTx.length &&
          frame.data.every((v, i) => v === bufferTx[i])
        ) {
          return value;
        }
      });
    }
  }

  public writeFC15: this['writeMultipleCoils'];
  public writeMultipleCoils(unit: 0, address: number, value: boolean[], timeout?: number): void;
  public writeMultipleCoils(unit: number, address: number, value: boolean[], timeout?: number): Promise<ReturnValue<boolean[]>>;
  public writeMultipleCoils(unit: number, address: number, value: boolean[], timeout = this.timeout): any {
    const fc = 0x0f;
    const byteCount = Math.ceil(value.length / 8);
    const bufferTx = Buffer.alloc(5 + byteCount);
    bufferTx.writeUInt16BE(address, 0);
    bufferTx.writeUInt16BE(value.length, 2);
    bufferTx.writeUInt8(byteCount, 4);
    value.forEach((v, i) => {
      if (v) {
        bufferTx[5 + ~~(i / 8)] |= 1 << i % 8;
      }
    });
    this.physicalLayer.write(
      this.applicationLayer.encode({
        unit,
        fc,
        data: Array.from(bufferTx),
      }),
    );
    if (unit !== 0) {
      return this.waitResponse(timeout, (frame) => {
        if (frame.unit === unit && frame.fc === fc && frame.data.length === 4 && frame.data.every((v, i) => v === bufferTx[i])) {
          return value;
        }
      });
    }
  }

  public writeFC16: this['writeMultipleRegisters'];
  public writeMultipleRegisters(unit: 0, address: number, value: number[], timeout?: number): void;
  public writeMultipleRegisters(unit: number, address: number, value: number[], timeout?: number): Promise<ReturnValue<number[]>>;
  public writeMultipleRegisters(unit: number, address: number, value: number[], timeout = this.timeout): any {
    const fc = 0x10;
    const byteCount = value.length * 2;
    const bufferTx = Buffer.alloc(5 + byteCount);
    bufferTx.writeUInt16BE(address, 0);
    bufferTx.writeUInt16BE(value.length, 2);
    bufferTx.writeUInt8(byteCount, 4);
    value.forEach((v, i) => {
      bufferTx.writeUInt16BE(v, 5 + i * 2);
    });
    this.physicalLayer.write(
      this.applicationLayer.encode({
        unit,
        fc,
        data: Array.from(bufferTx),
      }),
    );
    if (unit !== 0) {
      return this.waitResponse(timeout, (frame) => {
        if (frame.unit === unit && frame.fc === fc && frame.data.length === 4 && frame.data.every((v, i) => v === bufferTx[i])) {
          return value;
        }
      });
    }
  }

  public handleFC17: this['reportServerId'];
  public reportServerId(unit: 0, timeout?: number): void;
  public reportServerId(unit: number, timeout?: number): Promise<ReturnValue<ServerId>>;
  public reportServerId(unit: number, timeout = this.timeout): any {
    const fc = 0x11;
    this.physicalLayer.write(
      this.applicationLayer.encode({
        unit,
        fc,
        data: [],
      }),
    );
    if (unit !== 0) {
      return this.waitResponse(timeout, (frame) => {
        if (frame.unit === unit && frame.fc === fc && frame.data.length >= 3) {
          const byteCount = frame.data[0];
          if (frame.data.length - 1 === byteCount) {
            return {
              serverId: frame.data[1],
              runIndicatorStatus: frame.data[2] === 0xff,
              additionalData: frame.data.slice(3),
            };
          }
        }
      });
    }
  }

  public handleFC22: this['maskWriteRegister'];
  public maskWriteRegister(unit: 0, address: number, andMask: number, orMask: number, timeout?: number): void;
  public maskWriteRegister(
    unit: number,
    address: number,
    andMask: number,
    orMask: number,
    timeout?: number,
  ): Promise<ReturnValue<{ andMask: number; orMask: number }>>;
  public maskWriteRegister(unit: number, address: number, andMask: number, orMask: number, timeout = this.timeout): any {
    const fc = 0x16;
    const bufferTx = Buffer.alloc(6);
    bufferTx.writeUInt16BE(address, 0);
    bufferTx.writeUInt16BE(andMask, 2);
    bufferTx.writeUInt16BE(orMask, 4);
    this.physicalLayer.write(
      this.applicationLayer.encode({
        unit,
        fc,
        data: Array.from(bufferTx),
      }),
    );
    if (unit !== 0) {
      return this.waitResponse(timeout, (frame) => {
        if (frame.unit === unit && frame.fc === fc && frame.data.length === 6 && frame.data.every((v, i) => v === bufferTx[i])) {
          return { andMask, orMask };
        }
      });
    }
  }

  public handleFC23: this['readAndWriteMultipleRegisters'];
  public readAndWriteMultipleRegisters(
    unit: 0,
    read: { address: number; length: number },
    write: { address: number; value: number[] },
    timeout?: number,
  ): void;
  public readAndWriteMultipleRegisters(
    unit: number,
    read: { address: number; length: number },
    write: { address: number; value: number[] },
    timeout?: number,
  ): Promise<ReturnValue<number[]>>;
  public readAndWriteMultipleRegisters(
    unit: number,
    read: { address: number; length: number },
    write: { address: number; value: number[] },
    timeout = this.timeout,
  ): any {
    const fc = 0x17;
    const byteCount = write.value.length * 2;
    const bufferTx = Buffer.alloc(9 + byteCount);
    bufferTx.writeUInt16BE(read.address, 0);
    bufferTx.writeUInt16BE(read.length, 2);
    bufferTx.writeUInt16BE(write.address, 4);
    bufferTx.writeUInt16BE(write.value.length, 6);
    bufferTx.writeUInt8(byteCount, 8);
    write.value.forEach((v, i) => {
      bufferTx.writeUInt16BE(v, 9 + i * 2);
    });
    this.physicalLayer.write(
      this.applicationLayer.encode({
        unit,
        fc,
        data: Array.from(bufferTx),
      }),
    );
    if (unit !== 0) {
      return this.waitResponse(timeout, (frame) => {
        if (frame.unit === unit && frame.fc === fc && frame.data.length === 1 + byteCount && frame.data[0] === byteCount) {
          const bufferRx = Buffer.from(frame.data.slice(1));
          return Array.from({ length: read.length }).map((_, index) => bufferRx.readUInt16BE(index * 2));
        }
      });
    }
  }

  public handleFC43_14: this['readDeviceIdentification'];
  public readDeviceIdentification(unit: 0, readDeviceIDCode: number, objectId: number, timeout?: number): void;
  public readDeviceIdentification(
    unit: number,
    readDeviceIDCode: number,
    objectId: number,
    timeout?: number,
  ): Promise<ReturnValue<DeviceIdentification>>;
  public readDeviceIdentification(unit: number, readDeviceIDCode: number, objectId: number, timeout = this.timeout): any {
    const fc = 0x2b;
    this.physicalLayer.write(
      this.applicationLayer.encode({
        unit,
        fc,
        data: [0x0e, readDeviceIDCode, objectId],
      }),
    );
    if (unit !== 0) {
      return this.waitResponse(timeout, (frame) => {
        if (
          frame.unit === unit &&
          frame.fc === fc &&
          frame.data.length >= 6 &&
          frame.data[0] === 0x0e &&
          frame.data[1] === readDeviceIDCode
        ) {
          const conformityLevel = frame.data[2];
          const moreFollows = frame.data[3] === 0xff;
          const nextObjectId = frame.data[4];
          const objectLength = frame.data[5];
          const objects: { id: number; value: string }[] = [];
          let object: [number?, number?, number[]?] = [];
          for (const v of frame.data.slice(6)) {
            switch (object.length) {
              case 0:
              case 1: {
                object.push(v);
                break;
              }

              case 2: {
                object.push([v]);
                break;
              }

              case 3: {
                object[2]!.push(v);
                break;
              }

              default:
                break;
            }

            if (object.length === 3 && object[1] === object[2]!.length) {
              objects.push({ id: object[0]!, value: Buffer.from(object[2]!).toString() });
              object = [];
            }
          }

          if (objects.length === objectLength) {
            return {
              readDeviceIDCode,
              conformityLevel,
              moreFollows,
              nextObjectId,
              objects,
            };
          }
        }
      });
    }
  }

  public open(...args: Parameters<P['open']>): Promise<void> {
    return this.physicalLayer.open(...args);
  }

  public close(): Promise<void> {
    return this.physicalLayer.close();
  }

  public destroy(): Promise<void> {
    this.removeAllListeners();
    this.applicationLayer.destroy();
    return this.physicalLayer.destroy();
  }
}
