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
 * Hybrid timer manager: uses native `setTimeout` for low concurrency
 * and switches to a binary min-heap when concurrency exceeds the threshold.
 *
 * Benchmarks (add + clear throughput, Node 24, x64):
 *   1 concurrent:  setTimeout ~1.7× faster than heap
 *   2 concurrent:  setTimeout ~1.6× faster than heap
 *   5 concurrent:  setTimeout ~1.5-1.9× faster than heap
 *  10 concurrent:  roughly equal
 *  20 concurrent:  heap ~1.3× faster than setTimeout[]
 *  50 concurrent:  heap ~1.4-1.7× faster than setTimeout[]
 *
 * The crossover point is around 10 concurrent timers, so the default
 * `concurrentThreshold = 2` keeps the common 1-2 request case on the
 * fast direct path while delegating to the heap for larger batches.
 *
 * Used by the master to track per-request response timeouts. Tie-breaking
 * uses an insertion sequence counter so two timers scheduled at the same
 * `performance.now()` deadline still fire in registration order — this
 * matters for queue strategies that depend on FIFO timeout dispatch.
 */
export class TimerHeap {
  private _deadlines: number[] = [];
  private _ids: number[] = [];
  private _seqs: number[] = [];
  private _counter: number = 0;

  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _onFire: (id: number) => void;
  private _boundTick: () => void;

  private _threshold: number;
  private _mode: 'direct' | 'heap' = 'direct';
  private _directTimers = new Map<number, { handle: ReturnType<typeof setTimeout>; deadline: number }>();

  /**
   * @param onFire Callback invoked with the timer id when it expires.
   * @param concurrentThreshold Maximum number of timers kept as individual
   *   native `setTimeout` handles. Once exceeded, all timers migrate to the
   *   internal heap and share a single native timer. Default is 2.
   * @returns A new {@link TimerHeap} instance.
   */
  constructor(onFire: (id: number) => void, concurrentThreshold: number = 2) {
    this._onFire = onFire;
    this._boundTick = this._onTick.bind(this);
    this._threshold = concurrentThreshold;
  }

  /**
   * Number of pending timers — sums direct-mode and heap-mode entries.
   *
   * @returns Pending timer count.
   */
  get size(): number {
    return this._mode === 'direct' ? this._directTimers.size : this._deadlines.length;
  }

  /**
   * Register a timer that fires `ms` milliseconds from now.
   *
   * Stays on the direct (`setTimeout`-per-id) path while pending count is
   * below `concurrentThreshold`; otherwise migrates all existing direct
   * timers into the heap (preserving their absolute deadlines) and adds the
   * new timer to the heap as well.
   *
   * @param id Caller-assigned timer identifier — passed back to `onFire`.
   * @param ms Delay in milliseconds (relative to `performance.now()`).
   * @returns `void`.
   */
  add(id: number, ms: number): void {
    if (this._mode === 'direct' && this._directTimers.size + 1 <= this._threshold) {
      const deadline = performance.now() + ms;
      const handle = setTimeout(() => {
        if (this._mode !== 'direct') {
          return;
        }
        this._directTimers.delete(id);
        this._onFire(id);
      }, ms);
      this._directTimers.set(id, { handle, deadline });
      return;
    }

    if (this._mode === 'direct') {
      this._mode = 'heap';
      for (const [existingId, { handle, deadline }] of this._directTimers) {
        clearTimeout(handle);
        const diff = deadline - performance.now();
        const trunc = diff | 0;
        const remaining = diff > 0 ? trunc + (diff > trunc ? 1 : 0) : 0;
        if (remaining === 0) {
          this._onFire(existingId);
        } else {
          this._heapAdd(existingId, remaining);
        }
      }
      this._directTimers.clear();
    }

    this._heapAdd(id, ms);
  }

  /**
   * Cancel every pending timer and reset the structure to its empty,
   * direct-mode state. Safe to call from inside an `onFire` callback —
   * the heap-tick loop checks `_deadlines.length` between iterations.
   *
   * @returns `void`.
   */
  clear(): void {
    for (const { handle } of this._directTimers.values()) {
      clearTimeout(handle);
    }
    this._directTimers.clear();
    this._mode = 'direct';

    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    this._deadlines.length = 0;
    this._ids.length = 0;
    this._seqs.length = 0;
    this._counter = 0;
  }

  /**
   * Cancel the timer associated with `id`.
   *
   * In direct mode the native `setTimeout` is cleared immediately. In heap
   * mode the entry is located in the internal arrays, removed, and the heap
   * invariant is restored; if the removed entry was at the root, the shared
   * underlying timer is re-armed for the next earliest deadline.
   *
   * @param id Caller-assigned timer identifier passed to {@link add}.
   * @returns `true` if the id existed and was cancelled, otherwise `false`.
   */
  remove(id: number): boolean {
    if (this._mode === 'direct') {
      const entry = this._directTimers.get(id);
      if (!entry) {
        return false;
      }
      clearTimeout(entry.handle);
      this._directTimers.delete(id);
      return true;
    }

    const index = this._ids.indexOf(id);
    if (index === -1) {
      return false;
    }

    const wasRoot = index === 0;
    const lastIndex = this._deadlines.length - 1;

    const lastId = this._ids.pop()!;
    const lastDeadline = this._deadlines.pop()!;
    const lastSeq = this._seqs.pop()!;

    if (index < lastIndex) {
      this._ids[index] = lastId;
      this._deadlines[index] = lastDeadline;
      this._seqs[index] = lastSeq;
      this._sift(index);
    }

    if (wasRoot) {
      this._refresh();
    }

    return true;
  }

  /**
   * Insert a new entry into the binary min-heap and re-arm the underlying
   * `setTimeout` if it now points at a more imminent deadline.
   *
   * Deliberately uses parallel arrays of primitives instead of an object
   * pool to avoid per-insert allocations.
   *
   * @param id Timer identifier.
   * @param ms Delay in milliseconds (relative to `performance.now()`).
   * @returns `void`.
   */
  private _heapAdd(id: number, ms: number): void {
    const deadline = performance.now() + ms;
    const seq = this._counter++;
    let i = this._deadlines.length;

    this._deadlines.push(deadline);
    this._ids.push(id);
    this._seqs.push(seq);

    while (i > 0) {
      const p = (i - 1) >> 1;

      const parentComesFirst = this._deadlines[p] < deadline || (this._deadlines[p] === deadline && this._seqs[p] < seq);

      if (parentComesFirst) {
        break;
      }

      this._deadlines[i] = this._deadlines[p];
      this._ids[i] = this._ids[p];
      this._seqs[i] = this._seqs[p];
      i = p;
    }

    this._deadlines[i] = deadline;
    this._ids[i] = id;
    this._seqs[i] = seq;

    if (i === 0) {
      this._refresh();
    }
  }

  /**
   * Re-program the single shared `setTimeout` to fire at the heap's
   * earliest deadline. Clamps to Node's 32-bit `setTimeout` ceiling
   * (`2^31 - 1` ms) for safety.
   *
   * @returns `void`.
   */
  private _refresh(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    if (this._deadlines.length === 0) {
      return;
    }

    const diff = this._deadlines[0] - performance.now();
    const trunc = diff | 0;
    const delay = diff > 0 ? trunc + (diff > trunc ? 1 : 0) : 0;
    const safeDelay = delay < 2147483647 ? delay : 2147483647;

    this._timer = setTimeout(this._boundTick, safeDelay);
  }

  /**
   * Single-tick handler — drains every timer whose deadline has already
   * elapsed and re-arms the underlying `setTimeout` for the next earliest
   * deadline (or stays disarmed if the heap is now empty).
   *
   * @returns `void`.
   */
  private _onTick(): void {
    this._timer = null;
    const now = performance.now();

    try {
      while (this._deadlines.length > 0 && this._deadlines[0] <= now) {
        const id = this._pop();
        this._onFire(id);
      }
    } finally {
      this._refresh();
    }
  }

  /**
   * Remove and return the heap's earliest-deadline id, restoring the
   * min-heap invariant via sift-down. Tie-breaks on insertion sequence
   * to keep FIFO order across equal deadlines.
   *
   * @returns The timer id with the earliest deadline.
   */
  private _pop(): number {
    const topId = this._ids[0];
    const lastId = this._ids.pop()!;
    const lastDeadline = this._deadlines.pop()!;
    const lastSeq = this._seqs.pop()!;
    const n = this._deadlines.length;

    if (n > 0) {
      let i = 0;
      const half = n >> 1;

      while (i < half) {
        let minChild = (i << 1) + 1;
        const rightChild = minChild + 1;

        if (rightChild < n) {
          const rightComesFirst =
            this._deadlines[rightChild] < this._deadlines[minChild] ||
            (this._deadlines[rightChild] === this._deadlines[minChild] && this._seqs[rightChild] < this._seqs[minChild]);

          if (rightComesFirst) {
            minChild = rightChild;
          }
        }

        const lastComesFirst =
          lastDeadline < this._deadlines[minChild] || (lastDeadline === this._deadlines[minChild] && lastSeq < this._seqs[minChild]);

        if (lastComesFirst) {
          break;
        }

        this._deadlines[i] = this._deadlines[minChild];
        this._ids[i] = this._ids[minChild];
        this._seqs[i] = this._seqs[minChild];
        i = minChild;
      }

      this._deadlines[i] = lastDeadline;
      this._ids[i] = lastId;
      this._seqs[i] = lastSeq;
    }
    return topId;
  }

  /**
   * Restore the min-heap invariant starting at `index` after an element
   * has been replaced. Moves the element up if it is earlier than its
   * parent, otherwise sifts it down toward the leaves.
   *
   * @param index Heap position whose value may violate the invariant.
   * @returns `void`.
   */
  private _sift(index: number): void {
    const id = this._ids[index];
    const deadline = this._deadlines[index];
    const seq = this._seqs[index];

    let i = index;

    while (i > 0) {
      const parent = (i - 1) >> 1;
      const parentComesFirst = this._deadlines[parent] < deadline || (this._deadlines[parent] === deadline && this._seqs[parent] < seq);

      if (parentComesFirst) {
        break;
      }

      this._deadlines[i] = this._deadlines[parent];
      this._ids[i] = this._ids[parent];
      this._seqs[i] = this._seqs[parent];
      i = parent;
    }

    if (i !== index) {
      this._deadlines[i] = deadline;
      this._ids[i] = id;
      this._seqs[i] = seq;
      return;
    }

    const n = this._deadlines.length;
    const half = n >> 1;

    while (i < half) {
      let minChild = (i << 1) + 1;
      const rightChild = minChild + 1;

      if (rightChild < n) {
        const rightComesFirst =
          this._deadlines[rightChild] < this._deadlines[minChild] ||
          (this._deadlines[rightChild] === this._deadlines[minChild] && this._seqs[rightChild] < this._seqs[minChild]);

        if (rightComesFirst) {
          minChild = rightChild;
        }
      }

      const thisComesFirst = deadline < this._deadlines[minChild] || (deadline === this._deadlines[minChild] && seq < this._seqs[minChild]);

      if (thisComesFirst) {
        break;
      }

      this._deadlines[i] = this._deadlines[minChild];
      this._ids[i] = this._ids[minChild];
      this._seqs[i] = this._seqs[minChild];
      i = minChild;
    }

    if (i !== index) {
      this._deadlines[i] = deadline;
      this._ids[i] = id;
      this._seqs[i] = seq;
    }
  }
}
