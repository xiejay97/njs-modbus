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

import { CompactEventEmitter } from './compact-event';

interface TestEvents {
  zero: [];
  one: [number];
  two: [string, number];
  three: [number, string, boolean];
  four: [number, number, number, number];
  five: [number, number, number, number, number];
  six: [number, number, number, number, number, number];
}

class TestEmitter extends CompactEventEmitter<TestEvents> {
  emitZero(): boolean {
    return this.emit('zero');
  }

  emitOne(value: number): boolean {
    return this.emit('one', value);
  }

  emitTwo(a: string, b: number): boolean {
    return this.emit('two', a, b);
  }

  emitThree(a: number, b: string, c: boolean): boolean {
    return this.emit('three', a, b, c);
  }

  emitFour(a: number, b: number, c: number, d: number): boolean {
    return this.emit('four', a, b, c, d);
  }

  emitFive(a: number, b: number, c: number, d: number, e: number): boolean {
    return this.emit('five', a, b, c, d, e);
  }

  emitSix(a: number, b: number, c: number, d: number, e: number, f: number): boolean {
    return this.emit('six', a, b, c, d, e, f);
  }

  emitLazyOne(factory: () => number): boolean {
    return this.emitLazy('one', factory);
  }
}

describe('CompactEventEmitter', () => {
  it('returns false when emitting an event with no listeners', () => {
    const emitter = new TestEmitter();
    expect(emitter.emitOne(1)).toBe(false);
  });

  it('calls a single listener with one argument', () => {
    const emitter = new TestEmitter();
    const fn = vi.fn();
    emitter.on('one', fn);
    expect(emitter.emitOne(42)).toBe(true);
    expect(fn).toHaveBeenCalledWith(42);
  });

  it('calls listeners for 0 through 6 arguments', () => {
    const emitter = new TestEmitter();
    const spy0 = vi.fn();
    const spy1 = vi.fn();
    const spy2 = vi.fn();
    const spy3 = vi.fn();
    const spy4 = vi.fn();
    const spy5 = vi.fn();
    const spy6 = vi.fn();

    emitter.on('zero', spy0);
    emitter.on('one', spy1);
    emitter.on('two', spy2);
    emitter.on('three', spy3);
    emitter.on('four', spy4);
    emitter.on('five', spy5);
    emitter.on('six', spy6);

    emitter.emitZero();
    emitter.emitOne(1);
    emitter.emitTwo('a', 2);
    emitter.emitThree(1, 'b', true);
    emitter.emitFour(1, 2, 3, 4);
    emitter.emitFive(1, 2, 3, 4, 5);
    emitter.emitSix(1, 2, 3, 4, 5, 6);

    expect(spy0).toHaveBeenCalledWith();
    expect(spy1).toHaveBeenCalledWith(1);
    expect(spy2).toHaveBeenCalledWith('a', 2);
    expect(spy3).toHaveBeenCalledWith(1, 'b', true);
    expect(spy4).toHaveBeenCalledWith(1, 2, 3, 4);
    expect(spy5).toHaveBeenCalledWith(1, 2, 3, 4, 5);
    expect(spy6).toHaveBeenCalledWith(1, 2, 3, 4, 5, 6);
  });

  it('calls multiple listeners in registration order', () => {
    const emitter = new TestEmitter();
    const calls: number[] = [];
    emitter.on('one', () => calls.push(1));
    emitter.on('one', () => calls.push(2));
    emitter.emitOne(0);
    expect(calls).toEqual([1, 2]);
  });

  it('removes a listener with off', () => {
    const emitter = new TestEmitter();
    const fn = vi.fn();
    emitter.on('one', fn);
    emitter.off('one', fn);
    emitter.emitOne(1);
    expect(fn).not.toHaveBeenCalled();
  });

  it('returns this from off when the listener is not found', () => {
    const emitter = new TestEmitter();
    const fn = vi.fn();
    expect(emitter.off('one', fn)).toBe(emitter);
  });

  it('removes a one-time listener after it fires', () => {
    const emitter = new TestEmitter();
    const fn = vi.fn();
    emitter.once('one', fn);
    emitter.emitOne(1);
    emitter.emitOne(2);
    expect(fn).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(1);
  });

  it('removeAllListeners clears all listeners when called without argument', () => {
    const emitter = new TestEmitter();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('one', a);
    emitter.on('two', b);
    emitter.removeAllListeners();
    emitter.emitOne(1);
    emitter.emitTwo('x', 2);
    expect(a).not.toHaveBeenCalled();
    expect(b).not.toHaveBeenCalled();
  });

  it('removeAllListeners clears only the specified event', () => {
    const emitter = new TestEmitter();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on('one', a);
    emitter.on('two', b);
    emitter.removeAllListeners('one');
    emitter.emitOne(1);
    emitter.emitTwo('x', 2);
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledWith('x', 2);
  });

  it('supports addListener and removeListener aliases', () => {
    const emitter = new TestEmitter();
    const fn = vi.fn();
    emitter.addListener('one', fn);
    emitter.emitOne(1);
    emitter.removeListener('one', fn);
    emitter.emitOne(2);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it('emitLazy returns false and skips the factory when there are no listeners', () => {
    const emitter = new TestEmitter();
    const factory = vi.fn(() => 99);
    expect(emitter.emitLazyOne(factory)).toBe(false);
    expect(factory).not.toHaveBeenCalled();
  });

  it('emitLazy calls the factory once and passes the payload', () => {
    const emitter = new TestEmitter();
    const fn = vi.fn();
    const factory = vi.fn(() => 42);
    emitter.on('one', fn);
    expect(emitter.emitLazyOne(factory)).toBe(true);
    expect(factory).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledWith(42);
  });
});
