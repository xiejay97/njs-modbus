# njs-modbus Best-Practice Example

This example shows production-oriented patterns for `njs-modbus` TCP master and slave applications. It is self-contained: no external PLC, serial port, or database is required.

## What it demonstrates

- **Shared configuration**: port, unit IDs, address ranges, and queue strategies live in one place so master and slave never disagree.
- **Access control on both sides**: the same authorizer is installed on the master (fail-fast before queueing) and the slave (defense at the edge).
- **Per-connection slave lifecycle**: a new `ModbusSlave` is created for every TCP connection and destroyed when the pipeline closes.
- **Concurrent pipelining on the master**: safe on Modbus TCP because MBAP transaction ids correlate responses with requests.
- **Reconnection with exponential backoff**: the master reconnects automatically if the TCP socket drops.
- **Structured error handling**: distinguishes local access-denial, Modbus exception responses, and transport errors.
- **Graceful shutdown**: `SIGINT` closes the server/client cleanly.

## Layout

```text
examples/best-practice/
├── src/
│   ├── config.ts      # Endpoint, units, address ranges, queue strategies
│   ├── authorizer.ts  # Shared AccessAuthorizer
│   └── models.ts      # In-memory unit models for the slave
├── slave.ts           # TCP server best-practice
├── master.ts          # TCP client best-practice
├── package.json
└── README.md
```

## Run

Install dependencies once from the repo root:

```bash
pnpm install
```

Start the slave in one terminal:

```bash
pnpm --filter njs-modbus-best-practice server
```

Then run the master in another terminal:

```bash
pnpm --filter njs-modbus-best-practice client
```

Or run the full demo from the repo root:

```bash
pnpm --filter njs-modbus-best-practice demo
```

## Key patterns

### 1. Shared authorizer

Both `slave.ts` and `master.ts` import `sharedAuthorizer` from `src/authorizer.ts`. Keeping the policy in one file prevents the master from sending requests the slave would reject, and avoids wasting queue slots or wire bandwidth.

### 2. Master queue strategy

The master uses `queueStrategy: 'concurrent'`. This is safe only because the protocol is `TCP`; RTU/ASCII have no transaction id, so concurrent dispatch could mismatch responses.

### 3. Slave queue strategy

The slave uses `queueStrategy: 'drop-stale'`, which discards queued requests when a newer request arrives. This is appropriate when only the latest measurement or command matters.

### 4. Error handling

The master catches:

- Local `ModbusError` from the authorizer (`ILLEGAL_DATA_ADDRESS`).
- Slave-side exceptions such as `GATEWAY_PATH_UNAVAILABLE` for unmapped units.
- Transport errors and timeouts from the pipeline layer.

### 5. Reconnect logic

`master.ts` listens for the pipeline `close` event, destroys the `ModbusMaster`, and schedules a reconnect with capped exponential backoff. Shutdown requests cancel the pending reconnect timer.

## Extending the example

- Add RTU or ASCII variants by swapping the physical layer and removing `concurrent` mode.
- Persist the in-memory model to a real database by replacing the arrays in `src/models.ts`.
- Replace the exponential-backoff reconnect with a circuit breaker for production deployments.
