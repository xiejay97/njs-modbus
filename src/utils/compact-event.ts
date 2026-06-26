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

/** Sentinel type used as the default event map for an untyped emitter. */
type DefaultEventMap = [never];

/**
 * Event map contract: either a record of event names to argument tuples, or
 * the {@link DefaultEventMap} sentinel for untyped emitters.
 *
 * @template T The emitter's event map type.
 */
type EventMap<T> = Record<keyof T, any[]> | DefaultEventMap;

/**
 * Valid event key type for a given event map.
 *
 * @template K Candidate key from the typed map.
 * @template T The emitter's event map type.
 */
type Key<K, T> = T extends DefaultEventMap ? string | symbol : K | keyof T;

/** Shorthand for an arbitrary argument list. */
type AnyRest = [...args: any[]];

/**
 * Argument tuple for a specific event key.
 *
 * @template K Candidate key from the typed map.
 * @template T The emitter's event map type.
 */
type Args<K, T> = T extends DefaultEventMap ? AnyRest : K extends keyof T ? T[K] : never;

/**
 * Listener signature for a specific event key and fallback shape.
 *
 * @template K Candidate key from the typed map.
 * @template T The emitter's event map type.
 * @template F Fallback listener signature when the map is untyped.
 */
type Listener<K, T, F> = T extends DefaultEventMap
  ? F
  : K extends keyof T
    ? T[K] extends unknown[]
      ? (...args: T[K]) => void
      : never
    : never;

/**
 * Listener signature with a generic fallback, used by {@link CompactEventEmitter.on}.
 *
 * @template K Candidate key from the typed map.
 * @template T The emitter's event map type.
 */
type Listener1<K, T> = Listener<K, T, (...args: any[]) => void>;

/**
 * A tiny, zero-dependency event emitter optimized for typed, internal use.
 *
 * Supports the same `on`/`once`/`off`/`emit` surface as Node's
 * `EventEmitter`, but stores listeners in a flat object keyed by event name
 * and unrolls the emit loop for up to five arguments to avoid rest-array
 * allocation on common call patterns.
 *
 * @template T Typed event map. Use the default `DefaultEventMap` for an
 *   untyped emitter that accepts any string/symbol event.
 */
export class CompactEventEmitter<T extends EventMap<T> = DefaultEventMap> {
  /** Alias for {@link on}. */
  public addListener: this['on'];
  /** Alias for {@link off}. */
  public removeListener: this['off'];

  private _registry: Record<string, ((...args: any[]) => void)[] | undefined> = Object.create(null);

  constructor() {
    this.addListener = this.on;
    this.removeListener = this.off;
  }

  /**
   * Register a listener for `eventName`.
   *
   * @template K Candidate event key inferred from the typed map.
   * @param eventName Event name to subscribe to.
   * @param listener Callback invoked when the event fires.
   * @returns `this` for chaining.
   */
  on<K>(eventName: Key<K, T>, listener: Listener1<K, T>): this {
    const list = this._registry[eventName as string];
    if (list === undefined) {
      this._registry[eventName as string] = [listener];
    } else {
      list.push(listener);
    }
    return this;
  }

  /**
   * Register a one-time listener for `eventName`.
   *
   * The listener is removed automatically before it is invoked.
   *
   * @template K Candidate event key inferred from the typed map.
   * @param eventName Event name to subscribe to.
   * @param listener Callback invoked when the event fires.
   * @returns `this` for chaining.
   */
  once<K>(eventName: Key<K, T>, listener: Listener1<K, T>): this {
    const wrapper = (...args: any[]) => {
      this.off(eventName, wrapper as Listener1<K, T>);
      listener(...args);
    };
    (wrapper as any).origin = listener;
    this.on(eventName, wrapper as Listener1<K, T>);
    return this;
  }

  /**
   * Remove a previously registered listener for `eventName`.
   *
   * @template K Candidate event key inferred from the typed map.
   * @param eventName Event name to unsubscribe from.
   * @param listener Listener reference to remove.
   * @returns `this` for chaining.
   */
  off<K>(eventName: Key<K, T>, listener: Listener1<K, T>): this {
    const list = this._registry[eventName as string];
    if (list === undefined) {
      return this;
    }

    const index = list.findIndex((item) => item === listener || (item as any).origin === listener);
    if (index !== -1) {
      list.splice(index, 1);
      if (list.length === 0) {
        this._registry[eventName as string] = undefined;
      }
    }
    return this;
  }

  /**
   * Remove all listeners for a specific event, or for all events.
   *
   * @template K Candidate event key inferred from the typed map.
   * @param event Optional event name. When omitted, every listener is cleared.
   * @returns `this` for chaining.
   */
  removeAllListeners(event?: Key<unknown, T>): this {
    if (event) {
      this._registry[event as string] = undefined;
    } else {
      this._registry = Object.create(null);
    }
    return this;
  }

  /**
   * Synchronously invoke all listeners for `eventName`.
   *
   * @template K Candidate event key inferred from the typed map.
   * @param eventName Event name to emit.
   * @param args Arguments passed to each listener.
   * @returns `true` if listeners were registered, `false` otherwise.
   */
  protected emit<K>(eventName: Key<K, T>, ...args: Args<K, T>): boolean {
    const list = this._registry[eventName as string];
    if (list === undefined) {
      return false;
    }

    const len = list.length;

    switch (args.length) {
      case 0: {
        for (let i = 0; i < len; i++) {
          list[i]();
        }
        break;
      }

      case 1: {
        const a0 = args[0];
        for (let i = 0; i < len; i++) {
          list[i](a0);
        }
        break;
      }

      case 2: {
        const a0 = args[0],
          a1 = args[1];
        for (let i = 0; i < len; i++) {
          list[i](a0, a1);
        }
        break;
      }

      case 3: {
        const a0 = args[0],
          a1 = args[1],
          a2 = args[2];
        for (let i = 0; i < len; i++) {
          list[i](a0, a1, a2);
        }
        break;
      }

      case 4: {
        const a0 = args[0],
          a1 = args[1],
          a2 = args[2],
          a3 = args[3];
        for (let i = 0; i < len; i++) {
          list[i](a0, a1, a2, a3);
        }
        break;
      }

      case 5: {
        const a0 = args[0],
          a1 = args[1],
          a2 = args[2],
          a3 = args[3],
          a4 = args[4];
        for (let i = 0; i < len; i++) {
          list[i](a0, a1, a2, a3, a4);
        }
        break;
      }

      default: {
        for (let i = 0; i < len; i++) {
          list[i](...args);
        }
        break;
      }
    }

    return true;
  }

  /**
   * Emit a single-argument event, but only compute the payload if listeners
   * are registered.
   *
   * @template K Candidate event key inferred from the typed map.
   * @param eventName Event name to emit.
   * @param payloadFactory Factory called once when at least one listener exists.
   * @returns `true` if listeners were registered, `false` otherwise.
   */
  protected emitLazy<K>(eventName: Key<K, T>, payloadFactory: () => Args<K, T>[0]): boolean {
    if (this._registry[eventName as string] === undefined) {
      return false;
    }
    const payload = payloadFactory();
    const list = this._registry[eventName as string]!;
    for (let i = 0; i < list.length; i++) {
      list[i](payload);
    }
    return true;
  }
}
