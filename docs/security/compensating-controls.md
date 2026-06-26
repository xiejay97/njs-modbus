# Deployment Compensating Controls

`njs-modbus` is a pure Modbus protocol stack. It provides protocol-level access control through `AccessAuthorizer`, protocol-level audit events through `accessAudit` and related events, server-side connection controls through `ConnectionSecurityOptions`, and an optional TLS transport plugin. Transport encryption, network identity, host hardening, physical security, and durable audit logging remain deployment responsibilities.

This document lists the deployment-side controls you should consider when building a secure system around `njs-modbus`.

---

## What the library provides

| Control | API / Mechanism | Notes |
| --- | --- | --- |
| Request authorization | `AccessAuthorizer` (`checkUnit`, `checkAddress`, `checkRuntime`) | Opt-in; default allows all. |
| Access-denial audit | `accessAudit` event on `ModbusSlave` | Emitted only when an authorizer is configured. |
| Protocol-exception monitoring | `protocolException` event on `ModbusSlave` | Useful for diagnostics and misconfiguration detection. |
| Transport-fault monitoring | `pipelineFault` event on `ModbusSlave` | Alerts on write failures. |
| Malformed-frame visibility | `frameError` event on `ModbusSlave` | Alerts on wire-quality or probing issues. |
| Server connection controls | `ConnectionSecurityOptions` | IP whitelist, max connections, max connections per IP, idle timeout. |
| Encrypted Modbus TCP | `TlsClientPhysicalLayer` / `TlsServerPhysicalLayer` | Backed by `node:tls`. |

---

## What you must provide externally

| Control | Why it matters | Typical implementation |
| --- | --- | --- |
| **Transport encryption** | Modbus payloads are plaintext without TLS; use the built-in TLS plugin, a reverse proxy, a VPN, or a network appliance for untrusted networks. | `TlsClientPhysicalLayer` / `TlsServerPhysicalLayer` with valid certificates; terminate TLS in a reverse proxy; or use a site-to-site VPN. |
| **Peer identity** | Ensure only trusted devices can open a transport connection. | mTLS client certificates, IP whitelisting, firewall rules, or network segmentation. |
| **Connection limits** | Prevent resource exhaustion and restrict peer exposure. | `ConnectionSecurityOptions` on `TcpServerPhysicalLayer`, `UdpServerPhysicalLayer`, and `TlsServerPhysicalLayer`: `whitelist`, `maxConnections`, `maxConnectionsPerIp`, `idleTimeout`. |
| **Network segmentation** | Limit lateral movement if a device is compromised. | VLANs, Purdue-model zones, industrial firewalls. |
| **Rate limiting** | Protect against accidental or malicious request floods. | Reverse proxy rate limiter, OS-level traffic shaping, or an application-level limiter. |
| **Persistent audit logging** | Meet compliance and forensic requirements. | Forward `accessAudit`, `protocolException`, `pipelineFault`, and `frameError` events to a SIEM or log store. |
| **Human operator authentication** | Control who can issue commands. | Implement in the host application or HMI before forwarding requests to `njs-modbus`. |
| **Host hardening** | Reduce the attack surface of the runtime. | Least-privilege OS user, minimal container image, timely Node.js and dependency updates, host firewall. |

---

## TLS deployment guidance

### Using the built-in TLS plugin

```ts
import { TlsServerPhysicalLayer } from 'njs-modbus';

const physical = new TlsServerPhysicalLayer();

physical.open({
  port: 802,
  tls: {
    key: fs.readFileSync('server-key.pem'),
    cert: fs.readFileSync('server-cert.pem'),
    ca: fs.readFileSync('ca-cert.pem'),
    requestCert: true, // require mutual TLS
    rejectUnauthorized: true,
  },
});
```

For mutual TLS, set `requestCert: true` and `rejectUnauthorized: true`. The client certificate is available to your application through the underlying `tls.TLSSocket`; map the certificate identity to your device registry if you need application-level authorization.

### Using an external TLS terminator

If you terminate TLS in a reverse proxy or load balancer:

- Ensure the proxy validates client certificates before forwarding.
- Forward traffic to `njs-modbus` over a trusted local interface (loopback or internal VPC).
- Do not expose the plaintext Modbus port to untrusted networks.

---

## `ConnectionSecurityOptions` reference

Server physical layers accept a `security` option:

```ts
interface ConnectionSecurityOptions {
  whitelist?: WhitelistEntry[];      // allowed IP addresses or CIDRs
  maxConnections?: number;           // total concurrent connections
  maxConnectionsPerIp?: number;      // concurrent connections per source IP
  idleTimeout?: number;              // milliseconds; close idle connections
}
```

Example:

```ts
physical.open({
  port: 502,
  security: {
    whitelist: ['10.0.0.0/24', '192.168.1.10'],
    maxConnections: 100,
    maxConnectionsPerIp: 10,
    idleTimeout: 300_000,
  },
});
```

Treat these options as a **second line of defense**, not a replacement for perimeter firewalls or network segmentation.

---

## Recommended deployment checklist

- [ ] Transport encryption is enforced for any path that crosses an untrusted network (built-in TLS plugin, reverse proxy, or VPN).
- [ ] Only trusted peers can reach the Modbus endpoint (firewall, ACL, or mTLS).
- [ ] `AccessAuthorizer` is configured with the minimum required units, function codes, and address ranges.
- [ ] `ConnectionSecurityOptions` are configured for server physical layers as a secondary control.
- [ ] Audit events are captured and forwarded to a durable log store or SIEM.
- [ ] The host application authenticates and authorizes human operators before allowing Modbus operations.
- [ ] The Node.js process runs under a dedicated, least-privilege OS account.
- [ ] Private keys are protected with filesystem permissions (`0o600`) or an HSM/KMS.
- [ ] Node.js and dependencies are kept up to date; `npm audit` is run regularly.
- [ ] Network segmentation isolates Modbus endpoints from untrusted networks.
- [ ] Rate limiting is in place to protect against request floods.
- [ ] A tested incident-response runbook exists for access-denial spikes and protocol exceptions.

---

## Responsibility model

```text
┌─────────────────────────────────────────────────────────────────────────────┐
│  Your application / host / network                                          │
│  - TLS termination (or use built-in TLS plugin), IP filtering, rate limits  │
│  - Operator authentication, SIEM forwarding, durable audit storage          │
└───────────────────────────────┬─────────────────────────────────────────────┘
                                │ raw or TLS-wrapped Modbus ADU bytes
┌───────────────────────────────▼─────────────────────────────────────────────┐
│  njs-modbus                                                                 │
│  - TLS plugin (optional)                                                    │
│  - ADU decode / encode                                                      │
│  - AccessAuthorizer evaluation                                              │
│  - ConnectionSecurityOptions (whitelist / limits / idle timeout)            │
│  - accessAudit / protocolException / pipelineFault / frameError events      │
└─────────────────────────────────────────────────────────────────────────────┘
```

Keep this boundary in mind when reasoning about security: `njs-modbus` can reject requests based on protocol content, but it cannot protect the transport or the host environment by itself.

---

## References

- [`access-control.md`](access-control.md)
- [`audit.md`](audit.md)
- [`../../SECURITY.md`](../../SECURITY.md)
- [`../../README.md`](../../README.md) — performance and feature overview
