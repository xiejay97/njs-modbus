# njs-modbus Best-Practice Example

This example shows production-oriented patterns for `njs-modbus` TCP master and slave applications. It is self-contained: no external PLC, serial port, or database is required.

## What it demonstrates

- **Shared configuration**: port, unit IDs, address ranges, and queue strategies live in one place so master and slave never disagree.
- **Access control on both sides**: the same authorizer is installed on the master (fail-fast before queueing) and the slave (defense at the edge).
- **Per-connection slave lifecycle**: a new `ModbusSlave` is created for every TCP connection and destroyed when the pipeline closes.
- **Concurrent pipelining on the master**: safe on Modbus TCP because MBAP transaction ids correlate responses with requests.
- **Reconnection is an application concern**: `njs-modbus` deliberately does not provide built-in auto-reconnect; the included examples show how to implement it yourself.
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
├── master.ts          # TCP client best-practice (includes reconnect)
├── reconnect.ts       # Focused reconnection pattern with polling loop
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
pnpm --filter njs-modbus-best-practice run server
```

Then run the master in another terminal:

```bash
pnpm --filter njs-modbus-best-practice run client
```

To see the dedicated reconnection example in action:

```bash
pnpm --filter njs-modbus-best-practice run server
pnpm --filter njs-modbus-best-practice run reconnect
```

Stop and restart the slave while `reconnect.ts` is running; the master will pause its polling loop and reconnect with exponential backoff.

Or run the full demo from the repo root:

```bash
pnpm --filter njs-modbus-best-practice run demo
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

`njs-modbus` intentionally leaves reconnection to the application. A protocol stack cannot know your deployment's retry budget, backoff policy, or whether a lost connection should be fatal. Both `master.ts` and `reconnect.ts` implement the same pattern; `reconnect.ts` isolates it so you can copy the file as a starting point.

The recommended pattern is:

1. **Open the physical layer once** and keep it alive across reconnects. The `TcpClientPhysicalLayer` emits a new pipeline on every successful TCP connection.
2. **Create a new `ModbusMaster` for each connection.** Queues, transaction ids, and listeners are tied to the pipeline; reusing an old master after a disconnect leaks state.
3. **Listen for `pipeline.once('close', ...)`** as the authoritative "wire is gone" signal. Destroy the master, stop any application-level loops, and schedule a reconnect.
4. **Use capped exponential backoff with jitter.** `reconnect.ts` uses `delay = min(max, initial * 2^attempt) * (0.5 + random/2)`. Jitter prevents a fleet of clients from reconnecting in lockstep after a server restart.
5. **Carry a retry budget.** After `MAX_RECONNECT_ATTEMPTS` failures, give up and shut down so an operator or orchestrator can investigate.
6. **Cancel timers on shutdown.** Pending reconnect and poll timers must be cleared in the `SIGINT` handler to avoid hanging the process.

`master.ts` shows the minimal version of this pattern; `reconnect.ts` adds a polling loop that automatically pauses while disconnected and resumes after reconnect.

## Extending the example

- Add RTU or ASCII variants by swapping the physical layer and removing `concurrent` mode.
- Persist the in-memory model to a real database by replacing the arrays in `src/models.ts`.
- Replace the exponential-backoff reconnect with a circuit breaker for production deployments.
- Adapt `reconnect.ts` into a reusable `ReconnectingMaster` wrapper class if multiple masters in your application need the same policy.
