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
 * Modbus slave / server public API.
 *
 * Re-exports the unit model contract, slave-emitted event types, the
 * construction options, and the slave orchestrator itself.
 */

/** Unit model contract and slave-emitted event types / payloads. */
export type {
  ModbusUnitModel,
  ProtocolExceptionEventType,
  ProtocolExceptionEvent,
  AccessAuditEventType,
  AccessAuditEvent,
  PipelineFaultEventType,
  PipelineFaultEvent,
} from './types';

/** Construction options for {@link ModbusSlave}. */
export type { ModbusSlaveOptions } from './slave';
/** Modbus slave / server orchestrator. */
export { ModbusSlave } from './slave';
