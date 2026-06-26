# Security Development Lifecycle (SDL)

**Document class:** Process artifact describing the secure development practices applied to `njs-modbus`.  
**Purpose:** Define threat modeling, secure coding, code review, and release practices for the protocol-layer access-control architecture.

---

## 1. Threat Modeling

### 1.1 Scope and Trust Boundaries

`njs-modbus` is a pure-software Modbus protocol stack. Transport-layer encryption is optionally provided by the built-in TLS plugin; physical security remains outside the library scope. Primary trust boundaries are:

- **Network boundary:** Any untrusted TCP/UDP/TLS/serial peer. When the TLS plugin is not used, the library assumes the host has already enforced transport-layer controls (VPN, firewall, proxy) before bytes reach `njs-modbus`.
- **Process boundary:** The Node.js process hosting the library. Secrets, identity state, and audit sinks are managed by the host application.
- **Application boundary:** User code that supplies `AccessAuthorizer` policies and `ConnectionSecurityOptions`, and consumes `accessAudit` / `protocolException` / `pipelineFault` / `frameError` events.

### 1.2 STRIDE-Driven Threats and Mitigations

| Threat | Example in Modbus Context | Mitigation in `njs-modbus` |
| --- | --- | --- |
| **Spoofing** | Attacker sends requests from an unauthorized unit address. | `AccessAuthorizer.checkUnit` rejects frames from disallowed units. |
| **Tampering** | Man-in-the-middle modifies function code or payload. | Mitigated by TLS (built-in TLS plugin or external termination) / VPN. The library detects malformed frames via `frameError` events. |
| **Repudiation** | Operator denies issuing a dangerous command. | `accessAudit` events carry unit, function code, address range, and PDU snapshot. The host application is responsible for durable logging. |
| **Information Disclosure** | Plaintext Modbus traffic exposes register values. | Mitigated by TLS (built-in TLS plugin or external termination) / VPN. |
| **Denial of Service** | Flooding the endpoint with requests. | Queue strategies (`fifo`, `drop-stale`, `deduplicate`), `ConnectionSecurityOptions` (connection limits, idle timeout), plus user-supplied `AccessAuthorizer` gates. **Rate limiting is a deployment concern.** |
| **Elevation of Privilege** | Attacker accesses address ranges outside their authorization. | `AccessAuthorizer.checkAddress` enforces per-table address ranges; `checkRuntime` provides a last-chance gate before wire I/O. |

### 1.3 Model Update Triggers

The threat model is reviewed when any of the following occurs:

- A new transport or protocol layer is added (including TLS plugin / `node:tls` usage).
- The `AccessAuthorizer` interface, `ConnectionSecurityOptions`, or audit event schema changes.
- A CVE affects the Node.js runtime or a production dependency.
- A new security vulnerability is disclosed in `njs-modbus`.

---

## 2. Secure Coding

### 2.1 Hot-Path Rules

CPU-bound parsing and access-control paths must:

- Stay strictly inline; no helper function extraction for small math/bitwise ops.
- Avoid allocation; pass shared `Buffer` + explicit `offset`/`length`.
- Prefer primitive scalars over objects or boxed wrappers.

These rules are codified in [CLAUDE.md](../../CLAUDE.md) §1.1 and enforced by code review and benchmarks.

### 2.2 Input Validation

- All network-length fields are bounded before allocation or traversal in the protocol layers.
- `AccessAuthorizer` hooks receive validated unit/function-code/address-range values; user policy code should still validate its own inputs.
- Custom function codes must declare `requestAddressRange` or be authorized exclusively through `checkRuntime`.

### 2.3 Audit and Observability

- Security-relevant access-control decisions emit structured `accessAudit` events.
- Event payloads are constructed lazily when no listener is registered, keeping the hot path allocation-free.
- The library does not write audit records to local files or stdout; the host application consumes events and forwards them to its chosen sink.

---

## 3. Code Review

### 3.1 Required Review Gates

All changes touching the following areas require at least one additional security-focused review:

- `src/types.ts` — especially `AccessAuthorizer` and related public interfaces.
- `src/plugins/connection-security-options.ts` — server-side connection controls and whitelist behavior.
- `src/plugins/tcp/tcp-server-physical-layer.ts`, `src/plugins/udp/udp-server-physical-layer.ts`, `src/plugins/tls/tls-server-physical-layer.ts` — enforcement of `ConnectionSecurityOptions`.
- `src/slave/slave.ts` — access-control evaluation and audit event emission.
- `src/utils/access-authorizer.ts` — authorization result normalization.
- Audit event schemas in `src/slave/types.ts` and frame-error schemas in `src/layers/protocol/types.ts`.

### 3.2 Review Checklist

- [ ] Does the change preserve the hot-path performance contract (inline, zero-allocation, primitives-only)?
- [ ] Does the change introduce any new sink for untrusted input without bounds checking?
- [ ] Are failures fail-closed (deny by default) when a gate returns an error or rejection?
- [ ] Are new or changed public APIs documented with TSDoc, including units, inclusivity, and `@throws` triggers?
- [ ] Does the change alter the compiled MD5 of any existing Section 1.1 hot path? If yes, a benchmark delta must be recorded.
- [ ] Are Conventional Commits used with a relevant scope (`feat(slave):`, `fix(codec):`, etc.)?
- [ ] Does the change affect the threat model or security documentation? If yes, update `docs/security/` and `SECURITY.md`.

### 3.3 Automated Checks

The CI pipeline runs:

```bash
pnpm run lint --fix
pnpm run typecheck
pnpm run lint
pnpm test
pnpm run build
pnpm audit
```

`pnpm audit` scans the installed dependency tree.

---

## 4. Release Signing and Supply Chain

### 4.1 Versioning and Changelog

- Releases follow [Semantic Versioning](https://semver.org/) and [Conventional Commits](https://www.conventionalcommits.org/).
- `release-it` with `@release-it/conventional-changelog` generates the changelog and git tag.
- Breaking changes are marked with `!` or a `BREAKING CHANGE:` footer.

### 4.2 npm Publication

- The package is published as a public, unscoped package: `njs-modbus` (see `package.json`).
- `prepublishOnly` runs `pnpm run build`, ensuring the published artifact matches the tagged source.
- `package.json` `files` includes only `dist/` to minimize the published attack surface.

### 4.3 Provenance and Verification

- npm provenance is generated by the publish environment when supported.
- Consumers can verify the package with:

  ```bash
  npm audit signatures
  npm provenance njs-modbus@<version>
  ```

### 4.4 Dependency Update Policy

- `pnpm install --frozen-lockfile` is used in CI to guarantee reproducible builds.
- Security advisories affecting production dependencies are triaged within 14 days.
- Dependabot or equivalent automation is recommended for routine dependency updates.

---

## 5. Security Response

See [SECURITY.md](../../SECURITY.md) for:

- Vulnerability reporting channels.
- Disclosure policy and embargo periods.
- CVE handling and security-advisory release process.
