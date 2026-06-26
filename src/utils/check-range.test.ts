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

import { checkRange } from './check-range';

describe('checkRange', () => {
  it('should return true when no range is provided', () => {
    expect(checkRange(5)).toBe(true);
    expect(checkRange([1, 5], undefined)).toBe(true);
  });

  it('should check a single value against a single range', () => {
    expect(checkRange(5, [0, 10])).toBe(true);
    expect(checkRange(15, [0, 10])).toBe(false);
  });

  it('should handle reversed ranges', () => {
    expect(checkRange(5, [10, 0])).toBe(true);
    expect(checkRange(15, [10, 0])).toBe(false);
  });

  it('should handle reversed ranges in all contexts', () => {
    expect(checkRange(5, [[10, 0]])).toBe(true);
    expect(checkRange([5], [10, 0])).toBe(true);
    expect(checkRange([5], [[10, 0]])).toBe(true);
    expect(checkRange([15], [10, 0])).toBe(false);
    expect(checkRange([15], [[10, 0]])).toBe(false);
  });

  it('should check a single value against multiple ranges', () => {
    expect(
      checkRange(5, [
        [0, 2],
        [4, 6],
      ]),
    ).toBe(true);
    expect(
      checkRange(3, [
        [0, 2],
        [4, 6],
      ]),
    ).toBe(false);
  });

  it('should check an array of values against a single range', () => {
    expect(checkRange([1, 5, 9], [0, 10])).toBe(true);
    expect(checkRange([1, 15, 9], [0, 10])).toBe(false);
  });

  it('should check an array of values against multiple ranges', () => {
    expect(
      checkRange(
        [5, 9],
        [
          [0, 2],
          [4, 10],
        ],
      ),
    ).toBe(true);
    expect(
      checkRange(
        [1, 5, 9],
        [
          [0, 2],
          [4, 10],
        ],
      ),
    ).toBe(false);
    expect(
      checkRange(
        [1, 3, 9],
        [
          [0, 2],
          [4, 10],
        ],
      ),
    ).toBe(false);
  });

  it('should return true for an empty value array', () => {
    expect(checkRange([], [0, 10])).toBe(true);
    expect(
      checkRange(
        [],
        [
          [0, 2],
          [4, 10],
        ],
      ),
    ).toBe(true);
  });
});
