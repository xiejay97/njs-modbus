# Access Control

`njs-modbus` delegates all authorization decisions to an optional, user-supplied `AccessAuthorizer`. The library evaluates the policy at well-defined points in the request lifecycle and either allows the request, denies it with `UnauthorizedAccessError`, or returns a typed Modbus exception code.

By default, **no authorizer is installed and all requests are allowed**. This is intentional: the appropriate constraints are deployment-specific, and a secure-by-default policy would silently break legitimate use cases. Production deployments should always install an `AccessAuthorizer` with the minimum required permissions.

---

## Authorization lifecycle

On both master and slave, evaluation follows the same three-gate model. Each gate is optional; omit it to disable that check.

```text
Incoming request
      │
      ▼
┌─────────────┐    ┌─────────────┐    ┌─────────────┐
│  checkUnit  │──▶│ checkAddress │──▶│ checkRuntime │
│  (unit)     │    │ (unit, table,│    │ (unit, fc,  │
│             │    │  addressRange)│   │  data)       │
└─────────────┘    └─────────────┘    └─────────────┘
      │                  │                  │
   allow/deny         allow/deny         allow/deny
```

| Gate | Evaluated on master | Evaluated on slave | Purpose |
| --- | --- | --- | --- |
| `checkUnit` | Before request enters queue. | When frame is received. | Authorize the target unit / slave address. |
| `checkAddress` | Before request enters queue. | When frame is received. | Authorize the address range and Modbus table touched by the request. |
| `checkRuntime` | After queue drains, before request is encoded and written. | After unit handler produces a successful response, before encoding. | Last-chance authorization with full request context (unit, FC, PDU bytes). |

If any gate denies the request, later gates are skipped.

---

## The `AccessAuthorizer` interface

```ts
export interface AccessAuthorizer {
  /**
   * Authorize the target unit / slave address.
   *
   * @param unit Unit / slave address byte (0..247, inclusive).
   * @returns `true`, `false`, or an {@link ErrorCode}.
   */
  checkUnit?: (unit: number) => ErrorCode | boolean | Promise<ErrorCode | boolean>;

  /**
   * Authorize the address range touched by the request.
   *
   * Only invoked for standard function codes and for custom function codes
   * that declare {@link CustomFunctionCode.requestAddressRange}.
   *
   * @param unit Unit / slave address byte (0..247, inclusive).
   * @param table Modbus table being accessed.
   * @param addressRange Inclusive zero-based `[startAddress, endAddress]` pair.
   * @returns `true`, `false`, or an {@link ErrorCode}.
   */
  checkAddress?: (
    unit: number,
    table: 'discreteInputs' | 'coils' | 'inputRegisters' | 'holdingRegisters',
    addressRange: [startAddress: number, endAddress: number],
  ) => ErrorCode | boolean | Promise<ErrorCode | boolean>;

  /**
   * Last-chance runtime authorization evaluated immediately before wire I/O.
   *
   * @param unit Unit / slave address byte (0..247, inclusive).
   * @param fc Function code byte (0..255).
   * @param data PDU payload bytes (length 0..253).
   * @returns `true`, `false`, or an {@link ErrorCode}.
   */
  checkRuntime?: (unit: number, fc: number, data: Buffer) => ErrorCode | boolean | Promise<ErrorCode | boolean>;
}
```

Each hook may return:

| Return value | Meaning | Result on the wire |
| --- | --- | --- |
| `true` | Allow the request. | Request proceeds normally. |
| `false` | Deny. | `UnauthorizedAccessError` is thrown (master) or an exception response is emitted (slave). |
| `ErrorCode` | Deny with a typed Modbus exception. | A {@link ModbusError} with the chosen exception code. |
| `Promise<...>` | Evaluate asynchronously. | Same as above once resolved. |

---

## Installing and removing a policy

### Master

```ts
import { ModbusMaster } from 'njs-modbus';

const master = new ModbusMaster({ /* transport options */ });

master.setAccessAuthorizer({
  checkUnit: (unit) => unit === 1,
  checkAddress: (_unit, table, [start, end]) =>
    table === 'holdingRegisters' && start >= 0 && end < 100,
});

// later
master.deleteAccessAuthorizer();
```

### Slave

```ts
import { ModbusSlave } from 'njs-modbus';

const slave = new ModbusSlave({ /* transport options */ });

slave.setAccessAuthorizer({
  checkUnit: (unit) => allowedUnits.has(unit),
  checkAddress: (_unit, table, [start, end]) =>
    table === 'holdingRegisters' && start >= 0 && end < 100,
  checkRuntime: (unit, fc, data) => {
    // Last-chance gate; e.g., enforce a maintenance window.
    return maintenanceMode ? ErrorCode.SERVER_DEVICE_BUSY : true;
  },
});
```

---

## Common authorization patterns

### Whitelist units

```ts
slave.setAccessAuthorizer({
  checkUnit: (unit) => [1, 2, 3].includes(unit),
});
```

### Read-only slave

Block all write function codes while allowing reads and diagnostics:

```ts
const WRITE_FCS = new Set([
  0x05, // Write Single Coil
  0x06, // Write Single Register
  0x0f, // Write Multiple Coils
  0x10, // Write Multiple Registers
  0x16, // Mask Write Register
  0x17, // Read/Write Multiple Registers
]);

slave.setAccessAuthorizer({
  checkRuntime: (_unit, fc, _data) => !WRITE_FCS.has(fc),
});
```

### Per-table address ranges

```ts
slave.setAccessAuthorizer({
  checkAddress: (_unit, table, [start, end]) => {
    const allowed: Record<string, [number, number]> = {
      holdingRegisters: [0, 999],
      inputRegisters: [0, 499],
      coils: [0, 1999],
      discreteInputs: [0, 1999],
    };
    const [lo, hi] = allowed[table];
    return start >= lo && end <= hi;
  },
});
```

### Maintenance window

Use `checkRuntime` to reject destructive operations during planned maintenance:

```ts
slave.setAccessAuthorizer({
  checkRuntime: (_unit, fc, _data) => {
    const writeFCs = new Set([0x05, 0x06, 0x0f, 0x10, 0x16, 0x17]);
    if (maintenanceMode && writeFCs.has(fc)) {
      return ErrorCode.SERVER_DEVICE_BUSY;
    }
    return true;
  },
});
```

### Async authorization against an external directory

```ts
slave.setAccessAuthorizer({
  checkUnit: async (unit) => {
    const allowed = await policyService.isUnitAllowed(unit);
    return allowed;
  },
});
```

---

## Custom function codes

Standard function codes have built-in address-range extraction, so `checkAddress` works automatically. For custom function codes, declare `requestAddressRange` so the access-control layer knows which ranges to authorize:

```ts
slave.addCustomFunctionCode(
  {
    fc: 0x65,
    requestAddressRange: (_unit, _fc, data) => ({
      holdingRegisters: [[0, data.length - 1]],
    }),
  },
  (_unit, _fc, data, callback) => callback(null, () => Buffer.concat([data, data])),
);
```

If `requestAddressRange` is omitted, `checkAddress` is not invoked for that function code. Use `checkRuntime` for custom-FC authorization when the address range is not meaningful.

---

## Default behavior

If no `AccessAuthorizer` is installed, **all requests are allowed**. The library does not ship a secure-by-default policy because the appropriate constraints are deployment-specific.

To remove a previously installed policy:

```ts
master.deleteAccessAuthorizer();
slave.deleteAccessAuthorizer();
```

---

## Errors and audit events

| Denial type | Return value | Master behavior | Slave behavior |
| --- | --- | --- | --- |
| Generic deny | `false` | Throws {@link UnauthorizedAccessError}. | Responds with an exception and emits `accessAudit`. |
| Typed deny | `ErrorCode` | Throws {@link ModbusError} with that code. | Responds with the specified Modbus exception and emits `accessAudit`. |

On the slave, every access-control denial emits an `accessAudit` event. See [`audit.md`](audit.md) for event schemas and SIEM integration patterns.

---

## Performance and design notes

- `checkUnit` and `checkAddress` run before a request enters the queue on the master, so denied requests never consume queue slots or transaction IDs.
- `checkRuntime` is the only gate that sees the raw PDU bytes. Keep it fast: it runs on the hot path immediately before wire I/O.
- Async hooks are awaited; a slow authorizer will block the request pipeline. Cache external directory lookups when latency matters.
- The library normalizes the result of each hook. Any value other than `true` or a resolved `true` is treated as a denial.
