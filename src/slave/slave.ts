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

  getAddressRange?: () => {
    discreteInputs?: [number, number] | [number, number][];
    coils?: [number, number] | [number, number][];
    inputRegisters?: [number, number] | [number, number][];
    holdingRegisters?: [number, number] | [number, number][];
  };
}

interface ModbusSlaveEvents {
  error: [error: Error];
  close: [];
}

export class ModbusSlave<A extends AbstractApplicationLayer, P extends AbstractPhysicalLayer> extends EventEmitter<ModbusSlaveEvents> {
  public models = new Map<number, ModbusSlaveModel>();

  get isOpen(): boolean {
    return this.physicalLayer.isOpen;
  }

  get destroyed(): boolean {
    return this.physicalLayer.destroyed;
  }

  constructor(
    private applicationLayer: A,
    private physicalLayer: P,
  ) {
    super();

    applicationLayer.on('framing', (frame, _response) => {
      if (!(frame.unit === 0x00 || this.models.has(frame.unit))) {
        return;
      }

      const response = async (data: Buffer) => {
        if (frame.unit === 0x00) {
          return;
        }
        try {
          await _response(data);
        } catch (error) {}
      };

      const intercept = async (model: ModbusSlaveModel) => {
        if (model.interceptor) {
          try {
            const data = await model.interceptor(frame.fc, frame.data);
            if (data) {
              response(this.applicationLayer.encode({ ...frame, data }));
              return 'break';
            }
          } catch (error) {
            this.responseError(frame, response, error as Error);
            return 'break';
          }
        }
      };

      const handleFC = (model: ModbusSlaveModel) => {
        switch (frame.fc) {
          case 0x01: {
            this.handleFC1(model, frame, response);
            break;
          }

          case 0x02: {
            this.handleFC2(model, frame, response);
            break;
          }

          case 0x03: {
            this.handleFC3(model, frame, response);
            break;
          }

          case 0x04: {
            this.handleFC4(model, frame, response);
            break;
          }

          case 0x05: {
            this.handleFC5(model, frame, response);
            break;
          }

          case 0x06: {
            this.handleFC6(model, frame, response);
            break;
          }

          case 0x0f: {
            this.handleFC15(model, frame, response);
            break;
          }

          case 0x10: {
            this.handleFC16(model, frame, response);
            break;
          }

          case 0x11: {
            this.handleFC17(model, frame, response);
            break;
          }

          case 0x16: {
            this.handleFC22(model, frame, response);
            break;
          }

          case 0x17: {
            this.handleFC23(model, frame, response);
            break;
          }

          case 0x2b: {
            this.handleFC43_14(model, frame, response);
            break;
          }

          default: {
            this.responseError(frame, response, getErrorByCode(ErrorCode.ILLEGAL_FUNCTION));
            break;
          }
        }
      };

      for (const model of frame.unit === 0x00 ? this.models.values() : [this.models.get(frame.unit)!]) {
        intercept(model).then((res) => {
          if (res !== 'break') {
            handleFC(model);
          }
        });
      }
    });
    physicalLayer.on('error', (error) => {
      this.emit('error', error);
    });
    physicalLayer.on('close', () => {
      this.emit('close');
    });
  }

  private handleFC1(model: ModbusSlaveModel, frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 4) {
      if (model.readCoils) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const length = bufferRx.readUInt16BE(2);
        if (length >= 0x0001 && length <= 0x07d0) {
          if (checkRange([address, address + length], model.getAddressRange?.().coils)) {
            Promise.resolve(model.readCoils(address, length))
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

  private handleFC2(model: ModbusSlaveModel, frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 4) {
      if (model.readDiscreteInputs) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const length = bufferRx.readUInt16BE(2);
        if (length >= 0x0001 && length <= 0x07d0) {
          if (checkRange([address, address + length], model.getAddressRange?.().discreteInputs)) {
            Promise.resolve(model.readDiscreteInputs(address, length))
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

  private handleFC3(model: ModbusSlaveModel, frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 4) {
      if (model.readHoldingRegisters) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const length = bufferRx.readUInt16BE(2);
        if (length >= 0x0001 && length <= 0x007d) {
          if (checkRange([address, address + length], model.getAddressRange?.().holdingRegisters)) {
            Promise.resolve(model.readHoldingRegisters(address, length))
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

  private handleFC4(model: ModbusSlaveModel, frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 4) {
      if (model.readInputRegisters) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const length = bufferRx.readUInt16BE(2);
        if (length >= 0x0001 && length <= 0x007d) {
          if (checkRange([address, address + length], model.getAddressRange?.().inputRegisters)) {
            Promise.resolve(model.readInputRegisters(address, length))
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

  private handleFC5(model: ModbusSlaveModel, frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 4) {
      if (model.writeSingleCoil) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const value = bufferRx.readUInt16BE(2);
        if (value === 0x0000 || value === 0xff00) {
          if (checkRange(address, model.getAddressRange?.().coils)) {
            Promise.resolve(model.writeSingleCoil(address, value === 0xff00))
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

  private handleFC6(model: ModbusSlaveModel, frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 4) {
      if (model.writeSingleRegister) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const value = bufferRx.readUInt16BE(2);
        if (value >= 0x0000 && value <= 0xffff) {
          if (checkRange(address, model.getAddressRange?.().holdingRegisters)) {
            Promise.resolve(model.writeSingleRegister(address, value))
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

  private handleFC15(model: ModbusSlaveModel, frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length > 5 && frame.data.length === 5 + frame.data[4]) {
      if (model.writeMultipleCoils || model.writeSingleCoil) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const length = bufferRx.readUInt16BE(2);
        const byteCount = bufferRx[4];
        if (length >= 0x0001 && length <= 0x07b0 && byteCount === Math.ceil(length / 8)) {
          if (checkRange([address, address + length], model.getAddressRange?.().coils)) {
            const value = Array.from({ length }).map((_, index) => (bufferRx[5 + ~~(index / 8)] & (1 << index % 8)) > 0);
            Promise.resolve(
              model.writeMultipleCoils
                ? model.writeMultipleCoils(address, value)
                : Promise.all(value.map((v, i) => model.writeSingleCoil!(address + i, v))),
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

  private handleFC16(model: ModbusSlaveModel, frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length > 5 && frame.data.length === 5 + frame.data[4]) {
      if (model.writeMultipleRegisters || model.writeSingleRegister) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const length = bufferRx.readUInt16BE(2);
        const byteCount = bufferRx[4];
        if (length >= 0x0001 && length <= 0x007b && byteCount === length * 2) {
          if (checkRange([address, address + length], model.getAddressRange?.().holdingRegisters)) {
            const value = Array.from({ length }).map((_, index) => bufferRx.readUInt16BE(5 + index * 2));
            Promise.resolve(
              model.writeMultipleRegisters
                ? model.writeMultipleRegisters(address, value)
                : Promise.all(value.map((v, i) => model.writeSingleRegister!(address + i, v))),
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

  private handleFC17(model: ModbusSlaveModel, frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 0) {
      if (model.reportServerId) {
        Promise.resolve(model.reportServerId())
          .then(({ serverId = model.unit ?? 1, runIndicatorStatus = true, additionalData = [] }) => {
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

  private handleFC22(model: ModbusSlaveModel, frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 6) {
      if (model.maskWriteRegister || (model.readHoldingRegisters && model.writeSingleRegister)) {
        const bufferRx = Buffer.from(frame.data);
        const address = bufferRx.readUInt16BE(0);
        const andMask = bufferRx.readUInt16BE(2);
        const orMask = bufferRx.readUInt16BE(4);
        if (checkRange(address, model.getAddressRange?.().holdingRegisters)) {
          Promise.resolve(
            model.maskWriteRegister
              ? model.maskWriteRegister(address, andMask, orMask)
              : Promise.resolve(model.readHoldingRegisters!(address, 1)).then(([value]) => {
                  return Promise.resolve(model.writeSingleRegister!(address, (value & andMask) | (orMask & (~andMask & 0xff))));
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

  private handleFC23(model: ModbusSlaveModel, frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length > 9 && frame.data.length === 9 + frame.data[8]) {
      if (model.readHoldingRegisters && (model.writeMultipleRegisters || model.writeSingleRegister)) {
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
              model.getAddressRange?.().holdingRegisters,
            )
          ) {
            const value = Array.from({ length: length.write }).map((_, index) => bufferRx.readUInt16BE(9 + index * 2));
            Promise.resolve(
              model.writeMultipleRegisters
                ? model.writeMultipleRegisters(address.write, value)
                : Promise.all(value.map((v, i) => model.writeSingleRegister!(address.write + i, v))),
            )
              .then(() => Promise.resolve(model.readHoldingRegisters!(address.read, length.read)))
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

  private handleFC43_14(model: ModbusSlaveModel, frame: ApplicationDataUnit, response: (data: Buffer) => Promise<void>) {
    if (frame.data.length === 3) {
      if (frame.data[0] === 0x0e && model.readDeviceIdentification) {
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

        Promise.resolve(model.readDeviceIdentification())
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

  public add(model: ModbusSlaveModel) {
    this.models.set(model.unit ?? 1, model);
  }

  public remove(unit: number) {
    this.models.delete(unit);
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
