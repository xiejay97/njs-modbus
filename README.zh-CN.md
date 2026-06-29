# njs-modbus

[![License](https://img.shields.io/badge/License-BSL%201.1-orange.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/Runtime-Node%20%3E%3D18.19-339933.svg?logo=nodedotjs)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-Strict-3178C6.svg?logo=typescript)](https://www.typescriptlang.org/)
[![Modbus](https://img.shields.io/badge/Modbus-TCP%20%7C%20RTU%20%7C%20ASCII%20%7C%20TLS-555555.svg)](https://modbus.org/)

[English](README.md) | **中文**

> 面向 Node.js 的生产级、热路径零 GC Modbus 协议栈 —— 支持 TCP、RTU、ASCII，可运行在 TCP、UDP、TLS、串口或任何可被建模为字节管道的自定义传输层之上。

`njs-modbus` 使用严格 TypeScript 编写，目标运行时为 Node.js `>=18.19`。其设计充分考虑了工业现场常见的 GC 抖动、静默帧损坏和非受控总线访问等实际约束：确定性时延、流式帧恢复、可编程访问控制与审计日志均内置于核心。

采用 **Business Source License 1.1（BSL 1.1）** 许可。个人、教育机构、非营利组织以及年营收低于 100 万美元的企业，可免费用于开发、测试及生产环境。更大规模组织可购买专有商业许可。每个版本在其 Change Date 之后自动转为 **Apache-2.0** 许可。

---

## 目录

- [njs-modbus 是什么？](#njs-modbus-是什么)
- [为什么选择 njs-modbus？](#为什么选择-njs-modbus)
- [功能矩阵](#功能矩阵)
- [安装](#安装)
- [快速开始](#快速开始)
  - [TCP 主站](#tcp-主站)
  - [TCP 从站](#tcp-从站)
  - [串口 RTU](#串口-rtu)
- [架构](#架构)
- [核心能力](#核心能力)
- [支持的功能码](#支持的功能码)
- [基准测试](#基准测试)
- [安全与合规](#安全与合规)
- [商业支持与许可](#商业支持与许可)

---

## njs-modbus 是什么？

`njs-modbus` 是一个面向 Node.js 的分层 Modbus 协议库。协议层只与 Buffer 打交道，不感知任何底层物理设备。这意味着同一套主站/从站逻辑可以跑在 TCP、UDP、TLS、串口、WebSocket、内存 mock 或任何其他传输层之上 —— 你只需在 `AbstractPipelineAdapter` 接口后实现一次传输层，即可无需改动地复用完整协议栈。

```
┌─────────────────────────────────────────────┐
│  应用层：ModbusMaster / ModbusSlave          │
├─────────────────────────────────────────────┤
│  协议帧层：TCP / RTU / ASCII                 │
├─────────────────────────────────────────────┤
│  管道层：AbstractPipelineAdapter             │
├─────────────────────────────────────────────┤
│  物理传输层：TCP / UDP / TLS /               │
│  串口 / WebSocket / 自定义                   │
└─────────────────────────────────────────────┘
```

- **严格 TypeScript** —— 协议类型字面量（`'TCP' | 'RTU' | 'ASCII'`）与类型化 Promise API，可在编译期发现大多数集成错误。
- **热路径零 GC 解码** —— 显式有限状态机帧同步，在稳态运行期间不在 JavaScript 堆上分配对象或 Buffer。
- **传输层无关** —— 一个适配器接口，任意物理链路。

---

## 为什么选择 njs-modbus？

| 关注点 | 你能获得什么 |
| --- | --- |
| **确定性性能** | 解码路径零 GC、编码路径低分配，编解码 P50 时延低于 1 微秒，热路径无垃圾回收停顿。 |
| **生产级帧同步** | 流式状态机可从脏数据、粘包、残帧、跨边界分片以及 CRC/LRC 损坏中自愈，不会把无效数据泄漏到相邻帧。 |
| **类型安全** | 严格 TypeScript + 类型化 Promise API，多数集成错误在编译期即可发现。 |
| **访问控制与审计** | unit、地址、运行时三道闸门策略钩子，以及从站结构化 `accessAudit` 事件，满足合规与溯源需求。 |
| **传输层自由** | TCP、UDP、TLS、串口或自定义传输，统一通过 `AbstractPipelineAdapter` 接入，协议逻辑始终不变。 |
| **商业许可清晰** | BSL 1.1：个人、非营利机构及小企业免费使用；大型组织可购买商业许可；Change Date 后自动转为 Apache-2.0。 |

---

## 功能矩阵

| 能力 | TCP | RTU | ASCII |
| --- | :---: | :---: | :---: |
| 主站 / 客户端 | ✅ | ✅ | ✅ |
| 从站 / 服务端 | ✅ | ✅ | ✅ |
| 并发流水线 | ✅ | — | — |
| 广播（`unit === 0`） | ✅ | ✅ | ✅ |
| 自定义功能码 | ✅ | ✅* | ✅ |
| 流式帧恢复 | ✅ | ✅ | ✅ |

\* RTU 自定义功能码需要提供 `determineFrameLength` 回调，以便帧状态机在不缓冲的情况下确定帧长度。

由于协议层与传输层解耦，任意协议（TCP / RTU / ASCII）都可以运行在任意提供管道适配器的传输层之上。内置传输包括 TCP、UDP、TLS（基于 TCP）和串口；WebSocket 示例展示了一套自定义适配器。

---

## 安装

```bash
npm install njs-modbus
```

串口支持通过可选的对等依赖提供：

```bash
npm install serialport
```

需要 Node.js `>=18.19`。

---

## 快速开始

### TCP 主站

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

### TCP 从站

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

### 串口 RTU

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

[`examples/`](https://github.com/xiejay97/njs-modbus/tree/main/examples) 目录包含可运行的主站/从站示例，涵盖访问控制、审计日志、TLS 以及 WebSocket 等自定义传输层。

### 重连

`njs-modbus` 不提供内置自动重连。重连是应用层职责：合适的退避策略、重试预算与关闭行为取决于你的部署环境。[`examples/best-practice/`](https://github.com/xiejay97/njs-modbus/tree/main/examples/best-practice) 示例展示了一套生产可用的模式，包括指数退避、抖动、重试预算与优雅关闭。

---

## 架构

库体被组织为四层。每层相互独立、可单独测试、可替换。

| 层级 | 职责 | 公共契约 |
| --- | --- | --- |
| **物理层** | 打开/关闭链路，并为每个连接抛出一个管道实例。 | `AbstractPhysicalLayer` |
| **管道层** | 搬运原始字节、处理背压，暴露 `write(data)` + `data` 事件接口。 | `AbstractPipelineAdapter` / `AbstractPipelineLayer` |
| **协议层** | 解析帧、校验 CRC/LRC/MBAP，并抛出完整 ADU。 | `TcpProtocolLayer` / `RtuProtocolLayer` / `AsciiProtocolLayer` |
| **应用层** | 编排事务、队列、访问控制，并对外暴露 Promise API。 | `ModbusMaster` / `ModbusSlave` |

这种分层让自定义传输层变得极为简单。[`examples/websocket/`](https://github.com/xiejay97/njs-modbus/tree/main/examples/websocket) 中的 WebSocket 示例在 150 行内实现了一套完整管道层。

---

## 核心能力

### 低分配编解码热路径

TCP、RTU、ASCII 的协议帧层均以显式有限状态机实现。解码路径在稳态运行期间不在 JavaScript 堆上分配对象或 Buffer（通过预分配残量缓冲与零拷贝视图实现），从而彻底消除热路径上的 GC 抖动断点。编码路径每帧执行一次有界的 `Buffer.allocUnsafe()` 分配。

### 流式帧恢复

帧层以流式方式解析输入字节，可在以下场景中自愈：

- 线路上注入的脏数据。
- 一次读取中多个有效帧粘连（`sticky`）。
- 残帧后接有效帧。
- 一个帧被拆分到多次读取中（跨边界分片）。
- CRC（RTU）或 LRC（ASCII）损坏。

有效帧会被正常抛出，无效数据被丢弃，不会污染相邻帧。

### 队列策略

`ModbusMaster` 与 `ModbusSlave` 均支持四种队列策略：

| 策略 | 行为 | 适用场景 |
| --- | --- | --- |
| `fifo` | 严格先进先出执行。 | 串口线路、确定性顺序。 |
| `drop-stale` | 新请求到达时清空所有未执行的旧请求。 | 只需最新值的遥测采集。 |
| `deduplicate` | 相同 ADU 指纹的待处理请求会被去重丢弃。 | 可能重叠的轮询循环。 |
| `concurrent` | 请求并发派发。 | Modbus TCP 或多链路主站/从站。 |

默认策略为 `drop-stale`。

### 每 unit 写范围锁

对于 `concurrent` 模式下的从站，`enableWriteRangeLock`（默认 `true`）确保同一 unit 上地址范围重叠的写请求（FC05/06/15/16/22/23）被序列化，防止竞态条件。这对于在多个连接同时修改共享寄存器或线圈时保持一致性至关重要。仅对于不需要协调开销的纯同步内存从站，才设置为 `false`。

### 访问控制与审计

在主站或从站上安装 `AccessAuthorizer`，可在三道闸门上执行策略：

- `checkUnit` —— 授权目标单元地址。
- `checkAddress` —— 授权请求触及的地址区间。
- `checkRuntime` —— 在真正发起写 I/O 前的最后机会检查。

每个钩子可返回 `true`、`false` 或数字形式的 Modbus 异常 `ErrorCode`。在从站上，被拒绝的请求会触发 `accessAudit` 事件。

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

### 自定义功能码

在主站或从站上注册非标准功能码。帧层会学习请求形状，应用层则拿到原始 PDU 进行解析与响应。

```typescript
slave.addCustomFunctionCode(
  { fc: 0x65 },
  (unit, fc, data, callback) => {
    // 构造响应 PDU 字节
    callback(null, () => Buffer.from([0x00]));
  },
);
```

对于 RTU（以及面向字节传输的 ASCII），描述符还需提供 `determineFrameLength`，以便帧状态机在不缓冲的情况下确定帧长度。

---

## 支持的功能码

| FC | 名称 | 主站 | 从站 |
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

## 基准测试

以下全部数据由本仓库的基准测试套件在 **AMD Ryzen 7 9800X3D** 工作站上、**Node.js v24.16.0** 环境下测得。完整报告、测试方法与复现说明见 [`benchmark/report_presentation.md`](benchmark/report_presentation.md)。

### 编解码微基准

纯 CPU 编解码测试，无网络 I/O。每次操作都在亚微秒级别完成，因此 `Ops/sec` 和 `CPU (µs/op)` 是可靠指标；此量级下的单次时延主要由 `process.hrtime` 开销主导，故省略。

| 测试项 | Ops/sec | CPU (µs/op) |
| --- | ---: | ---: |
| TCP 请求编码 | 9.37 M | 0.11 |
| TCP 响应编码 | 7.83 M | 0.13 |
| TCP 请求解码 | 8.83 M | 0.11 |
| TCP 响应解码 | 8.90 M | 0.11 |
| RTU 请求编码 | 9.12 M | 0.11 |
| RTU 响应编码 | 1.91 M | 0.53 |
| RTU 请求解码 | 8.53 M | 0.12 |
| RTU 响应解码 | 1.98 M | 0.51 |
| ASCII 请求编码 | 8.83 M | 0.11 |
| ASCII 响应编码 | 2.44 M | 0.42 |
| ASCII 请求解码 | 7.84 M | 0.13 |
| ASCII 响应解码 | 2.53 M | 0.4 |

所有编解码测试项的 `GC (ns/op)` 均为零，因为稳态运行期间解码路径不在 JavaScript 堆上分配内存。

### 端到端传输吞吐

FC 03（读取 50 个保持寄存器），TCP 走本地回环，串口通过 115200 波特率的 `socat` PTY 对进行测试。

| 传输层 | 协议栈 | Ops/sec | P50 (µs) | P99 (µs) |
| --- | --- | ---: | ---: | ---: |
| TCP 顺序 | **njs-modbus** | **94.81 k** | **8.7** | **43.9** |
| TCP 顺序 | jsmodbus | 59.59 k | 13.6 | 65.7 |
| TCP 顺序 | modbus-serial | 867 | 1,150.5 | 1,244.5 |
| TCP 8 连接 | **njs-modbus** | **109.23 k** | **60.7** | **179.8** |
| TCP 8 连接 | jsmodbus | 63.84 k | 102.6 | 299.7 |
| TCP 8 连接 | modbus-serial | 6.37 k | 1,241.3 | 1,437.6 |
| RTU 顺序 | **njs-modbus** | **104** | **514.5** | **852.8** |
| RTU 顺序 | jsmodbus | 104 | 546.4 | 927.3 |
| RTU 顺序 | modbus-serial | 31 | 31,903.6 | 32,219.3 |
| ASCII 顺序 | **njs-modbus** | **51** | **556.1** | **947.9** |

### 混沌弹性

混沌套件向真实 Modbus 服务器注入损坏、分片、粘包及脏数据帧，验证有效帧能否在无泄漏的情况下被正确恢复。

| 协议 | 通过场景数 |
| --- | ---: |
| TCP | 12 / 12 |
| RTU | 12 / 12 |
| ASCII | 14 / 14 |

本地复现完整测试：

```bash
npm run benchmark:full
```

---

## 安全与合规

`njs-modbus` 是一个纯 Modbus 协议栈。面向受监管环境，它通过 `AccessAuthorizer` 提供协议层策略执行点，并通过从站 `accessAudit` 事件提供可审计轨迹：

- `checkUnit` —— 授权目标单元地址。
- `checkAddress` —— 授权请求触及的地址区间。
- `checkRuntime` —— 在真正发起写 I/O 前的最后机会检查。

被拒绝的请求会触发结构化 `accessAudit` 事件，可转发至 SIEM 或审计日志。这有助于在不引入外部代理的情况下，满足工业控制（OT）安全与合规要求。

`njs-modbus` 同时内置 **TLS 传输插件**（`TlsClientPhysicalLayer` / `TlsServerPhysicalLayer`），基于 `node:tls` 实现，因此在提供证书与 TLS 选项的前提下，可直接建立加密的 Modbus TCP 连接并支持双向 TLS。证书生命周期管理、网络身份、主机加固与物理安全仍由宿主应用和基础设施负责。

- [`SECURITY.md`](SECURITY.md) —— 漏洞报告、协调披露与安全更新策略。
- [`docs/security/`](https://github.com/xiejay97/njs-modbus/tree/main/docs/security) —— 访问控制、审计事件、TLS 使用、部署补偿控制与 SDL。

`examples/security/` 目录包含可运行的主站/从站示例，包括 TLS 与传输层安全选项。

---

## 商业支持与许可

`njs-modbus` 采用 [Business Source License 1.1（BSL 1.1）](LICENSE) 发布。

- **免费生产使用**：授予个人、教育机构、非营利组织以及年营收低于 100 万美元的企业。
- **Change Date**：2029-06-24。在该日期，本版本将转为 Apache License, Version 2.0。
- **商业许可**：面向 OEM、系统集成商以及需要可预测许可路径、有保障支持或无法满足 BSL 免费使用条件的商业产品，我们提供独立的专有商业许可。

商业许可可解除 BSL 对您产品的限制，同时我们的支持服务帮助您安心交付：

- **产品集成许可** —— 在闭源商业产品中使用 `njs-modbus`，无需承担 copyleft 义务。
- **专业技术支持** —— 故障排查、性能调优、迁移指导与升级规划。
- **企业级支持方案** —— 响应 SLA、长期维护版本、优先 Bug 修复与定制开发。

具体授权条款、报价及支持方案请联系：

- 邮箱：[xiejay97@gmail.com](mailto:xiejay97@gmail.com)
- GitHub Issues：[https://github.com/xiejay97/njs-modbus/issues](https://github.com/xiejay97/njs-modbus/issues)
