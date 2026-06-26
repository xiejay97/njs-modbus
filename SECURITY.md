# Security Policy

This document defines the security policy for `njs-modbus`: supported versions, how to report vulnerabilities, how we disclose and fix them, and the deployment best practices that surround the library.

`njs-modbus` is a pure Modbus protocol stack. Its built-in security surface is intentionally narrow: protocol-level access control (`AccessAuthorizer`), protocol-level audit events (`accessAudit`, `protocolException`, `pipelineFault`), server-side connection controls (`ConnectionSecurityOptions`), and an optional TLS transport plugin. Transport encryption, network identity, host hardening, physical security, and durable audit logging are the responsibility of the host application and infrastructure.

---

## Supported Versions

Only the latest minor release of the current major line receives security patches. Users should run the latest patch version and upgrade promptly when a security advisory is published.

| Version | Supported | Notes |
| ------- | :-------: | ----- |
| 4.x     | ✅        | Actively maintained. |
| < 4.0   | ❌        | No longer supported; please upgrade to 4.x. |

---

## Threat Model in Brief

- **Untrusted peers can reach the transport endpoint.** Use TLS, VPNs, firewalls, or network segmentation for any path that crosses an untrusted network.
- **Access control is opt-in.** When no `AccessAuthorizer` is installed, all requests are allowed. The host application supplies and enforces policy.
- **`ConnectionSecurityOptions` are a second line of defense.** Perimeter controls must still be deployed in production.
- **Audit events are emitted, not stored.** The host application must forward them to a durable log store or SIEM.

For the full STRIDE threat model and review gates, see [`docs/security/sdl.md`](docs/security/sdl.md).

---

## Reporting a Vulnerability

If you believe you have found a security vulnerability in `njs-modbus`, please report it to us responsibly.

**Do NOT disclose security issues through public GitHub issues, discussions, or pull requests.** Public disclosure before a fix is available puts all users at risk.

### Contact

Send details to:

- **xiejay97@gmail.com**

Please include the following information so we can triage quickly:

1. A clear description of the vulnerability and its potential impact.
2. Steps to reproduce the issue, or a minimal proof-of-concept.
3. The affected version(s), component(s), and transport(s) (TCP / RTU / ASCII / TLS / UDP / serial).
4. Your assessment of severity (see below) and any suggested remediation or patch.
5. Your preferred disclosure timeline and whether you wish to be credited.

### What to expect

- **Acknowledgment** within 5 business days.
- **Initial triage** within 10 business days, including severity assignment and affected-version confirmation.
- **Progress updates** as the investigation and fix develop.
- **Coordinated disclosure** once a patched release is available.

### Severity guidance

We use the following rough severity scale to prioritize work. You do not need to classify the issue yourself; we will do that during triage.

| Severity | Typical criteria |
| :------: | ---------------- |
| **Critical** | Remote code execution, authentication bypass of `AccessAuthorizer`, or a flaw that allows arbitrary wire access against a configured slave. |
| **High** | Denial of service that can be triggered by unauthenticated peers, significant information disclosure from plaintext payloads, or TLS bypass. |
| **Medium** | Denial of service requiring specific conditions, partial policy bypass, or notable integrity impact. |
| **Low** | Minor information leakage, defense-in-depth weaknesses, or documentation gaps that do not directly enable exploitation. |

---

## Disclosure Policy

We follow a coordinated disclosure process:

1. **Acknowledgment** — we confirm receipt and begin triage.
2. **Investigation** — we validate the issue, determine affected versions, and assess severity.
3. **Remediation** — we develop and test a fix in a private branch.
4. **Release** — we publish a patched version and a security advisory.
5. **Public disclosure** — after a fix is available, we publish the advisory on GitHub and update this document.

We request that reporters allow us at least **90 days** from acknowledgment to release a fix before publicly disclosing the issue. We will work with you to coordinate an agreed disclosure date, and we are happy to shorten or extend this window based on the circumstances.

---

## Security Update Process

- Security fixes are released as patch versions on the supported major line (e.g., `4.0.1`).
- Releases follow [Semantic Versioning](https://semver.org/) and [Conventional Commits](https://www.conventionalcommits.org/).
- Security advisories are published via [GitHub Security Advisories](https://github.com/xiejay97/njs-modbus/security/advisories) when applicable.
- Users can subscribe to release notifications by watching the repository on GitHub or using automated dependency monitors such as Dependabot, Snyk, or `npm audit`.

---

## CVE Handling

When a vulnerability is assigned a CVE identifier, we will:

1. Reference the CVE in the security advisory and release notes.
2. Credit the reporter unless they request anonymity.
3. Backport the fix to all supported major versions when feasible.
4. Update this document and any related security guides in `docs/security/`.

---

## Security Best Practices for Deployments

`njs-modbus` is a library, not a standalone security product. The overall security posture depends on deployment-specific controls. See [`docs/security/compensating-controls.md`](docs/security/compensating-controls.md) for a full checklist; the summary below covers the essentials.

- **Transport encryption** — use the built-in `TlsClientPhysicalLayer` / `TlsServerPhysicalLayer`, a TLS-terminating reverse proxy, or a VPN for any Modbus traffic that crosses an untrusted network.
- **Peer identity** — restrict who can open a connection using mTLS client certificates, IP whitelisting, firewall rules, and network segmentation.
- **Least privilege** — run the Node.js process under a dedicated, low-privilege OS account.
- **Secrets management** — protect private keys with filesystem permissions (`0o600`) or a hardware security module (HSM) / key-management service.
- **Access control** — install an `AccessAuthorizer` with the minimum required units, function codes, and address ranges.
- **Connection controls** — configure `ConnectionSecurityOptions` (`whitelist`, `maxConnections`, `maxConnectionsPerIp`, `idleTimeout`) on server physical layers.
- **Audit forwarding** — forward `accessAudit`, `protocolException`, and `pipelineFault` events from `ModbusSlave` to a durable audit log or SIEM.
- **Dependency hygiene** — keep Node.js and all dependencies up to date; run `npm audit` regularly.

---

## Acknowledgments

We thank security researchers and community members who report vulnerabilities responsibly. A list of credited reporters will be maintained here as issues are disclosed.

---

**Last updated:** 2026-06-26
