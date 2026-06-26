# Audit Events

`njs-modbus` exposes protocol-layer events that you can forward to your own logging pipeline, SIEM, or monitoring system. The library itself does **not** write audit records to disk, stdout, or any external sink. This keeps the library runtime-agnostic and avoids imposing a logging framework on your application.

This document describes each event, its schema, and common integration patterns.

---

## Events emitted by `ModbusSlave`

| Event | When | Payload type | Primary use |
| --- | --- | --- | --- |
| `accessAudit` | A request is denied by the configured `AccessAuthorizer`. | {@link AccessAuditEvent} | Security monitoring, compliance, forensics. |
| `protocolException` | A valid request results in a Modbus exception response. | {@link ProtocolExceptionEvent} | Operational diagnostics, misconfiguration detection. |
| `pipelineFault` | The encoded response could not be written to the pipeline layer. | {@link PipelineFaultEvent} | Transport-layer reliability alerting. |
| `frameError` | A malformed or out-of-spec frame could not be parsed. | {@link FrameErrorEvent} | Wire-quality monitoring, attack-surface detection. |

`ModbusMaster` does **not** emit `accessAudit` events: master-side request denials are returned directly to the caller through the request's callback or Promise.

---

## `accessAudit`

The `accessAudit` event is emitted only when an `AccessAuthorizer` hook denies a request. It is **not** emitted when no authorizer is configured.

```ts
import type { AccessAuditEvent } from 'njs-modbus';

slave.on('accessAudit', (event: AccessAuditEvent) => {
  logger.warn({ audit: event }, 'modbus access denied');
});
```

### Event shape

```ts
interface AccessAuditEvent {
  type: 'unit_access_denied' | 'address_access_denied' | 'runtime_access_denied';
  message: string;
  transaction?: number; // TCP MBAP transaction id, when available
  unit: number;         // Modbus unit / slave address (0..247)
  fc: number;           // Modbus function code (0..255)
  data: Buffer;         // Copy of the PDU payload that triggered the denial
}
```

### Type mapping to gates

| `type` | Triggering gate |
| --- | --- |
| `unit_access_denied` | `AccessAuthorizer.checkUnit` |
| `address_access_denied` | `AccessAuthorizer.checkAddress` |
| `runtime_access_denied` | `AccessAuthorizer.checkRuntime` |

### Example: structured log line

```ts
slave.on('accessAudit', (event) => {
  logger.warn({
    modbus: {
      event: 'access_denied',
      type: event.type,
      unit: event.unit,
      fc: event.fc,
      transaction: event.transaction,
      reason: event.message,
    },
  }, 'Modbus access denied');
});
```

---

## `protocolException`

The `protocolException` event is emitted when the slave responds with a Modbus exception function code. This includes validation errors, missing handlers, and explicit `ErrorCode` returns from `checkRuntime`.

```ts
import type { ProtocolExceptionEvent } from 'njs-modbus';

slave.on('protocolException', (event: ProtocolExceptionEvent) => {
  metrics.increment(`modbus_exception.${event.type}`);
  logger.info({ exception: event }, 'modbus exception');
});
```

### Event shape

```ts
interface ProtocolExceptionEvent {
  type:
    | 'function_illegal'
    | 'function_not_implemented'
    | 'data_value_illegal'
    | 'data_address_illegal'
    | 'server_device_failure'
    | 'gateway_path_unavailable';
  message: string;
  transaction?: number;
  unit: number;
  fc: number;
  data: Buffer; // Copy of the request PDU payload
}
```

### Common scenarios

| `type` | Example cause |
| --- | --- |
| `function_illegal` | The function code is not supported by the slave or framing layer. |
| `function_not_implemented` | The function code is supported, but the target unit model does not implement the handler. |
| `data_value_illegal` | PDU length, value range, or structure violates the Modbus spec. |
| `data_address_illegal` | Data address or object id is outside the allowed range. |
| `server_device_failure` | A handler detected an internal failure while building the response. |
| `gateway_path_unavailable` | The target unit is not registered on this slave session. |

---

## `pipelineFault`

Emitted when the slave has produced a response but the underlying pipeline layer fails to transmit it:

```ts
slave.on('pipelineFault', (event) => {
  logger.error({ fault: event }, 'failed to write modbus response');
});
```

### Event shape

```ts
interface PipelineFaultEvent {
  type: 'write_failed';
  message: string;
  transaction?: number;
  unit: number;
  fc: number;
  data: Buffer;        // Copy of the request PDU payload
  responseRaw: Buffer; // The encoded response frame that failed to write
  error: Error;        // The error returned by the pipeline layer
}
```

---

## `frameError`

Emitted when the protocol framing layer discards a malformed, incomplete, or out-of-spec frame. This is useful for detecting wire-quality issues, misconfigured peers, or probing traffic.

```ts
import type { FrameErrorEvent } from 'njs-modbus';

slave.on('frameError', (event: FrameErrorEvent) => {
  metrics.increment(`modbus_frame_error.${event.type}`);
  logger.info({ frameError: event }, 'modbus frame rejected');
});
```

### Event shape

```ts
interface FrameErrorEvent {
  type:
    | 'hex_character_invalid'
    | 'lrc_check_failed'
    | 'frame_too_long'
    | 'frame_length_insufficient'
    | 'frame_length_invalid'
    | 't3.5_timeout'
    | 't1.5_timeout'
    | 'protocol_id_invalid';
  message: string;
  raw: Buffer;          // Snapshot of the bad frame bytes
  transaction?: number; // TCP MBAP transaction id, when available
  fc?: number;          // Extracted function code, when available
}
```

---

## Performance note: zero-cost when not listened

`accessAudit`, `protocolException`, `pipelineFault`, and `frameError` events are emitted through a lazy event emitter. The event object is only allocated when at least one listener is registered. If you do not listen to these events, denied requests and protocol faults incur no audit-event allocation overhead on the hot path.

---

## SIEM integration pattern

A typical production integration forwards all event streams to a structured logger and then to a SIEM:

```ts
slave
  .on('accessAudit', (event) =>
    logger.warn({
      modbus: { event: 'access_denied', ...event },
      severity: 'medium',
    }),
  )
  .on('protocolException', (event) =>
    logger.info({
      modbus: { event: 'protocol_exception', ...event },
      severity: 'low',
    }),
  )
  .on('pipelineFault', (event) =>
    logger.error({
      modbus: { event: 'pipeline_fault', ...event },
      severity: 'high',
    }),
  )
  .on('frameError', (event) =>
    logger.info({
      modbus: { event: 'frame_error', ...event },
      severity: 'low',
    }),
  );
```

Because the events carry the raw PDU copy (`data`), you can log, hash, or archive the payload according to your own retention and privacy requirements. Be cautious with full payload logging in regulated environments: Modbus payloads may contain sensitive operational data.

---

## Recommended alerting rules

| Event pattern | Suggested action |
| --- | --- |
| Spike in `accessAudit` denials from a single IP or unit | Investigate for unauthorized probing or misconfigured peer. |
| `protocolException` with `data_address_illegal` for allowed ranges | Check unit model address limits and client requests. |
| `pipelineFault` events | Alert on transport reliability; may indicate network partition or resource exhaustion. |
| Sustained `frameError` events | Inspect wire quality, baud-rate mismatch, or malicious traffic injection. |
| `accessAudit` of type `runtime_access_denied` for write FCs | Treat as high-priority; may indicate policy bypass attempt. |

---

## Retention and privacy

- **Retention**: Store audit events long enough to satisfy compliance and forensic requirements. Typical industrial/OT retention ranges from 30 days to several years; align with your organization's policy.
- **Privacy**: PDU payloads may contain process data. Hash or truncate payloads before long-term storage if the raw values are sensitive.
- **Correlation**: Include host name, process id, transport endpoint, and timestamp in your logged events so SIEM queries can correlate Modbus activity across a fleet.
