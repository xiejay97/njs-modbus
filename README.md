# njs-modbus

[![License](https://img.shields.io/badge/License-BSL%201.1-orange.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Runtime-Node%20%3E%3D18.19-339933.svg?logo=nodedotjs)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6.svg?logo=typescript)](https://www.typescriptlang.org/)
[![Modbus](https://img.shields.io/badge/Modbus-TCP%20%7C%20RTU%20%7C%20ASCII%20%7C%20TLS-555555.svg)](https://modbus.org/)

**English** | [中文](README.zh-CN.md)

> A production-grade, zero-GC Modbus protocol stack for Node.js — TCP, RTU, and ASCII over TCP, UDP, TLS, serial, or any custom transport you can model as a byte pipeline.

`njs-modbus` is written in strict TypeScript and targets Node.js `>=18.19`. Its design is heavily informed by industrial field conditions: deterministic latency, streaming frame recovery, programmable access control, and audit logging are built in from the start.

Licensed under the **Business Source License 1.1 (BSL 1.1)**. Free for development, testing, and production use by individuals, educational institutions, non-profits, and companies with annual gross revenue below US$1M. A proprietary commercial license is available for larger organizations. Every version transitions to **Apache-2.0** on its Change Date.

---

## Table of Contents

- [What is njs-modbus?](#what-is-njs-modbus)
- [Why njs-modbus?](#why-njs-modbus)
- [Feature Matrix](#feature-matrix)
- [Installation](#installation)
- [Quick Start](#quick-start)
  - [TCP Master](#tcp-master)
  - [TCP Slave](#tcp-slave)
  - [RTU over Serial](#rtu-over-serial)
- [Architecture](#architecture)
- [Core Capabilities](#core-capabilities)
- [Supported Function Codes](#supported-function-codes)
- [Benchmarks](#benchmarks)
- [Security & Compliance](#security--compliance)
- [Commercial Support & License](#commercial-support--license)

---

## What is njs-modbus?

`njs-modbus` is a layered Modbus protocol library for Node.js. The protocol layer speaks only in buffers and knows nothing about the underlying physical device. That means the same master/slave logic runs over TCP, UDP, TLS, serial, WebSocket, an in-memory mock, or any other transport — you implement the wire once behind the `AbstractPipelineAdapter` interface and reuse the full protocol stack unchanged.

```
┌─────────────────────────────────────────────┐
│  Application: ModbusMaster / ModbusSlave    │
├─────────────────────────────────────────────┤
│  Protocol framing: TCP / RTU / ASCII        │
├─────────────────────────────────────────────┤
│  Pipeline: AbstractPipelineAdapter          │
├─────────────────────────────────────────────┤
│  Physical transport: TCP / UDP / TLS /      │
│  Serial / WebSocket / custom                │
└─────────────────────────────────────────────┘
```

- **Strict TypeScript** — generic protocol literals (`'TCP' | 'RTU' | 'ASCII'`) and typed Promise APIs catch integration mistakes at compile time.
- **Zero-GC decode hot paths** — explicit finite-state-machine framing avoids allocating objects or buffers on the JS heap during steady-state operation.
- **Transport-agnostic** — one adapter interface, any wire.

---

## Why njs-modbus?

| Concern | What you get |
| --- | --- |
| **Deterministic latency** | GC-free decode paths, low-allocation encode, and sub-microsecond P50 codec latency. No garbage-collection pauses on the hot path. |
| **Production-hardened framing** | Streaming state machines recover from garbage bytes, sticky frames, truncation, cross-boundary chunks, and corrupted CRC/LRC — without leaking invalid data into adjacent frames. |
| **Type safety** | Strict TypeScript with typed Promise APIs; most integration mistakes surface at compile time. |
| **Access control & audit** | Policy hooks at unit, address, and runtime gates, plus structured `accessAudit` events on the slave for compliance and forensics. |
| **Transport freedom** | TCP, UDP, TLS, serial, or custom transports via `AbstractPipelineAdapter`. The protocol logic never changes. |
| **Commercial clarity** | BSL 1.1: free for individuals, non-profits, and small companies; commercial license available for larger organizations; Apache-2.0 after the Change Date. |

---

## Feature Matrix

| Capability | TCP | RTU | ASCII |
| --- | :---: | :---: | :---: |
| Master / client | ✅ | ✅ | ✅ |
| Slave / server | ✅ | ✅ | ✅ |
| Concurrent pipelining | ✅ | — | — |
| Broadcast (`unit === 0`) | ✅ | ✅ | ✅ |
| Custom function codes | ✅ | ✅* | ✅ |
| Streaming frame recovery | ✅ | ✅ | ✅ |

\* RTU custom function codes require a `determineFrameLength` callback so the framing state machine can know the frame length without buffering.

Because the protocol layer is transport-agnostic, any protocol (TCP / RTU / ASCII) can run over any transport for which you provide a pipeline adapter. Built-in transports include TCP, UDP, TLS (over TCP), and serial; the WebSocket example demonstrates a custom adapter.

---

## Installation

```bash
npm install njs-modbus
```

Serial support is provided through an optional peer dependency:

```bash
npm install serialport
```

Requires Node.js `>=18.19`.

---

## Quick Start

### TCP Master

```typescript
import { ModbusMaster, TcpClientPhysicalLayer } from 'njs-modbus';

const physical = new TcpClientPhysicalLayer();

physical.on('connect', async (pipeline) => {
  const master = new ModbusMaster({
    pipelineAdapter: pipeline,
    protocol: { type: 'TCP' },
    queueStrategy: 'concurrent',
    timeout: 1000,
  });

  try {
    const response = await master.readHoldingRegisters(1, 0, 10);
    console.log('registers:', response.data);
  } catch (err) {
    console.error('request failed:', (err as Error).message);
  } finally {
    master.destroy();
    physical.close();
  }
});

physical.open({ host: '127.0.0.1', port: 502 }, (err) => {
  if (err) {
    console.error('failed to connect:', err.message);
    process.exit(1);
  }
});
```

### TCP Slave

```typescript
import { ModbusSlave, TcpServerPhysicalLayer } from 'njs-modbus';

const physical = new TcpServerPhysicalLayer();

physical.on('connect', (pipeline) => {
  const slave = new ModbusSlave({
    pipelineAdapter: pipeline,
    protocol: { type: 'TCP' },
    queueStrategy: 'drop-stale',
  });

  slave.addUnit(1, {
    readHoldingRegisters: (address, length, callback) => {
      const values = Array.from({ length }, (_, i) => (address + i) & 0xffff);
      callback(null, values);
    },
    writeSingleRegister: (address, value, callback) => {
      console.log(`write ${value} to ${address}`);
      callback(null);
    },
  });
});

physical.open({ port: 502 }, (err) => {
  if (err) {
    console.error('failed to listen:', err.message);
    process.exit(1);
  }
  console.log('slave listening on port 502');
});
```

### RTU over Serial

```typescript
import { ModbusMaster, SerialPhysicalLayer } from 'njs-modbus';

const physical = new SerialPhysicalLayer();

physical.on('connect', async (pipeline) => {
  const master = new ModbusMaster({
    pipelineAdapter: pipeline,
    protocol: { type: 'RTU' },
    queueStrategy: 'fifo',
    timeout: 500,
  });

  const res = await master.readHoldingRegisters(1, 0, 10);
  console.log('registers:', res.data);

  master.destroy();
  physical.close();
});

physical.open({ path: '/dev/ttyUSB0', baudRate: 115200 });
```

See [`examples/`](https://github.com/xiejay97/njs-modbus/tree/main/examples) for runnable master/slave pairs, including access control, audit logging, TLS, and custom transports such as WebSocket.

---

## Architecture

The library is organized into four layers. Each layer is independent, testable in isolation, and replaceable.

| Layer | Responsibility | Public Contract |
| --- | --- | --- |
| **Physical** | Open/close the wire and emit a pipeline per connection. | `AbstractPhysicalLayer` |
| **Pipeline** | Move raw bytes, handle back-pressure, and expose a `write(data)` + `data` event surface. | `AbstractPipelineAdapter` / `AbstractPipelineLayer` |
| **Protocol** | Parse frames, validate CRC/LRC/MBAP, and emit complete ADUs. | `TcpProtocolLayer` / `RtuProtocolLayer` / `AsciiProtocolLayer` |
| **Application** | Orchestrate transactions, queues, access control, and expose the public Promise API. | `ModbusMaster` / `ModbusSlave` |

This separation is what makes custom transports trivial. The WebSocket example in [`examples/websocket/`](https://github.com/xiejay97/njs-modbus/tree/main/examples/websocket) implements a full pipeline layer in under 150 lines.

---

## Core Capabilities

### Low-Allocation Codec Hot Paths

The protocol framing layers for TCP, RTU, and ASCII are implemented as explicit finite state machines. Decode paths avoid allocating objects or buffers on the JavaScript heap during steady-state operation by using pre-allocated residual buffers and zero-copy views, which removes garbage-collection jitter from the protocol hot path. Encode paths perform a single bounded `Buffer.allocUnsafe()` per frame.

### Streaming Frame Recovery

The framing layers parse incoming bytes as a stream. They recover from:

- Garbage bytes injected on the wire.
- Multiple valid frames concatenated in one read (`sticky` frames).
- Truncated frames followed by valid frames.
- Cross-boundary chunks split across multiple reads.
- Corrupted CRC (RTU) or LRC (ASCII).

Valid frames are emitted; invalid data is discarded without corrupting adjacent frames.

### Queue Strategies

Both `ModbusMaster` and `ModbusSlave` support four queue strategies:

| Strategy | Behavior | Best for |
| --- | --- | --- |
| `fifo` | Strict first-in-first-out execution. | Serial lines, deterministic ordering. |
| `drop-stale` | New requests clear all pending, unexecuted requests. | Telemetry collectors where only the latest value matters. |
| `deduplicate` | Pending requests with the same ADU fingerprint are dropped. | Polling loops that may overlap. |
| `concurrent` | Requests are dispatched concurrently. | Modbus TCP or multi-link masters/slaves. |

`drop-stale` is the default.

### Per-Unit Write Range Lock

For the slave in `concurrent` mode, `enableWriteRangeLock` (default `true`) ensures that write requests (FC05/06/15/16/22/23) with overlapping address ranges on the same unit are serialized, preventing race conditions. This is critical for maintaining consistency when modifying shared registers or coils from multiple connections simultaneously. Set to `false` only for purely synchronous in-memory slaves that do not need the coordination overhead.

### Access Control and Audit

Install an `AccessAuthorizer` on either master or slave to enforce policies at three gates:

- `checkUnit` — authorize the target unit address.
- `checkAddress` — authorize the address range touched by the request.
- `checkRuntime` — last-chance authorization immediately before wire I/O.

Each hook may return `true`, `false`, or a numeric Modbus exception `ErrorCode`. On the slave, denied requests emit `accessAudit` events.

```typescript
slave.setAccessAuthorizer({
  checkUnit: (unit) => unit === 1,
  checkAddress: (_unit, table, [start, end]) =>
    table === 'holdingRegisters' && start >= 0 && end < 100,
});

slave.on('accessAudit', (event) => {
  console.log('access denied:', event.type, event.message);
});
```

### Custom Function Codes

Register non-standard function codes on the master or slave. The framing layer learns the request shape, and the application layer receives the raw PDU to parse and respond.

```typescript
slave.addCustomFunctionCode(
  { fc: 0x65 },
  (unit, fc, data, callback) => {
    // produce response PDU bytes
    callback(null, () => Buffer.from([0x00]));
  },
);
```

For RTU (and ASCII when operating over byte-oriented transports), the descriptor must also provide `determineFrameLength` so the framing state machine can determine frame length without buffering.

---

## Supported Function Codes

| FC | Name | Master | Slave |
| --: | --- | :---: | :---: |
| 01 | Read Coils | ✅ | ✅ |
| 02 | Read Discrete Inputs | ✅ | ✅ |
| 03 | Read Holding Registers | ✅ | ✅ |
| 04 | Read Input Registers | ✅ | ✅ |
| 05 | Write Single Coil | ✅ | ✅ |
| 06 | Write Single Register | ✅ | ✅ |
| 08/00 | Return Query Data | ✅ | ✅ |
| 15 | Write Multiple Coils | ✅ | ✅ |
| 16 | Write Multiple Registers | ✅ | ✅ |
| 17 | Report Server ID | ✅ | ✅ |
| 22 | Mask Write Register | ✅ | ✅ |
| 23 | Read/Write Multiple Registers | ✅ | ✅ |
| 43/14 | Read Device Identification | ✅ | ✅ |

---

## Benchmarks

All figures below were produced by the benchmark harness in this repository on an **AMD Ryzen 7 9800X3D** workstation running **Node.js v24.16.0**. See [`benchmark/report_presentation.md`](benchmark/report_presentation.md) for the full report, methodology, and reproducibility instructions.

### Codec Micro-Benchmark

Pure CPU encode/decode, no network I/O. Each op completes in sub-microsecond time, so `Ops/sec` and `CPU (µs/op)` are the reliable indicators; per-op latency at this scale is dominated by `process.hrtime` overhead and is omitted.

| Suite | Ops/sec | CPU (µs/op) |
| --- | ---: | ---: |
| TCP request encode | 9.37 M | 0.11 |
| TCP response encode | 7.83 M | 0.13 |
| TCP request decode | 8.83 M | 0.11 |
| TCP response decode | 8.90 M | 0.11 |
| RTU request encode | 9.12 M | 0.11 |
| RTU response encode | 1.91 M | 0.53 |
| RTU request decode | 8.53 M | 0.12 |
| RTU response decode | 1.98 M | 0.51 |
| ASCII request encode | 8.83 M | 0.11 |
| ASCII response encode | 2.44 M | 0.42 |
| ASCII request decode | 7.84 M | 0.13 |
| ASCII response decode | 2.53 M | 0.4 |

All codec suites report `0` ns/op of GC pressure because the decode hot paths do not allocate on the JavaScript heap during steady-state operation.

### End-to-End Transport Throughput

FC 03 (read 50 holding registers) over loopback TCP and a 115200-baud `socat` PTY pair for serial transports.

| Transport | Library | Ops/sec | P50 (µs) | P99 (µs) |
| --- | --- | ---: | ---: | ---: |
| TCP sequential | **njs-modbus** | **94.81 k** | **8.7** | **43.9** |
| TCP sequential | jsmodbus | 59.59 k | 13.6 | 65.7 |
| TCP sequential | modbus-serial | 867 | 1,150.5 | 1,244.5 |
| TCP 8 connections | **njs-modbus** | **109.23 k** | **60.7** | **179.8** |
| TCP 8 connections | jsmodbus | 63.84 k | 102.6 | 299.7 |
| TCP 8 connections | modbus-serial | 6.37 k | 1,241.3 | 1,437.6 |
| RTU sequential | **njs-modbus** | **104** | **514.5** | **852.8** |
| RTU sequential | jsmodbus | 104 | 546.4 | 927.3 |
| RTU sequential | modbus-serial | 31 | 31,903.6 | 32,219.3 |
| ASCII sequential | **njs-modbus** | **51** | **556.1** | **947.9** |

### Chaos Resilience

The chaos suite injects corrupted, fragmented, sticky, and garbage-contaminated frames into live Modbus servers and verifies that valid frames are recovered without leakage.

| Protocol | Scenarios passed |
| --- | ---: |
| TCP | 12 / 12 |
| RTU | 12 / 12 |
| ASCII | 14 / 14 |

Re-run the full suite locally:

```bash
npm run benchmark:full
```

---

## Security & Compliance

`njs-modbus` is a pure Modbus protocol stack. For regulated environments, it provides a protocol-level policy enforcement point through `AccessAuthorizer` and an auditable trail through `accessAudit` events on `ModbusSlave`:

- `checkUnit` — authorize the target unit address.
- `checkAddress` — authorize the address range touched by the request.
- `checkRuntime` — last-chance authorization immediately before wire I/O.

Denied requests emit structured `accessAudit` events that can be forwarded to SIEM or audit logs. This helps meet operational-technology (OT) security and compliance requirements without adding external proxies.

`njs-modbus` also ships a built-in **TLS transport plugin** (`TlsClientPhysicalLayer` / `TlsServerPhysicalLayer`) backed by `node:tls`, so encrypted Modbus TCP links and mutual TLS are available when you supply certificates and TLS options. Network identity beyond certificate validation, IP whitelisting, host hardening, and physical security remain the responsibility of the host application and infrastructure.

- [`SECURITY.md`](SECURITY.md) — vulnerability reporting, coordinated disclosure, and security update policy.
- [`docs/security/`](https://github.com/xiejay97/njs-modbus/tree/main/docs/security) — access control, audit events, TLS usage, deployment compensating controls, and SDL.

See `examples/security/` for runnable master/slave examples, including TLS and transport-layer security options.

---

## Commercial Support & License

`njs-modbus` is released under the [Business Source License 1.1 (BSL 1.1)](LICENSE).

- **Free production use** is granted for individuals, educational institutions, non-profit organizations, and companies with annual gross revenue below US$1,000,000.
- **Change Date**: 2029-06-24. On that date, this version transitions to the Apache License, Version 2.0.
- **Commercial license**: For OEMs, system integrators, and commercial products that need a predictable licensing path, guaranteed support, or cannot satisfy the BSL free-use conditions, we offer a separate proprietary commercial license.

A commercial license removes BSL restrictions for your product and our support offerings help you ship with confidence:

- **Product integration license** — use `njs-modbus` in closed-source commercial products without copyleft obligations.
- **Professional technical support** — troubleshooting, performance tuning, migration guidance, and upgrade planning.
- **Enterprise support options** — response SLAs, long-term maintenance releases, priority bug fixes, and custom development.

For licensing terms, pricing, and support options, please contact us:

- Email: [xiejay97@gmail.com](mailto:xiejay97@gmail.com)
- GitHub Issues: [https://github.com/xiejay97/njs-modbus/issues](https://github.com/xiejay97/njs-modbus/issues)
