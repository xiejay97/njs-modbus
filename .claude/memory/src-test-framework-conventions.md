---
name: src-test-framework-conventions
description: Unit-test framework conventions for src/: test only src/, co-located *.test.ts, shared helpers in test/helpers, mock physical layer, preserve hot-path inlining
metadata:
  type: project
---

# `src/` Unit-Test Framework Conventions

## Scope Rules

- **Only test source code under `src/`**. Do not add unit tests for `benchmark/` or `examples/`.
- Test files and shared helpers must not be bundled into `dist` or exposed as public API.

## Directory and Naming

- Co-locate tests with source: `src/utils/crc.ts` → `src/utils/crc.test.ts`.
- Shared helpers, fixtures, and mocks live under `test/helpers/`:
  - `mock-connection.ts`
  - `mock-physical-layer.ts`
  - `fixtures.ts`
  - `utils.ts`
- Test files must be named `*.test.ts`.
- Use Vitest globals (`describe`, `it`, `expect`, `beforeEach`, etc.); do **not** import from `vitest`.

## Configuration

- `vitest.config.ts`: keep `globals: true`, `coverage.include: ['src/**/*.ts']`, `coverage.exclude: ['src/**/*.test.ts']`.
- `tsconfig.build.json`: add `exclude: ["src/**/*.test.ts"]` so `tsdown` skips tests.
- `package.json`: use `vitest run` for the `test` script. Subpath imports are configured as:
  - `"#src/*": "./src/*"`
  - `"#test/*": "./test/*.ts"`

## Import Conventions

- Public API types/classes: `import { ... } from 'njs-modbus'`.
- Source module right next to the test: use a relative import, e.g. `import { crcFixed } from './crc'`.
- Other internal source modules: `import { ... } from '#src/...'`.
- Shared test helpers: `import { ... } from '#test/helpers/...'`.

## Mocks and Fixtures

- `MockPhysicalConnection extends AbstractPhysicalConnection`: records `write()` calls, provides `emitData(chunk)`, and supports `destroy()`.
- `MockPhysicalLayer extends AbstractPhysicalLayer`: `open()` immediately emits `open` then `connect`; `close()` emits `close` and cleans up.
- `fixtures.ts` provides `rtuFrame()`, `tcpFrame()`, `asciiFrame()`, and common PDU builders.
- `utils.ts` provides `waitForEvent()`, `flushPromises()`, `collectFrames()`.

## Test Layers

1. **Pure utilities**: crc, lrc, rtu-timing, checkRange, bitsToMs, whitelist, timer-heap, etc.
2. **Application-layer codecs**: RTU / ASCII / TCP `encode()`, single-frame fast path, residual reassembly, exception frames, custom function codes.
3. **Master / Slave protocol logic**: test via `MockPhysicalLayer` for FIFO / concurrent mode / timeouts / broadcasts / exceptions / custom FCs / interceptor / interval-lock.
4. **Physical layer**: avoid real network/serial tests by default; if necessary, use local loopback with `port: 0`.

## Opening Master/Slave in Tests

- When using a `CUSTOM` physical layer, the public `master.open()` / `slave.open()` is typed as `never`-args.
- Open the mock physical layer directly (`physicalLayer.open()`) so the master/slave receives the `connect` event and creates its application layer.
- See `src/master/master.test.ts` and `src/slave/slave.test.ts` for the pattern.

## Coding Conventions

- `describe('function or class name')` + `it('should ...')`.
- Each `it` prepares its own inputs; do not rely on execution order.
- Buffer assertions: `expect(buf).toEqual(Buffer.from([...]))`.
- Exception assertions: `await expect(p).rejects.toThrow(...)` or `.toBeInstanceOf(ModbusError)`.
- Avoid non-null assertions (`!`) in tests; use optional chaining or narrowing instead.
- Fake timers (`vi.useFakeTimers()`) are fine for utility tests; for Master/Slave timeout tests use real short timeouts to avoid mismatch with `performance.now()`.

## Performance Red Line

- **Do not refactor hot-path inlined loops or bit operations just to make them testable**.
- Do not test private methods (`_xxx`). Assert behavior through public API and events only.
- Do not change the public API or export extra internal state for testing.

## Verification Checklist

- `pnpm test` passes.
- `pnpm typecheck` passes (test files are type-checked too).
- `pnpm lint` passes (only pre-existing warnings in `benchmark/` and `examples/` remain).
- `pnpm build` output contains no `*.test.ts` or `test/helpers/` files.
- Coverage reports measure source files only, not tests or helpers.

## Why

- Co-located tests make it obvious where to add tests when a source file changes.
- Mocking the physical layer decouples protocol logic from real ports and hardware.
- Hot-path inlining is a hard requirement in `CLAUDE.md`; the test framework must not trade runtime performance for testability.

## How to Apply

- When adding a feature, add a co-located `*.test.ts` next to the source file.
- Reusable mocks/fixtures go in `test/helpers/`.
- Before and after changes run `pnpm test && pnpm typecheck && pnpm lint && pnpm build`.
- Use `src/utils/crc.test.ts`, `src/layers/application/rtu-application-layer.test.ts`, and `src/master/master.test.ts` as templates.

## Related

- [[benchmark-optimization-guidelines]] — also enforces zero-allocation hot paths; tests must not weaken this guarantee
