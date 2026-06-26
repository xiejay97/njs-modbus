# njs-modbus Benchmark Suite

This directory contains the benchmark suite for `njs-modbus`. It was rebuilt to keep the original measurement depth while making the harness easier to extend, debug, and run in isolation.

## Architecture

```
benchmark/
├── adapters/        # LibraryAdapter registry and implementations
├── engine/          # Task scheduler + process models (fork / worker / in-process)
├── transport/       # Raw TCP and serial transport helpers
├── jitter/          # Jitter-resistant byte collector
├── chaos/           # Chaos scene definitions, runner, and validators
├── codec/           # Encode/decode micro-benchmark runner
├── reports/         # Report coordinator and Markdown generators
├── workers/         # Forked / worker-thread entry points
├── bench-run.ts           # Unified runner: select suites via CLI flags
├── bench-test-report.ts   # Smoke-test report generator using mock data
├── macro.ts               # Shared end-to-end benchmark loop
├── bench-chaos.ts         # Legacy standalone chaos runner (also exposed via bench-run.ts)
├── bench-encode-decode.ts # Legacy standalone codec runner
├── bench-transport-suite.ts
└── bench-all-fcs.ts
```

- **Adapters** decouple the benchmark core from third-party libraries. Each adapter advertises its supported protocols and optional codec capability.
- **Execution engine** (`engine/runTasks`) schedules tasks with bounded concurrency across forked children, worker threads, or in-process execution.
- **Macro harness** (`macro.ts`) provides the shared end-to-end benchmark loop used by transport-suite and all-fcs.
- **Codec runner** measures encode/decode throughput for all `{tcp,rtu,ascii} × {request,response} × {encode,decode}` combinations.
- **Transport suite** measures FC03 readHoldingRegisters across `{sequential,pipelined,multiconn} × {TCP,RTU,ASCII}`.
- **All function codes** measures every standard FC end-to-end over TCP.
- **Chaos runner** exercises parser resilience against 38 corrupted/framed scenarios and reports accuracy, recovery latency, memory growth, and jitter contamination.
- **Report coordinator** uses the engine to run all benchmarks, picks the median run per test point, and feeds the Markdown generator.

## Commands

### npm scripts

```bash
# Generate mock reports instantly (no real benchmarks; validates report pipeline)
pnpm benchmark:test

# Fast full report: short durations, 1 run, high concurrency
pnpm benchmark:fast

# Full report: 5 runs, 120 s transport duration, 2000 chaos requests, max payload
pnpm benchmark:full
```

### Unified runner

`benchmark/bench-run.ts` prints JSON to stdout by default. Add `--report` to build the Markdown reports instead.

```bash
# Selected suites, JSON output
pnpm benchmark -- --all-fcs --fast --runs 1
pnpm benchmark -- --transport --all-fcs

# Full report with fast defaults
pnpm benchmark -- --all --report --fast --runs 1

# Full report with max payload
pnpm benchmark -- --all --report --fast --runs 1 --max-payload

# Override specific defaults
pnpm benchmark -- --transport --all-fcs --report --duration 60 --runs 3
pnpm benchmark -- --chaos --report --chaos-requests 1000 --libraries njs-modbus,jsmodbus
```

### Legacy standalone entry points

These still work for debugging a single suite in isolation:

```bash
pnpm exec tsx benchmark/bench-transport-suite.ts --fast --runs 1
pnpm exec tsx benchmark/bench-all-fcs.ts --fast --runs 1
pnpm exec tsx benchmark/bench-encode-decode.ts --fast --runs 2
pnpm exec tsx benchmark/bench-encode-decode.ts --fast --runs 2 --suites asciiResDecode
pnpm exec tsx --expose-gc benchmark/bench-chaos.ts --fast --runs 1
pnpm exec tsx --expose-gc benchmark/bench-chaos.ts --fast --runs 1 --protocol TCP
```

## CLI options

| Flag                               | Description                                                                    |
| ---------------------------------- | ------------------------------------------------------------------------------ |
| `--all`                            | Run all suites (`--encode-decode --transport --all-fcs --all-fcs-max --chaos`) |
| `--encode-decode`, `--codec`       | Codec micro-benchmark                                                          |
| `--transport`, `--transport-suite` | Transport suite                                                                |
| `--all-fcs`                        | All function codes (normal payload)                                            |
| `--all-fcs-max`                    | All function codes (max payload)                                               |
| `--chaos`                          | Chaos scenes                                                                   |
| `--report`                         | Build Markdown reports instead of printing JSON                                |
| `--fast`                           | Short durations, 1 run, and full-machine concurrency (see below)               |
| `--runs N`                         | Repeated runs per test point                                                   |
| `--duration N`                     | Per-test wall-clock duration in seconds (transport + all-fcs)                  |
| `--duration-ms N`                  | Same as `--duration` but in milliseconds                                       |
| `--chaos-requests N`               | Iteration count per chaos (scene, library) pair                                |
| `--libraries A,B,C`                | Comma-separated library subset                                                 |
| `--suites A,B,C`                   | Comma-separated codec suite subset (used by `--encode-decode` / `--all`)       |
| `--concurrency N`                  | Maximum concurrent benchmark tasks                                             |
| `--max-payload`                    | Include max-payload variant when running `--all` or `--report`                 |
| `--output PATH`, `-o PATH`         | Write JSON / Markdown to PATH                                                  |
| `-h`, `--help`                     | Show usage                                                                     |

## `--fast` defaults

Passing `--fast` shortens durations and defaults to a single run. It also lifts the conservative concurrency caps used in normal runs so that the full benchmark finishes as quickly as possible.

| Parameter                               | `--fast` default             | Normal default        |
| --------------------------------------- | ---------------------------- | --------------------- |
| `runs`                                  | `1`                          | `3`                   |
| Codec `minDurationMs`                   | `500`                        | `5000`                |
| Codec `warmupDurationMs`                | `200`                        | `3000`                |
| Codec `warmupIterations`                | `1000`                       | `50000`               |
| Transport `durationMs`                  | `8000`                       | `30000`               |
| All-FCs `durationMs`                    | `3000`                       | `10000`               |
| Chaos `chaosRequests`                   | `50`                         | `200`                 |
| Codec concurrency                       | `availableParallelism() - 1` | `1`                   |
| Chaos / Transport / All-FCs concurrency | `availableParallelism() - 1` | `min(concurrency, 4)` |

All `--fast` defaults can be overridden explicitly (e.g. `--runs 3 --fast`).

## Report outputs

With `--report` the runner writes two Markdown files:

- `benchmark/report_presentation.md` — human-readable report with tables and commentary.
- `benchmark/report_data.md` — flat tables intended for downstream analysis and diffs.

## Notes

- Optional dependencies (`jsmodbus`, `modbus-serial`) are loaded lazily. If they are not installed, the report simply skips them instead of crashing.
- Forked workers are started with `--import tsx --expose-gc`; worker threads use `--import tsx` because Node does not accept `--expose-gc` in Worker `execArgv`.
- In normal runs, Chaos, Transport, and All-FCs cap concurrency at 4 to protect wall-clock metrics from kernel network/PTY contention and event-loop jitter. `--fast` lifts those caps for speed.
