/**
 * In-memory Modbus unit model used by the best-practice slave.
 *
 * This implementation demonstrates the callback-style handler contract while
 * keeping the example self-contained (no external PLC or database required).
 */

import type { ModbusUnitModel } from 'njs-modbus';

import { ErrorCode } from 'njs-modbus';

import { ADDRESS_RANGES } from './config';

/**
 * Create a process unit model with holding registers, coils, and discrete inputs.
 *
 * @param initialHoldingRegisters Seed values for the holding-register table.
 * @returns A {@link ModbusUnitModel} that mutates the returned internal arrays.
 */
export function createProcessUnit(initialHoldingRegisters: number[]): ModbusUnitModel & {
  readonly holdingRegisters: number[];
} {
  const holdingRegisters = [...initialHoldingRegisters];
  const coils = new Array<0 | 1>(ADDRESS_RANGES.coils.end + 1).fill(0);
  const discreteInputs = new Array<0 | 1>(ADDRESS_RANGES.discreteInputs.end + 1).fill(0);

  return {
    readHoldingRegisters: (address: number, length: number, callback) => {
      const end = address + length;
      if (end > holdingRegisters.length) {
        callback(ErrorCode.ILLEGAL_DATA_ADDRESS, undefined);
        return;
      }
      callback(null, holdingRegisters.slice(address, end));
    },

    writeSingleRegister: (address: number, value: number, callback) => {
      if (address >= holdingRegisters.length) {
        callback(ErrorCode.ILLEGAL_DATA_ADDRESS);
        return;
      }
      holdingRegisters[address] = value & 0xffff;
      callback(null);
    },

    writeMultipleRegisters: (address: number, values: number[], callback) => {
      const end = address + values.length;
      if (end > holdingRegisters.length) {
        callback(ErrorCode.ILLEGAL_DATA_ADDRESS);
        return;
      }
      for (let i = 0; i < values.length; i++) {
        holdingRegisters[address + i] = values[i] & 0xffff;
      }
      callback(null);
    },

    readCoils: (address: number, length: number, callback) => {
      const end = address + length;
      if (end > coils.length) {
        callback(ErrorCode.ILLEGAL_DATA_ADDRESS, undefined);
        return;
      }
      callback(null, coils.slice(address, end));
    },

    writeSingleCoil: (address: number, value: number, callback) => {
      if (address >= coils.length) {
        callback(ErrorCode.ILLEGAL_DATA_ADDRESS);
        return;
      }
      coils[address] = value ? 1 : 0;
      callback(null);
    },

    writeMultipleCoils: (address: number, values: (0 | 1)[], callback) => {
      const end = address + values.length;
      if (end > coils.length) {
        callback(ErrorCode.ILLEGAL_DATA_ADDRESS);
        return;
      }
      for (let i = 0; i < values.length; i++) {
        coils[address + i] = values[i];
      }
      callback(null);
    },

    readDiscreteInputs: (address: number, length: number, callback) => {
      const end = address + length;
      if (end > discreteInputs.length) {
        callback(ErrorCode.ILLEGAL_DATA_ADDRESS, undefined);
        return;
      }
      callback(null, discreteInputs.slice(address, end));
    },

    /** Expose the live holding-register table for logging/debugging. */
    get holdingRegisters() {
      return holdingRegisters;
    },
  };
}

/**
 * Create a sensor unit model with read-only input registers and alarm coils.
 *
 * @param initialInputRegisters Seed values for the input-register table.
 * @returns A {@link ModbusUnitModel} with no write handlers.
 */
export function createSensorUnit(initialInputRegisters: number[]): ModbusUnitModel & {
  setInputRegisters: (values: number[]) => void;
  setAlarm: (address: number, active: boolean) => void;
} {
  const inputRegisters = [...initialInputRegisters];
  const alarmCoils = new Array<0 | 1>(ADDRESS_RANGES.coils.end + 1).fill(0);

  return {
    readInputRegisters: (address: number, length: number, callback) => {
      const end = address + length;
      if (end > inputRegisters.length) {
        callback(ErrorCode.ILLEGAL_DATA_ADDRESS, undefined);
        return;
      }
      callback(null, inputRegisters.slice(address, end));
    },

    readCoils: (address: number, length: number, callback) => {
      const end = address + length;
      if (end > alarmCoils.length) {
        callback(ErrorCode.ILLEGAL_DATA_ADDRESS, undefined);
        return;
      }
      callback(null, alarmCoils.slice(address, end));
    },

    /** Simulate a sensor update by rewriting the input-register table. */
    setInputRegisters: (values: number[]) => {
      inputRegisters.length = 0;
      inputRegisters.push(...values.slice(0, ADDRESS_RANGES.inputRegisters.end + 1));
    },

    /** Simulate an alarm state change. */
    setAlarm: (address: number, active: boolean) => {
      if (address < alarmCoils.length) {
        alarmCoils[address] = active ? 1 : 0;
      }
    },
  };
}
