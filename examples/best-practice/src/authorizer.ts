/**
 * Reusable access-control policy for the best-practice example.
 *
 * The same policy is installed on both the master (to fail fast and avoid
 * queuing illegal requests) and the slave (to defend the model at the edge).
 */

import { ErrorCode } from 'njs-modbus';

import { ADDRESS_RANGES, ALLOWED_UNITS } from './config';

/**
 * Authorizer that whitelists units and clamps each table to its configured
 * inclusive address range.
 */
export const sharedAuthorizer = {
  /**
   * Reject unknown unit addresses before they reach the queue or model.
   *
   * @param unit Unit / slave address byte (0..247).
   * @returns `true` when the unit is in the allowed set.
   */
  checkUnit: (unit: number): boolean => ALLOWED_UNITS.has(unit),

  /**
   * Reject requests that touch addresses outside the configured table ranges.
   *
   * Standard FCs automatically provide `[startAddress, endAddress]` inclusive.
   *
   * @param _unit Unit / slave address byte.
   * @param table Modbus table being accessed.
   * @param [start, end] Inclusive zero-based address range.
   * @returns `true` when the range is fully inside the allowed window.
   */
  checkAddress: (
    _unit: number,
    table: 'coils' | 'discreteInputs' | 'inputRegisters' | 'holdingRegisters',
    [start, end]: [startAddress: number, endAddress: number],
  ): ErrorCode | boolean => {
    const range = ADDRESS_RANGES[table];
    if (start < range.start || end > range.end || start > end) {
      return ErrorCode.ILLEGAL_DATA_ADDRESS;
    }
    return true;
  },
} as const;
