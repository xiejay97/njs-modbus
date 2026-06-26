---
name: benchmark-optimization-guidelines
description: Benchmark optimization principles: eliminate hot-path allocations, use optimal APIs, follow all-fcs-worker as the reference
metadata:
  type: project
---

# Benchmark Optimization Guidelines

All benchmarks under `benchmark/` must ensure that **each library is measured in its best possible state** — the benchmark harness itself must not become the bottleneck.

## Core principles

1. **Zero allocation on hot paths**
   - Inside the `fn` callback passed to `micro()` or `macro()`, avoid creating objects, arrays, `Buffer`s, or strings on every iteration.
   - Hoist stable payloads, request descriptors, slave handler return values, and other constants to module level or outside the closure.

2. **Use each library's optimal API**
   - `njs-modbus`: slave reads should return `TypedArray.subarray()` views; bulk writes should use `TypedArray.set()`; enable `concurrent: true` for pipelining where applicable.
   - `modbus-serial`: provide bulk vector methods such as `getMultipleHoldingRegisters` / `setRegisterArray`, and return TypedArray views (its handler only uses `.length` and indexed access).
   - `jsmodbus`: pre-convert coil/register data into the form it accepts (e.g. `Buffer.from(coilArray)`).

3. **Treat `all-fcs-worker.ts` as the canonical example**
   - That worker already hoists stable data, returns views from slave handlers, and uses bulk writes.
   - When adding or modifying a worker, compare it against `all-fcs-worker.ts` to check for any per-request allocations that can be removed.

## Why

- If the harness allocates on the hot path, GC will pollute the measured CPU, latency, and memory numbers, so the results no longer reflect the library's real performance.
- Using the wrong API (e.g. `Array.from` in a slave read handler, or ASCII decode via string/hex) artificially lowers one library's numbers and makes head-to-head comparisons unfair.

## How to apply

- Before modifying a worker, locate the `fn` callback passed to `micro()`/`macro()` and audit every line for in-loop allocations.
- Allocate the slave/server backing store once during setup (`Uint16Array` / `Buffer`), and return only `subarray` views in the hot path.
- When comparing libraries, make sure each one is invoked through its most efficient supported API, not a "lowest common denominator" wrapper.
- After changes, run the relevant benchmark with `--fast` to verify it still produces valid results.
