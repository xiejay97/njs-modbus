/*
 * Copyright (c) 2026 xiejay97
 *
 * Licensed under the Business Source License 1.1 (the "License");
 * you may not use this file except in compliance with the License.
 *
 * Change Date: 2029-06-24
 *
 * On the date above, in accordance with the Change Date, the Licensed Work
 * will be made available under the Apache License, Version 2.0.
 *
 * You may obtain a copy of the License at
 *     https://mariadb.com/bsl11/
 */

/**
 * Public entry point for `njs-modbus`.
 *
 * Re-exports the core types, error codes, constants, protocol framing layers,
 * master / slave orchestrators, and transport plugins. Anything not exported
 * here is considered internal and may change without notice.
 */

/**
 * Core protocol-agnostic types: ADU, frame, queue strategy, access control, etc.
 */
export type {
  ApplicationDataUnit,
  ModbusFrame,
  ServerId,
  DeviceIdentification,
  ModbusQueueStrategy,
  CustomFunctionCode,
  AccessAuthorizer,
} from './types';

/**
 * Modbus exception codes and the typed error that carries them.
 */
export { ErrorCode, ModbusError, getErrorByCode, getCodeByError } from './error-code';

/**
 * Framing helpers: CRC-16 (exported as `crc`), LRC, ADU fingerprinting, and
 * the IP whitelist entry type used by {@link ConnectionSecurityOptions.whitelist}.
 */
export type { WhitelistEntry } from './utils';
export { crcFixed as crc, lrc, generateAduHashFingerprint } from './utils';

/**
 * Standard function-code enum, constants, and access-denial error.
 */
export { FunctionCode, UnauthorizedAccessError } from './vars';

/**
 * Protocol framing layers (TCP / RTU / ASCII) and the pipeline adapter contract.
 */
export * from './layers/protocol';
export * from './layers/abstract-pipeline-adapter';

/**
 * Master / client orchestrator and its public types.
 */
export * from './master';

/**
 * Slave / server orchestrator and its public types.
 */
export * from './slave';

/**
 * Transport plugins (serial / TCP / TLS / UDP) and their abstract contracts.
 */
export * from './plugins';

declare const __VERSION__: string;
let localVersion: string;
try {
  localVersion = __VERSION__;
} catch {
  localVersion = '1.0.0-dev';
}

/**
 * Runtime version string of the installed `njs-modbus` package.
 *
 * Resolved from the bundler-injected `__VERSION__` define when present;
 * falls back to `'1.0.0-dev'` for unbundled source consumption (e.g., CI
 * tests linking the workspace directly). Useful for client-side telemetry,
 * version-gated diagnostics, and log lines that need to pin protocol
 * behaviour to a specific release.
 */
export const NJS_MODBUS_VERSION = localVersion;
