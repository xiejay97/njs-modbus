import type { AbstractApplicationLayer } from '../layers/application';
import type { AbstractPhysicalLayer } from '../layers/physical';
import type { ApplicationDataUnit, FConvertPromise, ServerId } from '../types';

import EventEmitter from 'node:events';

import { ErrorCode, getCodeByError, getErrorByCode } from '../error-code';
import { checkRange } from '../utils';

export interface ModbusSlaveModel {
  unit?: number;

  /**
   * Intercept read and write behavior.
   *
   * If provide the return value, use this value as data of `PDU` to respond.
   * Otherwise keep the default read and write behavior.
   */
  interceptor?: FConvertPromise<(fc: number, data: number[]) => number[] | undefined>;

  //#region Discrete Inputs

  readDiscreteInputs?: FConvertPromise<(address: number, length: number) => boolean[]>;

  //#endregion

  //#region Coils

  readCoils?: FConvertPromise<(address: number, length: number) => boolean[]>;
  writeSingleCoil?: FConvertPromise<(address: number, value: boolean) => void>;
  /**
   * If omitted, defaults to loop and call `writeSingleCoil`.
   */
  writeMultipleCoils?: FConvertPromise<(address: number, value: boolean[]) => void>;

  //#endregion

  //#region Input Registers

  readInputRegisters?: FConvertPromise<(address: number, length: number) => number[]>;

  //#endregion

  //#region Holding Registers

  readHoldingRegisters?: FConvertPromise<(address: number, length: number) => number[]>;
  writeSingleRegister?: FConvertPromise<(address: number, value: number) => void>;
  /**
   * If omitted, defaults to loop and call `writeSingleRegister`.
   */
  writeMultipleRegisters?: FConvertPromise<(address: number, value: number[]) => void>;
  /**
   * If omitted, defaults to call `readHoldingRegisters` and `writeSingleRegister`.
   */
  maskWriteRegister?: FConvertPromise<(address: number, andMask: number, orMask: number) => void>;

  //#endregion

  reportServerId?: FConvertPromise<() => ServerId>;

  readDeviceIdentification?: FConvertPromise<() => { [index: number]: string }>;

  addressRange?: {
    discreteInputs?: [number, number];
    coils?: [number, number];
    inputRegisters?: [number, number];
    holdingRegisters?: [number, number];
  };
}

interface ModbusSlaveEvents {
  error: [error: Error];
  close: [];
}

export class ModbusSlave<A extends AbstractApplicationLayer, P extends AbstractPhysicalLayer> extends EventEmitter<ModbusSlaveEvents> {
  public unit = 1;

  get isOpen(): boolean {
    return this.physicalLayer.isOpen;
  }

  get destroyed(): boolean {
    return this.physicalLayer.destroyed;
  }

  constructor(
    private model: ModbusSlaveModel,
    private applicationLayer: A,
    private physicalLayer: P,
  ) {
    super();

    if (typeof model.unit !== 'undefined') {
      this.unit = model.unit;
    }

    applicationLayer.on('framing', async (frame, _response) => {
      if (!(frame.unit === 0x00 || frame.unit === this.unit)) {
        return;
      }

      const response = frame.unit === 0x00 ? () => Promise.resolve() : _response;

      if (model.interceptor) {
        try {
          const data = await model.interceptor(frame.fc, frame.data);
          if (data) {
            response(this.applicationLayer.encode({ ...frame, data }));
            return;
          }
        } catch (error) {
          this.responseError(frame, response, error as Error);
          return;
        }
      }

      switch (frame.fc) {
        case 0x01: {
          this.handleFC1(frame, response);
          break;
        }

        case 0x02: {
          this.handleFC2(frame, response);
          break;
        }

        case 0x03: {
          this.handleFC3(frame, response);
          break;
        }

        case 0x04: {
          this.handleFC4(frame, response);
          break;
        }

        case 0x05: {
          this.handleFC5(frame, response);
          break;
        }

        case 0x06: {
          this.handleFC6(frame, response);
          break;
        }

        case 0x0f: {
          this.handleFC15(frame, response);
          break;
        }

        case 0x10: {
          this.handleFC16(frame, response);
          break;
        }

        case 0x11: {
          this.handleFC17(frame, response);
          break;
        }

        case 0x16: {
          this.handleFC22(frame, response);
          break;
        }

        case 0x17: {
          this.handleFC23(frame, response);
          break;
        }

        case 0x2b: {
          this.handleFC43_14(frame, response);
          break;
        }

        default: {
          this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
          break;
        }
      }
    });
    physicalLayer.on('error', (error) => {
      this.emit('error', error);
    });
    physicalLayer.on('close', () => {
      this.emit('close');
    });
  }

  private handleFC1(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 4) {
      if (this.model.readCoils) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const length = bufferRx.readUInt16BE(2);
        if (length >= 0x0001 && length <= 0x07d0) {
          if (checkRange([address, address + length], this.model.addressRange?.coils)) {
            Promise.resolve(this.model.readCoils(address, length))
              .then((coils) => {
                const bufferTx = Buffer.alloc(Math.ceil(length / 8));
                coils.forEach((coil, index) => {
                  if (coil) {
                    bufferTx[~~(index / 8)] |= 1 << index % 8;
                  }
                });
                response(this.applicationLayer.encode({ ...frame, data: [bufferTx.length].concat(Array.from(bufferTx)) }));
              })
              .catch((error) => {
                this.responseError(frame, response, error);
              });
          } else {
            this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS));
          }
        } else {
          this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_VALUE));
        }
      } else {
        this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
      }
    }
  }

  private handleFC2(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 4) {
      if (this.model.readDiscreteInputs) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const length = bufferRx.readUInt16BE(2);
        if (length >= 0x0001 && length <= 0x07d0) {
          if (checkRange([address, address + length], this.model.addressRange?.discreteInputs)) {
            Promise.resolve(this.model.readDiscreteInputs(address, length))
              .then((discreteInputs) => {
                const bufferTx = Buffer.alloc(Math.ceil(length / 8));
                discreteInputs.forEach((discreteInput, index) => {
                  if (discreteInput) {
                    bufferTx[~~(index / 8)] |= 1 << index % 8;
                  }
                });
                response(this.applicationLayer.encode({ ...frame, data: [bufferTx.length].concat(Array.from(bufferTx)) }));
              })
              .catch((error) => {
                this.responseError(frame, response, error);
              });
          } else {
            this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS));
          }
        } else {
          this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_VALUE));
        }
      } else {
        this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
      }
    }
  }

  private handleFC3(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 4) {
      if (this.model.readHoldingRegisters) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const length = bufferRx.readUInt16BE(2);
        if (length >= 0x0001 && length <= 0x007d) {
          if (checkRange([address, address + length], this.model.addressRange?.holdingRegisters)) {
            Promise.resolve(this.model.readHoldingRegisters(address, length))
              .then((registers) => {
                const bufferTx = Buffer.alloc(length * 2);
                registers.forEach((register, index) => {
                  bufferTx.writeUInt16BE(register, index * 2);
                });
                response(this.applicationLayer.encode({ ...frame, data: [bufferTx.length].concat(Array.from(bufferTx)) }));
              })
              .catch((error) => {
                this.responseError(frame, response, error);
              });
          } else {
            this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS));
          }
        } else {
          this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_VALUE));
        }
      } else {
        this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
      }
    }
  }

  private handleFC4(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 4) {
      if (this.model.readInputRegisters) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const length = bufferRx.readUInt16BE(2);
        if (length >= 0x0001 && length <= 0x007d) {
          if (checkRange([address, address + length], this.model.addressRange?.inputRegisters)) {
            Promise.resolve(this.model.readInputRegisters(address, length))
              .then((registers) => {
                const bufferTx = Buffer.alloc(length * 2);
                registers.forEach((register, index) => {
                  bufferTx.writeUInt16BE(register, index * 2);
                });
                response(this.applicationLayer.encode({ ...frame, data: [bufferTx.length].concat(Array.from(bufferTx)) }));
              })
              .catch((error) => {
                this.responseError(frame, response, error);
              });
          } else {
            this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS));
          }
        } else {
          this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_VALUE));
        }
      } else {
        this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
      }
    }
  }

  private handleFC5(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 4) {
      if (this.model.writeSingleCoil) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const value = bufferRx.readUInt16BE(2);
        if (value === 0x0000 || value === 0xff00) {
          if (checkRange(address, this.model.addressRange?.coils)) {
            Promise.resolve(this.model.writeSingleCoil(address, value === 0xff00))
              .then(() => {
                response(this.applicationLayer.encode(frame));
              })
              .catch((error) => {
                this.responseError(frame, response, error);
              });
          } else {
            this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS));
          }
        } else {
          this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_VALUE));
        }
      } else {
        this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
      }
    }
  }

  private handleFC6(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 4) {
      if (this.model.writeSingleRegister) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const value = bufferRx.readUInt16BE(2);
        if (value >= 0x0000 && value <= 0xffff) {
          if (checkRange(address, this.model.addressRange?.holdingRegisters)) {
            Promise.resolve(this.model.writeSingleRegister(address, value))
              .then(() => {
                response(this.applicationLayer.encode(frame));
              })
              .catch((error) => {
                this.responseError(frame, response, error);
              });
          } else {
            this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS));
          }
        } else {
          this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_VALUE));
        }
      } else {
        this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
      }
    }
  }

  private handleFC15(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length > 5 && frame.data.length === 5 + frame.data[4]) {
      if (this.model.writeMultipleCoils || this.model.writeSingleCoil) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const length = bufferRx.readUInt16BE(2);
        const byteCount = bufferRx[4];
        if (length >= 0x0001 && length <= 0x07b0 && byteCount === Math.ceil(length / 8)) {
          if (checkRange([address, address + length], this.model.addressRange?.coils)) {
            const value = Array.from({ length }).map((_, index) => (bufferRx[5 + ~~(index / 8)] & (1 << index % 8)) > 0);
            Promise.resolve(
              this.model.writeMultipleCoils
                ? this.model.writeMultipleCoils(address, value)
                : Promise.all(value.map((v, i) => this.model.writeSingleCoil!(address + i, v))),
            )
              .then(() => {
                response(this.applicationLayer.encode({ ...frame, data: Array.from(bufferRx).slice(0, 4) }));
              })
              .catch((error) => {
                this.responseError(frame, response, error);
              });
          } else {
            this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS));
          }
        } else {
          this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_VALUE));
        }
      } else {
        this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
      }
    }
  }

  private handleFC16(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length > 5 && frame.data.length === 5 + frame.data[4]) {
      if (this.model.writeMultipleRegisters || this.model.writeSingleRegister) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const length = bufferRx.readUInt16BE(2);
        const byteCount = bufferRx[4];
        if (length >= 0x0001 && length <= 0x007b && byteCount === length * 2) {
          if (checkRange([address, address + length], this.model.addressRange?.holdingRegisters)) {
            const value = Array.from({ length }).map((_, index) => bufferRx.readUInt16BE(5 + index * 2));
            Promise.resolve(
              this.model.writeMultipleRegisters
                ? this.model.writeMultipleRegisters(address, value)
                : Promise.all(value.map((v, i) => this.model.writeSingleRegister!(address + i, v))),
            )
              .then(() => {
                response(this.applicationLayer.encode({ ...frame, data: Array.from(bufferRx).slice(0, 4) }));
              })
              .catch((error) => {
                this.responseError(frame, response, error);
              });
          } else {
            this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS));
          }
        } else {
          this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_VALUE));
        }
      } else {
        this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
      }
    }
  }

  private handleFC17(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 0) {
      if (this.model.reportServerId) {
        Promise.resolve(this.model.reportServerId())
          .then(({ serverId = this.unit, runIndicatorStatus = true, additionalData = [] }) => {
            response(
              this.applicationLayer.encode({
                ...frame,
                data: [2 + additionalData.length, serverId, runIndicatorStatus ? 0xff : 0x00].concat(additionalData),
              }),
            );
          })
          .catch((error) => {
            this.responseError(frame, response, error);
          });
      } else {
        this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
      }
    }
  }

  private handleFC22(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 6) {
      if (this.model.maskWriteRegister || (this.model.readHoldingRegisters && this.model.writeSingleRegister)) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const andMask = bufferRx.readUInt16BE(2);
        const orMask = bufferRx.readUInt16BE(4);
        if (checkRange(address, this.model.addressRange?.holdingRegisters)) {
          Promise.resolve(
            this.model.maskWriteRegister
              ? this.model.maskWriteRegister(address, andMask, orMask)
              : Promise.resolve(this.model.readHoldingRegisters!(address, 1)).then(([value]) => {
                  return Promise.resolve(this.model.writeSingleRegister!(address, (value & andMask) | (orMask & (~andMask & 0xff))));
                }),
          )
            .then(() => {
              response(this.applicationLayer.encode(frame));
            })
            .catch((error) => {
              this.responseError(frame, response, error);
            });
        } else {
          this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS));
        }
      } else {
        this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
      }
    }
  }

  private handleFC23(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length > 9 && frame.data.length === 9 + frame.data[8]) {
      if (this.model.readHoldingRegisters && (this.model.writeMultipleRegisters || this.model.writeSingleRegister)) {
        const bufferRx = Buffer.from(frame.data);
        const address = {
          read: bufferRx.readUInt16BE(0),
          write: bufferRx.readUInt16BE(4),
        };
        const length = {
          read: bufferRx.readUInt16BE(2),
          write: bufferRx.readUInt16BE(6),
        };
        const byteCount = bufferRx[8];
        if (
          length.read >= 0x0001 &&
          length.read <= 0x007d &&
          length.write >= 0x0001 &&
          length.write <= 0x0079 &&
          byteCount === length.write * 2
        ) {
          if (
            checkRange(
              [address.read, address.read + length.read, address.write, address.write + length.write],
              this.model.addressRange?.holdingRegisters,
            )
          ) {
            const value = Array.from({ length: length.write }).map((_, index) => bufferRx.readUInt16BE(9 + index * 2));
            Promise.resolve(
              this.model.writeMultipleRegisters
                ? this.model.writeMultipleRegisters(address.write, value)
                : Promise.all(value.map((v, i) => this.model.writeSingleRegister!(address.write + i, v))),
            )
              .then(() => Promise.resolve(this.model.readHoldingRegisters!(address.read, length.read)))
              .then((registers) => {
                const bufferTx = Buffer.alloc(length.read * 2);
                registers.forEach((register, index) => {
                  bufferTx.writeUInt16BE(register, index * 2);
                });
                response(this.applicationLayer.encode({ ...frame, data: [bufferTx.length].concat(Array.from(bufferTx)) }));
              })
              .catch((error) => {
                this.responseError(frame, response, error);
              });
          } else {
            this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS));
          }
        } else {
          this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_VALUE));
        }
      } else {
        this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
      }
    }
  }

  private handleFC43_14(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 3) {
      if (frame.data[0] === 0x0e && this.model.readDeviceIdentification) {
        const readDeviceIDCode = frame.data[1];
        let objectID = frame.data[2];

        switch (readDeviceIDCode) {
          case 0x01: {
            if (objectID > 0x02 || (objectID > 0x06 && objectID < 0x80)) {
              objectID = 0x00;
            }
            break;
          }

          case 0x02: {
            if (objectID >= 0x80 || (objectID > 0x06 && objectID < 0x80)) {
              objectID = 0x00;
            }
            break;
          }

          case 0x03: {
            if (objectID > 0x06 && objectID < 0x80) {
              objectID = 0x00;
            }
            break;
          }

          case 0x04: {
            if (objectID > 0x06 && objectID < 0x80) {
              this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS));
              return;
            }
            break;
          }

          default: {
            this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_VALUE));
            return;
          }
        }

        Promise.resolve(this.model.readDeviceIdentification())
          .then((identification) => {
            const objects = new Map([
              [0x00, 'null'],
              [0x01, 'null'],
              [0x02, 'null'],
            ]);
            for (const [key, value] of Object.entries(identification)) {
              const id = parseInt(key);
              if (!isNaN(id) && id >= 0 && id <= 255) {
                objects.set(id, value);
              }
            }

            if (!objects.has(objectID)) {
              if (readDeviceIDCode === 0x04) {
                this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_DATA_ADDRESS));
                return;
              }

              objectID = 0x00;
            }

            const ids: number[] = [];
            let totalLength = 10;
            let lastID = 0;
            let conformityLevel = 0x81;

            for (const [id, value] of objects.entries()) {
              if (id < 0x00 || (id >= 0x07 && id <= 0x7f) || id > 0xff) {
                this.responseError(frame, response, getErrorByCode(ErrorCode.SERVER_DEVICE_FAILURE));
                return;
              }

              if (id > 0x02) {
                conformityLevel = 0x82;
              }
              if (id > 0x80) {
                conformityLevel = 0x83;
              }

              if (objectID > id) {
                continue;
              }

              if (value.length > 245) {
                this.responseError(frame, response, getErrorByCode(ErrorCode.SERVER_DEVICE_FAILURE));
                return;
              }

              if (lastID !== 0) {
                continue;
              }

              if (value.length + 2 > 253 - totalLength) {
                if (lastID === 0) {
                  lastID = id;
                }
              } else {
                totalLength += value.length + 2;
                ids.push(id);

                if (readDeviceIDCode === 0x04) {
                  break;
                }
              }
            }
            ids.sort((a, b) => a - b);

            response(
              this.applicationLayer.encode({
                ...frame,
                data: [0x0e, readDeviceIDCode, conformityLevel, lastID === 0 ? 0x00 : 0xff, lastID, ids.length].concat(
                  ids
                    .map((id) => {
                      const value = objects.get(id)!;
                      return [id, value.length].concat(Array.from(Buffer.from(value)));
                    })
                    .flat(),
                ),
              }),
            );
          })
          .catch((error) => {
            this.responseError(frame, response, error);
          });
      } else {
        this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
      }
    }
  }

  private responseError(frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>, error: Error) {
    response(this.applicationLayer.encode({ ...frame, fc: frame.fc | 0x80, data: [getCodeByError(error)] }));
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
