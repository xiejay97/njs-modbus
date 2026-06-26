/*
 * Copyright (c) 2026 xiejay97
 *
 * Licensed under the Business Source License 1.1 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * Change Date: 2029-06-24
 *
 * On the date above, in accordance with the Change Date, the Licensed Work
 * will be made available under the Apache License, Version 2.0.
 *
 * You may obtain a copy of the License at
 *     https://mariadb.com/bsl11/
 */

/**
 * Inclusive numeric range membership test for a scalar or array of values.
 *
 * Semantics:
 * - When `range` is a single `[a, b]` tuple, the test is `min(a,b) <= v <= max(a,b)`
 *   for every value (tuples are direction-agnostic so callers can pass either
 *   `[0, 10]` or `[10, 0]`).
 * - When `range` is a list of tuples, scalar `value` matches if it falls in
 *   ANY tuple, while array `value` matches only if there exists a single
 *   tuple containing ALL of its elements.
 * - When `range` is omitted or empty, the function returns `true` (no bounds
 *   are enforced — used by the slave dispatch path to model "wildcard"
 *   address spaces).
 *
 * Used by the slave-side address gate to validate FC 1/2/3/4/5/6/15/16/22/23
 * register and coil offsets before invoking user handlers; a `false` return
 * is translated by the caller into an `ILLEGAL_DATA_ADDRESS` exception.
 *
 * @param value Scalar offset, or array of offsets to validate atomically
 *   (unit: zero-based address).
 * @param range Optional `[lo, hi]` tuple, or array of such tuples
 *   (unit: zero-based address; inclusive both ends).
 * @returns `true` when the value(s) lie inside one of the (sub-)ranges.
 */
export function checkRange(value: number | number[], range?: [number, number] | [number, number][]): boolean {
  if (!range || range.length === 0) {
    return true;
  }

  const isMultiRange = Array.isArray(range[0]);
  const isValueArray = Array.isArray(value);

  if (!isValueArray && !isMultiRange) {
    const r = range as [number, number];
    const min = r[0],
      max = r[1];
    const v = value as number;
    return min <= max ? v >= min && v <= max : v >= max && v <= min;
  }

  if (!isValueArray && isMultiRange) {
    const ranges = range as [number, number][];
    const v = value as number;
    for (let i = 0; i < ranges.length; i++) {
      const min = ranges[i][0],
        max = ranges[i][1];
      const lo = min <= max ? min : max;
      const hi = min <= max ? max : min;
      if (v >= lo && v <= hi) {
        return true;
      }
    }
    return false;
  }

  const values = value as number[];
  if (values.length === 0) {
    return true;
  }

  if (!isMultiRange) {
    const r = range as [number, number];
    const min = r[0],
      max = r[1];
    const lo = min <= max ? min : max;
    const hi = min <= max ? max : min;

    for (let i = 0; i < values.length; i++) {
      if (values[i] < lo || values[i] > hi) {
        return false;
      }
    }
    return true;
  }

  const ranges = range as [number, number][];
  for (let i = 0; i < ranges.length; i++) {
    const min = ranges[i][0],
      max = ranges[i][1];
    const lo = min <= max ? min : max;
    const hi = min <= max ? max : min;

    let allInRange = true;
    for (let j = 0; j < values.length; j++) {
      if (values[j] < lo || values[j] > hi) {
        allInRange = false;
        break;
      }
    }
    if (allInRange) {
      return true;
    }
  }

  return false;
}
