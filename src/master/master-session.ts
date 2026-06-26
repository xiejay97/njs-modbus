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

import type { ModbusFrame } from '../types';

/**
 * Internal resolution callback for a pending master request session.
 *
 * Plain Node-style error-first callback delivered once by
 * {@link MasterSession.start} — the orchestrator wraps its result into a
 * {@link ModbusResponse} / rejected `Promise` for public callers, so this
 * signature never escapes the framework boundary.
 *
 * @internal
 */
type Callback = (error: Error | null, frame?: ModbusFrame) => void;

/**
 * Sentinel session key used by RTU and ASCII masters where there is no
 * MBAP transaction id to disambiguate concurrent requests.
 *
 * Under FIFO / drop-stale / deduplicate strategies only one in-flight
 * non-broadcast request exists at a time on these transports, so a
 * single fixed key is sufficient — the upstream queue layer enforces
 * the at-most-one invariant.
 */
export const FIFO_KEY = 'fifo' as const;

/**
 * Inbound-frame ↔ pending-request matcher used by {@link ModbusMaster}.
 *
 * A `MasterSession` holds at most one waiter per session key — typically
 * the MBAP transaction id for TCP, or the `FIFO_KEY` sentinel for
 * RTU/ASCII. The class deliberately holds **no** timeout state — the
 * master's global {@link TimerHeap} owns the per-request deadline so a single
 * native `setTimeout` covers the entire fleet of in-flight exchanges.
 */
export class MasterSession {
  private _waiters = new Map<string | number, Callback>();

  /**
   * Register a waiter for `key`.
   *
   * Any existing waiter for the same key is overwritten without being fired.
   *
   * @param key Session key — TCP transaction id or {@link FIFO_KEY}.
   * @param callback Node-style callback invoked exactly once by
   *   {@link handleFrame} or {@link stopAll}.
   * @returns `void`.
   */
  start(key: string | number, callback: Callback): void {
    this._waiters.set(key, callback);
  }

  /**
   * Cancel the waiter for `key` without firing its callback.
   *
   * @param key Session key to remove.
   * @returns `void`.
   */
  stop(key: string | number): void {
    this._waiters.delete(key);
  }

  /**
   * Cancel every pending waiter and reject each with `error`.
   *
   * Used during master close / framing-error / transport-down scenarios
   * to deliver a single coherent failure to every in-flight caller. The
   * map is cleared **before** the callbacks fire so a callback that
   * synchronously enqueues a new request does not collide with the
   * teardown.
   *
   * @param error Error passed to every pending callback.
   * @returns `void`.
   */
  stopAll(error: Error): void {
    const waiters = [...this._waiters.values()];
    this._waiters.clear();
    for (const waiter of waiters) {
      waiter(error);
    }
  }

  /**
   * Check whether a waiter is currently registered for `key`.
   *
   * @param key Session key to test.
   * @returns `true` when a waiter exists for `key`.
   */
  has(key: string | number): boolean {
    return this._waiters.has(key);
  }

  /**
   * Match an inbound frame to a pending waiter.
   *
   * The session key is the frame's `transaction` for TCP and
   * {@link FIFO_KEY} for RTU/ASCII. Frames arriving with no matching waiter
   * (out-of-window response, spurious slave traffic) are silently discarded —
   * this is the master-side mirror of the slave's drop-unknown-FC behaviour.
   *
   * @param frame Decoded ADU produced by the protocol framing layer.
   * @returns `void`.
   */
  handleFrame(frame: ModbusFrame): void {
    const key: string | number = frame.transaction ?? FIFO_KEY;
    const waiter = this._waiters.get(key);
    if (!waiter) {
      return;
    }
    this._waiters.delete(key);
    waiter(null, frame);
  }

  /**
   * Surface a transport-level framing error to every pending waiter.
   *
   * Delegates to {@link stopAll} so the failure semantics are uniform.
   *
   * @param error Error to propagate to all pending callbacks.
   * @returns `void`.
   */
  handleError(error: Error): void {
    this.stopAll(error);
  }
}
