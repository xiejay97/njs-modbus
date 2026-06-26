# Security in njs-modbus

`njs-modbus` is a pure Modbus protocol stack. Its built-in security surface is deliberately narrow and protocol-focused:

- **Access control** — `AccessAuthorizer` with three gates (`checkUnit`, `checkAddress`, `checkRuntime`).
- **Audit events** — `accessAudit`, `protocolException`, `pipelineFault`, and `frameError` on `ModbusSlave`.
- **Connection controls** — `ConnectionSecurityOptions` for TCP, UDP, and TLS server physical layers.
- **Transport encryption** — optional built-in TLS transport plugin.

Everything else — PKI lifecycle, network identity, perimeter firewalls, host hardening, physical security, durable audit logging, and operator authentication — is the responsibility of the host application and infrastructure. This separation keeps the library dataflow-driven, runtime-agnostic, and fast, while giving you full control over how Modbus traffic is secured in your environment.

---

## What the library provides

| Capability | API / Mechanism | Where to read more |
| --- | --- | --- |
| Unit-level authorization | `AccessAuthorizer.checkUnit` | [`access-control.md`](access-control.md) |
| Address-range authorization | `AccessAuthorizer.checkAddress` | [`access-control.md`](access-control.md) |
| Last-chance runtime authorization | `AccessAuthorizer.checkRuntime` | [`access-control.md`](access-control.md) |
| Access-denial audit trail | `accessAudit` event on `ModbusSlave` | [`audit.md`](audit.md) |
| Protocol-exception monitoring | `protocolException` event on `ModbusSlave` | [`audit.md`](audit.md) |
| Write/encoding fault monitoring | `pipelineFault` event on `ModbusSlave` | [`audit.md`](audit.md) |
| Malformed-frame visibility | `frameError` event on `ModbusSlave` | [`audit.md`](audit.md) |
| Server connection controls | `ConnectionSecurityOptions` (whitelist, max connections, idle timeout) | [`compensating-controls.md`](compensating-controls.md) |
| Encrypted Modbus TCP | `TlsClientPhysicalLayer` / `TlsServerPhysicalLayer` | [`compensating-controls.md`](compensating-controls.md) |

---

## What the library does **not** provide

The following concerns are intentionally outside the library scope. They must be implemented by the host application, operating system, network infrastructure, or a reverse proxy:

| Concern | Why it is outside the library | Typical implementation |
| --- | --- | --- |
| PKI lifecycle | Certificate provisioning, rotation, and revocation are deployment-specific. | Let's Encrypt, internal CA, HSM, cloud KMS. |
| Network identity beyond TLS cert validation | Device authentication and authorization depend on your trust model. | mTLS client certs, MAC filtering, 802.1X. |
| Perimeter firewalls / network segmentation | The library sees only bytes that have already reached the process. | Host firewall, VLANs, industrial firewalls. |
| Rate limiting | Request-rate policies are application-specific. | Reverse proxy, OS traffic shaping, app-level limiter. |
| Persistent audit logging | The library emits events; durable storage is a host concern. | SIEM, structured log shipper, database. |
| Operator / device authentication | Who can issue commands is a business-logic decision. | HMI login, OAuth, device certificates. |
| Host hardening | OS-level attack-surface reduction is environmental. | Least-privilege user, minimal container image, timely patches. |

---

## Responsibility model

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  Your environment: network, firewall, VPN, reverse proxy, HSM, SIEM         │
│  - TLS termination (or forward TLS bytes to the built-in TLS plugin)        │
│  - Peer identity, IP filtering, rate limiting                               │
│  - Operator authentication, durable audit logging                           │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ raw Modbus ADU bytes or TLS-wrapped bytes
┌───────────────────────────────▼─────────────────────────────────────────────┐
│  njs-modbus                                                                 │
│  - Optional TLS plugin (node:tls)                                           │
│  - ADU decode / encode, CRC/LRC/MBAP validation                             │
│  - AccessAuthorizer evaluation (checkUnit / checkAddress / checkRuntime)    │
│  - ConnectionSecurityOptions (whitelist / maxConnections / idleTimeout)     │
│  - accessAudit / protocolException / pipelineFault / frameError events      │
└─────────────────────────────────────────────────────────────────────────────┘
```

Keep this boundary in mind when designing security: `njs-modbus` can reject requests based on protocol content and emit rich audit events, but it cannot protect the transport or the host environment by itself.

---

## Threat model summary

The library assumes:

1. Untrusted peers can reach the transport endpoint (TCP / UDP / TLS / serial).
2. When the TLS plugin is not used, the host application has already enforced transport-layer controls (VPN, firewall, proxy) before bytes reach `njs-modbus`.
3. Access-control policies are supplied and enforced by user code; the default configuration allows all requests when no `AccessAuthorizer` is installed.
4. `ConnectionSecurityOptions` are a secondary control; perimeter firewalls and network segmentation should still be used in production.
5. Audit events are consumed by the host application; the library does not persist them.

For the full STRIDE threat model and SDL review gates, see [`sdl.md`](sdl.md).

---

## Documentation index

| Document | Purpose |
| --- | --- |
| [`access-control.md`](access-control.md) | Configure `AccessAuthorizer` on master and slave, common patterns, custom function codes. |
| [`audit.md`](audit.md) | Consume `accessAudit`, `protocolException`, `pipelineFault`, and `frameError` events. |
| [`compensating-controls.md`](compensating-controls.md) | Deployment-side controls for TLS, firewalls, logging, monitoring, and the responsibility model. |
| [`sdl.md`](sdl.md) | Security development lifecycle, threat model, secure coding rules, and release process. |
| [`../../SECURITY.md`](../../SECURITY.md) | Vulnerability reporting, disclosure policy, supported versions, and CVE handling. |
