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

import { TimerHeap } from './timer-heap';

describe('TimerHeap', () => {
  it('should fire a single timer', () =>
    new Promise<void>((resolve) => {
      const heap = new TimerHeap((id) => {
        expect(id).toBe(1);
        resolve();
      });
      heap.add(1, 10);
    }));

  it('should fire multiple timers in deadline order', () =>
    new Promise<void>((resolve) => {
      const fired: number[] = [];
      const heap = new TimerHeap((id) => {
        fired.push(id);
        if (fired.length === 3) {
          expect(fired).toEqual([2, 1, 3]);
          resolve();
        }
      });
      heap.add(1, 20);
      heap.add(2, 5);
      heap.add(3, 30);
    }));

  it('should clear all pending timers', () =>
    new Promise<void>((resolve, reject) => {
      const heap = new TimerHeap(() => reject(new Error('should not fire')));
      heap.add(1, 10);
      heap.clear();
      setTimeout(resolve, 30);
    }));

  it('should report the number of pending timers', () => {
    const heap = new TimerHeap(() => void 0);
    expect(heap.size).toBe(0);
    heap.add(1, 1000);
    heap.add(2, 2000);
    expect(heap.size).toBe(2);
    heap.clear();
    expect(heap.size).toBe(0);
  });

  it('should switch to heap mode and fire many timers in order', () =>
    new Promise<void>((resolve) => {
      const fired: number[] = [];
      const heap = new TimerHeap((id) => {
        fired.push(id);
        if (fired.length === 5) {
          expect(fired).toEqual([1, 2, 3, 4, 5]);
          resolve();
        }
      }, 2);
      heap.add(1, 10);
      heap.add(2, 20);
      heap.add(3, 30);
      heap.add(4, 40);
      heap.add(5, 50);
    }));

  it('should migrate already-expired direct timers into heap mode', () =>
    new Promise<void>((resolve) => {
      let fired = 0;
      const heap = new TimerHeap(() => {
        fired++;
        if (fired === 2) {
          resolve();
        }
      }, 1);
      heap.add(1, 1000);
      heap.add(2, 1000);
      // Adding a third timer triggers migration. The first two should not be lost.
      heap.add(3, 1000);
    }));

  it('should clear timers in heap mode', () =>
    new Promise<void>((resolve, reject) => {
      const heap = new TimerHeap(() => reject(new Error('should not fire')), 1);
      heap.add(1, 10);
      heap.add(2, 20);
      heap.add(3, 30);
      heap.clear();
      setTimeout(resolve, 50);
    }));

  it('should migrate zero-delay direct timers into heap mode before they fire', () =>
    new Promise<void>((resolve) => {
      const fired: number[] = [];
      const heap = new TimerHeap((id) => {
        fired.push(id);
        if (fired.length === 2) {
          expect(fired.sort()).toEqual([1, 2]);
          resolve();
        }
      }, 1);
      heap.add(1, 0);
      heap.add(2, 10);
    }));

  it('should break sift-down early when the last element becomes the new root', () =>
    new Promise<void>((resolve) => {
      const fired: number[] = [];
      const heap = new TimerHeap((id) => {
        fired.push(id);
        if (fired.length === 3) {
          expect(fired).toEqual([1, 3, 2]);
          resolve();
        }
      }, 0);
      // Build a heap where the last element is smaller than its sibling.
      heap.add(1, 5);
      heap.add(2, 30);
      heap.add(3, 10);
    }));

  it('should remove a pending direct timer', () =>
    new Promise<void>((resolve, reject) => {
      const heap = new TimerHeap((id) => reject(new Error(`timer ${id} should not fire`)));
      heap.add(1, 10);
      expect(heap.remove(1)).toBe(true);
      expect(heap.size).toBe(0);
      setTimeout(resolve, 30);
    }));

  it('should return false when removing an unknown id', () => {
    const heap = new TimerHeap(() => void 0);
    expect(heap.remove(99)).toBe(false);
    heap.add(1, 10);
    expect(heap.remove(99)).toBe(false);
    expect(heap.size).toBe(1);
  });

  it('should remove a pending heap timer', () =>
    new Promise<void>((resolve, reject) => {
      const heap = new TimerHeap((id) => {
        if (id === 2) {
          reject(new Error(`timer ${id} should not fire`));
        } else {
          resolve();
        }
      }, 1);
      heap.add(1, 10);
      heap.add(2, 20);
      expect(heap.remove(2)).toBe(true);
      expect(heap.size).toBe(1);
    }));

  it('should remove the heap root and still fire the rest in order', () =>
    new Promise<void>((resolve) => {
      const fired: number[] = [];
      const heap = new TimerHeap((id) => {
        fired.push(id);
        if (fired.length === 2) {
          expect(fired).toEqual([2, 3]);
          resolve();
        }
      }, 0);
      heap.add(1, 5);
      heap.add(2, 10);
      heap.add(3, 15);
      expect(heap.remove(1)).toBe(true);
    }));

  it('should remove a middle heap entry and preserve order', () =>
    new Promise<void>((resolve) => {
      const fired: number[] = [];
      const heap = new TimerHeap((id) => {
        fired.push(id);
        if (fired.length === 3) {
          expect(fired).toEqual([1, 3, 5]);
          resolve();
        }
      }, 0);
      heap.add(1, 10);
      heap.add(2, 20);
      heap.add(3, 30);
      heap.add(4, 40);
      heap.add(5, 50);
      expect(heap.remove(2)).toBe(true);
      expect(heap.remove(4)).toBe(true);
    }));
});
