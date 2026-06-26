# Benchmark Report

- Generated: 2026-06-26T15:24:50.965Z
- Duration: 16937s
- Runs per test: 5

## Environment

| Signal | Value |
|--------|-------|
| Platform | linux x64 |
| CPU | AMD Ryzen 7 9800X3D 8-Core Processor |
| Cores | 16 |
| Memory | 23 GB |
| Node.js | v24.16.0 |
| V8 | 13.6.233.17-node.49 |

## Competitors

| Library | Version |
|---------|---------|
| njs-modbus | 4.0.0 |
| jsmodbus | 4.0.10 |
| modbus-serial | 8.0.25 |

## Methodology

- Latency percentiles are computed from a reservoir sample of per-operation timings.
- Multi-run results use the median run to reduce environment jitter.
- Jitter-contaminated measurements are flagged when the event-loop stall detector fires.
- Memory deltas are reported after forced GC; the noise-floor baseline is subtracted to produce `netHeapGrowthKB`.
- Chaos overall correct rate uses recoverable frames as the denominator: `sum(framesCorrect) / sum(expectedCorrect)` across scenes with `expectedCorrect > 0`. Fully-unrecoverable scenes (e.g. `corrupt`, `truncated`) are excluded from the rate so a perfect parser shows 100%.
- `njs-modbus` uses `queueStrategy: 'fifo'` in sequential modes to match the FIFO request ordering of `jsmodbus` and `modbus-serial`; multi-connection TCP tests use `queueStrategy: 'concurrent'` for true pipelining.

## Encode / Decode Micro-benchmark

Pure CPU micro-benchmark of njs-modbus encode/decode hot paths — no network I/O. Each op completes in sub-microsecond time, so `Ops/sec` and `CPU (µs/op)` are the reliable indicators; per-op latency at this scale is dominated by `process.hrtime` overhead and is omitted.

| Suite | Ops/sec | CPU (µs/op) |
|-------|---------|-------------|
| tcpReqEncode | 9.37 M | 0.11 |
| tcpResEncode | 7.83 M | 0.13 |
| tcpReqDecode | 8.83 M | 0.11 |
| tcpResDecode | 8.90 M | 0.11 |
| rtuReqEncode | 9.12 M | 0.11 |
| rtuResEncode | 1.91 M | 0.53 |
| rtuReqDecode | 8.53 M | 0.12 |
| rtuResDecode | 1.98 M | 0.51 |
| asciiReqEncode | 8.83 M | 0.11 |
| asciiResEncode | 2.44 M | 0.42 |
| asciiReqDecode | 7.84 M | 0.13 |
| asciiResDecode | 2.53 M | 0.4 |

## Transport Suite

End-to-end FC03 (read 50 holding registers) over real transports. TCP runs over loopback (`127.0.0.1`); RTU and ASCII run over a `socat` PTY pair paced to a 115200-baud line, so serial throughput is bounded by the byte-time RTT, not by the library.

`vs Baseline` compares each library's Ops/sec to njs-modbus in the same row group; 🏆 marks the highest Ops/sec within a group regardless of library.

### Sequential (depth=1)

One master, one connection, awaits each response before issuing the next request. Reflects single-request round-trip cost; P99 surfaces tail jitter that Avg would mask.

| Transport | Library | Ops/sec | vs Baseline | P50 (µs) | P99 (µs) | CPU (µs/op) |
|-----------|---------|---------|-------------|----------|----------|-------------|
| **TCP** | **njs-modbus** 🏆 | **94.81 k** | **1.00x** | 8.7 | 43.9 | 11.52 |
|  | jsmodbus | 59.59 k | 0.63x | 13.6 | 65.7 | 17.5 |
|  | modbus-serial | 867 | <0.01x | 1,150.5 | 1,244.5 | 90.61 |
| **RTU** | **njs-modbus** 🏆 | **104** | **1.00x** | 514.5 | 852.8 | 742.28 |
|  | jsmodbus | 104 | 1.00x | 546.4 | 927.3 | 656.81 |
|  | modbus-serial | 31 | 0.30x | 31,903.6 | 32,219.3 | 797.49 |
| **ASCII** | **njs-modbus** 🏆 | **51** | **1.00x** | 556.1 | 947.9 | 801.98 |

### Multi-connection (connections=8)

8 independent TCP connections, each issuing depth-1 requests in parallel. Serial transports are skipped — RTU/ASCII share a single physical line and cannot host independent masters.

| Transport | Library | Ops/sec | vs Baseline | P50 (µs) | P99 (µs) | CPU (µs/op) |
|-----------|---------|---------|-------------|----------|----------|-------------|
| **TCP** | **njs-modbus** 🏆 | **109.23 k** | **1.00x** | 60.7 | 179.8 | 79.95 |
|  | jsmodbus | 63.84 k | 0.58x | 102.6 | 299.7 | 131.5 |
|  | modbus-serial | 6.37 k | 0.06x | 1,241.3 | 1,437.6 | 205.91 |

## All Function Codes

Per-function-code TCP throughput. Each (FC, library) cell runs in its own worker against a fresh server on a dedicated port, so workers never share an event loop. FC08/17/22/23/43 are njs-modbus-only (jsmodbus has no client implementation); modbus-serial omits FC08/17/22/23.

`vs Baseline` compares each library's Ops/sec to njs-modbus in the same FC group; 🏆 marks the highest Ops/sec within a group regardless of library.

### All Function Codes — Normal payload

Read 100 coils / 50 registers, write 100 coils / 50 registers, mask write a single register, issue FC08/0 return-query-data diagnostic. Per-FC TCP throughput; loopback only.

| Function Code | Library | Ops/sec | vs Baseline | P50 (µs) | P99 (µs) | CPU (µs/op) | GC (ns/op) |
|---------------|---------|---------|-------------|----------|----------|-------------|------------|
| **01 Read Coils** | **njs-modbus** 🏆 | **101.11 k** | **1.00x** | 8 | 41 | 42.46 | 113 |
|  | jsmodbus | 634 | <0.01x | 1,011 | 8,003 | 4,894.41 | 151,418 |
|  | modbus-serial | 866 | <0.01x | 1,149 | 1,239 | 1,435.53 | 609 |
| **02 Read Discrete Inputs** | **njs-modbus** 🏆 | **103.96 k** | **1.00x** | 8 | 40 | 32.32 | 110 |
|  | jsmodbus | 638 | <0.01x | 1,007 | 8,023 | 4,882.46 | 153,885 |
|  | modbus-serial | 869 | <0.01x | 1,145 | 1,234 | 352.25 | 618 |
| **03 Read Holding Registers** | **njs-modbus** 🏆 | **101.83 k** | **1.00x** | 8 | 42 | 43.48 | 114 |
|  | jsmodbus | 60.37 k | 0.59x | 14 | 67 | 53.27 | 129 |
|  | modbus-serial | 870 | <0.01x | 1,142 | 1,238 | 347.82 | 514 |
| **04 Read Input Registers** | **njs-modbus** 🏆 | **101.14 k** | **1.00x** | 8 | 42 | 43.82 | 115 |
|  | jsmodbus | 59.46 k | 0.59x | 14 | 67 | 71.5 | 130 |
|  | modbus-serial | 868 | <0.01x | 1,147 | 1,243 | 1,544.45 | 501 |
| **05 Write Single Coil** | **njs-modbus** 🏆 | **104.64 k** | **1.00x** | 8 | 40 | 41.31 | 104 |
|  | jsmodbus | 64.34 k | 0.61x | 13 | 61 | 64.56 | 110 |
|  | modbus-serial | 874 | <0.01x | 1,141 | 1,227 | 1,432.74 | 413 |
| **06 Write Single Register** | **njs-modbus** 🏆 | **106.06 k** | **1.00x** | 8 | 40 | 31.63 | 105 |
|  | jsmodbus | 64.60 k | 0.61x | 13 | 60 | 64.3 | 110 |
|  | modbus-serial | 875 | <0.01x | 1,138 | 1,219 | 321.06 | 440 |
| **08/0 Diagnostics Return Query Data** | **njs-modbus** 🏆 | **103.65 k** | **1.00x** | 8 | 41 | 41.45 | 111 |
| **15 Write Multiple Coils** | **njs-modbus** 🏆 | **101.20 k** | **1.00x** | 8 | 41 | 33.21 | 112 |
|  | jsmodbus | 400 | <0.01x | 1,800 | 8,675 | 8,419.85 | 189,055 |
|  | modbus-serial | 872 | <0.01x | 1,141 | 1,225 | 339.74 | 732 |
| **16 Write Multiple Registers** | **njs-modbus** 🏆 | **98.81 k** | **1.00x** | 8 | 42 | 44.7 | 112 |
|  | jsmodbus | 58.21 k | 0.59x | 14 | 67 | 56.23 | 130 |
|  | modbus-serial | 870 | <0.01x | 1,143 | 1,231 | 371.81 | 500 |
| **17 Report Server ID** | **njs-modbus** 🏆 | **104.64 k** | **1.00x** | 8 | 40 | 41.94 | 105 |
| **22 Mask Write Register** | **njs-modbus** 🏆 | **104.70 k** | **1.00x** | 8 | 38 | 41.96 | 105 |
| **23 Read/Write Multiple Registers** | **njs-modbus** 🏆 | **98.51 k** | **1.00x** | 8 | 42 | 45.24 | 124 |
| **43 Read Device Identification** | **njs-modbus** 🏆 | **88.70 k** | **1.00x** | 9 | 45 | 38.33 | 124 |
|  | modbus-serial | 868 | <0.01x | 1,146 | 1,241 | 362.28 | 491 |

### All Function Codes — Max payload

Read 2000 coils / 125 registers, write 1968 coils / 125 registers; FC08/0 uses its standard 2-byte query payload. Stresses encode/decode against the protocol upper bound.

| Function Code | Library | Ops/sec | vs Baseline | P50 (µs) | P99 (µs) | CPU (µs/op) | GC (ns/op) |
|---------------|---------|---------|-------------|----------|----------|-------------|------------|
| **01 Read Coils** | **njs-modbus** 🏆 | **79.91 k** | **1.00x** | 10 | 46 | 53.74 | 214 |
|  | jsmodbus | 629 | <0.01x | 1,039 | 7,856 | 5,009.76 | 146,903 |
|  | modbus-serial | 824 | 0.01x | 1,197 | 1,460 | 1,762.58 | 10,077 |
| **02 Read Discrete Inputs** | **njs-modbus** 🏆 | **83.50 k** | **1.00x** | 10 | 44 | 41.09 | 194 |
|  | jsmodbus | 623 | <0.01x | 1,040 | 8,163 | 5,026.25 | 156,170 |
|  | modbus-serial | 827 | <0.01x | 1,192 | 1,429 | 708.36 | 9,833 |
| **03 Read Holding Registers** | **njs-modbus** 🏆 | **97.41 k** | **1.00x** | 8 | 42 | 46.95 | 139 |
|  | jsmodbus | 57.91 k | 0.59x | 14 | 68 | 56.03 | 143 |
|  | modbus-serial | 865 | <0.01x | 1,149 | 1,261 | 377.86 | 692 |
| **04 Read Input Registers** | **njs-modbus** 🏆 | **97.41 k** | **1.00x** | 8 | 43 | 46.87 | 135 |
|  | jsmodbus | 56.97 k | 0.58x | 14 | 68 | 75.58 | 142 |
|  | modbus-serial | 862 | <0.01x | 1,153 | 1,267 | 1,627.11 | 660 |
| **05 Write Single Coil** | **njs-modbus** 🏆 | **104.20 k** | **1.00x** | 8 | 40 | 41.45 | 105 |
|  | jsmodbus | 64.25 k | 0.62x | 13 | 60 | 64.63 | 111 |
|  | modbus-serial | 873 | <0.01x | 1,141 | 1,227 | 1,429.95 | 408 |
| **06 Write Single Register** | **njs-modbus** 🏆 | **104.99 k** | **1.00x** | 8 | 40 | 31.94 | 107 |
|  | jsmodbus | 64.44 k | 0.61x | 13 | 60 | 64.4 | 111 |
|  | modbus-serial | 875 | <0.01x | 1,138 | 1,223 | 318.8 | 439 |
| **08/0 Diagnostics Return Query Data** | **njs-modbus** 🏆 | **102.87 k** | **1.00x** | 8 | 42 | 41.74 | 112 |
| **15 Write Multiple Coils** | **njs-modbus** 🏆 | **70.07 k** | **1.00x** | 12 | 48 | 47.71 | 215 |
|  | jsmodbus | 376 | <0.01x | 1,934 | 8,865 | 9,017.95 | 189,997 |
|  | modbus-serial | 837 | 0.01x | 1,185 | 1,427 | 544 | 3,919 |
| **16 Write Multiple Registers** | **njs-modbus** 🏆 | **90.86 k** | **1.00x** | 9 | 44 | 49.81 | 145 |
|  | jsmodbus | 54.50 k | 0.60x | 15 | 74 | 60.44 | 146 |
|  | modbus-serial | 867 | <0.01x | 1,148 | 1,242 | 364.33 | 576 |
| **17 Report Server ID** | **njs-modbus** 🏆 | **103.92 k** | **1.00x** | 8 | 40 | 42.45 | 106 |
| **22 Mask Write Register** | **njs-modbus** 🏆 | **103.63 k** | **1.00x** | 8 | 40 | 43.5 | 107 |
| **23 Read/Write Multiple Registers** | **njs-modbus** 🏆 | **84.33 k** | **1.00x** | 9 | 52 | 58.16 | 241 |
| **43 Read Device Identification** | **njs-modbus** 🏆 | **88.05 k** | **1.00x** | 9 | 47 | 38.6 | 128 |
|  | modbus-serial | 867 | <0.01x | 1,147 | 1,241 | 366.12 | 456 |

### Normal vs Max payload

Pairs each (FC, library) cell across the Normal and Max payload runs and reports the relative change. `↑` = the metric moved in the better direction (Ops/sec up, or CPU/GC/P99 down); `↓` = worse. Larger payloads cost encode/decode time, so dropping ops/sec and rising P99 are expected.

| Function Code | Library | Ops/sec | CPU (µs/op) | GC (ns/op) | P99 (µs) |
|---------------|---------|---------|-------------|------------|----------|
| **01 Read Coils** | **njs-modbus** | 101.11 k → 79.91 k (↓21.0%) | 42.46 → 53.74 (↓26.6%) | 113 → 214 (↓89.4%) | 41 → 46 (↓12.2%) |
|  | jsmodbus | 634 → 629 (↓0.8%) | 4,894.41 → 5,009.76 (↓2.4%) | 151,418 → 146,903 (↑3.0%) | 8,003 → 7,856 (↑1.8%) |
|  | modbus-serial | 866 → 824 (↓4.8%) | 1,435.53 → 1,762.58 (↓22.8%) | 609 → 10,077 (↓1554.7%) | 1,239 → 1,460 (↓17.8%) |
| **02 Read Discrete Inputs** | **njs-modbus** | 103.96 k → 83.50 k (↓19.7%) | 32.32 → 41.09 (↓27.1%) | 110 → 194 (↓76.4%) | 40 → 44 (↓10.0%) |
|  | jsmodbus | 638 → 623 (↓2.4%) | 4,882.46 → 5,026.25 (↓2.9%) | 153,885 → 156,170 (↓1.5%) | 8,023 → 8,163 (↓1.7%) |
|  | modbus-serial | 869 → 827 (↓4.8%) | 352.25 → 708.36 (↓101.1%) | 618 → 9,833 (↓1491.1%) | 1,234 → 1,429 (↓15.8%) |
| **03 Read Holding Registers** | **njs-modbus** | 101.83 k → 97.41 k (↓4.3%) | 43.48 → 46.95 (↓8.0%) | 114 → 139 (↓21.9%) | 42 → 42 (↑0.0%) |
|  | jsmodbus | 60.37 k → 57.91 k (↓4.1%) | 53.27 → 56.03 (↓5.2%) | 129 → 143 (↓10.9%) | 67 → 68 (↓1.5%) |
|  | modbus-serial | 870 → 865 (↓0.6%) | 347.82 → 377.86 (↓8.6%) | 514 → 692 (↓34.6%) | 1,238 → 1,261 (↓1.9%) |
| **04 Read Input Registers** | **njs-modbus** | 101.14 k → 97.41 k (↓3.7%) | 43.82 → 46.87 (↓7.0%) | 115 → 135 (↓17.4%) | 42 → 43 (↓2.4%) |
|  | jsmodbus | 59.46 k → 56.97 k (↓4.2%) | 71.5 → 75.58 (↓5.7%) | 130 → 142 (↓9.2%) | 67 → 68 (↓1.5%) |
|  | modbus-serial | 868 → 862 (↓0.7%) | 1,544.45 → 1,627.11 (↓5.4%) | 501 → 660 (↓31.7%) | 1,243 → 1,267 (↓1.9%) |
| **05 Write Single Coil** | **njs-modbus** | 104.64 k → 104.20 k (↓0.4%) | 41.31 → 41.45 (↓0.3%) | 104 → 105 (↓1.0%) | 40 → 40 (↑0.0%) |
|  | jsmodbus | 64.34 k → 64.25 k (↓0.1%) | 64.56 → 64.63 (↓0.1%) | 110 → 111 (↓0.9%) | 61 → 60 (↑1.6%) |
|  | modbus-serial | 874 → 873 (↓0.1%) | 1,432.74 → 1,429.95 (↑0.2%) | 413 → 408 (↑1.2%) | 1,227 → 1,227 (↑0.0%) |
| **06 Write Single Register** | **njs-modbus** | 106.06 k → 104.99 k (↓1.0%) | 31.63 → 31.94 (↓1.0%) | 105 → 107 (↓1.9%) | 40 → 40 (↑0.0%) |
|  | jsmodbus | 64.60 k → 64.44 k (↓0.3%) | 64.3 → 64.4 (↓0.2%) | 110 → 111 (↓0.9%) | 60 → 60 (↑0.0%) |
|  | modbus-serial | 875 → 875 (↑0.0%) | 321.06 → 318.8 (↑0.7%) | 440 → 439 (↑0.2%) | 1,219 → 1,223 (↓0.3%) |
| **08/0 Diagnostics Return Query Data** | **njs-modbus** | 103.65 k → 102.87 k (↓0.8%) | 41.45 → 41.74 (↓0.7%) | 111 → 112 (↓0.9%) | 41 → 42 (↓2.4%) |
| **15 Write Multiple Coils** | **njs-modbus** | 101.20 k → 70.07 k (↓30.8%) | 33.21 → 47.71 (↓43.7%) | 112 → 215 (↓92.0%) | 41 → 48 (↓17.1%) |
|  | jsmodbus | 400 → 376 (↓6.0%) | 8,419.85 → 9,017.95 (↓7.1%) | 189,055 → 189,997 (↓0.5%) | 8,675 → 8,865 (↓2.2%) |
|  | modbus-serial | 872 → 837 (↓4.0%) | 339.74 → 544 (↓60.1%) | 732 → 3,919 (↓435.4%) | 1,225 → 1,427 (↓16.5%) |
| **16 Write Multiple Registers** | **njs-modbus** | 98.81 k → 90.86 k (↓8.0%) | 44.7 → 49.81 (↓11.4%) | 112 → 145 (↓29.5%) | 42 → 44 (↓4.8%) |
|  | jsmodbus | 58.21 k → 54.50 k (↓6.4%) | 56.23 → 60.44 (↓7.5%) | 130 → 146 (↓12.3%) | 67 → 74 (↓10.4%) |
|  | modbus-serial | 870 → 867 (↓0.3%) | 371.81 → 364.33 (↑2.0%) | 500 → 576 (↓15.2%) | 1,231 → 1,242 (↓0.9%) |
| **17 Report Server ID** | **njs-modbus** | 104.64 k → 103.92 k (↓0.7%) | 41.94 → 42.45 (↓1.2%) | 105 → 106 (↓1.0%) | 40 → 40 (↑0.0%) |
| **22 Mask Write Register** | **njs-modbus** | 104.70 k → 103.63 k (↓1.0%) | 41.96 → 43.5 (↓3.7%) | 105 → 107 (↓1.9%) | 38 → 40 (↓5.3%) |
| **23 Read/Write Multiple Registers** | **njs-modbus** | 98.51 k → 84.33 k (↓14.4%) | 45.24 → 58.16 (↓28.6%) | 124 → 241 (↓94.4%) | 42 → 52 (↓23.8%) |
| **43 Read Device Identification** | **njs-modbus** | 88.70 k → 88.05 k (↓0.7%) | 38.33 → 38.6 (↓0.7%) | 124 → 128 (↓3.2%) | 45 → 47 (↓4.4%) |
|  | modbus-serial | 868 → 867 (↓0.1%) | 362.28 → 366.12 (↓1.1%) | 491 → 456 (↑7.1%) | 1,241 → 1,241 (↑0.0%) |

## Chaos Scenes

End-to-end resilience benchmark: sends corrupted, fragmented, and sticky frames to real Modbus servers and measures frame-level correctness, recovery latency after noise stops, and any heap retained across the run.

- **Sent (plan/actual)**: planned request count vs requests actually completed. When the circuit breaker trips (5 consecutive timeouts), remaining requests are marked failed instantly and the actual count drops below plan. Shown as a single value when plan equals actual.
- **Correct / Failed / Extra**: absolute frame counts. **Failed** = sent frames that did not receive a correct response. **Extra** = received frames that do not match any sent request.
- **✅ / ❌**: scene pass/fail mark before the library name. RTU and ASCII pass when the library recovers every recoverable frame from the byte stream (`framesCorrect == expectedCorrect`). TCP also passes under a stricter per-packet rule: parse from the start of each `socket.write` packet until the first error, count only frames whose header lands at a packet boundary or immediately follows another counted frame (`framesCorrect == expectedStrictCorrect`).
- **Recovery P99**: P99 latency (µs) of 100 clean frames sent after chaos noise stops; measures how quickly a parser re-syncs. A trailing ⚠ means the event-loop stall detector fired during the run and latency may be inflated.
- **Max CPU (µs)**: worst-case single-iteration CPU time. <1000 µs (1 ms) is flat-line stable; higher values indicate occasional CPU stalls that could jitter application-layer timing.
- **Net heap (KB)**: heapUsed delta after forced GC + settle, with a calibrated noise floor subtracted. Lower is better; a positive value means the library retained memory across the window.

### TCP

- ✅ **njs-modbus**: passed 12/12 scenes, overall correct rate 92.0%
- jsmodbus: passed 9/12 scenes, overall correct rate 100.0%
- modbus-serial: passed 9/12 scenes, overall correct rate 100.0%

| Scene | Library | Sent | Correct | Failed | Extra | Recovery P99 (µs) | Max CPU (µs) | Net heap (KB) |
|-------|---------|------|---------|--------|-------|-------------------|--------------|---------------|
| **drip-1** | **✅ njs-modbus** | 2,000 | 2,000 | 0 | 0 | 452.7 | 4,999 | 469.16 |
|  | ✅ jsmodbus | 2,000 | 2,000 | 0 | 0 | 186.9 | 4,983 | 457.94 |
|  | ✅ modbus-serial | 2,000 | 2,000 | 0 | 0 | 1,465.8 | 5,252 | 489.14 |
| **drip-10** | **✅ njs-modbus** | 2,000 | 20,000 | 0 | 0 | 240.6 | 6,501 | 372.16 |
|  | ✅ jsmodbus | 2,000 | 20,000 | 0 | 0 | 296.8 | 12,008 | 331.2 |
|  | ✅ modbus-serial | 2,000 | 20,000 | 0 | 0 | 1,387.4 | 13,569 | 350.05 |
| **sticky-2** | **✅ njs-modbus** | 2,000 | 4,000 | 0 | 0 | 150.6 | 5,147 | 443.41 |
|  | ✅ jsmodbus | 2,000 | 4,000 | 0 | 0 | 251.3 | 12,030 | 428.13 |
|  | ✅ modbus-serial | 2,000 | 4,000 | 0 | 0 | 1,511.8 | 11,445 | 472.36 |
| **sticky-10** | **✅ njs-modbus** | 2,000 | 20,000 | 0 | 0 | 250.4 | 5,072 | 416.93 |
|  | ✅ jsmodbus | 2,000 | 20,000 | 0 | 0 | 322.8 | 12,440 | 370.84 |
|  | ✅ modbus-serial | 2,000 | 20,000 | 0 | 0 | 1,273.9 | 13,203 | 438.41 |
| **sticky-50** | **✅ njs-modbus** | 2,000 | 100,000 | 0 | 0 | 260.5 | 9,231 | 278.45 |
|  | ✅ jsmodbus | 2,000 | 100,000 | 0 | 0 | 185.7 | 12,402 | 286.69 |
|  | ✅ modbus-serial | 2,000 | 100,000 | 0 | 0 | 1,529.1 | 12,292 | 269.88 |
| **garbage-2B** | **✅ njs-modbus** | 2,000 | 2,000 | 2,000 | 0 | 233 | 11,741 | 387.69 |
|  | ❌ jsmodbus | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,066 | 10.55 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,148 | 11.2 |
| **mixed** | **✅ njs-modbus** | 2,000 | 2,000 | 4,000 | 0 | 277.9 | 13,534 | 413.73 |
|  | ❌ jsmodbus | 2,000 / 5 | 0 | 5,997 | 0 | - | 2,570 | 20.22 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 5,997 | 0 | - | 2,818 | 22.42 |
| **corrupt-len** | **✅ njs-modbus** | 2,000 / 5 | 0 | 3,998 | 0 | - | 1,833 | 11.37 |
|  | ✅ jsmodbus | 2,000 | 2,000 | 2,000 | 0 | 272.5 | 11,967 | 420.88 |
|  | ✅ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,208 | 10.9 |
| **garbage-256B** | **✅ njs-modbus** | 2,000 / 5 | 0 | 1,999 | 0 | - | 2,038 | 4.69 |
|  | ✅ jsmodbus | 2,000 / 5 | 0 | 1,999 | 0 | - | 2,145 | 12.38 |
|  | ✅ modbus-serial | 2,000 / 5 | 0 | 1,999 | 0 | - | 2,061 | 16.84 |
| **chunk-2B** | **✅ njs-modbus** | 2,000 | 10,000 | 0 | 0 | 273.1 | 6,621 | 365.66 |
|  | ✅ jsmodbus | 2,000 | 10,000 | 0 | 0 | 263.6 | 11,890 | 381.98 |
|  | ✅ modbus-serial | 2,000 | 10,000 | 0 | 0 | 1,371.7 | 12,346 | 417.13 |
| **garbage-after** | **✅ njs-modbus** | 2,000 | 2,000 | 8,000 | 0 | 225.8 | 11,349 | 411.54 |
|  | ❌ jsmodbus | 2,000 / 5 | 0 | 9,995 | 0 | - | 2,026 | 6.88 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 9,995 | 0 | - | 1,959 | 10.77 |
| **truncated** | **✅ njs-modbus** | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,200 | 15.63 |
|  | ✅ jsmodbus | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,120 | 16.64 |
|  | ✅ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 1,873 | 16.55 |

### RTU

- ✅ **njs-modbus**: passed 12/12 scenes, overall correct rate 100.0%
- jsmodbus: passed 8/12 scenes, overall correct rate 99.3%
- modbus-serial: passed 3/12 scenes, overall correct rate 45.9%

| Scene | Library | Sent | Correct | Failed | Extra | Recovery P99 (µs) | Max CPU (µs) | Net heap (KB) |
|-------|---------|------|---------|--------|-------|-------------------|--------------|---------------|
| **drip-1** | **✅ njs-modbus** | 2,000 | 2,000 | 0 | 0 | 878.8 | 10,284 | 571.23 |
|  | ✅ jsmodbus | 2,000 | 2,000 | 0 | 0 | 941.6 | 12,170 | 570.62 |
|  | ✅ modbus-serial | 2,000 | 2,000 | 0 | 0 | 32,688.5 | 11,089 | 620.73 |
| **drip-10** | **✅ njs-modbus** | 2,000 | 20,000 | 0 | 0 | 857.9 | 27,213 | 432.59 |
|  | ✅ jsmodbus | 2,000 | 20,000 | 0 | 0 | 874.3 | 28,287 | 376.09 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 19,990 | 0 | - | 12,667 | 8.59 |
| **sticky-2** | **✅ njs-modbus** | 2,000 | 4,000 | 0 | 0 | 812.6 | 5,171 | 524.71 |
|  | ✅ jsmodbus | 2,000 | 4,000 | 0 | 0 | 762.8 | 5,396 | 526.49 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,860 | 25 |
| **sticky-10** | **✅ njs-modbus** | 2,000 | 20,000 | 0 | 0 | 956.6 | 10,945 | 503.46 |
|  | ✅ jsmodbus | 2,000 | 20,000 | 0 | 0 | 883 | 9,905 | 520.66 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 19,990 | 0 | - | 3,032 | 25.38 |
| **sticky-50** | **✅ njs-modbus** | 2,000 | 100,000 | 0 | 0 | 926.3 | 22,346 | 355.47 |
|  | ✅ jsmodbus | 2,000 | 100,000 | 0 | 0 | 916.2 | 10,883 | 404.68 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 99,950 | 0 | - | 2,859 | 25.77 |
| **garbage-2B** | **✅ njs-modbus** | 2,000 | 4,000 | 0 | 0 | 858.9 | 5,919 | 524.23 |
|  | ❌ jsmodbus | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,194 | 24.24 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,995 | 26.23 |
| **mixed** | **✅ njs-modbus** | 2,000 | 6,000 | 0 | 0 | 942.4 | 11,413 | 543.83 |
|  | ❌ jsmodbus | 2,000 / 5 | 0 | 5,997 | 0 | - | 4,037 | 22.03 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 5,997 | 0 | - | 4,038 | 11.77 |
| **corrupt-crc** | **✅ njs-modbus** | 2,000 | 2,000 | 2,000 | 0 | 864.8 | 11,604 | 476.14 |
|  | ✅ jsmodbus | 2,000 | 2,000 | 2,000 | 0 | 964.7 | 13,190 | 498.15 |
|  | ✅ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,886 | 26.32 |
| **garbage-256B** | **✅ njs-modbus** | 2,000 | 2,000 | 0 | 0 | 855 | 7,043 | 521.13 |
|  | ✅ jsmodbus | 2,000 / 5 | 0 | 1,999 | 0 | - | 2,206 | 25.05 |
|  | ❌ modbus-serial | 2,000 | 0 | 4,000 | 2,000 | 32,726.6 | 6,233 | 593.46 |
| **chunk-2B** | **✅ njs-modbus** | 2,000 | 10,000 | 0 | 0 | 929.2 | 12,107 | 542.25 |
|  | ✅ jsmodbus | 2,000 | 10,000 | 0 | 0 | 862 | 9,665 | 521.98 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 9,995 | 0 | - | 5,280 | 10.51 |
| **garbage-after** | **✅ njs-modbus** | 2,000 | 10,000 | 0 | 0 | 771.2 | 6,649 | 539.88 |
|  | ❌ jsmodbus | 2,000 / 5 | 0 | 9,995 | 0 | - | 2,519 | 13.54 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 9,995 | 0 | - | 2,581 | 25.38 |
| **truncated** | **✅ njs-modbus** | 2,000 | 2,000 | 2,000 | 0 | 962.5 | 12,225 | 457.06 |
|  | ❌ jsmodbus | 2,000 | 1,000 | 3,000 | 0 | - | 12,592 | 536.04 |
|  | ✅ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,703 | 25 |

### ASCII

- ✅ **njs-modbus**: passed 14/14 scenes, overall correct rate 100.0%
- modbus-serial: passed 5/14 scenes, overall correct rate 0.0%

| Scene | Library | Sent | Correct | Failed | Extra | Recovery P99 (µs) | Max CPU (µs) | Net heap (KB) |
|-------|---------|------|---------|--------|-------|-------------------|--------------|---------------|
| **drip-1** | **✅ njs-modbus** | 2,000 | 2,000 | 0 | 0 | 919.9 | 11,436 | 562.75 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 1,999 | 0 | - | 5,459 | 24.16 |
| **drip-10** | **✅ njs-modbus** | 2,000 | 20,000 | 0 | 0 | 810.4 | 40,801 | 407.13 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 19,990 | 0 | - | 25,115 | 17.62 |
| **sticky-2** | **✅ njs-modbus** | 2,000 | 4,000 | 0 | 0 | 804 | 6,172 | 540.3 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,730 | 18.56 |
| **sticky-10** | **✅ njs-modbus** | 2,000 | 20,000 | 0 | 0 | 814.8 | 10,060 | 499.59 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 19,990 | 0 | - | 2,377 | 17.15 |
| **sticky-50** | **✅ njs-modbus** | 2,000 | 100,000 | 0 | 0 | 823.8 | 25,925 | 338.02 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 99,950 | 0 | - | 2,396 | 23.28 |
| **garbage-2B** | **✅ njs-modbus** | 2,000 | 4,000 | 0 | 0 | 881.1 | 6,393 | 543.52 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,465 | 19.88 |
| **mixed** | **✅ njs-modbus** | 2,000 | 6,000 | 0 | 0 | 876.9 | 9,741 | 482.18 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 5,997 | 0 | - | 4,912 | 15.17 |
| **corrupt-lrc** | **✅ njs-modbus** | 2,000 | 2,000 | 2,000 | 0 | 935.7 | 13,005 | 451.97 |
|  | ✅ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,365 | 19.88 |
| **garbage-256B** | **✅ njs-modbus** | 2,000 | 2,000 | 0 | 0 | 1,163.7 | 6,419 | 525.38 |
|  | ✅ modbus-serial | 2,000 / 5 | 0 | 1,999 | 0 | - | 2,228 | 18.34 |
| **chunk-2B** | **✅ njs-modbus** | 2,000 | 10,000 | 0 | 0 | 848.5 | 18,786 | 404.17 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 9,995 | 0 | - | 8,064 | 14.77 |
| **garbage-after** | **✅ njs-modbus** | 2,000 | 10,000 | 0 | 0 | 902.8 | 9,627 | 483.89 |
|  | ❌ modbus-serial | 2,000 / 5 | 0 | 9,995 | 0 | - | 2,313 | 18.34 |
| **truncated** | **✅ njs-modbus** | 2,000 | 2,000 | 2,000 | 0 | 822.1 | 11,184 | 484.12 |
|  | ✅ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,479 | 18.43 |
| **colon-inject** | **✅ njs-modbus** | 2,000 | 2,000 | 2,000 | 0 | 821.3 | 11,583 | 443.66 |
|  | ✅ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,625 | 19.88 |
| **cr-no-lf** | **✅ njs-modbus** | 2,000 | 2,000 | 2,000 | 0 | 986.7 | 12,556 | 435.54 |
|  | ✅ modbus-serial | 2,000 / 5 | 0 | 3,998 | 0 | - | 2,423 | 19.88 |

### Scene key

- `drip-1` — Single frame drip-fed one byte at a time
- `drip-10` — 10 frames drip-fed one byte at a time
- `sticky-2` — 2 valid frames stuck together
- `sticky-10` — 10 valid frames stuck together
- `sticky-50` — 50 frames with varying register counts stuck together
- `garbage-2B` — Valid frame + 2 bytes garbage + valid frame
- `mixed` — 3 frames with interleaved garbage, sent in 3-byte chunks
- `corrupt-len` — MBAP length field corrupted in first frame
- `garbage-256B` — 256 bytes garbage followed by one valid frame
- `chunk-2B` — 5 frames sent in 2-byte chunks (crosses frame boundaries)
- `garbage-after` — 5 frames with 4 bytes garbage after each
- `truncated` — Truncated first frame followed by valid second frame
- `corrupt-crc` — Last byte (checksum) corrupted in first frame
- `corrupt-lrc` — Last byte (checksum) corrupted in first frame
- `colon-inject` — Colon injected mid-first-frame (forces parser restart)
- `cr-no-lf` — First frame has CR+CR instead of CR+LF

## Measurement Confidence & Diagnostics

### Sample integrity

- **Encode/Decode micro-benchmark**: 12 tests, 390.5 M samples collected; 12/12 overflowed reservoir (cap 100,000); 0.04% outliers removed (IQR 1.5×).
- **Transport suite**: 10 tests, 21.4 M samples collected; 5/10 overflowed reservoir (cap 100,000); 0.33% outliers removed (IQR 1.5×).
- **All Function Codes (Normal)**: 30 tests, 196.3 M samples collected; 27/30 overflowed reservoir (cap 100,000); 0.22% outliers removed (IQR 1.5×).
- **All Function Codes (Max)**: 30 tests, 182.2 M samples collected; 25/30 overflowed reservoir (cap 100,000); 0.23% outliers removed (IQR 1.5×).
- **Chaos scenes**: 100 tests, 1.0 M samples collected; 0/100 overflowed reservoir (cap 100,000); 7.44% outliers removed (IQR 1.5×).

### Chaos resilience runtime

- **Circuit breaker tripped**: 42/100 (scene, library) cells — TCP/jsmodbus: garbage-2B, mixed, garbage-256B, garbage-after, truncated; TCP/modbus-serial: garbage-2B, mixed, corrupt-len, garbage-256B, garbage-after, truncated; TCP/njs-modbus: corrupt-len, garbage-256B, truncated; RTU/modbus-serial: drip-10, sticky-2, sticky-10, sticky-50, garbage-2B, mixed, corrupt-crc, chunk-2B, garbage-after, truncated; RTU/jsmodbus: garbage-2B, mixed, garbage-256B, garbage-after; ASCII/modbus-serial: drip-1, drip-10, sticky-2, sticky-10, sticky-50, garbage-2B, mixed, corrupt-lrc, garbage-256B, chunk-2B, garbage-after, truncated, colon-inject, cr-no-lf.
- **Jitter contamination flagged**: 0/100 cells — none.
