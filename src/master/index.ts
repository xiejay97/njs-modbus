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
 * Modbus master / client public API.
 *
 * Re-exports the orchestrator and its construction / response types.
 */

/** Construction options and resolved response type for {@link ModbusMaster}. */
export type { ModbusMasterOptions, ModbusResponse } from './master';
/** Modbus master / client orchestrator. */
export { ModbusMaster } from './master';
